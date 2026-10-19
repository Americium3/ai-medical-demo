/**
 * Simulated patients for evaluations and the /agent page's demo cases. Not
 * part of any agent: they only answer questions about one case's dialogue.
 */
import { z } from "zod";
import type { MedicalCase } from "@/data/cases";
import { normalize } from "../../../shared/safety/grounding";
import type { AgentLLM } from "./gateway";

export type Turn = { role: "patient" | "agent"; content: string };

/** Answers the agent's questions during an offline evaluation. */
export type PatientSimulator = (transcript: Turn[], questions: string[]) => Promise<string>;

export const patientOutputSchema = z.object({
  answer: z.string().describe("患者的口语化回答"),
});

function formatTranscript(transcript: Turn[]): string {
  return transcript.map((t) => `${t.role === "patient" ? "患者" : "问诊助手"}：${t.content}`).join("\n");
}

export function patientPrompt(
  profile: { age: number; gender: string; chiefComplaint: string },
  caseDialogue: { role: "doctor" | "patient"; content: string }[],
  transcript: Turn[],
  questions: string[],
) {
  return {
    system: `你在扮演一位来门诊看病的患者（${profile.age}岁，${profile.gender}）。
规则：
1. 只能根据下面「病例资料」里患者说过的内容回答，不要编造新的症状、数字或病史。
2. 病例资料里没有的信息，就说「这个我不太清楚」或「没注意」。
3. 口语化、简短，像普通人说话。不要说出任何医学诊断名。
4. 只回答医生这次问到的问题。

病例资料（医生与你之前的真实对话）：
${caseDialogue.map((d) => `${d.role === "doctor" ? "医生" : "患者"}：${d.content}`).join("\n")}`,
    user: `到目前为止的对话：\n${formatTranscript(transcript)}\n\n医生现在问：${questions.join(" ")}`,
  };
}

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
