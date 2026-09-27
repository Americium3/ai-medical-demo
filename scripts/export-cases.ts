/** Export the TS case library as JSON for the Python (CrewAI) experiments. */
import { writeFileSync } from "node:fs";
import { MEDICAL_CASES } from "../src/data/cases";

const out = "experiments/crewai/cases.json";
writeFileSync(out, JSON.stringify(MEDICAL_CASES, null, 2) + "\n");
console.log(`wrote ${MEDICAL_CASES.length} cases to ${out}`);
