/**
 * The red-flag rule table and its matcher, with negation handling. This is the
 * only rule table in the repository (#13): backend/src/triage.ts uses it as is,
 * and the prototype in experiments/next-agent maps its levels.
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

/**
 * Four-level emergency triage (《急诊预检分诊专家共识》, docs/agent/DESIGN.md §3.3):
 *   1 濒危 · 2 危重 · 3 急症 · 4 非急症. Lower is more urgent.
 */
export type Level = 1 | 2 | 3 | 4;

export const LEVEL_NAME: Record<Level, string> = { 1: "Ⅰ级 濒危", 2: "Ⅱ级 危重", 3: "Ⅲ级 急症", 4: "Ⅳ级 非急症" };

/**
 * Deterministic rules over the patient's own words. They can only make the
 * level more urgent than the model's, never less. Small and conservative on
 * purpose: a safety net, not a triage system.
 */
export const RED_FLAG_RULES: RuleDef<Level>[] = [
  { rule: "意识丧失或呼吸停止", level: 1, pattern: /昏迷|叫不醒|呼吸停止|停止呼吸|没了呼吸|意识丧失/ },
  { rule: "意识改变或晕厥", level: 2, pattern: /意识(不清|模糊)|晕倒|晕厥|昏过去/ },
  { rule: "胸痛伴大汗或持续不缓解", level: 2, pattern: /胸[口]?痛.{0,12}(大汗|出汗|不缓解|压榨|濒死)|(大汗|压榨).{0,12}胸[口]?痛/ },
  { rule: "呼吸困难", level: 2, pattern: /呼吸困难|喘不上气|喘不过气|憋得说不出话/ },
  { rule: "卒中征象", level: 2, pattern: /口角歪斜|嘴歪|说话不清|言语不清|半边身子|一侧.{0,2}(无力|麻木)|偏瘫/ },
  { rule: "抽搐", level: 2, pattern: /抽搐|抽风/ },
  { rule: "消化道大出血", level: 2, pattern: /呕血|吐血|大量便血|柏油样/ },
  { rule: "突发剧烈头痛", level: 2, pattern: /(从来没有|这辈子最|炸裂|爆炸).{0,4}头痛|头痛.{0,4}(从来没有|最厉害)/ },
  { rule: "自伤风险", level: 2, pattern: /自杀|轻生|不想活/ },
  { rule: "活动相关胸闷胸痛", level: 3, pattern: /(活动|上楼|走快|运动|劳累).{0,10}胸(闷|痛)|胸(闷|痛).{0,10}(活动|上楼|走快|运动)/ },
  { rule: "不明原因体重下降", level: 3, pattern: /(瘦了|体重下降|体重减轻).{0,6}(\d+|[一二三四五六七八九十]+)\s*(公斤|斤|kg)/ },
  { rule: "高热", level: 3, pattern: /(39|40|41)(\.\d)?\s*(度|℃)/ },
  { rule: "黑便", level: 3, pattern: /黑便|大便发黑|便血/ },
];
