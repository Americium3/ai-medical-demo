import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { RED_FLAG_CASES } from "../evals/red-flags/cases";
import { matchPatientTurns, mostUrgent } from "../backend/src/triage";

// Driven by evals/red-flags/cases.json, the same set scripts/eval-red-flags.ts scores.

test("every covered red flag fires its rule at its level", () => {
  const missed = RED_FLAG_CASES.filter((c) => c.kind === "redflag" && c.expect.rule !== null)
    .filter((c) => {
      const hits = matchPatientTurns(c.turns);
      return !hits.some((h) => h.rule === c.expect.rule) || mostUrgent(...hits.map((h) => h.level)) !== c.expect.level;
    })
    .map((c) => `${c.id} ${c.turns.join(" / ")}`);
  assert.deepEqual(missed, []);
});

test("explicit denials and routine complaints fire nothing", () => {
  const fired = RED_FLAG_CASES.filter((c) => c.kind !== "redflag")
    .map((c) => ({ c, hits: matchPatientTurns(c.turns) }))
    .filter(({ hits }) => hits.length > 0)
    .map(({ c, hits }) => `${c.id} ${c.turns.join(" / ")} → ${hits.map((h) => h.rule).join("、")}`);
  assert.deepEqual(fired, []);
});

test("no patient turn from the real Bedrock eval runs fires a level I/II rule", () => {
  // The six demo cases are not emergencies; every I/II hit in these transcripts was a misread denial.
  const dir = "docs/agent/eval";
  const files = readdirSync(dir).filter((f) => /^backend-results-bedrock.*\.json$/.test(f));
  assert.ok(files.length >= 2, "real eval results are committed");
  const fired: string[] = [];
  let turns = 0;
  for (const f of files) {
    for (const r of JSON.parse(readFileSync(path.join(dir, f), "utf8")).results as { caseId: string; transcript?: { role: string; content: string }[] }[]) {
      const said = (r.transcript ?? []).filter((t) => t.role === "patient").map((t) => t.content);
      turns += said.length;
      for (const h of matchPatientTurns(said)) if (h.level <= 2) fired.push(`${f} ${r.caseId}: ${h.rule}「${h.quote}」`);
    }
  }
  assert.ok(turns > 100);
  assert.deepEqual(fired, []);
});
