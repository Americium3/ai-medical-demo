import raw from "./cases.json";

/**
 * Danger-signal test set shared by tests/red-flags.test.ts and scripts/eval-red-flags.ts.
 *
 * The two agents have different rule tables, so expectations are per implementation.
 * A null rule on a "redflag" case is a coverage gap (that implementation has no rule
 * for the symptom); it is reported separately and not counted as a miss.
 */
export interface RedFlagCase {
  id: string;
  kind: "redflag" | "denial" | "routine";
  /** Patient turns, in order. */
  turns: string[];
  expect: {
    srcRule: string | null;
    srcLevel: "routine" | "urgent" | "emergency";
    backendRule: string | null;
    backendLevel: 1 | 2 | 3 | 4;
  };
  tags: string[];
}

export const RED_FLAG_CASES = raw as RedFlagCase[];
