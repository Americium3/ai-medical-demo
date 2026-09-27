import type { RiskLevel } from "./schemas";

/**
 * Deterministic red-flag rules over the patient's own words.
 * They can only raise the risk level the LLM assigns, never lower it.
 * Deliberately small and conservative: this is a safety net, not a triage system.
 */
export const RED_FLAG_RULES: { rule: string; level: RiskLevel; pattern: RegExp }[] = [
  { rule: "胸痛伴大汗/持续不缓解", level: "emergency", pattern: /胸[口]?痛.{0,12}(大汗|出汗|不缓解|压榨|濒死)|(大汗|压榨).{0,12}胸[口]?痛/ },
  { rule: "呼吸困难", level: "emergency", pattern: /呼吸困难|喘不上气|喘不过气|憋得说不出话/ },
  { rule: "意识改变/晕厥", level: "emergency", pattern: /意识(不清|模糊)|昏迷|晕倒|晕厥|昏过去/ },
  { rule: "卒中征象", level: "emergency", pattern: /口角歪斜|嘴歪|说话不清|言语不清|半边身子|一侧.{0,2}(无力|麻木)|偏瘫/ },
  { rule: "抽搐", level: "emergency", pattern: /抽搐|抽风/ },
  { rule: "消化道大出血", level: "emergency", pattern: /呕血|吐血|大量便血|柏油样/ },
  { rule: "最剧烈头痛", level: "emergency", pattern: /(从来没有|这辈子最|炸裂|爆炸).{0,4}头痛|头痛.{0,4}(从来没有|最厉害)/ },
  { rule: "自伤风险", level: "emergency", pattern: /自杀|轻生|不想活/ },
  { rule: "活动相关胸闷/胸痛", level: "urgent", pattern: /(活动|上楼|走快|运动|劳累).{0,10}胸(闷|痛)|胸(闷|痛).{0,10}(活动|上楼|走快|运动)后/ },
  { rule: "不明原因体重下降", level: "urgent", pattern: /(瘦了|体重下降|体重减轻).{0,6}(\d+|[一二三四五六七八九十]+)\s*(公斤|斤|kg)/ },
  { rule: "高热", level: "urgent", pattern: /(39|40|41)(\.\d)?\s*(度|℃)/ },
  { rule: "黑便/便血", level: "urgent", pattern: /黑便|便血/ },
];

const NEGATION = /(没有|没|无|不|否认|未)[^，。,.!！?？]{0,3}$/;

export function matchRedFlagRules(
  text: string,
): { rule: string; level: RiskLevel; quote: string }[] {
  const hits: { rule: string; level: RiskLevel; quote: string }[] = [];
  for (const r of RED_FLAG_RULES) {
    const re = new RegExp(r.pattern.source, "g");
    for (const m of text.matchAll(re)) {
      const before = text.slice(Math.max(0, (m.index ?? 0) - 6), m.index);
      if (NEGATION.test(before)) continue; // "没有呼吸困难"
      hits.push({ rule: r.rule, level: r.level, quote: m[0] });
      break;
    }
  }
  return hits;
}

const ORDER: Record<RiskLevel, number> = { routine: 0, urgent: 1, emergency: 2 };

export function maxLevel(...levels: RiskLevel[]): RiskLevel {
  return levels.reduce((a, b) => (ORDER[b] > ORDER[a] ? b : a), "routine");
}
