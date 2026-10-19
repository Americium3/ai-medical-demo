import raw from "./cases.json";

/**
 * Danger-signal test set shared by tests/red-flags.test.ts and scripts/eval-red-flags.ts.
 *
 * Expectations are against the one rule table, shared/safety/red-flags.ts (#13).
 * A null rule on a "redflag" case would be a coverage gap (no rule for the
 * symptom); it is reported separately and not counted as a miss.
 */
export interface RedFlagCase {
  id: string;
  kind: "redflag" | "denial" | "routine";
  /** Patient turns, in order. */
  turns: string[];
  expect: {
    rule: string | null;
    level: 1 | 2 | 3 | 4;
  };
  tags: string[];
}

export const RED_FLAG_CASES = raw as RedFlagCase[];
