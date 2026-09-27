/** Export the TS case library and judge prompt as JSON for the Python (CrewAI) experiments. */
import { writeFileSync } from "node:fs";
import { MEDICAL_CASES } from "../src/data/cases";
import { MEDICAL_CONSULTATION_PROMPT, MEDICAL_SCORING_PROMPT } from "../src/lib/prompts";

writeFileSync("experiments/crewai/cases.json", JSON.stringify(MEDICAL_CASES, null, 2) + "\n");
writeFileSync(
  "experiments/crewai/prompts.json",
  JSON.stringify({ consultation: MEDICAL_CONSULTATION_PROMPT, scoring: MEDICAL_SCORING_PROMPT }, null, 2) + "\n",
);
console.log(`wrote ${MEDICAL_CASES.length} cases and prompts to experiments/crewai/`);
