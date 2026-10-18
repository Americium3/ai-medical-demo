import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCheckpointer } from "../src/config";
import { GUIDELINES, retrieve } from "../src/guidelines";
import { createMockLLM } from "../src/mock-llm";
import { ConsultationService } from "../src/service";

// #12: doctor-side suggestions cite retrieved guideline passages.

const tmpDb = () => path.join(mkdtempSync(path.join(tmpdir(), "consult-")), "db.sqlite");
const UNSURE = "这个我不太清楚。";

async function complete(service: ConsultationService, complaint: string, reply = UNSURE) {
  let v = await service.start(complaint, "k");
  while (v.status === "awaiting_answer") v = await service.answer(v.id, reply, "k");
  return v;
}

test("every passage names its source document", () => {
  assert.ok(GUIDELINES.length >= 10);
  assert.equal(new Set(GUIDELINES.map((g) => g.id)).size, GUIDELINES.length, "passage ids are unique");
  for (const g of GUIDELINES) assert.ok(g.source.title && g.source.org && g.source.year, `${g.id} has no full source`);
});

test("retrieval finds the guideline for the complaint", () => {
  const top = (q: string) => retrieve(q, 4).map((h) => h.passage.id);
  assert.ok(top("反复胸闷心悸两周，活动后加重，上楼更明显").some((id) => id.startsWith("chest")));
  assert.ok(top("咳嗽发热一周，伴有黄痰，最高39度").some((id) => id.startsWith("resp")));
  assert.ok(top("多饮多尿两个月，体重下降5公斤").some((id) => id.startsWith("endo")));
  assert.ok(top("腰背疼痛三个月，伴左下肢放射痛").some((id) => id.startsWith("back")));
  assert.deepEqual(retrieve("今天天气不错", 4), [], "no passage for an unrelated query");
});

test("each suggestion in a completed note cites a retrieved guideline, and the note shows the source", async () => {
  const service = new ConsultationService(createMockLLM(), createCheckpointer(tmpDb()));
  const v = await complete(service, "我胸闷两周了，上楼更明显");
  assert.equal(v.status, "completed");
  const s = await service.state(v.id);
  const suggestions = [...s.note!.forDoctor.possibleCauses, ...s.note!.forDoctor.suggestedTests];
  assert.ok(suggestions.length > 0, "the offline note suggests at least one test");
  assert.ok(s.guidelineIds.length > 0);
  for (const x of suggestions) {
    assert.ok(x.sources.length > 0, `${x.name} has no source`);
    for (const id of x.sources) assert.ok(s.guidelineIds.includes(id), `${x.name} cites ${id}, which was not retrieved`);
  }
  const title = GUIDELINES.find((g) => g.id === suggestions[0].sources[0])!.source.title;
  assert.ok(v.output!.includes(title), "the rendered note names the guideline");
});

test("the self-check rejects a suggestion without a source or citing a passage that was not retrieved", async () => {
  const llm = createMockLLM({
    note: (_c: never, n: number) => ({
      chiefComplaint: { text: "胸闷两周", slotIds: [] },
      presentIllness: [],
      pastHistory: [],
      forDoctor: {
        possibleCauses: [{ name: "稳定型心绞痛", reasoning: "活动后加重", slotIds: [], sources: n === 0 ? [] : ["chest-angina-ctca"] }],
        suggestedTests: [{ name: "腰椎MRI", purpose: "排查", sources: ["back-imaging"] }],
      },
    }),
  });
  const service = new ConsultationService(llm, createCheckpointer(tmpDb()));
  const v = await complete(service, "我胸闷两周了，上楼更明显");
  const s = await service.state(v.id);
  assert.ok(s.reviewFailures >= 1, "the note was sent back for a rewrite");
  assert.ok(s.issues.some((i) => i.includes("腰椎MRI") && i.includes("back-imaging")), `issues: ${s.issues.join(" | ")}`);
  assert.ok(!s.issues.some((i) => i.includes("稳定型心绞痛")), "the rewrite fixed the missing source");
});
