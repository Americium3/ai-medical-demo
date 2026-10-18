/**
 * Risk levels follow the four-level emergency triage standard
 * (《急诊预检分诊专家共识》, design doc §3.3):
 *   1 濒危 · 2 危重 · 3 急症 · 4 非急症
 * Lower is more urgent. Deterministic rules over the patient's own words can
 * only make the level more urgent than the model's, never less.
 */

import { matchRules as matchSharedRules, matchTurns } from "../../shared/safety/red-flags";

export type Level = 1 | 2 | 3 | 4;

export const LEVEL_NAME: Record<Level, string> = { 1: "Ⅰ级 濒危", 2: "Ⅱ级 危重", 3: "Ⅲ级 急症", 4: "Ⅳ级 非急症" };

export const RULES: { rule: string; level: Level; pattern: RegExp }[] = [
  { rule: "意识丧失或呼吸停止", level: 1, pattern: /昏迷|叫不醒|呼吸停止|停止呼吸|没了呼吸|意识丧失/ },
  { rule: "胸痛伴大汗或持续不缓解", level: 2, pattern: /胸[口]?痛.{0,12}(大汗|出汗|不缓解|压榨|濒死)|(大汗|压榨).{0,12}胸[口]?痛/ },
  { rule: "呼吸困难", level: 2, pattern: /呼吸困难|喘不上气|喘不过气|憋得说不出话/ },
  { rule: "卒中征象", level: 2, pattern: /口角歪斜|嘴歪|说话不清|言语不清|一侧.{0,2}(无力|麻木)|偏瘫/ },
  { rule: "抽搐", level: 2, pattern: /抽搐|抽风/ },
  { rule: "消化道大出血", level: 2, pattern: /呕血|吐血|大量便血|柏油样/ },
  { rule: "突发剧烈头痛", level: 2, pattern: /(从来没有|这辈子最|炸裂|爆炸).{0,4}头痛|头痛.{0,4}(从来没有|最厉害)/ },
  { rule: "自伤风险", level: 2, pattern: /自杀|轻生|不想活/ },
  { rule: "活动相关胸闷胸痛", level: 3, pattern: /(活动|上楼|走快|运动|劳累).{0,10}胸(闷|痛)|胸(闷|痛).{0,10}(活动|上楼|走快|运动)/ },
  { rule: "高热", level: 3, pattern: /(39|40|41)(\.\d)?\s*(度|℃)/ },
  { rule: "黑便", level: 3, pattern: /黑便|大便发黑|便血/ },
];

export interface RuleHit {
  rule: string;
  level: Level;
  quote: string;
}

export function matchRules(text: string): RuleHit[] {
  return matchSharedRules(text, RULES);
}

/** Rule hits over everything the patient has said, one string per patient turn, matched turn by turn. */
export function matchPatientTurns(turns: string[]): RuleHit[] {
  return matchTurns(turns, RULES);
}

export function mostUrgent(...levels: Level[]): Level {
  return Math.min(4, ...levels) as Level;
}

/** Levels 1 and 2 stop the consultation and send the patient to the emergency department. */
export function isEmergency(level: Level): boolean {
  return level <= 2;
}
