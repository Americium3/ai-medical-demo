/**
 * Quote grounding shared by both agents: a fact (src) or a record entry
 * (backend) is kept only when its quote is real evidence for the claim.
 * Before #5 any substring of the patient's words passed, so a one-character
 * quote like 热 could "ground" 高热39℃.
 */
import { DENIAL_BEFORE, clauseBefore, maskNonNegating } from "./red-flags";

/** Strip whitespace and punctuation so quote matching ignores formatting. */
export function normalize(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
}

export type GroundingProblem = "empty" | "not_found" | "too_short" | "unrelated" | "negated";

/** Shorter quotes pass only when they are the whole turn (有, 没有, 三天). */
export const MIN_QUOTE_CHARS = 3;

/** Characters too common to show that a quote and a claim are about the same thing. */
const FILLER = /[了的有是我]/g;
const NEGATED_CLAIM = /没|无|不|否认|未|阴性/;

/** CJK characters and alphanumeric tokens of a text, minus filler. */
function tokens(text: string): Set<string> {
  const n = normalize(text).replace(FILLER, "");
  return new Set([...(n.match(/\p{Script=Han}/gu) ?? []), ...(n.match(/[a-z0-9]+/g) ?? [])]);
}

function sharesToken(quote: string, claim: string): boolean {
  const q = tokens(quote);
  return [...tokens(claim)].some((t) => q.has(t));
}

/** True when the patient denied what the quote says, e.g. quote 发烧 in 没有发烧. */
function deniedBefore(quote: string, turn: string): boolean {
  const at = turn.indexOf(quote.trim());
  if (at >= 0) return DENIAL_BEFORE.test(maskNonNegating(clauseBefore(turn, at)));
  // The quote differs only in formatting; fall back to the normalized text before it.
  const n = normalize(turn);
  const prefix = n.slice(0, n.indexOf(normalize(quote)));
  return DENIAL_BEFORE.test(maskNonNegating(prefix.slice(-8)));
}

/**
 * Why `quote` does not ground `claim` in one patient turn, or null when it does.
 * `claim` is the model's wording (a fact's statement, a slot's value); when it
 * is empty only the quote itself is checked.
 */
export function quoteProblem(quote: string, turn: string, claim: string): GroundingProblem | null {
  const needle = normalize(quote);
  const hay = normalize(turn);
  if (!needle) return "empty";
  if (!hay.includes(needle)) return "not_found";
  const wholeTurn = needle === hay;
  if (!wholeTurn && needle.length < MIN_QUOTE_CHARS) return "too_short";
  if (!wholeTurn && claim.trim() && !sharesToken(quote, claim)) return "unrelated";
  if (!NEGATED_CLAIM.test(claim) && deniedBefore(quote, turn)) return "negated";
  return null;
}

/**
 * Ground a quote against the patient's turns, one turn at a time, so a quote
 * stitched together across two turns never passes. Returns null when some
 * turn grounds it, otherwise the most specific problem found.
 */
export function groundingProblem(quote: string, turns: string[], claim: string): GroundingProblem | null {
  let worst: GroundingProblem = turns.length ? "not_found" : "empty";
  for (const turn of turns) {
    const p = quoteProblem(quote, turn, claim);
    if (p === null) return null;
    if (p !== "not_found" && p !== "empty") worst = p;
    else if (worst === "not_found" && p === "empty") worst = p;
  }
  return worst;
}

export function isGroundedQuote(quote: string, turns: string[], claim: string): boolean {
  return groundingProblem(quote, turns, claim) === null;
}
