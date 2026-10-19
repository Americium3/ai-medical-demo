import { RED_FLAG_RULES, matchRules, matchTurns, type Level, type RuleDef } from "../../../shared/safety/red-flags";
import type { RiskLevel } from "./schemas";

/**
 * The prototype's three risk levels over the one shared rule table
 * (shared/safety/red-flags.ts, four levels): Ⅰ/Ⅱ → emergency, Ⅲ → urgent.
 * Rules can only raise the level the LLM assigns, never lower it.
 */
export function toRiskLevel(level: Level): RiskLevel {
  return level <= 2 ? "emergency" : level === 3 ? "urgent" : "routine";
}

export const RED_FLAG_RULES_3: RuleDef<RiskLevel>[] = RED_FLAG_RULES.map((r) => ({ ...r, level: toRiskLevel(r.level) }));

export function matchRedFlagRules(text: string): { rule: string; level: RiskLevel; quote: string }[] {
  return matchRules(text, RED_FLAG_RULES_3);
}

/** Rule hits over everything the patient has said, one string per patient turn, matched turn by turn. */
export function matchPatientTurns(turns: string[]): { rule: string; level: RiskLevel; quote: string }[] {
  return matchTurns(turns, RED_FLAG_RULES_3);
}

const ORDER: Record<RiskLevel, number> = { routine: 0, urgent: 1, emergency: 2 };

export function maxLevel(...levels: RiskLevel[]): RiskLevel {
  return levels.reduce((a, b) => (ORDER[b] > ORDER[a] ? b : a), "routine");
}
