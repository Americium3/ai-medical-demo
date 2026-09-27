import { test } from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV3 } from "ai/test";
import { readUIMessageText } from "@/lib/ui-stream";
import { scoreDiagnosis, ScoringError, judgeTotal } from "@/lib/scoring";
import { MEDICAL_CASES } from "@/data/cases";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

test("readUIMessageText joins text deltas even when lines split across chunks", async () => {
  const wire =
    'data: {"type":"start"}\n\n' +
    'data: {"type":"text-delta","id":"t","delta":"社区"}\n\n' +
    'data: {"type":"text-delta","id":"t","delta":"获得性肺炎"}\n\n' +
    "data: [DONE]\n\n";
  // split every 7 bytes-ish to force partial lines
  const parts: string[] = [];
  for (let i = 0; i < wire.length; i += 7) parts.push(wire.slice(i, i + 7));
  const seen: string[] = [];
  const text = await readUIMessageText(streamOf(parts), (t) => seen.push(t));
  assert.equal(text, "社区获得性肺炎");
  assert.deepEqual(seen, ["社区", "社区获得性肺炎"]);
});

test("readUIMessageText surfaces stream errors", async () => {
  await assert.rejects(
    readUIMessageText(streamOf(['data: {"type":"error","errorText":"quota"}\n\n'])),
    /quota/,
  );
});

test("old v4 parser format ('0:' lines) yields no text — documents the fixed bug", async () => {
  const text = await readUIMessageText(streamOf(['0:"hello"\n']));
  assert.equal(text, "");
});

function modelReturning(text: string) {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }),
  });
}

test("scoreDiagnosis parses a valid judge reply", async () => {
  const c = MEDICAL_CASES[0];
  const s = await scoreDiagnosis(
    c,
    "初步诊断：社区获得性肺炎",
    modelReturning(
      '{"accuracy":90,"completeness":80,"standardization":85,"recommendation":70,"comments":"ok"}',
    ),
  );
  assert.equal(s.accuracy, 90);
  assert.equal(judgeTotal(s), 83.5);
});

test("scoreDiagnosis throws instead of returning default scores", async () => {
  const c = MEDICAL_CASES[0];
  await assert.rejects(
    scoreDiagnosis(c, "诊断", modelReturning("抱歉，我无法评分")),
    ScoringError,
  );
  await assert.rejects(scoreDiagnosis(c, "   ", modelReturning("{}")), ScoringError);
});
