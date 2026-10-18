import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { createTracing, isSelfHostedUrl, maskData, tracingOptionsFromEnv } from "../../shared/tracing/langfuse";
import { createCheckpointer } from "../src/config";
import { createMockLLM } from "../src/mock-llm";
import { ConsultationService } from "../src/service";

// #9: with tracing on, every graph node is a span tagged with the consultation id.

const tmpDb = () => path.join(mkdtempSync(path.join(tmpdir(), "consult-")), "db.sqlite");
const opts = { publicKey: "pk-test", secretKey: "sk-test", baseUrl: "http://localhost:3000" };

test("tracing is off unless all three LANGFUSE_* variables are set", () => {
  assert.equal(tracingOptionsFromEnv({}), null);
  assert.equal(tracingOptionsFromEnv({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" }), null);
  assert.equal(tracingOptionsFromEnv({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", LANGFUSE_BASE_URL: "http://localhost:3000" })!.maskAllText, false);
  assert.equal(tracingOptionsFromEnv({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", LANGFUSE_BASE_URL: "https://cloud.langfuse.com" })!.maskAllText, true);
  assert.equal(
    tracingOptionsFromEnv({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", LANGFUSE_BASE_URL: "https://langfuse.corp.example", LANGFUSE_SELF_HOSTED: "true" })!.maskAllText,
    false,
  );
  assert.ok(isSelfHostedUrl("http://10.0.3.7:3000") && isSelfHostedUrl("http://langfuse.internal") && !isSelfHostedUrl("https://us.cloud.langfuse.com"));
});

test("masking redacts phone and ID numbers, and all text for a hosted Langfuse", () => {
  const data = { complaint: "我胸闷，电话13812345678，身份证110101199003071234", n: 3 };
  assert.deepEqual(maskData(data, false), { complaint: "我胸闷，电话[手机号]，身份证[身份证号]", n: 3 });
  assert.deepEqual(maskData(data, true), { complaint: "[已隐藏 39 字]", n: 3 });
  assert.equal(maskData(JSON.stringify({ a: "胸闷" }), true), JSON.stringify({ a: "[已隐藏 2 字]" }));
});

test("every node of a consultation is a span tagged with its id, with patient identifiers masked", async () => {
  const exporter = new InMemorySpanExporter();
  const tracing = createTracing({ ...opts, maskAllText: false, exportMode: "immediate", exporter });
  try {
    const service = new ConsultationService(createMockLLM(), createCheckpointer(tmpDb()), undefined, tracing);
    let v = await service.start("我胸闷两周了，电话13812345678", "k");
    while (v.status === "awaiting_answer") v = await service.answer(v.id, "这个我不太清楚。", "k");
    await tracing.flush();

    const spans = exporter.getFinishedSpans();
    const names = new Set(spans.map((s) => s.name));
    for (const node of ["setup", "understand", "triage", "ask", "wait", "draft", "check", "finalize"]) {
      assert.ok(names.has(node), `no span for node ${node}; got ${[...names].join(", ")}`);
    }
    const NODES = new Set(["setup", "understand", "triage", "ask", "wait", "draft", "check", "finalize"]);
    // Langfuse keeps the session on the trace: each run's root span carries session.id, node spans share its trace.
    const sessionOfTrace = new Map(
      spans.filter((s) => s.attributes["session.id"]).map((s) => [s.spanContext().traceId, s.attributes["session.id"]]),
    );
    const untagged = spans.filter((s) => NODES.has(s.name) && sessionOfTrace.get(s.spanContext().traceId) !== v.id).map((s) => s.name);
    assert.deepEqual(untagged, [], "every node span belongs to a trace of the consultation's session");
    assert.ok(sessionOfTrace.size >= 2, "each start/answer call is its own trace in the same session");
    const exported = JSON.stringify(spans.map((s) => s.attributes));
    assert.ok(exported.includes("胸闷"), "self-hosted keeps clinical text");
    assert.ok(!exported.includes("13812345678"), "phone number must be masked");
  } finally {
    await tracing.shutdown();
  }
});
