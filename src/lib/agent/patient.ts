import type { MedicalCase } from "@/data/cases";
import type { AgentLLM } from "./llm";
import type { PatientSimulator } from "./graph";
import { normalize } from "./grounding";
import { patientPrompt } from "./prompts";
import { patientOutputSchema, type Turn } from "./schemas";

/**
 * The patient's opening line when the agent starts a case cold:
 * only the chief complaint, none of the dialogue's details.
 */
export function openingLine(c: MedicalCase): string {
  return `医生您好，我${c.chiefComplaint}。`;
}

/** LLM-played patient, constrained to what the case dialogue says. */
export function createLLMPatient(c: MedicalCase, llm: AgentLLM): PatientSimulator {
  return async (transcript: Turn[], questions: string[]) => {
    const out = await llm.invoke({
      task: "patient",
      schema: patientOutputSchema,
      ...patientPrompt(
        { age: c.patientInfo.age, gender: c.patientInfo.gender, chiefComplaint: c.chiefComplaint },
        c.dialogueHistory,
        transcript,
        questions,
      ),
      context: { questions },
    });
    return out.answer;
  };
}

/** Bigrams that appear in almost every question and carry no topic. */
const FILLER = new Set(["有没", "没有", "什么", "医生", "请问", "一下", "情况", "的时", "时候", "觉得", "大概", "会不", "不会"]);

function bigrams(text: string): Set<string> {
  const n = normalize(text);
  const out = new Set<string>();
  for (let i = 0; i < n.length - 1; i++) {
    const b = n.slice(i, i + 2);
    if (!FILLER.has(b)) out.add(b);
  }
  return out;
}

function overlap(a: Set<string>, b: Set<string>): number {
  let hits = 0;
  for (const x of a) if (b.has(x)) hits++;
  return hits;
}

/**
 * Offline patient: for each question, find the most similar doctor line in the
 * case dialogue and reply with the patient's answer to it.
 */
export function createScriptedPatient(c: MedicalCase): PatientSimulator {
  const pairs: { q: Set<string>; a: string }[] = [];
  c.dialogueHistory.forEach((turn, i) => {
    const next = c.dialogueHistory[i + 1];
    if (turn.role === "doctor" && next?.role === "patient") {
      pairs.push({ q: bigrams(turn.content), a: next.content });
    }
  });

  return async (_transcript, questions) => {
    const answers = questions.map((q) => {
      const qb = bigrams(q);
      const best = pairs
        .map((p) => ({ a: p.a, score: overlap(qb, p.q) }))
        .sort((x, y) => y.score - x.score)[0];
      return best && best.score >= 2 ? best.a : "这个我不太清楚。";
    });
    return [...new Set(answers)].join("");
  };
}
