import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createCheckpointer } from "../src/config";
import type { LLM } from "../src/llm";
import { createMockLLM } from "../src/mock-llm";
import { createApiServer } from "../src/server";
import { ConsultationService } from "../src/service";

// #7: when the caller goes away, the run stops and no further model calls are made.

const tmpDb = () => path.join(mkdtempSync(path.join(tmpdir(), "consult-")), "db.sqlite");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every model call takes `ms` and honours the abort signal it is given. */
function slow(inner: LLM, ms = 80): LLM {
  return {
    kind: inner.kind,
    usage: inner.usage,
    async invoke(call) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        call.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(call.signal!.reason ?? new Error("aborted"));
        });
      });
      return inner.invoke(call);
    },
  };
}

const calls = (service: ConsultationService, id: string) => service.usage.filter((u) => u.consultationId === id).length;

test("aborting an answer stops the run; the consultation shows as failed and retry finishes it", async () => {
  const service = new ConsultationService(slow(createMockLLM()), createCheckpointer(tmpDb()));
  const v = await service.start("我胸闷两周了", "k");
  const before = calls(service, v.id);

  const ctrl = new AbortController();
  const running = service.answer(v.id, "没有出汗。", "k", ctrl.signal);
  await sleep(120); // first call done, second in flight
  ctrl.abort();
  await assert.rejects(running);
  const atAbort = calls(service, v.id);
  await sleep(400);
  assert.equal(calls(service, v.id), atAbort, "no model call after the abort");
  assert.ok(atAbort - before < 3, "the round was cut short");

  const after = await service.get(v.id, "k");
  assert.equal(after.status, "failed");
  const resumed = await service.retry(v.id, "k");
  assert.equal(resumed.status, "awaiting_answer");
  assert.equal(resumed.rounds, 2);
});

test("API: a client that disconnects mid-answer stops the graph on the server", async () => {
  const service = new ConsultationService(slow(createMockLLM()), createCheckpointer(tmpDb()));
  const server = createApiServer({ service, apiKeys: ["key-a"], ratePerMinute: 100, dailyConsultations: 100, log: () => {} });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { authorization: "Bearer key-a", "content-type": "application/json" };
  try {
    const { id } = await (await fetch(`${base}/v1/consultations`, { method: "POST", headers, body: JSON.stringify({ complaint: "我胸闷两周了" }) })).json();
    const ctrl = new AbortController();
    const req = fetch(`${base}/v1/consultations/${id}/answers`, { method: "POST", headers, body: JSON.stringify({ text: "没有出汗。" }), signal: ctrl.signal });
    await sleep(120);
    ctrl.abort();
    await assert.rejects(req);
    await sleep(50);
    const atAbort = calls(service, id);
    await sleep(400);
    assert.equal(calls(service, id), atAbort, "the server stopped calling the model");
    assert.equal((await (await fetch(`${base}/v1/consultations/${id}`, { headers })).json()).status, "failed");
  } finally {
    server.close();
  }
});

test("while an answer is being processed, a status check says running, not failed", async () => {
  const service = new ConsultationService(slow(createMockLLM()), createCheckpointer(tmpDb()));
  const v = await service.start("我胸闷两周了", "k");
  const running = service.answer(v.id, "没有出汗。", "k");
  await sleep(120);
  const mid = await service.get(v.id, "k");
  assert.equal(mid.status, "running");
  assert.equal(mid.error, null);
  assert.equal((await running).status, "awaiting_answer");
});
