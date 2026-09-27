/**
 * Phase 1 demo 2 — LangGraph.js: state, conditional edges, a capped loop,
 * and human-in-the-loop with interrupt(). No LLM needed; nodes are plain
 * functions so the graph mechanics are easy to see.
 *
 *   npx tsx experiments/02-langgraph-loop.ts
 */
import {
  Annotation,
  Command,
  END,
  MemorySaver,
  START,
  StateGraph,
  interrupt,
} from "@langchain/langgraph";

// 1) State: each key has a reducer. `notes` appends, the rest overwrite.
const State = Annotation.Root({
  symptom: Annotation<string>,
  answers: Annotation<string[]>({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),
  draft: Annotation<string>,
  attempts: Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),
  notes: Annotation<string[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
});
type S = typeof State.State;

// 2) Nodes return partial state updates. Gotcha: a node name may not equal a
//    state key, so the "draft" node is registered as "write".
function askPatient(state: S) {
  // interrupt() pauses the graph and hands a value to the caller.
  // The caller resumes with new Command({ resume: answer }).
  const answer = interrupt({ question: `「${state.symptom}」持续多久了？` });
  return { answers: [String(answer)] };
}

function draft(state: S) {
  const attempts = state.attempts + 1;
  // Deliberately "hallucinate" on the first attempt so the checker rejects it.
  const text =
    attempts === 1
      ? `${state.symptom}，${state.answers.join("，")}，伴高热 39℃`
      : `${state.symptom}，${state.answers.join("，")}`;
  return { draft: text, attempts, notes: [`draft#${attempts}: ${text}`] };
}

function check(state: S) {
  const grounded = !state.draft.includes("39℃");
  return { notes: [grounded ? "check: pass" : "check: 发现患者未提及的「39℃」，打回"] };
}

// 3) Conditional edge: loop back to write until it passes, capped at 3.
function afterCheck(state: S) {
  const lastNote = state.notes[state.notes.length - 1];
  if (lastNote.endsWith("pass")) return END;
  return state.attempts >= 3 ? END : "write";
}

const graph = new StateGraph(State)
  .addNode("ask", askPatient)
  .addNode("write", draft)
  .addNode("check", check)
  .addEdge(START, "ask")
  .addEdge("ask", "write")
  .addEdge("write", "check")
  .addConditionalEdges("check", afterCheck, ["write", END])
  // A checkpointer is required for interrupt(): it stores the paused state.
  .compile({ checkpointer: new MemorySaver() });

async function main() {
  const config = { configurable: { thread_id: "demo-1" } };

  // First run stops at the interrupt.
  for await (const update of await graph.stream(
    { symptom: "咳嗽" },
    { ...config, streamMode: "updates" },
  )) {
    console.log("update:", JSON.stringify(update));
  }

  // Resume with the "patient's" answer; the loop then runs write → check → write → check.
  for await (const update of await graph.stream(new Command({ resume: "一周" }), {
    ...config,
    streamMode: "updates",
  })) {
    console.log("update:", JSON.stringify(update));
  }

  const final = await graph.getState(config);
  console.log("\nfinal draft:", final.values.draft);
  console.log("attempts:", final.values.attempts);

  // Note for Vercel: MemorySaver lives in process memory, so the paused state
  // is gone once a serverless invocation ends. The real agent avoids this by
  // being stateless per request (see docs/agent/ARCHITECTURE.md).
}

main();
