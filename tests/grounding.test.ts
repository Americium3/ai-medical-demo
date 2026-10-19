import { test } from "node:test";
import assert from "node:assert/strict";
import { applyUpdates, emptyRecord } from "../backend/src/record";

// #5: a quote must be real evidence for the claim, not just any substring of what the patient said.

test("single-character, unrelated and negated quotes are rejected", () => {
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

test("short whole-turn answers are kept", () => {
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
