import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { MEDICAL_CASES } from "@/data/cases";
import { groundFacts } from "@/lib/agent/grounding";
import { matchRedFlagRules } from "@/lib/agent/red-flags";
import { createMockLLM } from "@/lib/agent/mock-llm";
import { createScriptedPatient, openingLine } from "@/lib/agent/patient";
import { runToCompletion, type AgentEvent } from "@/lib/agent/run";
import { MAX_ASK_ROUNDS, MAX_REVISIONS } from "@/lib/agent/graph";
import { AgentLLMError, createGatewayLLM } from "@/lib/agent/llm";
import { intakeOutputSchema, type DifferentialOutput, type Turn } from "@/lib/agent/schemas";

const nodes = (events: AgentEvent[]) =>
  events.flatMap((e) => (e.type === "node" ? [e.node] : []));

const patient = (content: string): Turn => ({ role: "patient", content });

// ---- deterministic building blocks -------------------------------------

test("groundFacts keeps verbatim quotes and drops invented ones", () => {
  const transcript = [patient("我咳嗽一周了，还有点发烧。")];
  const { kept, dropped } = groundFacts(
    [
      { category: "onset_duration", statement: "咳嗽 1 周", quote: "咳嗽一周" },
      { category: "associated", statement: "发热", quote: "有点发烧" },
      { category: "associated", statement: "高热 39℃", quote: "烧到39度" },
    ],
    transcript,
  );
  assert.deepEqual(kept.map((f) => f.id), ["F1", "F2"]);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].quote, "烧到39度");
});

test("red-flag rules respect negation and fire on the demo cases as expected", () => {
  assert.deepEqual(matchRedFlagRules("我没有呼吸困难，也没有胸痛"), []);
  assert.equal(matchRedFlagRules("突然喘不上气")[0].level, "emergency");

  const levels = Object.fromEntries(
    MEDICAL_CASES.map((c) => {
      const text = c.dialogueHistory.filter((t) => t.role === "patient").map((t) => t.content).join("\n");
      return [c.id, matchRedFlagRules(text).map((h) => h.level)];
    }),
  );
  assert.deepEqual(levels, {
    "resp-001": [],
    "gastro-001": [],
    "cardio-001": ["urgent"],
    "neuro-001": [],
    "ortho-001": [],
    "endo-001": ["urgent"],
  });
});

// ---- graph routing -----------------------------------------------------

test("interactive mode stops after asking and waits for the patient", async () => {
  const { state, events } = await runToCompletion(
    { llm: createMockLLM(), mode: "interactive" },
    [patient("医生您好，我咳嗽。")],
  );
  assert.equal(state.status, "awaiting_patient");
  assert.deepEqual(nodes(events), ["intake", "red_flag", "ask"]);
  assert.equal(state.transcript.at(-1)?.role, "agent");
  assert.ok(state.pendingQuestions.length >= 1);
  assert.equal(state.report, "");
});

test("simulated mode completes every demo case with a scorer-compatible record", async () => {
  for (const c of MEDICAL_CASES) {
    const { state, events } = await runToCompletion(
      { llm: createMockLLM(), mode: "simulated", patient: createScriptedPatient(c) },
      [patient(openingLine(c))],
    );
    assert.equal(state.status, "complete", c.id);
    for (const h of ["**主诉：**", "**现病史：**", "**初步诊断：**", "**鉴别诊断：**", "**处置建议：**"]) {
      assert.ok(state.report.includes(h), `${c.id} report missing ${h}`);
    }
    const asks = nodes(events).filter((n) => n === "ask").length;
    assert.ok(asks <= MAX_ASK_ROUNDS, `${c.id} asked ${asks} rounds`);
    assert.equal(state.differential?.primary.name, c.expectedDiagnosis.mainDiagnosis.replace("（有先兆型）", ""), c.id);
  }
});

test("an emergency short-circuits straight to the report", async () => {
  const { state, events } = await runToCompletion(
    { llm: createMockLLM(), mode: "interactive" },
    [patient("医生，我胸口痛了一个小时，一直出大汗，现在喘不上气。")],
  );
  assert.equal(state.status, "emergency");
  assert.deepEqual(nodes(events), ["intake", "red_flag", "write_report"]);
  assert.match(state.report, /120/);
  assert.equal(state.differential, null);
});

test("a failed self-check sends the draft back once, then passes", async () => {
  const c = MEDICAL_CASES[0];
  const llm = createMockLLM({
    self_check: (_ctx: never, n: number) =>
      n === 0
        ? { pass: false, issues: [{ type: "overconfident", detail: "信息不足，置信度应降低" }] }
        : { pass: true, issues: [] },
  });
  const { state, events } = await runToCompletion(
    { llm, mode: "simulated", patient: createScriptedPatient(c) },
    [patient(openingLine(c))],
  );
  const tail = nodes(events).slice(nodes(events).indexOf("diagnose"));
  assert.deepEqual(tail, ["diagnose", "care_plan", "self_check", "diagnose", "care_plan", "self_check", "write_report"]);
  assert.equal(state.checkFailures, 1);
  assert.match(state.report, /通过（经 1 次修正）/);
});

test("the revision loop is capped even if self-check never passes", async () => {
  const c = MEDICAL_CASES[1];
  const llm = createMockLLM({
    self_check: () => ({ pass: false, issues: [{ type: "unsupported_claim", detail: "总是不满意" }] }),
  });
  const { state, events } = await runToCompletion(
    { llm, mode: "simulated", patient: createScriptedPatient(c) },
    [patient(openingLine(c))],
  );
  assert.equal(nodes(events).filter((n) => n === "self_check").length, MAX_REVISIONS + 1);
  assert.equal(state.status, "complete");
  assert.match(state.report, /未完全通过（已修正 2 次，达到上限）/);
});

test("citing a fact id that does not exist is caught deterministically", async () => {
  const c = MEDICAL_CASES[0];
  let calls = 0;
  const llm = createMockLLM({
    differential: (ctx: never) => {
      calls++;
      const facts = (ctx as { facts: { id: string }[] }).facts;
      const out: DifferentialOutput = {
        primary: { name: "社区获得性肺炎", confidence: "中", reasoning: "…", factIds: calls === 1 ? ["F99"] : [facts[0].id] },
        differentials: [{ name: "急性支气管炎", reasoning: "…", factIds: [] }],
      };
      return out;
    },
  });
  const { state } = await runToCompletion(
    { llm, mode: "simulated", patient: createScriptedPatient(c) },
    [patient(openingLine(c))],
  );
  assert.equal(calls, 2);
  assert.equal(state.checkFailures, 1);
  assert.equal(state.selfCheckPassed, true);
});

test("follow-up questions stop at MAX_ASK_ROUNDS when the patient cannot answer", async () => {
  const llm = createMockLLM({
    intake: () => ({
      facts: [{ category: "chief_complaint", statement: "乏力", quote: "没力气" }],
      missing: [{ topic: "onset_duration", why: "需要病程" }],
      enoughInfo: false,
    }),
  });
  const { events, state } = await runToCompletion(
    { llm, mode: "simulated", patient: async () => "这个我不太清楚。" },
    [patient("医生，我最近总是没力气。")],
  );
  assert.equal(nodes(events).filter((n) => n === "ask").length, MAX_ASK_ROUNDS);
  assert.equal(state.status, "complete");
});

// ---- the real LangChain path, against a local OpenAI-compatible server ----

test("createGatewayLLM sends a forced tool call and parses the structured reply", async () => {
  const seen: { url?: string; auth?: string; body?: Record<string, unknown> } = {};
  let reply: "tool" | "text" = "tool";
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.url = req.url;
      seen.auth = req.headers.authorization;
      seen.body = JSON.parse(raw);
      const message =
        reply === "tool"
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "intake",
                    arguments: JSON.stringify({
                      facts: [{ category: "chief_complaint", statement: "咳嗽", quote: "咳嗽" }],
                      missing: [],
                      enoughInfo: true,
                    }),
                  },
                },
              ],
            }
          : { role: "assistant", content: "我不知道" };
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion",
          created: 0,
          model: "openai/gpt-4o-mini",
          choices: [{ index: 0, message, finish_reason: reply === "tool" ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;

  try {
    const llm = createGatewayLLM("openai/gpt-4o-mini", {
      apiKey: "test-key",
      baseURL: `http://127.0.0.1:${port}/v1`,
    });
    const out = await llm.invoke({
      task: "intake",
      schema: intakeOutputSchema,
      system: "sys",
      user: "患者：咳嗽",
      context: null,
    });
    assert.equal(out.facts[0].quote, "咳嗽");
    assert.equal(seen.url, "/v1/chat/completions");
    assert.equal(seen.auth, "Bearer test-key");
    assert.equal(seen.body?.model, "openai/gpt-4o-mini");
    const tools = seen.body?.tools as { function: { name: string } }[];
    assert.equal(tools[0].function.name, "intake");
    assert.deepEqual(llm.usage.map((u) => [u.task, u.inputTokens, u.outputTokens]), [["intake", 120, 30]]);

    reply = "text";
    await assert.rejects(
      llm.invoke({ task: "intake", schema: intakeOutputSchema, system: "s", user: "u", context: null }),
      AgentLLMError,
    );
  } finally {
    server.close();
  }
});

test("chest pain with sweating is an emergency even with words in between", () => {
  const hits = matchRedFlagRules("我胸口痛了一个小时，一直出大汗");
  assert.equal(hits[0]?.rule, "胸痛伴大汗/持续不缓解");
});

test("scripted patient ignores filler words when matching questions", async () => {
  const c = MEDICAL_CASES.find((x) => x.id === "cardio-001")!;
  const answer = await createScriptedPatient(c)([], ["有没有对什么药物过敏？"]);
  assert.equal(answer, "这个我不太清楚。");
  const smoke = await createScriptedPatient(c)([], ["您抽烟吗？家里有人得过心脏病吗？"]);
  assert.match(smoke, /抽烟二十多年/);
});
