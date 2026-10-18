import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createCheckpointer } from "../src/config";
import { LLMError, type LLM } from "../src/llm";
import { createMockLLM } from "../src/mock-llm";
import { createApiServer } from "../src/server";
import { ConflictError, ConsultationService, ModelFailureError } from "../src/service";

// #6: two answers to the same consultation at the same time must not both resume the graph.

const tmpDb = () => path.join(mkdtempSync(path.join(tmpdir(), "consult-")), "db.sqlite");

/** Every model call takes a little while, so two requests overlap. */
function slow(inner: LLM, ms = 40): LLM {
  return {
    kind: inner.kind,
    usage: inner.usage,
    async invoke(call) {
      await new Promise((r) => setTimeout(r, ms));
      return inner.invoke(call);
    },
  };
}

const extracts = (service: ConsultationService, id: string) => service.usage.filter((u) => u.consultationId === id && u.task === "extract").length;

test("two concurrent answers: one runs, the other is a conflict", async () => {
  const service = new ConsultationService(slow(createMockLLM()), createCheckpointer(tmpDb()));
  const v = await service.start("我胸闷两周了", "k");
  const before = extracts(service, v.id);

  const results = await Promise.allSettled([service.answer(v.id, "没有出汗。", "k"), service.answer(v.id, "休息就好了。", "k")]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  assert.equal(ok.length, 1, "exactly one answer goes through");
  assert.equal(failed.length, 1);
  assert.ok(failed[0].reason instanceof ConflictError, `expected ConflictError, got ${failed[0].reason}`);
  assert.equal(extracts(service, v.id), before + 1, "the graph resumed once");

  const s = await service.state(v.id);
  assert.equal(s.transcript.filter((t) => t.role === "patient").length, 2, "only one answer was recorded");
  // Once the first answer is done, the next one is accepted again.
  assert.equal((await service.answer(v.id, "不清楚", "k")).id, v.id);
});

test("two concurrent retries of a failed consultation: one runs, the other is a conflict", async () => {
  let fail = true;
  const inner = slow(createMockLLM());
  const llm: LLM = {
    kind: inner.kind,
    usage: inner.usage,
    async invoke(call) {
      if (call.task === "extract" && fail) {
        fail = false;
        throw new LLMError("extract", "ThrottlingException");
      }
      return inner.invoke(call);
    },
  };
  const service = new ConsultationService(llm, createCheckpointer(tmpDb()));
  const err = await service.start("我胸闷两周了", "k").then(() => assert.fail("start should fail"), (e: unknown) => e);
  assert.ok(err instanceof ModelFailureError);
  const results = await Promise.allSettled([service.retry(err.id, "k"), service.retry(err.id, "k")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.ok(results.some((r) => r.status === "rejected" && r.reason instanceof ConflictError));
  assert.equal(extracts(service, err.id), 1, "the failed step re-ran once");
});

test("API: concurrent answers return one 200 and one 409", async () => {
  const service = new ConsultationService(slow(createMockLLM()), createCheckpointer(tmpDb()));
  const server = createApiServer({ service, apiKeys: ["key-a"], ratePerMinute: 100, dailyConsultations: 100, log: () => {} });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (url: string, body: unknown) =>
    fetch(`${base}${url}`, {
      method: "POST",
      headers: { authorization: "Bearer key-a", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const { id } = await (await post("/v1/consultations", { complaint: "我胸闷两周了" })).json();
    const before = extracts(service, id);
    const [a, b] = await Promise.all([post(`/v1/consultations/${id}/answers`, { text: "没有出汗。" }), post(`/v1/consultations/${id}/answers`, { text: "休息就好了。" })]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal(extracts(service, id), before + 1);
  } finally {
    server.close();
  }
});
