# Framework experiments (Phase 1)

Minimal, runnable demos used to learn each framework before building the agent.
All three run offline; set `AI_GATEWAY_API_KEY` to hit a real model instead.

| Demo | Run | Shows |
|---|---|---|
| `01-langchain-structured.ts` | `npx tsx experiments/01-langchain-structured.ts` | Prompt template → chat model → zod-validated structured output (LCEL pipe) |
| `02-langgraph-loop.ts` | `npx tsx experiments/02-langgraph-loop.ts` | State + reducers, conditional edge, capped retry loop, `interrupt()` human-in-the-loop |
| `crewai/crew_demo.py` | `pip install -r experiments/crewai/requirements.txt && python experiments/crewai/crew_demo.py` | Two role-played agents, sequential tasks, context passing |
| `crewai/crew_eval.py` | `python experiments/crewai/crew_eval.py --offline` | CrewAI version of the consultation (full-dialogue crew and a crew where the doctor interviews a patient agent via delegation), scored with the same judge |

`crewai/cases.json` and `crewai/prompts.json` are generated from `src/data/cases.ts` and `src/lib/prompts.ts` by `npx tsx scripts/export-cases.ts`.

Notes and the comparison live in [`docs/agent/FRAMEWORKS.md`](../docs/agent/FRAMEWORKS.md).
