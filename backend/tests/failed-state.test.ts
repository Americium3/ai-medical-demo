import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createCheckpointer } from "../src/config";
import { LLMError, type LLM, type Task } from "../src/llm";
import { createMockLLM } from "../src/mock-llm";
import { createApiServer } from "../src/server";
import { ConflictError, ConsultationService, ModelFailureError } from "../src/service";

// #3: a model failure must surface as a retryable "failed" state, never as "completed".

const tmpDb = () => path.join(mkdtempSync(path.join(tmpdir(), "consult-")), "db.sqlite");

/** Wraps an LLM so the first `times` calls to `task` throw LLMError, as Bedrock does after its retries. */
function failing(inner: LLM, task: Task, times = 1): LLM {
  let left = times;
  return {
    kind: inner.kind,
    usage: inner.usage,
    async invoke(call) {
      if (call.task === task && left > 0) {
        left--;
        throw new LLMError(task, "ThrottlingException: Too many requests");
      }
      return inner.invoke(call);
    },
  };
}

const COMPLAINT = "我头痛一周了";
const UNSURE = "这个我不太清楚。";

/** Answer until the consultation stops waiting; returns the id and the error the last answer threw, if any. */
async function answerUntilStop(service: ConsultationService) {
  let v = await service.start(COMPLAINT, "k");
  for (;;) {
    try {
      v = await service.answer(v.id, UNSURE, "k");
      if (v.status !== "awaiting_answer") return { id: v.id, error: null };
    } catch (err) {
      return { id: v.id, error: err };
    }
  }
}

test("a failed first draft shows as failed, and retry completes it on the same thread", async () => {
  const service = new ConsultationService(failing(createMockLLM(), "note"), createCheckpointer(tmpDb()));
  const { id, error } = await answerUntilStop(service);
  assert.ok(error, "the failing answer should throw");

  const failed = await service.get(id, "k");
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /note/);
  assert.equal(failed.output, null);
  await assert.rejects(service.answer(id, "x", "k"), /retry/);

  const done = await service.retry(id, "k");
  assert.equal(done.status, "completed");
  assert.match(done.output!, /门诊病历草稿/);
  assert.equal((await service.get(id, "k")).status, "completed");
  await assert.rejects(service.retry(id, "k"), ConflictError);
});

test("a failure on the very first model call still leaves a retryable consultation", async () => {
  const service = new ConsultationService(failing(createMockLLM(), "extract"), createCheckpointer(tmpDb()));
  const err = await service.start(COMPLAINT, "k").then(
    () => assert.fail("start should fail"),
    (e: unknown) => e,
  );
  assert.ok(err instanceof ModelFailureError);
  assert.equal((await service.get(err.id, "k")).status, "failed");
  assert.equal((await service.retry(err.id, "k")).status, "awaiting_answer");
});

test("a failed rewrite keeps the previous draft", async () => {
  const llm = createMockLLM({ review: () => ({ pass: false, issues: [{ type: "overconfident", detail: "说得太肯定" }] }) });
  let notes = 0;
  const wrapped: LLM = {
    kind: llm.kind,
    usage: llm.usage,
    async invoke(call) {
      if (call.task === "note" && notes++ === 1) throw new LLMError("note", "timeout");
      return llm.invoke(call);
    },
  };
  const service = new ConsultationService(wrapped, createCheckpointer(tmpDb()));
  const { id, error } = await answerUntilStop(service);
  assert.equal(error, null);
  const v = await service.get(id, "k");
  assert.equal(v.status, "completed");
  assert.match(v.output!, /门诊病历草稿/);
});

test("a failed self-check finishes with the draft and asks for doctor review", async () => {
  const service = new ConsultationService(failing(createMockLLM(), "review"), createCheckpointer(tmpDb()));
  const { id, error } = await answerUntilStop(service);
  assert.equal(error, null);
  const s = await service.state(id);
  assert.equal(s.status, "completed");
  assert.ok(s.issues.some((i) => i.includes("人工复核")));
});

test("API: a model failure is 502 retryable; GET shows failed; retry completes", async () => {
  const service = new ConsultationService(failing(createMockLLM(), "note"), createCheckpointer(tmpDb()));
  const server = createApiServer({ service, apiKeys: ["key-a"], ratePerMinute: 100, dailyConsultations: 100, log: () => {} });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (method: string, url: string, body?: unknown) =>
    fetch(`${base}${url}`, {
      method,
      headers: { authorization: "Bearer key-a", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    let res = await call("POST", "/v1/consultations", { complaint: COMPLAINT });
    const { id } = await res.json();
    for (;;) {
      res = await call("POST", `/v1/consultations/${id}/answers`, { text: UNSURE });
      if (res.status !== 200) break;
      if ((await res.json()).status !== "awaiting_answer") assert.fail("completed without hitting the injected failure");
    }
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.retryable, true);
    assert.equal(body.id, id);

    assert.equal((await (await call("GET", `/v1/consultations/${id}`)).json()).status, "failed");
    assert.equal((await call("POST", `/v1/consultations/${id}/answers`, { text: "x" })).status, 409);

    res = await call("POST", `/v1/consultations/${id}/retry`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "completed");
    assert.equal((await call("POST", `/v1/consultations/${id}/retry`)).status, 409);
  } finally {
    server.close();
  }
});
