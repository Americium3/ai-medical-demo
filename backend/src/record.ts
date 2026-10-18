import { isGroundedQuote, normalize } from "../../shared/safety/grounding";

/**
 * The consultation record table (design doc §7.2, §8.2): one entry per
 * template slot, saved with the graph state after every step. It is the
 * agent's memory of what has been asked and answered.
 */

export type SlotStatus = "unasked" | "answered" | "unknown";

export interface SlotEntry {
  status: SlotStatus;
  /** Clinical wording of the answer. */
  value?: string;
  /** The patient's own words, verbatim. */
  quote?: string;
  /** Question round in which the slot was settled (0 = from the complaint). */
  round?: number;
}

export type RecordTable = Record<string, SlotEntry>;

export function emptyRecord(slotIds: string[]): RecordTable {
  return Object.fromEntries(slotIds.map((id) => [id, { status: "unasked" as const }]));
}

export { normalize };

export interface SlotUpdate {
  slotId: string;
  status: "answered" | "unknown";
  value?: string;
  quote?: string;
}

/**
 * Apply model-proposed updates, keeping only those that are grounded:
 * the slot must exist, and an "answered" update must quote text that really
 * appears in what the patient said and supports the value
 * (shared/safety/grounding.ts). Returns the new table and the rejects.
 */
export function applyUpdates(
  record: RecordTable,
  updates: SlotUpdate[],
  patientText: string,
  round: number,
): { record: RecordTable; rejected: SlotUpdate[] } {
  const next: RecordTable = { ...record };
  const rejected: SlotUpdate[] = [];

  for (const u of updates) {
    if (!(u.slotId in next)) {
      rejected.push(u);
      continue;
    }
    if (u.status === "answered") {
      if (!isGroundedQuote(u.quote ?? "", [patientText], u.value ?? "")) {
        rejected.push(u);
        continue;
      }
      next[u.slotId] = { status: "answered", value: u.value?.trim() || u.quote, quote: u.quote, round };
    } else if (next[u.slotId].status === "unasked") {
      // "Not sure" never overwrites a real answer.
      next[u.slotId] = { status: "unknown", round };
    }
  }
  return { record: next, rejected };
}

export function countByStatus(record: RecordTable): Record<SlotStatus, number> {
  const out: Record<SlotStatus, number> = { unasked: 0, answered: 0, unknown: 0 };
  for (const e of Object.values(record)) out[e.status]++;
  return out;
}
