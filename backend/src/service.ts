/**
 * Consultation service: the one place that drives the graph. Both the HTTP
 * server and the in-process CLI use it.
 */
import { randomUUID } from "node:crypto";
import { Command, type BaseCheckpointSaver } from "@langchain/langgraph";
import { buildGraph, type GraphOptions, type State } from "./graph";
import type { Tracing } from "../../shared/tracing/langfuse";
import { consultationScope, LLMError, summarizeUsage, type LLM, type UsageRecord, type UsageSummary } from "./llm";
import { countByStatus, type SlotStatus } from "./record";
import { slotsFor, templateById, type SlotKind } from "./templates";
import { LEVEL_NAME } from "./triage";

export interface TraceStep {
  node: string;
  summary: string;
}

export interface RecordRow {
  label: string;
  kind: SlotKind;
  status: SlotStatus;
  quote: string | null;
}

export interface ConsultationView {
  id: string;
  /** "failed": a model call failed after its retries; POST …/retry resumes from the failed step. */
  status: "awaiting_answer" | "emergency" | "completed" | "failed";
  question: string | null;
  level: string;
  record: { answered: number; unknown: number; unasked: number };
  /** The record table, one row per history-taking point, with the patient's own words. */
  table: RecordRow[];
  rounds: number;
  output: string | null;
  /** Why the consultation failed, when status is "failed". */
  error: string | null;
  trace: TraceStep[];
}

export class NotFoundError extends Error {}
export class ConflictError extends Error {}

/** A model call failed after its retries. The consultation is saved as "failed" and can be retried. */
export class ModelFailureError extends Error {
  constructor(
    readonly id: string,
    readonly cause: LLMError,
  ) {
    super(cause.message);
  }
}

function summarize(node: string, u: Partial<State>): string {
  switch (node) {
    case "setup":
      return `选用模板：${u.templateId}`;
    case "screen":
      return u.level ? `规则筛查：命中危险信号，${LEVEL_NAME[u.level]}` : "规则筛查：未命中Ⅰ、Ⅱ级危险信号";
    case "understand": {
      const filled = Object.values(u.record ?? {}).filter((e) => e.status !== "unasked").length;
      return `更新记录表，已有结果 ${filled} 项${u.rejected?.length ? `，丢弃 ${u.rejected.length} 条找不到原话的内容` : ""}`;
    }
    case "triage":
      return `病情分级：${u.level ? LEVEL_NAME[u.level] : ""}`;
    case "phrase":
      return u.proposed ? "改写追问措辞" : "无需改写";
    case "ask":
      return `第 ${u.asked?.[0]?.round} 轮追问：${u.asked?.[0]?.slotIds.join("、")}`;
    case "wait":
      return "收到患者回答";
    case "draft":
      return "生成病历草稿";
    case "check":
      return u.issues?.length ? `自查未通过：${u.issues.length} 个问题` : "自查通过";
    case "finalize":
      return "病历草稿完成";
    case "emergency":
      return "危险情况，停止问诊";
    default:
      return "";
  }
}

/** The error saved on a failed task, if the last run ended in one. */
function failureOf(snap: { tasks: readonly { error?: unknown }[] }): string | null {
  const t = snap.tasks.find((x) => x.error);
  if (!t) return null;
  const e = t.error as { message?: unknown };
  return typeof e?.message === "string" ? e.message : String(t.error);
}

export interface ServiceOptions {
  phrasing?: GraphOptions["phrasing"];
}

export class ConsultationService {
  private graph;

  constructor(
    private llm: LLM,
    checkpointer: BaseCheckpointSaver,
    maxRounds?: number,
    private tracing?: Tracing,
    opts: ServiceOptions = {},
  ) {
    this.graph = buildGraph(llm, checkpointer, { maxRounds, phrasing: opts.phrasing });
  }

  get modelKind(): string {
    return this.llm.kind;
  }

  get usage(): UsageRecord[] {
    return this.llm.usage;
  }

  /** Calls, tokens, cost and model time spent on one consultation. */
  usageFor(id: string): UsageSummary {
    return summarizeUsage(this.llm.usage.filter((u) => u.consultationId === id));
  }

  private config(id: string) {
    return { configurable: { thread_id: id } };
  }

  private run(id: string, input: unknown): Promise<TraceStep[]> {
    return consultationScope.run(id, () => this.runInScope(id, input));
  }

  private async runInScope(id: string, input: unknown): Promise<TraceStep[]> {
    const trace: TraceStep[] = [];
    try {
      // Every run of one consultation lands in the same Langfuse session, keyed by its thread_id.
      const callbacks = this.tracing ? [this.tracing.handler(id, { consultationId: id })] : undefined;
      const stream = await this.graph.stream(input as never, { ...this.config(id), streamMode: "updates", callbacks });
      for await (const chunk of stream) {
        for (const [node, update] of Object.entries(chunk as Record<string, unknown>)) {
          if (node === "__interrupt__") continue;
          trace.push({ node, summary: summarize(node, (update ?? {}) as Partial<State>) });
        }
      }
    } catch (err) {
      // The checkpointer has saved the error on the failed task; view() reports it and retry() resumes it.
      if (err instanceof LLMError) throw new ModelFailureError(id, err);
      throw err;
    }
    return trace;
  }

  private async snapshot(id: string) {
    const snap = await this.graph.getState(this.config(id));
    if (!snap.values || !(snap.values as State).complaint) throw new NotFoundError(id);
    return snap;
  }

  private async view(id: string, trace: TraceStep[]): Promise<ConsultationView> {
    const snap = await this.snapshot(id);
    const s = snap.values as State;
    const waiting = snap.tasks.some((t) => t.interrupts.length > 0);
    const failure = failureOf(snap);
    return {
      id,
      status: waiting ? "awaiting_answer" : failure ? "failed" : s.status === "emergency" ? "emergency" : "completed",
      question: waiting ? (s.asked.at(-1)?.text ?? null) : null,
      level: LEVEL_NAME[s.level],
      record: countByStatus(s.record),
      table: slotsFor(templateById(s.templateId)).map((slot) => ({
        label: slot.label,
        kind: slot.kind,
        status: s.record[slot.id]?.status ?? "unasked",
        quote: s.record[slot.id]?.quote || null,
      })),
      rounds: s.asked.length,
      output: waiting || failure ? null : s.output,
      error: failure,
      trace,
    };
  }

  async start(complaint: string, owner: string): Promise<ConsultationView> {
    const id = randomUUID();
    const trace = await this.run(id, { complaint, owner });
    return this.view(id, trace);
  }

  async answer(id: string, text: string, owner: string): Promise<ConsultationView> {
    const snap = await this.snapshot(id);
    if ((snap.values as State).owner !== owner) throw new NotFoundError(id);
    if (failureOf(snap)) throw new ConflictError("consultation failed; POST /v1/consultations/:id/retry to resume it");
    if (!snap.tasks.some((t) => t.interrupts.length > 0)) throw new ConflictError("consultation is not waiting for an answer");
    const trace = await this.run(id, new Command({ resume: text }));
    return this.view(id, trace);
  }

  /** Resume a failed consultation from the step that failed, on the same thread. */
  async retry(id: string, owner: string): Promise<ConsultationView> {
    const snap = await this.snapshot(id);
    if ((snap.values as State).owner !== owner) throw new NotFoundError(id);
    if (!failureOf(snap)) throw new ConflictError("consultation has not failed; nothing to retry");
    // A null input makes LangGraph re-run the errored task from the last checkpoint.
    const trace = await this.run(id, null);
    return this.view(id, trace);
  }

  async get(id: string, owner: string): Promise<ConsultationView> {
    const snap = await this.snapshot(id);
    if ((snap.values as State).owner !== owner) throw new NotFoundError(id);
    return this.view(id, []);
  }

  /** Full state, for the CLI's /record command and for tests. */
  async state(id: string): Promise<State> {
    return (await this.snapshot(id)).values as State;
  }
}
