# AI Medical Demo Report (CN/US)

Date: 2026-02-26

## Purpose
This report summarizes high-level, market-style estimates for common visit reasons in China and the US, plus AI triage coverage assumptions (baseline, with devices, with nurse, with doctor). It is designed for landing page reference, not for clinical or regulatory use.

## Scope and caveats
- Scope: outpatient + emergency visits, all-age population, recent years.
- Data basis: public summaries and industry consensus only.
- Not an official statistical statement or medical advice.

## Common visit reasons (China, rough distribution, high to low)
- Respiratory infections / upper respiratory issues: 25% to 35%
- Digestive issues (gastritis, dyspepsia, diarrhea, reflux): 15% to 25%
- Musculoskeletal pain (neck/shoulder/back, joint pain): 10% to 18%
- Dermatology / allergy (dermatitis, eczema, urticaria, acne): 6% to 12%
- ENT (rhinitis, sinusitis, otitis, tonsillitis): 5% to 10%
- Chronic disease follow-up (hypertension, diabetes, lipids): 5% to 10%
- Ophthalmology (conjunctivitis, dry eye, eye fatigue): 3% to 6%
- Oral care (caries, periodontal issues, ulcers): 2% to 5%
- Gynecology common issues: 2% to 5%
- Other (trauma, urinary, pediatrics mix): 5% to 12%

## Common visit reasons (US, rough distribution, high to low)
- Respiratory infections / upper respiratory issues: 18% to 28%
- Chronic disease management (hypertension, diabetes, obesity-related): 12% to 22%
- Musculoskeletal pain / injury (back pain, joint pain, sports injury): 10% to 18%
- Allergy / asthma: 6% to 12%
- Dermatology (rash, dermatitis, acne): 5% to 10%
- Digestive issues (gastroenteritis, reflux, constipation): 5% to 10%
- Mental health / sleep (anxiety, depression, insomnia): 4% to 8%
- ENT / eye common issues: 3% to 6%
- Oral care: 2% to 4%
- Other (urinary, gynecology, trauma, pediatrics mix): 6% to 12%

## CN vs US (directional differences)
- CN higher: respiratory + digestive outpatient visits.
- US higher: chronic disease follow-up, mental health, allergy/asthma.
- Shared: respiratory, musculoskeletal pain, dermatology are top-tier across both.

## AI triage coverage (rough ranges)
Definition: "coverage" means AI can complete initial screening and give a reasonable direction (self-care, outpatient, ER, specialty). Ranges vary by model, prompt, and compliance rules.

### Baseline AI (no devices, no clinician in loop)
- Category-level coverage: 70% to 85%
- Visit-reason coverage: 65% to 80%

### With devices + nurse
Assumes vitals + basic POCT (BP, temp, SpO2, glucose, urine dip, ECG, optional CRP).
- Triage coverage: 80% to 92%
- Clear routing coverage: 75% to 88%

### With doctor in the loop
Assumes doctor review or co-visit; doctor can override AI.
- Triage coverage: 90% to 98%
- Clear routing coverage: 85% to 95%

## Key factors that move coverage up or down
- Input quality (structured history, med list, symptom timeline).
- Availability of objective measures (vitals, POCT, ECG).
- Safety policy (conservative routing reduces apparent coverage).
- Case mix (rare disease, multi-comorbidity, multi-system symptoms).

## Suggested landing page phrasing (safe, market-style)
- "AI supports initial triage for most common outpatient complaints."
- "Coverage improves with vitals, rapid tests, and clinician-in-the-loop review."
- "Designed for direction and risk flagging, not final diagnosis."

## References and limitations
- This report uses high-level public summaries and industry consensus.
- For official percentages, provide a specific dataset (yearbook or CDC/NCHS tables).
