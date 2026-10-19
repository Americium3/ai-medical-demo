/**
 * The question planner (DESIGN.md §7.3–7.4). Deterministic on purpose: given
 * the record table and what has already been asked, it decides which slots to
 * ask about next and when to stop. The language model only rephrases the
 * chosen questions; it never decides what to ask.
 */
import type { RecordTable } from "./record";
import { normalize } from "./record";
import { slotsFor, type Slot, type SlotKind, type Template } from "./templates";

export const DEFAULT_MAX_ROUNDS = 4;
export const QUESTIONS_PER_ROUND = 2;

const ORDER: SlotKind[] = ["redflag", "required", "discriminating", "optional"];

export interface AskedRound {
  round: number;
  slotIds: string[];
  text: string;
}

export interface PlanResult {
  done: boolean;
  reason: "complete" | "max_rounds" | "continue";
  slots: Slot[];
}

function bigrams(text: string): Set<string> {
  const n = normalize(text);
  const out = new Set<string>();
  for (let i = 0; i < n.length - 1; i++) out.add(n.slice(i, i + 2));
  return out;
}

/** Jaccard similarity of character bigrams, 0..1. Good enough to catch rephrased repeats. */
export function similarity(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  if (x.size === 0 || y.size === 0) return 0;
  let inter = 0;
  for (const g of x) if (y.has(g)) inter++;
  return inter / (x.size + y.size - inter);
}

export const REPEAT_THRESHOLD = 0.6;

/** True if a candidate question is too close to anything already asked. */
export function isRepeat(question: string, asked: AskedRound[]): boolean {
  return asked.some((r) => similarity(question, r.text) >= REPEAT_THRESHOLD);
}

export function plan(
  template: Template,
  record: RecordTable,
  asked: AskedRound[],
  maxRounds = DEFAULT_MAX_ROUNDS,
): PlanResult {
  const askedIds = new Set(asked.flatMap((r) => r.slotIds));
  const open = slotsFor(template).filter(
    // Layer 1 and 2 of duplicate control: only never-asked, still-open slots.
    (s) => record[s.id]?.status === "unasked" && !askedIds.has(s.id),
  );

  const requiredOpen = open.some((s) => s.kind === "redflag" || s.kind === "required");
  if (!requiredOpen && !open.some((s) => s.kind === "discriminating")) {
    return { done: true, reason: "complete", slots: [] };
  }
  if (asked.length >= maxRounds) {
    return { done: true, reason: "max_rounds", slots: [] };
  }

  const ranked = [...open].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  const chosen: Slot[] = [];
  for (const s of ranked) {
    // Layer 3: drop a question that reads like one already asked.
    if (isRepeat(s.question, asked)) continue;
    chosen.push(s);
    if (chosen.length === QUESTIONS_PER_ROUND) break;
  }
  if (chosen.length === 0) return { done: true, reason: "complete", slots: [] };
  return { done: false, reason: "continue", slots: chosen };
}
