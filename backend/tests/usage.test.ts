import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCheckpointer } from "../src/config";
import { summarizeUsage } from "../src/llm";
import { createMockLLM } from "../src/mock-llm";
import { ConsultationService } from "../src/service";

// #8: usage is attributed per consultation even though one LLM instance serves the whole process.

test("concurrent consultations get their own call counts", async () => {
  const service = new ConsultationService(createMockLLM(), createCheckpointer(path.join(mkdtempSync(path.join(tmpdir(), "u-")), "db.sqlite")));
  const [a, b] = await Promise.all([service.start("我头痛一周了", "k"), service.start("我胸口痛，一直出大汗", "k")]);
  const ua = service.usageFor(a.id);
  const ub = service.usageFor(b.id);
  assert.ok(ua.calls > 0 && ub.calls > 0);
  assert.equal(ua.calls + ub.calls, service.usage.length, "every call is attributed to exactly one consultation");
  await service.answer(a.id, "不清楚", "k");
  assert.ok(service.usageFor(a.id).calls > ua.calls);
  assert.equal(service.usageFor(b.id).calls, ub.calls);
});

test("cost uses the price table and is null for unpriced models", () => {
  const s = summarizeUsage([
    { task: "extract", model: "us.anthropic.claude-haiku-4-5-20251001-v1:0", inputTokens: 1_000_000, outputTokens: 0, ms: 1 },
    { task: "note", model: "us.anthropic.claude-sonnet-4-6", inputTokens: 0, outputTokens: 100_000, ms: 2 },
  ]);
  assert.equal(s.costUsd, 1 + 1.5);
  assert.equal(summarizeUsage([{ task: "extract", model: "mock", inputTokens: 0, outputTokens: 0, ms: 0 }]).costUsd, null);
});
