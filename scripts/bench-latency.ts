/**
 * Per-turn latency and cost of the backend graph (issue #10).
 *
 *   npx tsx scripts/bench-latency.ts                 # simulated Bedrock timing, offline
 *   npx tsx scripts/bench-latency.ts --label before  # tag the output files
 *   BEDROCK_ACCESS_KEY_ID=... BEDROCK_SECRET_ACCESS_KEY=... npx tsx scripts/bench-latency.ts --bedrock
 *
 * Offline it wraps the mock model so every call sleeps as long as a Bedrock call
 * of that size would take and is billed by estimated tokens:
 *   input tokens  = prompt + tool schema (1 per CJK char, 1 per 4 other chars) + 346 tool-use overhead
 *   output tokens = the returned JSON, same estimate
 *   latency       = time to first token + output tokens / output speed, per tier (PROFILE below)
 * The profile is an assumption, not a measurement, so absolute seconds are
 * indicative; call counts and calls on the critical path are exact. Graph
 * parallelism shows up because calls really sleep.
 *
 * Runs the 6 demo cases with the scripted patient, plus two emergencies (one in
 * the opening sentence, one in a later answer).
 *
 * Flags: --bedrock  --label <name>  --phrasing model|template  --out <dir>
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { MEDICAL_CASES } from "../src/data/cases";
import { createScriptedPatient, openingLine } from "../src/lib/agent/patient";
import type { Turn } from "../src/lib/agent/schemas";
import { createCheckpointer, createLLM, loadConfig } from "../backend/src/config";
import { consultationScope, summarizeUsage, TASK_TIER, type LLM, type UsageRecord } from "../backend/src/llm";
import { createMockLLM } from "../backend/src/mock-llm";
import { ConsultationService, type ConsultationView } from "../backend/src/service";
import { writeEvalOutput } from "./lib/eval-output";

const { values: args } = parseArgs({
  options: {
    bedrock: { type: "boolean", default: false },
    label: { type: "string", default: "current" },
    phrasing: { type: "string", default: "model" },
    out: { type: "string", default: "docs/agent/eval" },
  },
});

/** Assumed Bedrock timing per tier: seconds to first token, output tokens per second. */
const PROFILE = {
  fast: { model: "us.anthropic.claude-haiku-4-5-20251001-v1:0", ttft: 0.6, tps: 150 },
  smart: { model: "us.anthropic.claude-sonnet-4-6", ttft: 1.2, tps: 70 },
};
const TOOL_OVERHEAD = 346;

function estimateTokens(text: string): number {
  const cjk = (text.match(/[　-鿿＀-￯]/g) ?? []).length;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

function simulatedBedrock(): LLM {
  const inner = createMockLLM();
  const usage: UsageRecord[] = [];
  return {
    kind: "bedrock",
    usage,
    async invoke(call) {
      const tier = PROFILE[TASK_TIER[call.task]];
      const out = await inner.invoke(call);
      const schema = JSON.stringify(z.toJSONSchema(call.schema));
      const inputTokens = estimateTokens(call.system + call.user + schema) + TOOL_OVERHEAD;
      const outputTokens = estimateTokens(JSON.stringify(out)) + 20;
      const ms = Math.round((tier.ttft + outputTokens / tier.tps) * 1000);
      await new Promise((r) => setTimeout(r, ms));
      usage.push({ task: call.task, model: tier.model, inputTokens, outputTokens, ms, consultationId: consultationScope.getStore() });
      return out;
    },
  };
}

interface TurnResult {
  kind: "first" | "follow-up" | "final";
  wallMs: number;
  calls: number;
  costUsd: number;
}

interface ScenarioResult {
  id: string;
  status: ConsultationView["status"];
  turns: TurnResult[];
  calls: number;
  costUsd: number;
  inputTokensByTask: Record<string, number>;
}

type Step = (v: ConsultationView) => Promise<string>;

async function scenario(service: ConsultationService, id: string, opening: string, reply: Step): Promise<ScenarioResult> {
  const turns: TurnResult[] = [];
  let before = { calls: 0, cost: 0 };
  const measure = async (kind: TurnResult["kind"], run: () => Promise<ConsultationView>) => {
    const t = Date.now();
    const v = await run();
    const u = service.usageFor(v.id);
    turns.push({ kind: v.status === "awaiting_answer" ? kind : "final", wallMs: Date.now() - t, calls: u.calls - before.calls, costUsd: (u.costUsd ?? 0) - before.cost });
    before = { calls: u.calls, cost: u.costUsd ?? 0 };
    return v;
  };
  let v = await measure("first", () => service.start(opening, "bench"));
  while (v.status === "awaiting_answer") {
    const text = await reply(v);
    const cur = v;
    v = await measure("follow-up", () => service.answer(cur.id, text, "bench"));
  }
  const records = service.usage.filter((r) => r.consultationId === v.id);
  const inputTokensByTask: Record<string, number> = {};
  for (const r of records) inputTokensByTask[r.task] = Math.max(inputTokensByTask[r.task] ?? 0, r.inputTokens);
  const total = summarizeUsage(records);
  return { id, status: v.status, turns, calls: total.calls, costUsd: total.costUsd ?? 0, inputTokensByTask };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : NaN;
};
const sec = (ms: number) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(2)}s` : "—");

function summarize(results: ScenarioResult[]): string {
  const turns = results.flatMap((r) => r.turns);
  const byKind = (k: TurnResult["kind"]) => turns.filter((t) => t.kind === k);
  const row = (name: string, ts: TurnResult[]) =>
    `| ${name} | ${ts.length} | ${sec(mean(ts.map((t) => t.wallMs)))} | ${sec(pct(ts.map((t) => t.wallMs), 90))} | ${mean(ts.map((t) => t.calls)).toFixed(2)} | $${mean(ts.map((t) => t.costUsd)).toFixed(5)} |`;
  const maxTokens: Record<string, number> = {};
  for (const r of results) for (const [k, n] of Object.entries(r.inputTokensByTask)) maxTokens[k] = Math.max(maxTokens[k] ?? 0, n);
  const lines = [
    "| 轮次 | 次数 | 平均耗时 | P90 耗时 | 模型调用/轮 | 成本/轮 |",
    "|---|---|---|---|---|---|",
    row("首轮（主诉）", byKind("first")),
    row("追问轮", byKind("follow-up")),
    row("结束轮（写病历或急诊）", byKind("final")),
    "",
    "| 场景 | 结果 | 轮数 | 模型调用 | 成本/次 |",
    "|---|---|---|---|---|",
    ...results.map((r) => `| ${r.id} | ${r.status} | ${r.turns.length} | ${r.calls} | $${r.costUsd.toFixed(4)} |`),
    `| **平均** | | ${mean(results.map((r) => r.turns.length)).toFixed(1)} | ${mean(results.map((r) => r.calls)).toFixed(1)} | $${mean(results.map((r) => r.costUsd)).toFixed(4)} |`,
    "",
    `单次调用的最大输入 tokens（估算）：${Object.entries(maxTokens).map(([k, n]) => `${k} ${n}`).join("，")}`,
  ];
  return lines.join("\n");
}

async function main() {
  const db = path.join(mkdtempSync(path.join(tmpdir(), "bench-")), "db.sqlite");
  const llm = args.bedrock ? createLLM(loadConfig({ ...process.env, AGENT_LLM: "bedrock" })) : simulatedBedrock();
  const service = new ConsultationService(llm, createCheckpointer(db), undefined, undefined, {
    phrasing: args.phrasing === "template" ? "template" : "model",
  });
  const results: ScenarioResult[] = [];

  for (const c of MEDICAL_CASES) {
    const patient = createScriptedPatient(c);
    const reply: Step = async (v) => {
      const transcript = (await service.state(v.id)).transcript as Turn[];
      return patient(transcript, (v.question ?? "").split(/(?<=[？?])\s*/).filter(Boolean));
    };
    results.push(await scenario(service, c.id, openingLine(c), reply));
    console.log(`✓ ${c.id}`);
  }
  results.push(await scenario(service, "emergency-opening", "医生，我胸口痛了一个小时，一直出大汗，喘不上气", async () => "不清楚"));
  results.push(await scenario(service, "emergency-later", "我头痛一周了", async () => "刚才突然嘴歪了，说话不清楚"));
  console.log("✓ emergencies");

  const stamp = new Date().toISOString().slice(0, 10);
  const tag = `${args.bedrock ? "bedrock" : "simulated"}-${args.label}-${stamp}`;
  const meta = {
    date: new Date().toISOString(),
    mode: args.bedrock ? "bedrock" : "simulated",
    label: args.label,
    profile: args.bedrock ? null : PROFILE,
  };
  const note = args.bedrock
    ? ""
    : `> 模拟计时：每次模型调用按 PROFILE 假设的首字延迟和输出速度真实等待（快档 ${PROFILE.fast.ttft}s + ${PROFILE.fast.tps} tok/s，慢档 ${PROFILE.smart.ttft}s + ${PROFILE.smart.tps} tok/s），tokens 按字符估算、按 Haiku 4.5 / Sonnet 4.6 标价计费。调用次数是准确的，秒数和美元是估算。\n\n`;
  const summary = `# Latency bench ${tag}\n\n${note}${summarize(results)}\n`;
  const files = writeEvalOutput({ dir: args.out!, tag, prefix: "latency-", meta, results, summary });
  console.log(`\n${summary}\nwrote ${files.json} and ${files.md}`);
}

main();
