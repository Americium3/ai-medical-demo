import { test } from "node:test";
import assert from "node:assert/strict";
import { RED_FLAG_CASES } from "../evals/red-flags/cases";
import { matchPatientTurns as matchSrc } from "@/lib/agent/red-flags";
import { matchPatientTurns as matchBackend } from "../backend/src/triage";

// Driven by evals/red-flags/cases.json, the same set scripts/eval-red-flags.ts scores.

const impls = [
  { name: "src", match: matchSrc, rule: (c: (typeof RED_FLAG_CASES)[number]) => c.expect.srcRule },
  { name: "backend", match: matchBackend, rule: (c: (typeof RED_FLAG_CASES)[number]) => c.expect.backendRule },
];

for (const impl of impls) {
  test(`${impl.name}: every covered red flag fires its rule`, () => {
    const missed = RED_FLAG_CASES.filter((c) => c.kind === "redflag" && impl.rule(c) !== null)
      .filter((c) => !impl.match(c.turns).some((h) => h.rule === impl.rule(c)))
      .map((c) => `${c.id} ${c.turns.join(" / ")}`);
    assert.deepEqual(missed, []);
  });

  test(`${impl.name}: explicit denials and routine complaints fire nothing`, () => {
    const fired = RED_FLAG_CASES.filter((c) => c.kind !== "redflag")
      .map((c) => ({ c, hits: impl.match(c.turns) }))
      .filter(({ hits }) => hits.length > 0)
      .map(({ c, hits }) => `${c.id} ${c.turns.join(" / ")} → ${hits.map((h) => h.rule).join("、")}`);
    assert.deepEqual(fired, []);
  });
}
