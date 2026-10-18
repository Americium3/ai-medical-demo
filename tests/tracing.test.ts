import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { createTracing } from "../shared/tracing/langfuse";
import { createMockLLM } from "@/lib/agent/mock-llm";
import { runConsultation, runToCompletion } from "@/lib/agent/run";

// #9, Next.js side: /api/agent passes a per-request handler into the graph run.

test("each node of an /api/agent turn is a span in the request's session", async () => {
  const exporter = new InMemorySpanExporter();
  const tracing = createTracing({ publicKey: "pk", secretKey: "sk", baseUrl: "http://localhost:3000", maskAllText: false, exportMode: "immediate", exporter });
  try {
    const runId = "run-123";
    for await (const e of runConsultation(
      { llm: createMockLLM(), mode: "interactive" },
      [{ role: "patient", content: "医生您好，我咳嗽。" }],
      { callbacks: [tracing.handler(runId, { runId })] },
    )) void e;
    await tracing.flush();

    const spans = exporter.getFinishedSpans();
    const root = spans.find((s) => s.attributes["session.id"] === runId);
    assert.ok(root, "the run's root span carries the run id as its session");
    const traceId = root.spanContext().traceId;
    for (const node of ["intake", "red_flag", "ask"]) {
      assert.ok(spans.some((s) => s.name === node && s.spanContext().traceId === traceId), `no span for ${node}`);
    }
  } finally {
    await tracing.shutdown();
  }
});

test("without a handler the run is unchanged", async () => {
  const { state } = await runToCompletion({ llm: createMockLLM(), mode: "interactive" }, [{ role: "patient", content: "医生您好，我咳嗽。" }]);
  assert.equal(state.status, "awaiting_patient");
});
