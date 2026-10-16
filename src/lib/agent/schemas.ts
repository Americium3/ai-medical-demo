import { z } from "zod";

/** One line of the consultation, as the agent sees it. */
export type Turn = { role: "patient" | "agent"; content: string };

export const FACT_CATEGORIES = [
  "chief_complaint",
  "onset_duration",
  "character",
  "associated",
  "negative",
  "trigger",
  "history",
  "medication",
  "allergy",
  "family_social",
  "other",
] as const;
export type FactCategory = (typeof FACT_CATEGORIES)[number];

export const MISSING_TOPICS = [
  "onset_duration",
  "character",
  "associated",
  "trigger",
  "history",
  "medication",
  "allergy",
  "family_social",
] as const;
export type MissingTopic = (typeof MISSING_TOPICS)[number];

// ---- intake -------------------------------------------------------------

export const intakeOutputSchema = z.object({
  facts: z
    .array(
      z.object({
        category: z.enum(FACT_CATEGORIES),
        statement: z.string().describe("用规范医学语言复述的一条事实"),
        quote: z
          .string()
          .describe("患者原话中逐字出现的片段，作为这条事实的依据，不得改写"),
      }),
    )
    .describe("只包含患者明确说过的信息"),
  missing: z
    .array(
      z.object({
        topic: z.enum(MISSING_TOPICS),
        why: z.string().describe("为什么这个信息对鉴别诊断重要"),
      }),
    )
    .describe("还缺的关键信息，按重要性排序"),
  enoughInfo: z.boolean().describe("现有信息是否足够做初步鉴别诊断"),
});
export type IntakeOutput = z.infer<typeof intakeOutputSchema>;

/** A fact after grounding: it has a stable id and its quote was found verbatim. */
export type Fact = IntakeOutput["facts"][number] & { id: string };

// ---- red flags ----------------------------------------------------------

export const RISK_LEVELS = ["routine", "urgent", "emergency"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const redFlagOutputSchema = z.object({
  level: z.enum(RISK_LEVELS),
  flags: z.array(
    z.object({
      name: z.string().describe("危险信号名称，如：持续胸痛、意识改变"),
      factIds: z.array(z.string()).describe("支撑该信号的事实 id"),
    }),
  ),
  reason: z.string(),
});
export type RedFlagOutput = z.infer<typeof redFlagOutputSchema>;

export type RedFlagResult = RedFlagOutput & {
  /** Rule hits found deterministically in the patient's own words. */
  ruleHits: { rule: string; level: RiskLevel; quote: string }[];
};

// ---- ask ----------------------------------------------------------------

export const askOutputSchema = z.object({
  // Bounds are enforced in code (graph.ts), not in the schema: a model that
  // returns three questions should be trimmed, not fail the whole turn.
  questions: z.array(z.string()).describe("下一轮要问患者的问题，口语化，最多两个"),
  rationale: z.string().describe("为什么问这些"),
});
export type AskOutput = z.infer<typeof askOutputSchema>;

// ---- differential -------------------------------------------------------

export const differentialOutputSchema = z.object({
  primary: z.object({
    name: z.string(),
    confidence: z.enum(["高", "中", "低"]),
    reasoning: z.string(),
    factIds: z.array(z.string()).describe("支持该诊断的事实 id，必须来自事实列表"),
  }),
  differentials: z
    .array(
      z.object({
        name: z.string(),
        reasoning: z.string(),
        factIds: z.array(z.string()),
      }),
    )
    .describe("2-3 个鉴别诊断"),
});
export type DifferentialOutput = z.infer<typeof differentialOutputSchema>;

// ---- plan ---------------------------------------------------------------

export const planOutputSchema = z.object({
  physicalExam: z.array(z.string()),
  tests: z.array(z.object({ name: z.string(), purpose: z.string() })),
  medications: z.array(
    z.object({ name: z.string(), note: z.string().describe("用法要点或注意事项") }),
  ),
  advice: z.array(z.string()),
});
export type PlanOutput = z.infer<typeof planOutputSchema>;

// ---- self check ---------------------------------------------------------

export const ISSUE_TYPES = [
  "unsupported_claim",
  "overconfident",
  "missed_red_flag",
  "unsafe_medication",
  "inconsistent",
] as const;

export const selfCheckOutputSchema = z.object({
  pass: z.boolean(),
  issues: z.array(
    z.object({
      type: z.enum(ISSUE_TYPES),
      detail: z.string().describe("具体指出哪句话、为什么有问题、应如何修改"),
    }),
  ),
});
export type SelfCheckOutput = z.infer<typeof selfCheckOutputSchema>;
export type SelfCheckIssue = SelfCheckOutput["issues"][number] | {
  type: "unknown_fact_id" | "no_evidence";
  detail: string;
};

// ---- simulated patient --------------------------------------------------

export const patientOutputSchema = z.object({
  answer: z.string().describe("患者的口语化回答"),
});
export type PatientOutput = z.infer<typeof patientOutputSchema>;
