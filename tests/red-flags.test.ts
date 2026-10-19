import { test } from "node:test";
import assert from "node:assert/strict";
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
