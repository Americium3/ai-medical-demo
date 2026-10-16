import { z } from "zod";
import { getCaseById } from "@/data/cases";
import { AgentConfigError, resolveAgentLLM } from "@/lib/agent/config";
import { createLLMPatient, createScriptedPatient } from "@/lib/agent/patient";

export const runtime = "nodejs";
export const maxDuration = 30;

const bodySchema = z.object({
  caseId: z.string(),
  transcript: z.array(z.object({ role: z.enum(["patient", "agent"]), content: z.string().max(1000) })).max(30),
  questions: z.array(z.string().max(300)).min(1).max(3),
  model: z.string().optional(),
});

/** Let a simulated patient (bound to a case's dialogue) answer the agent's questions. */
export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  }
  const c = getCaseById(parsed.data.caseId);
  if (!c) return Response.json({ error: "Unknown case" }, { status: 404 });

  try {
    const llm = resolveAgentLLM(parsed.data.model);
    const patient = llm.kind === "mock" ? createScriptedPatient(c) : createLLMPatient(c, llm);
    const answer = await patient(parsed.data.transcript, parsed.data.questions);
    return Response.json({ answer });
  } catch (err) {
    const status = err instanceof AgentConfigError ? 500 : 502;
    return Response.json({ error: err instanceof Error ? err.message : "Patient simulator failed" }, { status });
  }
}
