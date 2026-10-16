import type { AgentLLM, UsageRecord } from "./llm";
import {
  buildConsultationGraph,
  type ConsultationStateT,
  type GraphDeps,
} from "./graph";
import type { Turn } from "./schemas";

export type AgentEvent =
  | { type: "start"; llm: AgentLLM["kind"]; model: string }
  | { type: "node"; node: string; update: Partial<ConsultationStateT>; ms: number }
  | {
      type: "done";
      state: ConsultationStateT;
      usage: UsageRecord[];
      ms: number;
    }
  | { type: "error"; message: string };

/** Enough for 4 ask rounds with a simulated patient plus 2 rewrites. */
const RECURSION_LIMIT = 60;

/**
 * Run the graph once over a transcript and yield one event per node, then the
 * final state. Used by both the streaming API route and the offline eval.
 */
export async function* runConsultation(
  deps: GraphDeps,
  transcript: Turn[],
): AsyncGenerator<AgentEvent> {
  const graph = buildConsultationGraph(deps);
  const started = Date.now();
  let last = started;
  let state: ConsultationStateT | null = null;

  yield { type: "start", llm: deps.llm.kind, model: deps.llm.model };

  try {
    const stream = await graph.stream(
      { transcript },
      { streamMode: ["updates", "values"], recursionLimit: RECURSION_LIMIT },
    );
    for await (const [mode, chunk] of stream) {
      if (mode === "values") {
        state = chunk as ConsultationStateT;
        continue;
      }
      for (const [node, update] of Object.entries(chunk as Record<string, unknown>)) {
        const now = Date.now();
        yield {
          type: "node",
          node,
          update: (update ?? {}) as Partial<ConsultationStateT>,
          ms: now - last,
        };
        last = now;
      }
    }
  } catch (err) {
    yield { type: "error", message: err instanceof Error ? err.message : String(err) };
    return;
  }

  yield { type: "done", state: state!, usage: deps.llm.usage, ms: Date.now() - started };
}

/** Drain the event stream; convenient for scripts and tests. */
export async function runToCompletion(deps: GraphDeps, transcript: Turn[]) {
  const events: AgentEvent[] = [];
  for await (const e of runConsultation(deps, transcript)) events.push(e);
  const done = events.find((e) => e.type === "done");
  const error = events.find((e) => e.type === "error");
  if (error && error.type === "error") throw new Error(error.message);
  if (!done || done.type !== "done") throw new Error("graph finished without a final state");
  return { events, state: done.state, usage: done.usage, ms: done.ms };
}
