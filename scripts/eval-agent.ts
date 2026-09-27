/**
 * Phase 4 evaluation: does letting the agent interview a patient beat a
 * single model call?
 *
 * Conditions, per case and run:
 *   A  one-shot, full dialogue      — what /consultation does today (upper bound on information)
 *   B  one-shot, chief complaint     — same information the agent starts with
 *   C  agent + simulated patient     — starts from the chief complaint, must ask for the rest
 *
 * All three are scored by the same LLM judge against the case's reference answer.
 *
 *   npx tsx scripts/eval-agent.ts --mock                 # offline: validates the harness only
 *   AI_GATEWAY_API_KEY=... npx tsx scripts/eval-agent.ts --model gpt-4o-mini --runs 3
 *
 * Flags: --mock  --model <id from src/data/models.ts>  --judge <gateway id>
 *        --runs <n>  --cases id1,id2  --concurrency <n>  --out <dir>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { generateText, type LanguageModel } from "ai";
import { gateway } from "@ai-sdk/gateway";
import { MockLanguageModelV3 } from "ai/test";
import { MEDICAL_CASES, type MedicalCase } from "../src/data/cases";
import { getModelById } from "../src/data/models";
import { MEDICAL_CONSULTATION_PROMPT, buildConsultationPrompt } from "../src/lib/prompts";
import { judgeTotal, scoreDiagnosis, type JudgeScore } from "../src/lib/scoring";
import { createGatewayLLM } from "../src/lib/agent/llm";
import { createMockLLM, mockRecordFromText } from "../src/lib/agent/mock-llm";
import { createLLMPatient, createScriptedPatient, openingLine } from "../src/lib/agent/patient";
import { runToCompletion } from "../src/lib/agent/run";
import { normalize } from "../src/lib/agent/grounding";
import type { Turn } from "../src/lib/agent/schemas";

const { values: args } = parseArgs({
  options: {
    mock: { type: "boolean", default: false },
    model: { type: "string", default: "gpt-4o-mini" },
    judge: { type: "string", default: "openai/gpt-4o-mini" },
    runs: { type: "string", default: "1" },
    cases: { type: "string" },
    concurrency: { type: "string", default: "3" },
    out: { type: "string", default: "docs/agent/eval" },
  },
});

const MOCK = args.mock;
if (!MOCK && !process.env.AI_GATEWAY_API_KEY) {
  console.error("AI_GATEWAY_API_KEY is not set. Pass --mock for an offline harness check.");
  process.exit(1);
}
const modelInfo = getModelById(args.model!);
if (!modelInfo) throw new Error(`Unknown model ${args.model}; see src/data/models.ts`);
const RUNS = Number(args.runs);
const cases = args.cases
  ? MEDICAL_CASES.filter((c) => args.cases!.split(",").includes(c.id))
  : MEDICAL_CASES;

// ---- models ---------------------------------------------------------------

function mockTextModel(): LanguageModel {
  return new MockLanguageModelV3({
    doGenerate: async (opts) => {
      const text = JSON.stringify(opts.prompt);
      return {
        content: [{ type: "text", text: mockRecordFromText(text) }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
}

const oneShotModel: LanguageModel = MOCK ? mockTextModel() : gateway(modelInfo.gatewayId);
const judgeModel: LanguageModel | null = MOCK ? null : gateway(args.judge!);

/** Offline judge: keyword overlap with the reference answer. Measures the harness, not medicine. */
function mockJudge(c: MedicalCase, text: string): JudgeScore {
  const has = (s: string) => text.includes(s.replace(/（.*?）/g, ""));
  const e = c.expectedDiagnosis;
  const frac = (xs: string[]) => (xs.length ? xs.filter(has).length / xs.length : 0);
  const headings = ["主诉", "现病史", "既往史", "辅助检查", "初步诊断", "鉴别诊断", "处置建议"];
  return {
    accuracy: Math.round((has(e.mainDiagnosis) ? 70 : 20) + 30 * frac(e.differentialDiagnosis)),
    completeness: Math.round(100 * headings.filter((h) => text.includes(h)).length / headings.length),
    standardization: 70,
    recommendation: Math.round(100 * (frac(e.recommendedTests) + frac(e.recommendedMedications)) / 2),
    comments: "mock judge",
  };
}

async function judge(c: MedicalCase, text: string): Promise<JudgeScore> {
  return judgeModel ? scoreDiagnosis(c, text, judgeModel) : mockJudge(c, text);
}

// ---- conditions ---------------------------------------------------------

interface Result {
  caseId: string;
  run: number;
  condition: "A_full" | "B_cold" | "C_agent";
  ok: boolean;
  error?: string;
  scores?: JudgeScore;
  total?: number;
  ms: number;
  tokens: number;
  calls: number;
  agent?: {
    askRounds: number;
    questions: number;
    facts: number;
    droppedFacts: number;
    checkFailures: number;
    riskLevel: string;
    status: string;
    infoRecall: number;
    transcript: Turn[];
  };
  output?: string;
}

async function oneShot(c: MedicalCase, run: number, cold: boolean): Promise<Result> {
  const condition = cold ? "B_cold" : "A_full";
  const started = Date.now();
  try {
    const dialogue = cold ? [{ role: "patient" as const, content: openingLine(c) }] : c.dialogueHistory;
    const res = await generateText({
      model: oneShotModel,
      system: MEDICAL_CONSULTATION_PROMPT,
      prompt: buildConsultationPrompt(dialogue),
      maxOutputTokens: 2000,
    });
    const ms = Date.now() - started;
    const scores = await judge(c, res.text);
    return {
      caseId: c.id, run, condition, ok: true, scores, total: judgeTotal(scores), ms,
      tokens: (res.usage.inputTokens ?? 0) + (res.usage.outputTokens ?? 0), calls: 1, output: res.text,
    };
  } catch (err) {
    return { caseId: c.id, run, condition, ok: false, error: String(err), ms: Date.now() - started, tokens: 0, calls: 0 };
  }
}

/** Share of the case's patient lines whose content surfaced in the agent's interview. */
function infoRecall(c: MedicalCase, transcript: Turn[]): number {
  const said = normalize(transcript.filter((t) => t.role === "patient").map((t) => t.content).join(""));
  const lines = c.dialogueHistory.filter((t) => t.role === "patient").slice(1); // first line ≈ chief complaint
  const revealed = lines.filter((l) => {
    const n = normalize(l.content);
    const grams = Array.from({ length: Math.max(0, n.length - 1) }, (_, i) => n.slice(i, i + 2));
    const hit = grams.filter((g) => said.includes(g)).length;
    return grams.length > 0 && hit / grams.length >= 0.5;
  });
  return lines.length ? revealed.length / lines.length : 1;
}

async function agent(c: MedicalCase, run: number): Promise<Result> {
  const started = Date.now();
  const llm = MOCK ? createMockLLM() : createGatewayLLM(modelInfo!.gatewayId);
  // The patient gets its own LLM instance so its tokens are not billed to the agent.
  const patient = MOCK ? createScriptedPatient(c) : createLLMPatient(c, createGatewayLLM(modelInfo!.gatewayId));
  try {
    const { state, usage } = await runToCompletion(
      { llm, mode: "simulated", patient },
      [{ role: "patient", content: openingLine(c) }],
    );
    const ms = Date.now() - started;
    const agentTurns = state.transcript.filter((t) => t.role === "agent");
    const scores = await judge(c, state.report);
    return {
      caseId: c.id, run, condition: "C_agent", ok: true, scores, total: judgeTotal(scores), ms,
      tokens: usage.reduce((n, u) => n + u.inputTokens + u.outputTokens, 0),
      calls: usage.length,
      agent: {
        askRounds: agentTurns.length,
        questions: agentTurns.reduce((n, t) => n + t.content.split(/[？?]/).filter((q) => q.trim()).length, 0),
        facts: state.facts.length,
        droppedFacts: state.droppedFacts.length,
        checkFailures: state.checkFailures,
        riskLevel: state.redFlag?.level ?? "n/a",
        status: state.status,
        infoRecall: infoRecall(c, state.transcript),
        transcript: state.transcript,
      },
      output: state.report,
    };
  } catch (err) {
    return { caseId: c.id, run, condition: "C_agent", ok: false, error: String(err), ms: Date.now() - started, tokens: 0, calls: 0 };
  }
}

// ---- run --------------------------------------------------------------------

async function pool<T>(jobs: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, jobs.length) }, async () => {
      while (next < jobs.length) {
        const i = next++;
        out[i] = await jobs[i]();
        const r = out[i] as unknown as Result;
        console.log(`${r.ok ? "✓" : "✗"} ${r.caseId} run${r.run} ${r.condition} ${r.total ?? r.error}`);
      }
    }),
  );
  return out;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const fmt = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "—");

function summarize(results: Result[]): string {
  const conds = ["A_full", "B_cold", "C_agent"] as const;
  const label = { A_full: "A 单次调用·完整对话", B_cold: "B 单次调用·仅主诉", C_agent: "C Agent·模拟患者" };
  const ok = results.filter((r) => r.ok);
  const lines: string[] = [];

  lines.push("| 条件 | 成功/总数 | 总分 | 准确性 | 完整性 | 规范性 | 建议 | 平均耗时 | 平均模型调用 | 平均 tokens |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const c of conds) {
    const rs = ok.filter((r) => r.condition === c);
    const all = results.filter((r) => r.condition === c);
    const s = (k: keyof Omit<JudgeScore, "comments">) => fmt(mean(rs.map((r) => r.scores![k])));
    lines.push(
      `| ${label[c]} | ${rs.length}/${all.length} | **${fmt(mean(rs.map((r) => r.total!)))}** | ${s("accuracy")} | ${s("completeness")} | ${s("standardization")} | ${s("recommendation")} | ${fmt(mean(rs.map((r) => r.ms)) / 1000)}s | ${fmt(mean(rs.map((r) => r.calls)))} | ${fmt(mean(rs.map((r) => r.tokens)), 0)} |`,
    );
  }

  lines.push("", "按病例（总分均值）：", "");
  lines.push("| 病例 | A 完整对话 | B 仅主诉 | C Agent | Agent 问出信息占比 | 追问轮数 | 自查打回 | 风险等级 |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const c of cases) {
    const byCond = (k: string) => ok.filter((r) => r.caseId === c.id && r.condition === k);
    const ag = byCond("C_agent");
    lines.push(
      `| ${c.id} ${c.title} | ${fmt(mean(byCond("A_full").map((r) => r.total!)))} | ${fmt(mean(byCond("B_cold").map((r) => r.total!)))} | ${fmt(mean(ag.map((r) => r.total!)))} | ${fmt(100 * mean(ag.map((r) => r.agent!.infoRecall)), 0)}% | ${fmt(mean(ag.map((r) => r.agent!.askRounds)))} | ${fmt(mean(ag.map((r) => r.agent!.checkFailures)))} | ${[...new Set(ag.map((r) => r.agent!.riskLevel))].join("/")} |`,
    );
  }

  const failures = results.filter((r) => !r.ok);
  if (failures.length) {
    lines.push("", "失败：", "", ...failures.map((f) => `- ${f.caseId} run${f.run} ${f.condition}: ${f.error}`));
  }
  return lines.join("\n");
}

async function main() {
  const jobs: (() => Promise<Result>)[] = [];
  for (let run = 1; run <= RUNS; run++) {
    for (const c of cases) {
      jobs.push(() => oneShot(c, run, false), () => oneShot(c, run, true), () => agent(c, run));
    }
  }
  const results = await pool(jobs, Number(args.concurrency));

  const stamp = new Date().toISOString().slice(0, 10);
  const tag = MOCK ? `mock-${stamp}` : `${args.model}-${stamp}`;
  mkdirSync(args.out!, { recursive: true });
  const meta = {
    date: new Date().toISOString(),
    mode: MOCK ? "mock" : "gateway",
    model: MOCK ? "mock" : modelInfo!.gatewayId,
    judge: MOCK ? "mock" : args.judge,
    runs: RUNS,
    cases: cases.map((c) => c.id),
  };
  writeFileSync(`${args.out}/results-${tag}.json`, JSON.stringify({ meta, results }, null, 2) + "\n");
  const summary = `# Eval ${tag}\n\n${MOCK ? "> ⚠️ 离线 mock 运行：模型、患者、裁判都是确定性替身，分数只验证评测流程能跑通，**不代表任何模型的真实水平**。\n\n" : ""}- 模型：${meta.model}\n- 裁判：${meta.judge}\n- 每个病例运行次数：${RUNS}\n\n${summarize(results)}\n`;
  writeFileSync(`${args.out}/summary-${tag}.md`, summary);
  console.log(`\n${summary}\nwrote ${args.out}/results-${tag}.json and summary-${tag}.md`);
}

main();
