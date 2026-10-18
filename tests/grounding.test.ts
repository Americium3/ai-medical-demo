import { test } from "node:test";
import assert from "node:assert/strict";
import { groundFacts } from "@/lib/agent/grounding";
import type { Turn } from "@/lib/agent/schemas";
import { applyUpdates, emptyRecord } from "../backend/src/record";

// #5: a quote must be real evidence for the claim, not just any substring of what the patient said.

const patient = (content: string): Turn => ({ role: "patient", content });
const agent = (content: string): Turn => ({ role: "agent", content });

test("src: single-character, unrelated, negated and cross-turn quotes are dropped", () => {
  const transcript = [
    patient("我咳嗽一周了，晚上有点热。"),
    agent("有没有发烧？胸口痛吗？"),
    patient("没有发烧"),
    patient("胸口"),
    patient("痛得厉害"),
  ];
  const { kept, dropped } = groundFacts(
    [
      { category: "associated", statement: "高热39℃", quote: "热" }, // one character
      { category: "associated", statement: "高热39℃", quote: "晚上有点" }, // shares nothing with the claim
      { category: "associated", statement: "发热", quote: "发烧" }, // patient said 没有发烧
      { category: "associated", statement: "胸口痛", quote: "胸口痛得" }, // only exists across two turns
      { category: "onset_duration", statement: "咳嗽一周", quote: "咳嗽一周" }, // fine
    ],
    transcript,
  );
  assert.deepEqual(kept.map((f) => f.quote), ["咳嗽一周"]);
  assert.deepEqual(dropped.map((f) => f.quote), ["热", "晚上有点", "发烧", "胸口痛得"]);
});

test("src: short answers that are a whole turn, and negated claims, are kept", () => {
  const transcript = [patient("头痛三天了"), agent("以前有过吗？"), patient("没有"), agent("持续多久？"), patient("三天")];
  const { kept } = groundFacts(
    [
      { category: "history", statement: "否认既往类似发作", quote: "没有" },
      { category: "onset_duration", statement: "持续三天", quote: "三天" },
    ],
    transcript,
  );
  assert.equal(kept.length, 2);
  const { kept: neg } = groundFacts([{ category: "negative", statement: "否认胸口痛", quote: "胸口痛" }], [patient("没有胸口痛，就是咳嗽")]);
  assert.equal(neg.length, 1, "a negated claim may quote the denied symptom");
});

test("backend: single-character, unrelated and negated quotes are rejected", () => {
  const record = emptyRecord(["fever_max", "sputum", "dyspnea"]);
  const { record: next, rejected } = applyUpdates(
    record,
    [
      { slotId: "fever_max", status: "answered", value: "高热39℃", quote: "热" },
      { slotId: "sputum", status: "answered", value: "黄痰", quote: "晚上有点" },
      { slotId: "dyspnea", status: "answered", value: "气喘", quote: "喘" },
    ],
    "晚上有点热，不喘",
    1,
  );
  assert.deepEqual(rejected.map((r) => r.slotId), ["fever_max", "sputum", "dyspnea"]);
  assert.equal(next.fever_max.status, "unasked");

  const { rejected: negated } = applyUpdates(
    emptyRecord(["dyspnea"]),
    [{ slotId: "dyspnea", status: "answered", value: "活动后气喘", quote: "喘不上气" }],
    "没有喘不上气，就是咳嗽",
    1,
  );
  assert.equal(negated.length, 1, "the patient denied it");
});

test("backend: short whole-turn answers are kept", () => {
  const { record, rejected } = applyUpdates(
    emptyRecord(["dyspnea", "onset", "sputum"]),
    [
      { slotId: "dyspnea", status: "answered", value: "无气喘", quote: "没有" },
      { slotId: "onset", status: "answered", value: "三天", quote: "三天" },
    ],
    "三天",
    1,
  );
  // "没有" is not in this turn, so only onset is kept.
  assert.deepEqual(rejected.map((r) => r.slotId), ["dyspnea"]);
  assert.equal(record.onset.status, "answered");
  const yes = applyUpdates(emptyRecord(["sputum"]), [{ slotId: "sputum", status: "answered", value: "有痰", quote: "有" }], "有。", 1);
  assert.equal(yes.record.sputum.status, "answered");
});
