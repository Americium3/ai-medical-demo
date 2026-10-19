import { z } from "zod";
import { getCaseById } from "@/data/cases";
import { getModelById, DEFAULT_MODEL_ID } from "@/data/models";
import { createGatewayLLM } from "@/lib/sim/gateway";
import { rateLimited } from "@/lib/rate-limit";
import { createLLMPatient, createScriptedPatient } from "@/lib/sim/patient";

export const runtime = "nodejs";
export const maxDuration = 30;

const bodySchema = z.object({
  caseId: z.string(),
  transcript: z.array(z.object({ role: z.enum(["patient", "agent"]), content: z.string().max(1000) })).max(30),
  questions: z.array(z.string().max(300)).min(1).max(3),
  model: z.string().optional(),
});

/**
 * Let a simulated patient (bound to a case's dialogue) answer the agent's questions.
 * Rate-limited per IP like /api/agent (#7); the model call stops if the browser disconnects.
 */
export async function POST(req: Request) {
  const limited = await rateLimited(req);
  if (limited) return limited;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  }
  const c = getCaseById(parsed.data.caseId);
  if (!c) return Response.json({ error: "Unknown case" }, { status: 404 });

  // Without a gateway key (or with AGENT_MOCK=1) the scripted patient answers from the case dialogue.
  const scripted = process.env.AGENT_MOCK === "1" || !process.env.AI_GATEWAY_API_KEY;
  try {
    const model = getModelById(parsed.data.model ?? DEFAULT_MODEL_ID) ?? getModelById(DEFAULT_MODEL_ID)!;
    const patient = scripted ? createScriptedPatient(c) : createLLMPatient(c, createGatewayLLM(model.gatewayId));
    const answer = await patient(parsed.data.transcript, parsed.data.questions, req.signal);
    return Response.json({ answer, scripted });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Patient simulator failed" }, { status: 502 });
  }
}
