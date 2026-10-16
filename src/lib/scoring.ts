import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";
import { buildScoringPrompt } from "@/lib/prompts";
import type { MedicalCase } from "@/data/cases";

export const judgeScoreSchema = z.object({
  accuracy: z.number().min(0).max(100),
  completeness: z.number().min(0).max(100),
  standardization: z.number().min(0).max(100),
  recommendation: z.number().min(0).max(100),
  comments: z.string(),
});

export type JudgeScore = z.infer<typeof judgeScoreSchema>;

export type ScoringCase = Pick<MedicalCase, "chiefComplaint" | "expectedDiagnosis">;

export class ScoringError extends Error {}

/**
 * Ask an LLM judge to score a diagnosis against the case's reference answer.
 * Throws ScoringError instead of inventing default scores, so a broken judge
 * can never be mistaken for a real result.
 */
export async function scoreDiagnosis(
  caseData: ScoringCase,
  aiResponse: string,
  model: LanguageModel,
): Promise<JudgeScore> {
  if (!aiResponse.trim()) {
    throw new ScoringError("诊断内容为空，无法评分");
  }

  try {
    const { output } = await generateText({
      model,
      output: Output.object({ schema: judgeScoreSchema }),
      prompt: buildScoringPrompt(caseData, aiResponse),
      maxOutputTokens: 500,
    });
    return output;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ScoringError(`评分裁判输出无法解析：${reason}`);
  }
}

/** Weighted total over the four judge dimensions (speed excluded), 0-100. */
export function judgeTotal(s: Omit<JudgeScore, "comments">): number {
  // Weights from SCORE_DIMENSIONS, renormalised without the 15% speed weight.
  const total =
    (s.accuracy * 0.3 +
      s.completeness * 0.25 +
      s.standardization * 0.2 +
      s.recommendation * 0.1) /
    0.85;
  return Math.round(total * 10) / 10;
}
