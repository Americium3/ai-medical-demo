import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { createCheckpointer } from "../src/config";
import { createBedrockLLM, LLMError } from "../src/llm";
import { createMockLLM } from "../src/mock-llm";
import { isRepeat, plan, similarity } from "../src/planner";
import { applyUpdates, emptyRecord } from "../src/record";
import { extractSchema } from "../src/schemas";
import { createApiServer } from "../src/server";
import { ConflictError, ConsultationService, NotFoundError } from "../src/service";
import { chooseTemplate, slotsFor } from "../src/templates";
import { matchRules } from "../src/triage";

const tmpDb = () => path.join(mkdtempSync(path.join(tmpdir(), "consult-")), "db.sqlite");
const newService = (db = tmpDb(), llm = createMockLLM()) => new ConsultationService(llm, createCheckpointer(db));

// ---- planner and record ------------------------------------------------

test("planner asks red-flag screening first, two at a time", () => {
  const t = chooseTemplate("我胸闷两周了");
  const record = emptyRecord(slotsFor(t).map((s) => s.id));
  const p = plan(t, record, []);
  assert.deepEqual(p.slots.map((s) => s.kind), ["redflag", "redflag"]);
});

test("planner never picks a slot that was already asked or settled", () => {
  const t = chooseTemplate("我胸闷两周了");
  const record = emptyRecord(slotsFor(t).map((s) => s.id));
  record.onset = { status: "answered", value: "两周", quote: "两周" };
  const asked = [{ round: 1, slotIds: ["rf_chest_sweat", "rf_chest_rest"], text: "有没有出汗？会不会休息也痛？" }];
  const ids = plan(t, record, asked).slots.map((s) => s.id);
  assert.ok(!ids.includes("rf_chest_sweat") && !ids.includes("rf_chest_rest") && !ids.includes("onset"));
});

test("planner stops at the round limit", () => {
  const t = chooseTemplate("我胸闷两周了");
  const record = emptyRecord(slotsFor(t).map((s) => s.id));
  const asked = [1, 2, 3, 4].map((round) => ({ round, slotIds: [], text: `q${round}` }));
  assert.equal(plan(t, record, asked, 4).reason, "max_rounds");
});

test("a reworded question counts as a repeat", () => {
  assert.ok(similarity("以前有没有什么病，比如高血压、糖尿病？", "以前有没有什么病，比如高血压或者糖尿病？") > 0.6);
  assert.ok(isRepeat("有没有对什么药物过敏？", [{ round: 1, slotIds: ["allergy"], text: "有没有对什么药物或食物过敏？" }]));
  assert.ok(!isRepeat("发烧最高到多少度？", [{ round: 1, slotIds: ["allergy"], text: "有没有对什么药物或食物过敏？" }]));
});

test("record updates must quote the patient; 'not sure' never overwrites an answer", () => {
  const record = emptyRecord(["onset", "allergy", "pmh"]);
  record.pmh = { status: "answered", value: "高血压", quote: "高血压" };
  const { record: next, rejected } = applyUpdates(
    record,
    [
      { slotId: "onset", status: "answered", value: "两周", quote: "两周了" },
      { slotId: "allergy", status: "answered", value: "青霉素过敏", quote: "对青霉素过敏" },
      { slotId: "pmh", status: "unknown" },
      { slotId: "nonexistent", status: "unknown" },
    ],
    "胸闷两周了，过敏的话不太清楚",
    1,
  );
  assert.equal(next.onset.status, "answered");
  assert.equal(next.allergy.status, "unasked");
  assert.equal(next.pmh.status, "answered");
  assert.deepEqual(rejected.map((r) => r.slotId), ["allergy", "nonexistent"]);
});

test("triage rules map to the four levels and respect negation", () => {
  assert.equal(matchRules("胸口痛了一个小时，一直出大汗")[0].level, 2);
  assert.equal(matchRules("刚才叫不醒")[0].level, 1);
  assert.equal(matchRules("上楼梯就胸闷")[0].level, 3);
  assert.deepEqual(matchRules("没有呼吸困难，也没有胸痛"), []);
});

// ---- graph through the service ----------------------------------------

async function runToEnd(service: ConsultationService, complaint: string, reply: (q: string) => string) {
  let v = await service.start(complaint, "k");
  const questions: string[] = [];
  while (v.status === "awaiting_answer") {
    questions.push(v.question!);
    v = await service.answer(v.id, reply(v.question!), "k");
  }
  return { v, questions };
}

test("a full consultation completes without asking any slot twice", async () => {
  const service = newService();
  const { v } = await runToEnd(service, "我胸闷两周了，上楼更明显", () => "这个我不太清楚。");
  assert.equal(v.status, "completed");
  const s = await service.state(v.id);
  const ids = s.asked.flatMap((r) => r.slotIds);
  assert.equal(new Set(ids).size, ids.length, "a slot was asked twice");
  assert.ok(!ids.includes("exertion"), "exertion was answered in the complaint and should not be asked");
  assert.ok(s.asked.length <= 4);
  assert.match(v.output!, /门诊病历草稿/);
});

test("an emergency in the first sentence stops the consultation", async () => {
  const v = await newService().start("医生，我胸口痛了一个小时，一直出大汗，喘不上气", "k");
  assert.equal(v.status, "emergency");
  assert.equal(v.question, null);
  assert.match(v.output!, /120/);
});

test("progress survives a restart: a new process resumes from the saved state", async () => {
  const db = tmpDb();
  const first = newService(db);
  const started = await first.start("我咳嗽发烧三天了", "k");
  const q1 = started.question;
  await first.answer(started.id, "没有喘。最高39度。", "k");

  const second = newService(db); // new checkpointer, same file: as if the server restarted
  const resumed = await second.get(started.id, "k");
  assert.equal(resumed.status, "awaiting_answer");
  assert.equal(resumed.rounds, 2);
  assert.notEqual(resumed.question, q1);
  const after = await second.answer(started.id, "有黄痰。", "k");
  assert.ok(after.rounds >= 2);
});

test("a failed self-check rewrites the note once, then passes", async () => {
  const llm = createMockLLM({
    review: (_c: never, n: number) => (n === 0 ? { pass: false, issues: [{ type: "overconfident", detail: "说得太肯定" }] } : { pass: true, issues: [] }),
  });
  const service = newService(tmpDb(), llm);
  const { v } = await runToEnd(service, "我头痛一周了", () => "不清楚");
  const s = await service.state(v.id);
  assert.equal(s.reviewFailures, 1);
  assert.match(v.output!, /通过（修改1次后）/);
});

test("only the creating key can see or answer a consultation, and only while it waits", async () => {
  const service = newService();
  const v = await service.start("我头痛一周了", "owner-a");
  await assert.rejects(service.get(v.id, "owner-b"), NotFoundError);
  await assert.rejects(service.answer(v.id, "x", "owner-b"), NotFoundError);
  const done = await service.start("我胸口痛，一直出大汗", "owner-a");
  await assert.rejects(service.answer(done.id, "x", "owner-a"), ConflictError);
});

// ---- HTTP API ------------------------------------------------------------

async function withServer(fn: (base: string) => Promise<void>, opts: { rate?: number; daily?: number } = {}) {
  const server: Server = createApiServer({
    service: newService(),
    apiKeys: ["key-a", "key-b"],
    ratePerMinute: opts.rate ?? 100,
    dailyConsultations: opts.daily ?? 100,
    log: () => {},
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

const call = (base: string, method: string, url: string, key?: string, body?: unknown, type = "application/json") =>
  fetch(`${base}${url}`, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": type },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });

test("API: keys are required and consultations are private to their key", async () => {
  await withServer(async (base) => {
    assert.equal((await call(base, "GET", "/healthz")).status, 200);
    assert.equal((await call(base, "POST", "/v1/consultations", undefined, { complaint: "我头痛" })).status, 401);
    assert.equal((await call(base, "POST", "/v1/consultations", "wrong", { complaint: "我头痛" })).status, 401);

    const created = await call(base, "POST", "/v1/consultations", "key-a", { complaint: "我头痛一周了" });
    assert.equal(created.status, 201);
    const v = await created.json();
    assert.equal(v.status, "awaiting_answer");

    assert.equal((await call(base, "GET", `/v1/consultations/${v.id}`, "key-b")).status, 404);
    const answered = await call(base, "POST", `/v1/consultations/${v.id}/answers`, "key-a", { text: "不清楚" });
    assert.equal(answered.status, 200);
  });
});

test("API: rejects bad input, oversized bodies and wrong content types", async () => {
  await withServer(async (base) => {
    assert.equal((await call(base, "POST", "/v1/consultations", "key-a", { complaint: "" })).status, 400);
    assert.equal((await call(base, "POST", "/v1/consultations", "key-a", "{not json")).status, 400);
    assert.equal((await call(base, "POST", "/v1/consultations", "key-a", { complaint: "x".repeat(10_000) })).status, 413);
    assert.equal((await call(base, "POST", "/v1/consultations", "key-a", "complaint=x", "text/plain")).status, 415);
    assert.equal((await call(base, "GET", "/v1/other", "key-a")).status, 404);
  });
});

test("API: per-key rate limit and daily consultation cap", async () => {
  await withServer(
    async (base) => {
      const codes = [];
      for (let i = 0; i < 4; i++) codes.push((await call(base, "GET", "/v1/consultations/00000000-0000-0000-0000-000000000000", "key-a")).status);
      assert.deepEqual(codes, [404, 404, 404, 429]);
      // key-b has its own window
      assert.equal((await call(base, "GET", "/v1/consultations/00000000-0000-0000-0000-000000000000", "key-b")).status, 404);
    },
    { rate: 3 },
  );
  await withServer(
    async (base) => {
      assert.equal((await call(base, "POST", "/v1/consultations", "key-a", { complaint: "我头痛一周了" })).status, 201);
      assert.equal((await call(base, "POST", "/v1/consultations", "key-a", { complaint: "我头痛一周了" })).status, 429);
    },
    { daily: 1 },
  );
});

// ---- Bedrock request shape, against a local fake Converse endpoint ------

test("Bedrock: offers the tool with auto choice, sends no temperature, validates the reply", async () => {
  const seen: { path?: string; body?: Record<string, unknown> }[] = [];
  let reply: "tool" | "text" = "tool";
  const fake = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ path: req.url, body: JSON.parse(raw) });
      const content =
        reply === "tool"
          ? [{ toolUse: { toolUseId: "t1", name: "submit_extract", input: { updates: [{ slotId: "onset", status: "answered", value: "两周", quote: "两周" }] } } }]
          : [{ text: "好的" }];
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          output: { message: { role: "assistant", content } },
          stopReason: reply === "tool" ? "tool_use" : "end_turn",
          usage: { inputTokens: 321, outputTokens: 45, totalTokens: 366 },
          metrics: { latencyMs: 10 },
        }),
      );
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  const { port } = fake.address() as AddressInfo;
  const client = new BedrockRuntimeClient({
    region: "us-east-1",
    endpoint: `http://127.0.0.1:${port}`,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    // The SDK defaults to HTTP/2; the fake server speaks HTTP/1.1.
    requestHandler: new NodeHttpHandler(),
  });

  try {
    const llm = createBedrockLLM({ region: "us-east-1", fastModelId: "fast-model", smartModelId: "smart-model", client });
    const out = await llm.invoke({ task: "extract", schema: extractSchema, system: "s", user: "u", context: null });
    assert.equal(out.updates[0].quote, "两周");

    const req = seen[0];
    assert.equal(req.path, "/model/fast-model/converse");
    const toolConfig = req.body!.toolConfig as { tools: { toolSpec: { name: string } }[]; toolChoice: unknown };
    assert.equal(toolConfig.tools[0].toolSpec.name, "submit_extract");
    assert.deepEqual(toolConfig.toolChoice, { auto: {} });
    const inference = (req.body!.inferenceConfig ?? {}) as Record<string, unknown>;
    assert.equal(inference.temperature, undefined);
    assert.deepEqual(llm.usage.map((u) => [u.task, u.model, u.inputTokens, u.outputTokens]), [["extract", "fast-model", 321, 45]]);

    reply = "text";
    await assert.rejects(llm.invoke({ task: "note", schema: extractSchema, system: "s", user: "u", context: null }), LLMError);
    assert.equal(seen.at(-1)!.path, "/model/smart-model/converse");
    assert.equal(seen.length, 5, "three retries after a reply without a tool call");
    // A full note runs past 1,500 output tokens on real models and was cut off mid-JSON (#8).
    assert.equal((seen[0].body!.inferenceConfig as { maxTokens: number }).maxTokens, 1500, "fast tier");
    assert.equal((seen.at(-1)!.body!.inferenceConfig as { maxTokens: number }).maxTokens, 4096, "smart tier");
  } finally {
    fake.close();
  }
});

test("offline mock keeps decimals intact when splitting an answer", async () => {
  const llm = createMockLLM();
  const t = chooseTemplate("我咳嗽发烧三天了");
  const fever = slotsFor(t).find((s) => s.id === "fever_max")!;
  const out = await llm.invoke({
    task: "extract",
    schema: extractSchema,
    system: "",
    user: "",
    context: { template: t, record: emptyRecord(slotsFor(t).map((s) => s.id)), asked: [fever], answer: "最高38.5度，有点难受" },
  });
  assert.equal(out.updates[0].quote, "最高38.5度");
});
