import { z } from "zod";
import { AgentConfigError, resolveAgentLLM } from "@/lib/agent/config";
import { runConsultation } from "@/lib/agent/run";

export const runtime = "nodejs";
// A final turn runs up to ~11 model calls (with two self-check rewrites).
export const maxDuration = 60;

const bodySchema = z.object({
  transcript: z
    .array(
      z.object({
        role: z.enum(["patient", "agent"]),
        content: z.string().trim().min(1).max(1000),
      }),
    )
    .min(1)
    .max(30)
    .refine((t) => t.at(-1)?.role === "patient", "The last turn must be the patient's."),
  model: z.string().optional(),
});

/**
 * One consultation turn. The client sends the whole transcript every time and
 * the graph re-derives its state from it, so no server-side session is needed
 * (Vercel functions keep no memory between requests).
 *
 * Response: text/event-stream, one `data: <AgentEvent JSON>` per graph node,
 * then a final `done` (or `error`) event.
 */
export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  }

  let llm;
  try {
    llm = resolveAgentLLM(parsed.data.model);
  } catch (err) {
    if (err instanceof AgentConfigError) {
      return Response.json({ error: err.message }, { status: 500 });
    }
    throw err;
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for await (const event of runConsultation({ llm, mode: "interactive" }, parsed.data.transcript)) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
    },
  });
}
