import { z } from "zod";

export const extractSchema = z.object({
  updates: z.array(
    z.object({
      slotId: z.string().describe("记录表中的要点编号"),
      status: z.enum(["answered", "unknown"]).describe("answered=患者给出了答案；unknown=患者表示不清楚"),
      value: z.string().describe("用规范医学语言概括的答案；unknown 时留空"),
      quote: z.string().describe("患者原话中逐字出现的片段；unknown 时留空"),
    }),
  ),
});
export type ExtractOutput = z.infer<typeof extractSchema>;

export const triageSchema = z.object({
  level: z.number().int().min(1).max(4).describe("1=濒危 2=危重 3=急症 4=非急症"),
  reason: z.string(),
});
export type TriageOutput = z.infer<typeof triageSchema>;

export const phraseSchema = z.object({
  questions: z.array(z.string()).describe("改写后的问题，与输入的要点一一对应"),
});
export type PhraseOutput = z.infer<typeof phraseSchema>;

const cited = z.object({
  text: z.string(),
  slotIds: z.array(z.string()).describe("这句话依据的记录表要点编号"),
});

export const noteSchema = z.object({
  chiefComplaint: cited,
  presentIllness: z.array(cited),
  pastHistory: z.array(cited),
  forDoctor: z.object({
    possibleCauses: z.array(
      z.object({ name: z.string(), reasoning: z.string(), slotIds: z.array(z.string()) }),
    ),
    suggestedTests: z.array(z.object({ name: z.string(), purpose: z.string() })),
  }),
});
export type NoteOutput = z.infer<typeof noteSchema>;

export const reviewSchema = z.object({
  pass: z.boolean(),
  issues: z.array(z.object({ type: z.string(), detail: z.string() })),
});
export type ReviewOutput = z.infer<typeof reviewSchema>;
