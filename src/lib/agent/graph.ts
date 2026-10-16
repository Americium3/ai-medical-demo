import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { AgentLLM } from "./llm";
import { groundFacts, patientText } from "./grounding";
import { matchRedFlagRules, maxLevel } from "./red-flags";
import {
  askPrompt,
  differentialPrompt,
  intakePrompt,
  planPrompt,
  redFlagPrompt,
  selfCheckPrompt,
} from "./prompts";
import { renderEmergencyReport, renderReport } from "./report";
import {
  askOutputSchema,
  differentialOutputSchema,
  intakeOutputSchema,
  planOutputSchema,
  redFlagOutputSchema,
  selfCheckOutputSchema,
  type DifferentialOutput,
  type Fact,
  type IntakeOutput,
  type PlanOutput,
  type RedFlagResult,
  type SelfCheckIssue,
  type Turn,
} from "./schemas";

/** Rounds of follow-up questions before the agent must work with what it has. */
export const MAX_ASK_ROUNDS = 4;
/** Rewrites allowed after a failed self-check. */
export const MAX_REVISIONS = 2;

export type AgentStatus = "running" | "awaiting_patient" | "emergency" | "complete";

const overwrite = <T>(fallback: () => T) =>
  Annotation<T>({ reducer: (_, b) => b, default: fallback });

export const ConsultationState = Annotation.Root({
  transcript: Annotation<Turn[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  facts: overwrite<Fact[]>(() => []),
  droppedFacts: overwrite<IntakeOutput["facts"]>(() => []),
  missing: overwrite<IntakeOutput["missing"]>(() => []),
  enoughInfo: overwrite<boolean>(() => false),
  redFlag: overwrite<RedFlagResult | null>(() => null),
  pendingQuestions: overwrite<string[]>(() => []),
  differential: overwrite<DifferentialOutput | null>(() => null),
  plan: overwrite<PlanOutput | null>(() => null),
  selfCheckPassed: overwrite<boolean>(() => false),
  issues: overwrite<SelfCheckIssue[]>(() => []),
  checkFailures: overwrite<number>(() => 0),
  status: overwrite<AgentStatus>(() => "running"),
  report: overwrite<string>(() => ""),
});
export type ConsultationStateT = typeof ConsultationState.State;

/** Answers the agent's questions during an offline evaluation. */
export type PatientSimulator = (transcript: Turn[], questions: string[]) => Promise<string>;

export interface GraphDeps {
  llm: AgentLLM;
  /**
   * interactive: after asking, the graph ends and waits for the next request.
   * simulated: a simulated patient answers inside the graph, closing the loop.
   */
  mode: "interactive" | "simulated";
  patient?: PatientSimulator;
}

export function askRounds(transcript: Turn[]): number {
  return transcript.filter((t) => t.role === "agent").length;
}

export function buildConsultationGraph(deps: GraphDeps) {
  const { llm } = deps;
  if (deps.mode === "simulated" && !deps.patient) {
    throw new Error("simulated mode needs a patient simulator");
  }

  // ---- nodes --------------------------------------------------------------

  async function intake(s: ConsultationStateT) {
    const out = await llm.invoke({
      task: "intake",
      schema: intakeOutputSchema,
      ...intakePrompt(s.transcript),
      context: { transcript: s.transcript },
    });
    const { kept, dropped } = groundFacts(out.facts, s.transcript);
    return {
      facts: kept,
      droppedFacts: dropped,
      missing: out.missing,
      enoughInfo: out.enoughInfo && kept.length > 0,
    };
  }

  async function redFlagNode(s: ConsultationStateT) {
    const out = await llm.invoke({
      task: "red_flag",
      schema: redFlagOutputSchema,
      ...redFlagPrompt(s.facts),
      context: { facts: s.facts, transcript: s.transcript },
    });
    const ruleHits = matchRedFlagRules(patientText(s.transcript));
    const level = maxLevel(out.level, ...ruleHits.map((h) => h.level));
    const known = new Set(s.facts.map((f) => f.id));
    const redFlag: RedFlagResult = {
      ...out,
      level,
      flags: out.flags.map((f) => ({ ...f, factIds: f.factIds.filter((id) => known.has(id)) })),
      ruleHits,
      reason:
        level !== out.level
          ? `${out.reason}（规则兜底升级：${ruleHits.map((h) => h.rule).join("、")}）`
          : out.reason,
    };
    return { redFlag };
  }

  async function ask(s: ConsultationStateT) {
    const out = await llm.invoke({
      task: "ask",
      schema: askOutputSchema,
      ...askPrompt(s.transcript, s.missing),
      context: { transcript: s.transcript, missing: s.missing },
    });
    const asked = new Set(s.transcript.filter((t) => t.role === "agent").map((t) => t.content));
    let questions = out.questions
      .map((q) => q.trim())
      .filter((q) => q && ![...asked].some((a) => a.includes(q)))
      .slice(0, 2);
    if (questions.length === 0) questions = ["还有什么其他不舒服，或者想补充的吗？"];
    return {
      pendingQuestions: questions,
      transcript: [{ role: "agent" as const, content: questions.join(" ") }],
      status: deps.mode === "interactive" ? ("awaiting_patient" as const) : ("running" as const),
    };
  }

  async function patient(s: ConsultationStateT) {
    const answer = await deps.patient!(s.transcript, s.pendingQuestions);
    return {
      pendingQuestions: [],
      transcript: [{ role: "patient" as const, content: answer }],
    };
  }

  async function differential(s: ConsultationStateT) {
    const out = await llm.invoke({
      task: "differential",
      schema: differentialOutputSchema,
      ...differentialPrompt(s.facts, s.redFlag, s.issues, s.differential),
      context: { facts: s.facts, issues: s.issues, previous: s.differential, attempt: s.checkFailures },
    });
    return { differential: { ...out, differentials: out.differentials.slice(0, 4) } };
  }

  async function plan(s: ConsultationStateT) {
    const out = await llm.invoke({
      task: "plan",
      schema: planOutputSchema,
      ...planPrompt(s.facts, s.differential!),
      context: { facts: s.facts, differential: s.differential },
    });
    return { plan: out };
  }

  async function selfCheck(s: ConsultationStateT) {
    const dx = s.differential!;
    const p = s.plan!;
    const issues: SelfCheckIssue[] = [];

    // Deterministic checks first: cheap, exact, and not up to the model.
    const known = new Set(s.facts.map((f) => f.id));
    const cited = [dx.primary, ...dx.differentials].flatMap((d) => d.factIds);
    const unknown = [...new Set(cited.filter((id) => !known.has(id)))];
    if (unknown.length) {
      issues.push({
        type: "unknown_fact_id",
        detail: `引用了不存在的事实 ${unknown.join(", ")}，只能引用事实列表中的 id`,
      });
    }
    if (dx.primary.factIds.filter((id) => known.has(id)).length === 0) {
      issues.push({ type: "no_evidence", detail: `初步诊断「${dx.primary.name}」没有引用任何事实作为依据` });
    }
    if (s.redFlag?.level === "urgent") {
      const text = p.advice.join(" ");
      if (!/尽快|及时|就诊|专科|急诊|复诊/.test(text)) {
        issues.push({
          type: "missed_red_flag",
          detail: "风险等级为 urgent，但处置建议没有提示尽快就诊，请在 advice 中写明",
        });
      }
    }

    const out = await llm.invoke({
      task: "self_check",
      schema: selfCheckOutputSchema,
      ...selfCheckPrompt(s.facts, s.redFlag, dx, p),
      context: { facts: s.facts, redFlag: s.redFlag, differential: dx, plan: p, attempt: s.checkFailures },
    });
    issues.push(...out.issues);

    const passed = out.pass && issues.length === 0;
    return {
      selfCheckPassed: passed,
      issues,
      checkFailures: passed ? s.checkFailures : s.checkFailures + 1,
    };
  }

  function report(s: ConsultationStateT) {
    if (s.redFlag?.level === "emergency") {
      return { status: "emergency" as const, report: renderEmergencyReport(s.facts, s.redFlag) };
    }
    return {
      status: "complete" as const,
      report: renderReport({
        facts: s.facts,
        redFlag: s.redFlag,
        differential: s.differential!,
        plan: s.plan!,
        selfCheckPassed: s.selfCheckPassed,
        issues: s.issues,
        checkFailures: s.checkFailures,
      }),
    };
  }

  // ---- edges ----
  // Node names may not equal state keys, hence diagnose/care_plan/write_report.----------------------------------------------------------

  function afterRedFlag(s: ConsultationStateT) {
    if (s.redFlag?.level === "emergency") return "write_report";
    if (!s.enoughInfo && askRounds(s.transcript) < MAX_ASK_ROUNDS) return "ask";
    return "diagnose";
  }

  function afterAsk() {
    return deps.mode === "simulated" ? "patient" : END;
  }

  function afterSelfCheck(s: ConsultationStateT) {
    if (s.selfCheckPassed) return "write_report";
    return s.checkFailures <= MAX_REVISIONS ? "diagnose" : "write_report";
  }

  return new StateGraph(ConsultationState)
    .addNode("intake", intake)
    .addNode("red_flag", redFlagNode)
    .addNode("ask", ask)
    .addNode("patient", patient)
    .addNode("diagnose", differential)
    .addNode("care_plan", plan)
    .addNode("self_check", selfCheck)
    .addNode("write_report", report)
    .addEdge(START, "intake")
    .addEdge("intake", "red_flag")
    .addConditionalEdges("red_flag", afterRedFlag, ["write_report", "ask", "diagnose"])
    .addConditionalEdges("ask", afterAsk, ["patient", END])
    .addEdge("patient", "intake")
    .addEdge("diagnose", "care_plan")
    .addEdge("care_plan", "self_check")
    .addConditionalEdges("self_check", afterSelfCheck, ["write_report", "diagnose"])
    .addEdge("write_report", END)
    .compile();
}

export type ConsultationGraph = ReturnType<typeof buildConsultationGraph>;
