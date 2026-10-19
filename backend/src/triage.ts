/**
 * Triage levels and red-flag rules for the backend. The rule table and the
 * level scale live in shared/safety/red-flags.ts, the only copy (#13).
 */
import { LEVEL_NAME, RED_FLAG_RULES, matchRules as matchSharedRules, matchTurns, type Level } from "../../shared/safety/red-flags";

export { LEVEL_NAME, type Level };

export const RULES = RED_FLAG_RULES;

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
