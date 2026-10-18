/**
 * Backend (Bedrock + LangGraph) evaluation on the 6 demo cases (issue #8).
 *
 *   npx tsx scripts/eval-backend.ts --mock            # offline: mock agent, scripted patient, mock judge
 *   BEDROCK_ACCESS_KEY_ID=... BEDROCK_SECRET_ACCESS_KEY=... AI_GATEWAY_API_KEY=... \
 *     npx tsx scripts/eval-backend.ts --runs 3
 *
 * The agent is the backend ConsultationService on Bedrock (Anthropic models).
 * The simulated patient and the judge run through Vercel AI Gateway on two
 * other model families, so neither shares a family with the agent or each
 * other. The judge scores the draft note against the conversation that
 * actually happened (completeness, accuracy, unsupported statements), not
 * against a reference diagnosis: the backend writes no diagnosis.
 *
 * Per consultation it records calls, tokens, cost (llm.ts PRICE_PER_MTOK),
 * model time and wall-clock latency, rounds, and grounding rejects.
 *
 * Guideline citations (#12): the retrieval hit rate against
 * evals/guidelines/relevance.json, citation coverage (share of doctor-facing
 * suggestions that cite a retrieved passage) and citation accuracy (share of
 * cited suggestion–passage pairs where the passage supports the suggestion,
 * decided by the judge; offline, by word overlap).
 *
 * --phrasing template asks the template wording instead of the model rewrite
 * (#10: run both and compare before dropping the rewrite step).
 *
 * Flags: --mock  --patient <gateway id>  --judge <gateway id>  --runs <n>  --phrasing model|template
 *        --cases id1,id2  --out <dir>  --label <tag suffix>
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { MEDICAL_CASES, type MedicalCase } from "../src/data/cases";
import { createGatewayChatModel, createGatewayLLM } from "../src/lib/agent/llm";
import { createLLMPatient, createScriptedPatient, openingLine } from "../src/lib/agent/patient";
import type { Turn } from "../src/lib/agent/schemas";
import { createCheckpointer, createLLM, loadConfig } from "../backend/src/config";
import { guidelineById } from "../backend/src/guidelines";
import type { UsageSummary } from "../backend/src/llm";
import type { NoteOutput } from "../backend/src/schemas";
import { normalize } from "../shared/safety/grounding";
import { createMockLLM } from "../backend/src/mock-llm";
import { ConsultationService, type ConsultationView } from "../backend/src/service";
import { writeEvalOutput } from "./lib/eval-output";

const { values: args } = parseArgs({
  options: {
    mock: { type: "boolean", default: false },
    patient: { type: "string", default: "openai/gpt-4o-mini" },
    judge: { type: "string", default: "deepseek/deepseek-chat" },
    runs: { type: "string", default: "1" },
    phrasing: { type: "string", default: "model" },
    cases: { type: "string" },
    out: { type: "string", default: "docs/agent/eval" },
    label: { type: "string" },
  },
});

const MOCK = args.mock;
const AGENT_FAMILY = "anthropic"; // Bedrock serves Claude
const family = (id: string) => id.split("/")[0];
if (!MOCK) {
  const families = [AGENT_FAMILY, family(args.patient!), family(args.judge!)];
  if (new Set(families).size !== 3) {
    console.error(`Agent, patient and judge must be three different model families; got ${families.join(", ")}.`);
    process.exit(1);
  }
  if (!process.env.AI_GATEWAY_API_KEY) {
    console.error("AI_GATEWAY_API_KEY is not set (needed for the patient and the judge). Pass --mock for an offline harness check.");
    process.exit(1);
  }
}

const cases = args.cases ? MEDICAL_CASES.filter((c) => args.cases!.split(",").includes(c.id)) : MEDICAL_CASES;
const RUNS = Number(args.runs);

// ---- judge ------------------------------------------------------------------

const judgeSchema = z.object({
  completeness: z.number().min(0).max(100).describe("病历覆盖了对话里患者提供的多少临床信息（0-100）"),
  accuracy: z.number().min(0).max(100).describe("病历的陈述与患者原话一致的程度（0-100）"),
  unsupported: z.array(z.string()).describe("病历中在对话里找不到依据的陈述，逐条列出"),
  comments: z.string(),
});
type JudgeOutput = z.infer<typeof judgeSchema>;

const JUDGE_SYSTEM = `你是门诊病历质控医生。下面给你一段 AI 预问诊的对话和它写出的病历草稿。
只对照这段对话评价病历，不要用你自己对疾病的判断：
- completeness：患者在对话里说出的症状、时间、诱因、伴随症状、既往史等，病历记录了多少；
- accuracy：病历中的每条陈述是否都能在患者的话里找到依据，有没有改变原意（比如把否认写成阳性）；
- unsupported：逐条列出在对话中找不到依据的陈述。`;

async function llmJudge(transcript: Turn[], note: string): Promise<JudgeOutput> {
  const chat = createGatewayChatModel(args.judge!, { maxTokens: 1200 });
  const runnable = chat.withStructuredOutput(judgeSchema, { name: "judge", method: "functionCalling" });
  const dialogue = transcript.map((t) => `${t.role === "patient" ? "患者" : "问诊助手"}：${t.content}`).join("\n");
  return runnable.invoke([
    { role: "system", content: JUDGE_SYSTEM },
    { role: "user", content: `对话：\n${dialogue}\n\n病历草稿：\n${note}` },
  ]);
}

/** Offline judge: share of patient clauses that reach the note. Measures the harness, not quality. */
function mockJudge(transcript: Turn[], note: string): JudgeOutput {
  const clauses = transcript
    .filter((t) => t.role === "patient")
    .flatMap((t) => t.content.split(/[，。！？,.!?；;\n]/))
    .map((x) => x.trim())
    .filter((x) => x.length >= 2 && !/不太清楚|不知道|不清楚/.test(x));
  const covered = clauses.filter((x) => note.includes(x)).length;
  return { completeness: clauses.length ? Math.round((100 * covered) / clauses.length) : 100, accuracy: 100, unsupported: [], comments: "mock judge" };
}

// ---- guideline citations (#12) --------------------------------------------------

const RELEVANT: Record<string, string[]> = JSON.parse(readFileSync("evals/guidelines/relevance.json", "utf8"));

interface CitationResult {
  retrieved: string[];
  /** Retrieved passages that are labelled relevant to the case. */
  relevantRetrieved: number;
  relevantTotal: number;
  suggestions: number;
  /** Suggestions citing at least one retrieved passage. */
  cited: number;
  pairs: { suggestion: string; passage: string; supported: boolean }[];
}

const citationJudgeSchema = z.object({
  verdicts: z.array(z.object({ index: z.number().int(), supported: z.boolean() })).describe("每一对一个判断，index 与输入编号对应"),
});

async function judgePairs(pairs: { suggestion: string; passage: string }[]): Promise<boolean[]> {
  if (pairs.length === 0) return [];
  if (MOCK) {
    // Offline: supported when enough of the suggestion name's character bigrams appear in the passage.
    // A rough harness check only; the real judge decides in a Bedrock run.
    return pairs.map(({ suggestion, passage }) => {
      const s = normalize(suggestion.replace(/[（：].*$/, ""));
      const p = normalize(passage);
      const grams = Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2));
      return grams.length > 0 && grams.filter((g) => p.includes(g)).length / grams.length >= 0.4;
    });
  }
  const chat = createGatewayChatModel(args.judge!, { maxTokens: 800 });
  const runnable = chat.withStructuredOutput(citationJudgeSchema, { name: "citations", method: "functionCalling" });
  const out = await runnable.invoke([
    { role: "system", content: "你是临床指南审核医生。逐对判断：给出的指南片段是否直接支持这条给医生的建议（可能原因或建议检查）。只看片段本身，不要用片段以外的知识。" },
    { role: "user", content: pairs.map((x, i) => `${i}. 建议：${x.suggestion}\n   指南片段：${x.passage}`).join("\n") },
  ]);
  return pairs.map((_, i) => out.verdicts.find((v) => v.index === i)?.supported ?? false);
}

async function citations(caseId: string, note: NoteOutput | null, retrieved: string[]): Promise<CitationResult> {
  const relevant = RELEVANT[caseId] ?? [];
  const items = note
    ? [
        ...note.forDoctor.possibleCauses.map((x) => ({ text: `${x.name}：${x.reasoning}`, sources: x.sources })),
        ...note.forDoctor.suggestedTests.map((x) => ({ text: `${x.name}（${x.purpose}）`, sources: x.sources })),
      ]
    : [];
  const pairs = items.flatMap((x) =>
    x.sources.filter((id) => retrieved.includes(id)).map((id) => ({ suggestion: x.text, passage: guidelineById(id)?.text ?? "" })),
  );
  const verdicts = await judgePairs(pairs);
  return {
    retrieved,
    relevantRetrieved: retrieved.filter((id) => relevant.includes(id)).length,
    relevantTotal: relevant.length,
    suggestions: items.length,
    cited: items.filter((x) => x.sources.some((id) => retrieved.includes(id))).length,
    pairs: pairs.map((x, i) => ({ ...x, supported: verdicts[i] })),
  };
}

// ---- one consultation ------------------------------------------------------------

interface Result {
  caseId: string;
  run: number;
  ok: boolean;
  error?: string;
  status?: ConsultationView["status"];
  rounds?: number;
  level?: string;
  record?: ConsultationView["record"];
  groundingRejects?: number;
  usage?: UsageSummary;
  wallMs: number;
  judge?: JudgeOutput;
  citations?: CitationResult;
  transcript?: Turn[];
  output?: string;
}

function agentService(): ConsultationService {
  const db = path.join(mkdtempSync(path.join(tmpdir(), "eval-backend-")), "db.sqlite");
  const llm = MOCK ? createMockLLM() : createLLM(loadConfig({ ...process.env, AGENT_LLM: "bedrock" }));
  return new ConsultationService(llm, createCheckpointer(db), undefined, undefined, { phrasing: args.phrasing === "template" ? "template" : "model" });
}

async function consult(service: ConsultationService, c: MedicalCase, run: number): Promise<Result> {
  const started = Date.now();
  // The patient has its own LLM instance, so its tokens are not billed to the agent.
  const patient = MOCK ? createScriptedPatient(c) : createLLMPatient(c, createGatewayLLM(args.patient!));
  let rejects = 0;
  const countRejects = (v: ConsultationView) => {
    for (const t of v.trace) rejects += Number(/丢弃 (\d+) 条/.exec(t.summary)?.[1] ?? 0);
  };
  try {
    let v = await service.start(openingLine(c), "eval");
    countRejects(v);
    while (v.status === "awaiting_answer") {
      const transcript = (await service.state(v.id)).transcript as Turn[];
      const questions = (v.question ?? "").split(/(?<=[？?])\s*/).filter(Boolean);
      v = await service.answer(v.id, await patient(transcript, questions), "eval");
      countRejects(v);
    }
    const state = await service.state(v.id);
    const transcript = state.transcript as Turn[];
    const note = v.output ?? "";
    const judge = MOCK ? mockJudge(transcript, note) : await llmJudge(transcript, note);
    const cites = await citations(c.id, state.note, state.guidelineIds);
    return {
      caseId: c.id, run, ok: true, status: v.status, rounds: v.rounds, level: v.level, record: v.record,
      groundingRejects: rejects, usage: service.usageFor(v.id), wallMs: Date.now() - started, judge, citations: cites, transcript, output: note,
    };
  } catch (err) {
    return { caseId: c.id, run, ok: false, error: err instanceof Error ? err.message : String(err), wallMs: Date.now() - started };
  }
}

// ---- summary ------------------------------------------------------------------

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const fmt = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "—");

function summarize(results: Result[]): string {
  const ok = results.filter((r) => r.ok);
  const costs = ok.map((r) => r.usage!.costUsd);
  const cost = costs.every((c) => c !== null) ? `$${fmt(mean(costs as number[]), 4)}` : "—（含未定价模型）";
  const lines = [
    "| 成功/总数 | 完整性 | 准确性 | 无依据陈述（条/次） | 平均轮数 | 原话校验丢弃（条/次） | 模型调用 | 输入 tokens | 输出 tokens | 成本/次 | 模型耗时 | 端到端耗时 |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    `| ${ok.length}/${results.length} | **${fmt(mean(ok.map((r) => r.judge!.completeness)))}** | **${fmt(mean(ok.map((r) => r.judge!.accuracy)))}** | ${fmt(mean(ok.map((r) => r.judge!.unsupported.length)))} | ${fmt(mean(ok.map((r) => r.rounds!)))} | ${fmt(mean(ok.map((r) => r.groundingRejects!)))} | ${fmt(mean(ok.map((r) => r.usage!.calls)))} | ${fmt(mean(ok.map((r) => r.usage!.inputTokens)), 0)} | ${fmt(mean(ok.map((r) => r.usage!.outputTokens)), 0)} | ${cost} | ${fmt(mean(ok.map((r) => r.usage!.ms)) / 1000)}s | ${fmt(mean(ok.map((r) => r.wallMs)) / 1000)}s |`,
    "",
    "| 病例 | 状态 | 等级 | 完整性 | 准确性 | 轮数 | 已答/不清楚/未问 | 丢弃 | 调用 |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const c of cases) {
    const rs = ok.filter((r) => r.caseId === c.id);
    lines.push(
      `| ${c.id} ${c.title} | ${[...new Set(rs.map((r) => r.status))].join("/")} | ${[...new Set(rs.map((r) => r.level))].join("/")} | ${fmt(mean(rs.map((r) => r.judge!.completeness)))} | ${fmt(mean(rs.map((r) => r.judge!.accuracy)))} | ${fmt(mean(rs.map((r) => r.rounds!)))} | ${rs.map((r) => `${r.record!.answered}/${r.record!.unknown}/${r.record!.unasked}`).join(", ")} | ${fmt(mean(rs.map((r) => r.groundingRejects!)))} | ${fmt(mean(rs.map((r) => r.usage!.calls)))} |`,
    );
  }
  const cs = ok.map((r) => r.citations!).filter((x) => x.suggestions > 0 || x.retrieved.length > 0);
  const sum = (f: (x: CitationResult) => number) => cs.reduce((n, x) => n + f(x), 0);
  const rate = (a: number, b: number) => (b ? `${fmt((100 * a) / b)}%` : "—");
  lines.push(
    "",
    "指南引用（#12）：",
    "",
    "| 检索命中（至少一条相关） | 相关片段召回 | 建议条数 | 引用覆盖率 | 引用对数 | **引用准确率** |",
    "|---|---|---|---|---|---|",
    `| ${rate(cs.filter((x) => x.relevantRetrieved > 0).length, cs.length)} | ${rate(sum((x) => x.relevantRetrieved), sum((x) => x.relevantTotal))} | ${sum((x) => x.suggestions)} | ${rate(sum((x) => x.cited), sum((x) => x.suggestions))} | ${sum((x) => x.pairs.length)} | **${rate(sum((x) => x.pairs.filter((p) => p.supported).length), sum((x) => x.pairs.length))}** |`,
  );
  const failed = results.filter((r) => !r.ok);
  if (failed.length) lines.push("", "失败：", "", ...failed.map((r) => `- ${r.caseId} run${r.run}: ${r.error}`));
  return lines.join("\n");
}

async function main() {
  const service = agentService();
  const results: Result[] = [];
  for (let run = 1; run <= RUNS; run++) {
    for (const c of cases) {
      const r = await consult(service, c, run);
      results.push(r);
      console.log(`${r.ok ? "✓" : "✗"} ${r.caseId} run${run} ${r.ok ? `${r.status} completeness=${r.judge!.completeness} calls=${r.usage!.calls}` : r.error}`);
    }
  }
  const stamp = new Date().toISOString().slice(0, 10);
  const tag = `${MOCK ? "mock" : "bedrock"}${args.phrasing === "template" ? "-template" : ""}${args.label ? `-${args.label}` : ""}-${stamp}`;
  const meta = {
    date: new Date().toISOString(),
    mode: MOCK ? "mock" : "bedrock",
    agent: MOCK ? "mock" : `bedrock (${loadConfig({ ...process.env, AGENT_LLM: "bedrock" }).fastModelId} / ${loadConfig({ ...process.env, AGENT_LLM: "bedrock" }).smartModelId})`,
    patient: MOCK ? "scripted" : args.patient,
    judge: MOCK ? "mock" : args.judge,
    runs: RUNS,
    phrasing: args.phrasing,
    cases: cases.map((c) => c.id),
  };
  const summary = `# Backend eval ${tag}\n\n${MOCK ? "> ⚠️ 离线 mock：agent、患者、裁判都是确定性替身，只验证评测流程，**不代表模型水平**。\n\n" : ""}- agent：${meta.agent}\n- 模拟患者：${meta.patient}\n- 裁判：${meta.judge}\n- 每个病例运行次数：${RUNS}\n\n${summarize(results)}\n`;
  const files = writeEvalOutput({ dir: args.out!, tag, prefix: "backend-", meta, results, summary });
  console.log(`\n${summary}\nwrote ${files.json} and ${files.md}`);
}

main();
