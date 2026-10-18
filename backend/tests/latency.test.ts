import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCheckpointer } from "../src/config";
import type { LLM, Task } from "../src/llm";
import { createMockLLM } from "../src/mock-llm";
import { ConsultationService } from "../src/service";

// #10: rules before any model call, rewrite in parallel with triage, optional template wording.

const tmpDb = () => path.join(mkdtempSync(path.join(tmpdir(), "consult-")), "db.sqlite");

/** Every call sleeps `ms`; records which tasks were in flight at the same time. */
function slow(inner: LLM, ms = 30) {
  const inFlight = new Set<Task>();
  const overlaps: Task[][] = [];
  const llm: LLM = {
    kind: inner.kind,
    usage: inner.usage,
    async invoke(call) {
      inFlight.add(call.task);
      if (inFlight.size > 1) overlaps.push([...inFlight].sort());
      try {
        await new Promise((r) => setTimeout(r, ms));
        return await inner.invoke(call);
      } finally {
        inFlight.delete(call.task);
      }
    },
  };
  return { llm, overlaps };
}

const tasksOf = (service: ConsultationService, id: string) => service.usage.filter((u) => u.consultationId === id).map((u) => u.task);

test("a level I/II red flag in the opening sentence goes to emergency with no model call", async () => {
  const service = new ConsultationService(createMockLLM(), createCheckpointer(tmpDb()));
  const v = await service.start("医生，我胸口痛了一个小时，一直出大汗，喘不上气", "k");
  assert.equal(v.status, "emergency");
  assert.match(v.output!, /120/);
  assert.deepEqual(tasksOf(service, v.id), []);
});

test("a red flag in a later answer stops the consultation before extraction or triage", async () => {
  const service = new ConsultationService(createMockLLM(), createCheckpointer(tmpDb()));
  const v = await service.start("我头痛一周了", "k");
  const before = tasksOf(service, v.id).length;
  const after = await service.answer(v.id, "刚才突然嘴歪了，说话不清楚", "k");
  assert.equal(after.status, "emergency");
  assert.match(after.output!, /卒中征象/);
  assert.equal(tasksOf(service, v.id).length, before, "no model call for a rule-detected emergency");
});

test("the question rewrite runs in parallel with triage", async () => {
  const { llm, overlaps } = slow(createMockLLM());
  const service = new ConsultationService(llm, createCheckpointer(tmpDb()));
  const v = await service.start("我胸闷两周了", "k");
  assert.equal(v.status, "awaiting_answer");
  assert.ok(
    overlaps.some((o) => o.includes("phrase") && o.includes("triage")),
    `phrase and triage never overlapped; overlaps: ${JSON.stringify(overlaps)}`,
  );
});

test("a rewritten question is discarded when triage finds an emergency", async () => {
  const llm = createMockLLM({ triage: (_c: never, n: number) => ({ level: n === 1 ? 2 : 4, reason: n === 1 ? "模型判断危重" : "非急症" }) });
  const service = new ConsultationService(llm, createCheckpointer(tmpDb()));
  const v = await service.start("我胸闷两周了", "k");
  const after = await service.answer(v.id, "这个我不太清楚。", "k");
  assert.equal(after.status, "emergency");
  assert.equal(after.question, null);
  const s = await service.state(v.id);
  assert.equal(s.asked.length, 1, "the discarded question is not recorded as asked");
  assert.equal(s.transcript.at(-1)!.role, "patient");
});

test("template phrasing asks the template wording and makes no rewrite call", async () => {
  const service = new ConsultationService(createMockLLM(), createCheckpointer(tmpDb()), undefined, undefined, { phrasing: "template" });
  let v = await service.start("我胸闷两周了", "k");
  while (v.status === "awaiting_answer") v = await service.answer(v.id, "这个我不太清楚。", "k");
  assert.equal(v.status, "completed");
  assert.ok(!tasksOf(service, v.id).includes("phrase"));
});
