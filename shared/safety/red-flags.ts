/**
 * Red-flag rule matching with negation handling, shared by both agents
 * (src/lib/agent/red-flags.ts and backend/src/triage.ts). Each agent keeps its
 * own rule table because the levels differ; merging the tables is #13.
 *
 * A rule is skipped only on an explicit denial of the matched symptom:
 *   1. Only the clause that holds the match counts. Clauses end at punctuation,
 *      a line break, or a contrast word (但/但是/可是/不过/却).
 *   2. Words that contain 不/无/没 but do not negate (不时, 无缘无故, 是不是, ...)
 *      are masked first.
 *   3. A denial cue must sit directly before the symptom, with at most a short
 *      filler from a fixed list in between: 否认有明显的呼吸困难 is a denial,
 *      不时呼吸困难 is not.
 * Callers match each patient turn separately, so a "没" answering the previous
 * question never negates the next turn.
 */

export interface RuleDef<L> {
  rule: string;
  level: L;
  pattern: RegExp;
}

export interface RuleMatch<L> {
  rule: string;
  level: L;
  quote: string;
}

/** Ends a clause: punctuation, a line break, or a contrast word. */
const CLAUSE_BREAK = /[，。,.!！?？、；;：:\n]|但是|但|可是|不过|却/g;

/** Contain a negation character but do not deny anything. Longest first. */
const NON_NEGATING = /不知不觉|无缘无故|毫无征兆|没完没了|止不住|不知道|不舒服|受不了|是不是|不时|不停|不断|不止|无力/g;

/** A denial cue, then optional filler words, then the end of the prefix (= the symptom). */
export const DENIAL_BEFORE = /(没有|没|无|未|否认|不)(有|出现|感到|觉得|明显的?|什么){0,3}$/;

/** Replace each non-negating word with same-length placeholders, so indices stay valid. */
export function maskNonNegating(text: string): string {
  return text.replace(NON_NEGATING, (m) => "□".repeat(m.length));
}

/** Text from the start of the clause holding `index` up to `index`. */
export function clauseBefore(text: string, index: number): string {
  let start = 0;
  for (const m of text.slice(0, index).matchAll(CLAUSE_BREAK)) start = (m.index ?? 0) + m[0].length;
  return text.slice(start, index);
}

/** True when the text right before `index` explicitly denies what starts there. */
export function isDeniedAt(text: string, index: number): boolean {
  return DENIAL_BEFORE.test(maskNonNegating(clauseBefore(text, index)));
}

/** First non-denied match of each rule in one piece of text. */
export function matchRules<L>(text: string, rules: RuleDef<L>[]): RuleMatch<L>[] {
  const hits: RuleMatch<L>[] = [];
  for (const r of rules) {
    for (const m of text.matchAll(new RegExp(r.pattern.source, "g"))) {
      if (isDeniedAt(text, m.index ?? 0)) continue;
      hits.push({ rule: r.rule, level: r.level, quote: m[0] });
      break;
    }
  }
  return hits;
}

/** Match each patient turn on its own; one hit per rule, from the earliest turn. */
export function matchTurns<L>(turns: string[], rules: RuleDef<L>[]): RuleMatch<L>[] {
  const byRule = new Map<string, RuleMatch<L>>();
  for (const turn of turns) {
    for (const h of matchRules(turn, rules)) if (!byRule.has(h.rule)) byRule.set(h.rule, h);
  }
  // Keep the rule table's order, as a single-text match would.
  return rules.flatMap((r) => byRule.get(r.rule) ?? []);
}
