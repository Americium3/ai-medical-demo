import { isGroundedQuote, normalize } from "../../../shared/safety/grounding";
import type { Fact, IntakeOutput, Turn } from "./schemas";

export { normalize };

export function patientText(transcript: Turn[]): string {
  return transcript
    .filter((t) => t.role === "patient")
    .map((t) => t.content)
    .join("\n");
}

/**
 * Keep only facts whose quote appears verbatim in one patient turn and is real
 * evidence for the statement (shared/safety/grounding.ts: not too short, related
 * to the statement, not something the patient denied).
 * This is the deterministic half of the anti-hallucination design: the model
 * may paraphrase in `statement`, but it must point at real patient words.
 */
export function groundFacts(
  facts: IntakeOutput["facts"],
  transcript: Turn[],
): { kept: Fact[]; dropped: IntakeOutput["facts"] } {
  const turns = transcript.filter((t) => t.role === "patient").map((t) => t.content);
  const kept: Fact[] = [];
  const dropped: IntakeOutput["facts"] = [];

  for (const f of facts) {
    if (isGroundedQuote(f.quote, turns, f.statement)) {
      kept.push({ ...f, id: `F${kept.length + 1}` });
    } else {
      dropped.push(f);
    }
  }
  return { kept, dropped };
}

export function formatFacts(facts: Fact[]): string {
  if (facts.length === 0) return "（暂无）";
  return facts
    .map((f) => `${f.id} [${f.category}] ${f.statement}（原话：「${f.quote}」）`)
    .join("\n");
}

export function formatTranscript(transcript: Turn[]): string {
  return transcript
    .map((t) => `${t.role === "patient" ? "患者" : "问诊助手"}：${t.content}`)
    .join("\n");
}
