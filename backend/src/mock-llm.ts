/**
 * Deterministic offline stand-in for the model, so the graph, persistence,
 * API and CLI can be run and tested without AWS credentials. Its clinical
 * judgement is keyword matching; it says nothing about real model quality.
 */
import type { GuidelinePassage } from "./guidelines";
import { consultationScope, type LLM, type StructuredCall, type Task, type UsageRecord } from "./llm";
import type { RecordTable } from "./record";
import type { ExtractOutput, NoteOutput, PhraseOutput, ReviewOutput, TriageOutput } from "./schemas";
import { slotsFor, type Slot, type Template } from "./templates";

const UNKNOWN = /不清楚|不知道|没注意|记不清|说不好/;

function clauses(text: string): string[] {
  return text
    // A "." between digits is a decimal point (38.5度), not a sentence end.
    .split(/[，。！？,!?；;\n]|\.(?!\d)/)
    .map((c) => c.trim())
    .filter((c) => c.length >= 2);
}

export interface ExtractContext {
  template: Template;
  record: RecordTable;
  asked: Slot[];
  answer: string;
}

function mockExtract(ctx: ExtractContext): ExtractOutput {
  const parts = clauses(ctx.answer);
  const updates: ExtractOutput["updates"] = [];
  const used = new Set<string>();

  if (ctx.asked.length === 0) {
    // Opening complaint: pick up what it already answers, e.g. duration or
    // "worse on exertion", so the planner does not ask about it again.
    const OPENING = new Set(["onset", "exertion", "triggers", "stool", "fever_max", "head_site"]);
    for (const s of slotsFor(ctx.template)) {
      if (!OPENING.has(s.id)) continue;
      const hit = parts.find((p) => s.keywords.test(p));
      if (hit) updates.push({ slotId: s.id, status: "answered", value: hit, quote: hit });
    }
    return { updates };
  }

  ctx.asked.forEach((slot, i) => {
    const byKeyword = parts.find((p) => !used.has(p) && slot.keywords.test(p));
    const byOrder = parts.length === ctx.asked.length ? parts[i] : undefined;
    const clause = byKeyword ?? byOrder;
    if (clause && !UNKNOWN.test(clause)) {
      used.add(clause);
      updates.push({ slotId: slot.id, status: "answered", value: clause, quote: clause });
    } else {
      updates.push({ slotId: slot.id, status: "unknown", value: "", quote: "" });
    }
  });

  // History the patient volunteers ("以前查出过高血压") also answers related
  // points that were not asked yet, as a real model would record it.
  const VOLUNTEERED = new Set(["pmh", "cv_risk", "meds", "family_cv"]);
  const askedIds = new Set(ctx.asked.map((s) => s.id));
  for (const s of slotsFor(ctx.template)) {
    if (!VOLUNTEERED.has(s.id) || askedIds.has(s.id) || ctx.record[s.id]?.status !== "unasked") continue;
    const hit = parts.find((p) => s.keywords.test(p) && !UNKNOWN.test(p));
    if (hit) updates.push({ slotId: s.id, status: "answered", value: hit, quote: hit });
  }
  return { updates };
}

function mockNote(ctx: { template: Template; record: RecordTable; complaint: string; passages: GuidelinePassage[] }): NoteOutput {
  const answered = slotsFor(ctx.template).filter((s) => ctx.record[s.id].status === "answered");
  const past = new Set(["pmh", "meds", "allergy", "family_cv", "cv_risk"]);
  const line = (s: Slot) => ({ text: `${s.label}：${ctx.record[s.id].value}`, slotIds: [s.id] });
  const onset = answered.find((s) => s.id === "onset");
  return {
    chiefComplaint: { text: ctx.complaint.replace(/^(医生)?(您好|你好)?[，,]?\s*(我)?/, "").replace(/。$/, ""), slotIds: onset ? ["onset"] : [] },
    presentIllness: answered.filter((s) => !past.has(s.id)).map(line),
    pastHistory: answered.filter((s) => past.has(s.id)).map(line),
    // No diagnosis offline; the tests come straight from the top retrieved guideline passages.
    forDoctor: {
      possibleCauses: [],
      suggestedTests: ctx.passages
        .filter((g) => g.suggests)
        .slice(0, 2)
        .map((g) => ({ ...g.suggests!, sources: [g.id] })),
    },
  };
}

const HANDLERS: Record<Task, (ctx: never) => unknown> = {
  extract: mockExtract as (ctx: never) => unknown,
  triage: (): TriageOutput => ({ level: 4, reason: "离线模式：由规则判断危险等级" }),
  phrase: ((ctx: { slots: Slot[] }): PhraseOutput => ({ questions: ctx.slots.map((s) => s.question) })) as (ctx: never) => unknown,
  note: mockNote as (ctx: never) => unknown,
  review: (): ReviewOutput => ({ pass: true, issues: [] }),
};

export function createMockLLM(overrides: Partial<Record<Task, (ctx: never, n: number) => unknown>> = {}): LLM {
  const usage: UsageRecord[] = [];
  const counts: Partial<Record<Task, number>> = {};
  return {
    kind: "mock",
    usage,
    async invoke<T>(call: StructuredCall<T>): Promise<T> {
      call.signal?.throwIfAborted();
      const n = counts[call.task] ?? 0;
      counts[call.task] = n + 1;
      const out = overrides[call.task]
        ? overrides[call.task]!(call.context as never, n)
        : HANDLERS[call.task](call.context as never);
      usage.push({ task: call.task, model: "mock", inputTokens: 0, outputTokens: 0, ms: 0, consultationId: consultationScope.getStore() });
      return call.schema.parse(out);
    },
  };
}
