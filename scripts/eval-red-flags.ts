/**
 * Danger-signal evaluation over evals/red-flags/cases.json (issue #8, shared with #4).
 *
 *   npx tsx scripts/eval-red-flags.ts --rules [--label baseline]   # deterministic, offline, both agents
 *   npx tsx scripts/eval-red-flags.ts --model --mock                 # backend triage, offline mock (harness check)
 *   BEDROCK_ACCESS_KEY_ID=... BEDROCK_SECRET_ACCESS_KEY=... npx tsx scripts/eval-red-flags.ts --model
 *
 * --rules  runs each agent's rule matcher over the patient turns and reports
 *          recall on red flags its rule table covers, false positives on
 *          explicit denials and routine complaints, and coverage gaps.
 * --model  runs the backend triage step (Bedrock fast model + rules), as the
 *          graph does on the latest patient turn, and records level agreement,
 *          recall, false positives, calls, tokens and latency.
 *
 * Flags: --label <text>  --cases id1,id2  --out <dir>
 */
import { parseArgs } from "node:util";
import { RED_FLAG_CASES, type RedFlagCase } from "../evals/red-flags/cases";
import { matchPatientTurns as matchSrc, maxLevel } from "../src/lib/agent/red-flags";
import type { RiskLevel } from "../src/lib/agent/schemas";
import { matchPatientTurns as matchBackend, mostUrgent, type Level } from "../backend/src/triage";
import { loadConfig, createLLM } from "../backend/src/config";
import { createMockLLM } from "../backend/src/mock-llm";
import type { LLM } from "../backend/src/llm";
import { triagePrompt } from "../backend/src/prompts";
import { emptyRecord } from "../backend/src/record";
import { triageSchema } from "../backend/src/schemas";
import { chooseTemplate, slotsFor } from "../backend/src/templates";
import { writeEvalOutput } from "./lib/eval-output";

const { values: args } = parseArgs({
  options: {
    rules: { type: "boolean", default: false },
    model: { type: "boolean", default: false },
    mock: { type: "boolean", default: false },
    label: { type: "string" },
    cases: { type: "string" },
    out: { type: "string", default: "docs/agent/eval" },
  },
});

if (args.rules === args.model) {
  console.error("Pass exactly one of --rules or --model.");
  process.exit(1);
}

const cases = args.cases
  ? RED_FLAG_CASES.filter((c) => args.cases!.split(",").includes(c.id))
  : RED_FLAG_CASES;

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "—");
const stamp = new Date().toISOString().slice(0, 10);

// ---- rules mode --------------------------------------------------------------

interface RuleResult {
  id: string;
  kind: RedFlagCase["kind"];
  tags: string[];
  impl: "src" | "backend";
  expectedRule: string | null;
  hits: string[];
  level: string;
  expectedLevel: string;
  /** covered red flag: the expected rule fired. denial/routine: nothing fired. gap: nothing to score. */
  outcome: "hit" | "miss" | "ok" | "false_positive" | "gap_fired" | "gap_silent";
}

function scoreRules(c: RedFlagCase, impl: "src" | "backend"): RuleResult {
  const hits = impl === "src" ? matchSrc(c.turns) : matchBackend(c.turns);
  const level =
    impl === "src"
      ? maxLevel(...hits.map((h) => h.level as RiskLevel))
      : String(mostUrgent(...hits.map((h) => h.level as Level)));
  const expectedRule = impl === "src" ? c.expect.srcRule : c.expect.backendRule;
  const expectedLevel = String(impl === "src" ? c.expect.srcLevel : c.expect.backendLevel);
  const names = hits.map((h) => h.rule);
  let outcome: RuleResult["outcome"];
  if (c.kind === "redflag") {
    if (expectedRule === null) outcome = names.length ? "gap_fired" : "gap_silent";
    else outcome = names.includes(expectedRule) ? "hit" : "miss";
  } else {
    outcome = names.length ? "false_positive" : "ok";
  }
  return { id: c.id, kind: c.kind, tags: c.tags, impl, expectedRule, hits: names, level, expectedLevel, outcome };
}

function rulesSummary(results: RuleResult[]): string {
  const lines: string[] = [];
  lines.push("| 实现 | 危险信号召回（规则覆盖的） | 等级一致 | 明确否认误报 | 普通主诉误报 | 覆盖缺口（不计入召回） |");
  lines.push("|---|---|---|---|---|---|");
  for (const impl of ["src", "backend"] as const) {
    const rs = results.filter((r) => r.impl === impl);
    const covered = rs.filter((r) => r.outcome === "hit" || r.outcome === "miss");
    const hit = covered.filter((r) => r.outcome === "hit");
    const levelOk = covered.filter((r) => r.level === r.expectedLevel);
    const denials = rs.filter((r) => r.kind === "denial");
    const routine = rs.filter((r) => r.kind === "routine");
    const gaps = rs.filter((r) => r.outcome.startsWith("gap"));
    lines.push(
      `| ${impl === "src" ? "src（Next）" : "backend（Bedrock）"} | **${pct(hit.length, covered.length)}** (${hit.length}/${covered.length}) | ${pct(levelOk.length, covered.length)} | ${pct(denials.filter((r) => r.outcome === "false_positive").length, denials.length)} (${denials.filter((r) => r.outcome === "false_positive").length}/${denials.length}) | ${pct(routine.filter((r) => r.outcome === "false_positive").length, routine.length)} (${routine.filter((r) => r.outcome === "false_positive").length}/${routine.length}) | ${gaps.length} 条：${gaps.map((g) => g.id).join(", ") || "无"} |`,
    );
  }

  lines.push("", "按标签（危险信号召回 / 否认误报）：", "");
  const tags = [...new Set(results.flatMap((r) => r.tags))].sort();
  lines.push("| 标签 | src | backend |");
  lines.push("|---|---|---|");
  for (const tag of tags) {
    const cell = (impl: "src" | "backend") => {
      const rs = results.filter((r) => r.impl === impl && r.tags.includes(tag));
      const covered = rs.filter((r) => r.outcome === "hit" || r.outcome === "miss");
      const neg = rs.filter((r) => r.kind !== "redflag");
      const parts: string[] = [];
      if (covered.length) parts.push(`召回 ${covered.filter((r) => r.outcome === "hit").length}/${covered.length}`);
      if (neg.length) parts.push(`误报 ${neg.filter((r) => r.outcome === "false_positive").length}/${neg.length}`);
      return parts.join("，") || "—";
    };
    lines.push(`| ${tag} | ${cell("src")} | ${cell("backend")} |`);
  }

  const bad = results.filter((r) => r.outcome === "miss" || r.outcome === "false_positive");
  lines.push("", "漏报与误报：", "");
  if (!bad.length) lines.push("- 无");
  for (const r of bad) {
    const c = cases.find((x) => x.id === r.id)!;
    lines.push(
      `- ${r.impl} ${r.id} ${r.outcome === "miss" ? "漏报" : "误报"}：「${c.turns.join(" / ")}」 期望 ${r.expectedRule ?? "不触发"}，实际 ${r.hits.join("、") || "无"}`,
    );
  }
  return lines.join("\n");
}

function runRules() {
  const results = cases.flatMap((c) => [scoreRules(c, "src"), scoreRules(c, "backend")]);
  const tag = `rules-${args.label ? `${args.label}-` : ""}${stamp}`;
  const meta = { date: new Date().toISOString(), mode: "rules", label: args.label ?? null, cases: cases.length };
  const summary = `# 危险信号评测 ${tag}\n\n- 模式：规则（确定性，离线）\n- 用例：${cases.length} 条（${cases.filter((c) => c.kind === "redflag").length} 危险信号 / ${cases.filter((c) => c.kind === "denial").length} 明确否认 / ${cases.filter((c) => c.kind === "routine").length} 普通主诉）\n\n${rulesSummary(results)}\n`;
  const files = writeEvalOutput({ dir: args.out!, tag, prefix: "redflags-", meta, results, summary });
  console.log(`${summary}\nwrote ${files.json} and ${files.md}`);
}

// ---- model mode (backend triage) -----------------------------------------------

interface ModelResult {
  id: string;
  kind: RedFlagCase["kind"];
  tags: string[];
  expectedLevel: Level;
  modelLevel: Level | null;
  rules: string[];
  level: Level | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  error?: string;
}

/**
 * Level the backend should reach on this case. Where the backend has no rule for
 * the symptom, the expected level is still the clinical one (taken from the src
 * table), so a model that answers "4" on a fainting patient is a miss, not a match.
 */
function clinicalBackendLevel(c: RedFlagCase): Level {
  if (c.kind !== "redflag" || c.expect.backendRule !== null) return c.expect.backendLevel;
  return c.expect.srcLevel === "emergency" ? 2 : c.expect.srcLevel === "urgent" ? 3 : 4;
}

async function triageCase(llm: LLM, c: RedFlagCase): Promise<ModelResult> {
  const before = llm.usage.length;
  const template = chooseTemplate(c.turns[0]);
  const record = emptyRecord(slotsFor(template).map((s) => s.id));
  const latest = c.turns.at(-1)!;
  const base = { id: c.id, kind: c.kind, tags: c.tags, expectedLevel: clinicalBackendLevel(c) };
  const started = Date.now();
  try {
    // Same inputs and combination as the graph's triage node.
    const out = await llm.invoke({ task: "triage", schema: triageSchema, ...triagePrompt(template, record, latest), context: { text: latest } });
    const hits = matchBackend(c.turns);
    const used = llm.usage.slice(before);
    return {
      ...base,
      modelLevel: out.level as Level,
      rules: hits.map((h) => h.rule),
      level: mostUrgent(out.level as Level, ...hits.map((h) => h.level)),
      calls: used.length,
      inputTokens: used.reduce((n, u) => n + u.inputTokens, 0),
      outputTokens: used.reduce((n, u) => n + u.outputTokens, 0),
      ms: Date.now() - started,
    };
  } catch (err) {
    const used = llm.usage.slice(before);
    return {
      ...base, modelLevel: null, rules: [], level: null, calls: used.length,
      inputTokens: used.reduce((n, u) => n + u.inputTokens, 0),
      outputTokens: used.reduce((n, u) => n + u.outputTokens, 0),
      ms: Date.now() - started, error: err instanceof Error ? err.message : String(err),
    };
  }
}

function modelSummary(results: ModelResult[]): string {
  const ok = results.filter((r) => r.level !== null);
  const pos = ok.filter((r) => r.kind === "redflag");
  const neg = ok.filter((r) => r.kind !== "redflag");
  // A red flag is caught when the final level is at least as urgent as expected (lower is more urgent).
  const caught = (lvl: Level | null, r: ModelResult) => lvl !== null && lvl <= r.expectedLevel;
  const fp = (lvl: Level | null) => lvl !== null && lvl <= 2;
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const lines = [
    "| 指标 | 仅模型 | 模型 + 规则（图里实际用的） |",
    "|---|---|---|",
    `| 危险信号召回（等级不低于期望） | ${pct(pos.filter((r) => caught(r.modelLevel, r)).length, pos.length)} | **${pct(pos.filter((r) => caught(r.level, r)).length, pos.length)}** |`,
    `| 否认 + 普通主诉被判急诊（1–2 级） | ${pct(neg.filter((r) => fp(r.modelLevel)).length, neg.length)} | ${pct(neg.filter((r) => fp(r.level)).length, neg.length)} |`,
    `| 等级与期望完全一致 | ${pct(ok.filter((r) => r.modelLevel === r.expectedLevel).length, ok.length)} | ${pct(ok.filter((r) => r.level === r.expectedLevel).length, ok.length)} |`,
    "",
    `- 成功 ${ok.length}/${results.length}；平均每条 ${mean(ok.map((r) => r.calls)).toFixed(2)} 次调用，${mean(ok.map((r) => r.inputTokens)).toFixed(0)} 输入 / ${mean(ok.map((r) => r.outputTokens)).toFixed(0)} 输出 tokens，${(mean(ok.map((r) => r.ms)) / 1000).toFixed(2)}s`,
  ];
  const failed = results.filter((r) => r.level === null);
  if (failed.length) lines.push("", "失败：", "", ...failed.map((r) => `- ${r.id}: ${r.error}`));
  return lines.join("\n");
}

async function runModel() {
  let llm: LLM;
  let model: string;
  if (args.mock) {
    llm = createMockLLM();
    model = "mock";
  } else {
    const cfg = loadConfig({ ...process.env, AGENT_LLM: "bedrock" });
    llm = createLLM(cfg);
    model = cfg.fastModelId;
  }
  const results: ModelResult[] = [];
  for (const c of cases) {
    const r = await triageCase(llm, c);
    results.push(r);
    console.log(`${r.level === null ? "✗" : "✓"} ${r.id} model=${r.modelLevel} final=${r.level} expect=${r.expectedLevel}`);
  }
  const tag = `model-${args.mock ? "mock-" : ""}${args.label ? `${args.label}-` : ""}${stamp}`;
  const meta = { date: new Date().toISOString(), mode: args.mock ? "mock" : "bedrock", model, label: args.label ?? null, cases: cases.length };
  const summary = `# 危险信号评测 ${tag}\n\n${args.mock ? "> ⚠️ 离线 mock：模型恒定返回 4 级，只验证评测流程，**不代表模型水平**。\n\n" : ""}- 模式：backend 分级节点（模型 + 规则）\n- 模型：${model}\n- 用例：${cases.length} 条\n\n${modelSummary(results)}\n`;
  const files = writeEvalOutput({ dir: args.out!, tag, prefix: "redflags-", meta, results, summary });
  console.log(`\n${summary}\nwrote ${files.json} and ${files.md}`);
}

if (args.rules) runRules();
else runModel().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
