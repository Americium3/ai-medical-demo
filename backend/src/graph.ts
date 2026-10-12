/**
 * The consultation graph (design doc §6–§8).
 *
 *   setup → understand → triage ─┬─ level 1–2 → emergency
 *               ▲                ├─ planner has questions → ask → wait ┐
 *               └────────────────┼──────────────────────────────────── ┘ (patient answers)
 *                                └─ planner done → draft → check ─┬─ pass → finalize
 *                                                    ▲            │
 *                                                    └─ fail (≤2) ┘
 *
 * `wait` calls interrupt(): the graph pauses and the checkpointer saves the
 * whole state under the consultation id. The next answer resumes it, even in
 * another process, so nothing is re-derived from the transcript.
 */
import { Annotation, END, START, StateGraph, interrupt, type BaseCheckpointSaver } from "@langchain/langgraph";
import { LLMError, type LLM } from "./llm";
import { plan, type AskedRound, DEFAULT_MAX_ROUNDS } from "./planner";
import { applyUpdates, emptyRecord, type RecordTable, type SlotUpdate } from "./record";
import { extractPrompt, notePrompt, phrasePrompt, reviewPrompt, triagePrompt } from "./prompts";
import { renderEmergency, renderNote } from "./render";
import { extractSchema, noteSchema, phraseSchema, reviewSchema, triageSchema, type NoteOutput } from "./schemas";
import { chooseTemplate, findSlot, slotsFor, TEMPLATES, type Slot, type Template } from "./templates";
import { isEmergency, matchRules, mostUrgent, type Level, type RuleHit } from "./triage";

export const MAX_NOTE_REWRITES = 2;

export interface Turn {
  role: "patient" | "agent";
  content: string;
}

const keep = <T>(fallback: () => T) => Annotation<T>({ reducer: (_, b) => b, default: fallback });

export const ConsultationState = Annotation.Root({
  complaint: keep<string>(() => ""),
  owner: keep<string>(() => ""),
  templateId: keep<string>(() => ""),
  record: keep<RecordTable>(() => ({})),
  asked: Annotation<AskedRound[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  pendingSlotIds: keep<string[]>(() => []),
  transcript: Annotation<Turn[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  level: keep<Level>(() => 4),
  levelReason: keep<string>(() => ""),
  ruleHits: keep<RuleHit[]>(() => []),
  rejected: keep<SlotUpdate[]>(() => []),
  note: keep<NoteOutput | null>(() => null),
  issues: keep<string[]>(() => []),
  reviewFailures: keep<number>(() => 0),
  status: keep<"asking" | "emergency" | "completed">(() => "asking"),
  output: keep<string>(() => ""),
});
export type State = typeof ConsultationState.State;

function templateOf(s: State): Template {
  return TEMPLATES.find((t) => t.id === s.templateId) ?? chooseTemplate(s.complaint);
}

export function buildGraph(llm: LLM, checkpointer: BaseCheckpointSaver, maxRounds = DEFAULT_MAX_ROUNDS) {
  function setup(s: State) {
    const template = chooseTemplate(s.complaint);
    return {
      templateId: template.id,
      record: emptyRecord(slotsFor(template).map((x) => x.id)),
      transcript: [{ role: "patient" as const, content: s.complaint }],
    };
  }

  /** Update the record from the latest patient turn only (design doc §8.2). */
  async function understand(s: State) {
    const template = templateOf(s);
    const latest = s.transcript.at(-1)!.content;
    const asked = s.pendingSlotIds.map((id) => findSlot(template, id)).filter((x): x is Slot => !!x);
    const question = s.asked.at(-1)?.text ?? "（开场主诉）";
    const out = await llm.invoke({
      task: "extract",
      schema: extractSchema,
      ...extractPrompt(template, s.record, asked, question, latest),
      context: { template, record: s.record, asked, answer: latest },
    });
    const { record, rejected } = applyUpdates(s.record, out.updates, latest, s.asked.length);
    return { record, rejected, pendingSlotIds: [] };
  }

  async function triage(s: State) {
    const template = templateOf(s);
    const latest = s.transcript.at(-1)!.content;
    const out = await llm.invoke({
      task: "triage",
      schema: triageSchema,
      ...triagePrompt(template, s.record, latest),
      context: { text: latest },
    });
    const allPatientText = s.transcript.filter((t) => t.role === "patient").map((t) => t.content).join("\n");
    const ruleHits = matchRules(allPatientText);
    const level = mostUrgent(s.level, out.level as Level, ...ruleHits.map((h) => h.level));
    const escalated = level < (out.level as Level);
    return {
      level,
      ruleHits,
      levelReason: escalated ? `${out.reason}（规则兜底：${ruleHits.map((h) => h.rule).join("、")}）` : out.reason,
    };
  }

  async function ask(s: State) {
    const template = templateOf(s);
    const p = plan(template, s.record, s.asked, maxRounds);
    const out = await llm.invoke({
      task: "phrase",
      schema: phraseSchema,
      ...phrasePrompt(p.slots, s.asked.map((r) => r.text)),
      context: { slots: p.slots },
    });
    // Fall back to the template wording if the model returned the wrong count.
    const questions = out.questions.length === p.slots.length ? out.questions : p.slots.map((x) => x.question);
    const text = questions.join(" ");
    return {
      pendingSlotIds: p.slots.map((x) => x.id),
      asked: [{ round: s.asked.length + 1, slotIds: p.slots.map((x) => x.id), text }],
      transcript: [{ role: "agent" as const, content: text }],
    };
  }

  /** Pause until the patient answers. Kept separate from `ask` so resuming never re-runs a model call. */
  function wait(s: State) {
    const answer = interrupt({ questions: s.asked.at(-1)?.text ?? "" }) as string;
    return { transcript: [{ role: "patient" as const, content: answer }] };
  }

  async function draft(s: State) {
    const template = templateOf(s);
    try {
      const note = await llm.invoke({
        task: "note",
        schema: noteSchema,
        ...notePrompt(template, s.record, s.issues, s.note),
        context: { template, record: s.record, complaint: s.complaint },
      });
      return { note };
    } catch (err) {
      // A failed rewrite keeps the previous draft and stops rewriting, so the patient still gets a note.
      if (!(err instanceof LLMError) || !s.note) throw err;
      return { note: s.note, reviewFailures: MAX_NOTE_REWRITES + 1 };
    }
  }

  async function check(s: State) {
    const template = templateOf(s);
    const note = s.note!;
    const issues: string[] = [];
    // Deterministic first: every cited slot must exist and be answered.
    const sentences = [note.chiefComplaint, ...note.presentIllness, ...note.pastHistory];
    for (const sentence of sentences) {
      const bad = sentence.slotIds.filter((id) => s.record[id]?.status !== "answered");
      if (bad.length) issues.push(`「${sentence.text}」引用了没有答案的要点 ${bad.join("、")}`);
    }
    let review;
    try {
      review = await llm.invoke({
        task: "review",
        schema: reviewSchema,
        ...reviewPrompt(template, s.record, note),
        context: { note },
      });
    } catch (err) {
      // If the model self-check itself fails, finish with the draft and flag it for the doctor.
      if (!(err instanceof LLMError)) throw err;
      issues.push("自动自查未能完成，请医生人工复核");
      return { issues, reviewFailures: MAX_NOTE_REWRITES + 1 };
    }
    issues.push(...review.issues.map((i) => `[${i.type}] ${i.detail}`));
    const passed = review.pass && issues.length === 0;
    return { issues: passed ? [] : issues, reviewFailures: passed ? s.reviewFailures : s.reviewFailures + 1 };
  }

  function finalize(s: State) {
    return { status: "completed" as const, output: renderNote(templateOf(s), s) };
  }

  function emergency(s: State) {
    return { status: "emergency" as const, output: renderEmergency(s) };
  }

  function afterTriage(s: State) {
    if (isEmergency(s.level)) return "emergency";
    return plan(templateOf(s), s.record, s.asked, maxRounds).done ? "draft" : "ask";
  }

  function afterCheck(s: State) {
    if (s.issues.length === 0) return "finalize";
    return s.reviewFailures <= MAX_NOTE_REWRITES ? "draft" : "finalize";
  }

  return new StateGraph(ConsultationState)
    .addNode("setup", setup)
    .addNode("understand", understand)
    .addNode("triage", triage)
    .addNode("ask", ask)
    .addNode("wait", wait)
    .addNode("draft", draft)
    .addNode("check", check)
    .addNode("finalize", finalize)
    .addNode("emergency", emergency)
    .addEdge(START, "setup")
    .addEdge("setup", "understand")
    .addEdge("understand", "triage")
    .addConditionalEdges("triage", afterTriage, ["emergency", "ask", "draft"])
    .addEdge("ask", "wait")
    .addEdge("wait", "understand")
    .addEdge("draft", "check")
    .addConditionalEdges("check", afterCheck, ["draft", "finalize"])
    .addEdge("finalize", END)
    .addEdge("emergency", END)
    .compile({ checkpointer });
}
