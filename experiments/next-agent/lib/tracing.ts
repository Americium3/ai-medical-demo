import { createTracing, tracingOptionsFromEnv, type Tracing } from "../../../shared/tracing/langfuse";

let tracer: Tracing | null | undefined;

/**
 * The Langfuse tracer for the Next.js agent, or null when LANGFUSE_* is not set.
 * Created once per server instance; spans are exported immediately because a
 * Vercel function may be frozen as soon as the response ends.
 */
export function getAgentTracer(): Tracing | null {
  if (tracer === undefined) {
    const opts = tracingOptionsFromEnv();
    tracer = opts ? createTracing({ ...opts, exportMode: "immediate" }) : null;
  }
  return tracer;
}
