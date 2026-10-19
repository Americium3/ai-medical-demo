import { z } from "zod";
import { rateLimited } from "@/lib/rate-limit";

export const runtime = "nodejs";
// A final answer runs the note, the self-check and up to two rewrites on the backend.
export const maxDuration = 60;

/**
 * The /agent page's door to the consultation backend (backend/, the one agent
 * implementation, #13). The browser never sees the backend's API key: this
 * route adds it and forwards to BACKEND_URL.
 *
 *   POST { action: "start", complaint }      → POST /v1/consultations
 *   POST { action: "answer", id, text }      → POST /v1/consultations/:id/answers
 *   POST { action: "retry", id }             → POST /v1/consultations/:id/retry
 *   GET  ?id=<consultation id>               → GET  /v1/consultations/:id
 *
 * The backend's status code and JSON body are passed through unchanged.
 *
 * #7: an optional per-IP rate limit (AGENT_RATE_LIMIT_PER_MINUTE), and when
 * the browser disconnects the forwarded request is aborted, which makes the
 * backend stop the run and its model calls.
 */

const id = z.string().uuid();
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), complaint: z.string().trim().min(2).max(500) }),
  z.object({ action: z.literal("answer"), id, text: z.string().trim().min(1).max(500) }),
  z.object({ action: z.literal("retry"), id }),
]);

function backend(): { url: string; key: string } | null {
  const url = process.env.BACKEND_URL?.replace(/\/+$/, "");
  const key = process.env.BACKEND_API_KEY;
  return url && key ? { url, key } : null;
}

const NOT_CONFIGURED = Response.json(
  { error: "The consultation backend is not configured: set BACKEND_URL and BACKEND_API_KEY (see backend/README.md)." },
  { status: 503 },
);

async function forward(path: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  const b = backend();
  if (!b) return NOT_CONFIGURED.clone();
  let res: Response;
  try {
    res = await fetch(`${b.url}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${b.key}`, "content-type": "application/json" },
      cache: "no-store",
      signal,
    });
  } catch {
    if (signal.aborted) return Response.json({ error: "Client closed the request" }, { status: 499 });
    return Response.json({ error: "The consultation backend is unreachable." }, { status: 502 });
  }
  const body = await res.json().catch(() => ({ error: `Backend answered ${res.status}` }));
  return Response.json(body, { status: res.status });
}

export async function POST(req: Request) {
  const limited = await rateLimited(req);
  if (limited) return limited;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  }
  const b = parsed.data;
  if (b.action === "start") return forward("/v1/consultations", { method: "POST", body: JSON.stringify({ complaint: b.complaint }) }, req.signal);
  if (b.action === "answer") return forward(`/v1/consultations/${b.id}/answers`, { method: "POST", body: JSON.stringify({ text: b.text }) }, req.signal);
  return forward(`/v1/consultations/${b.id}/retry`, { method: "POST" }, req.signal);
}

export async function GET(req: Request) {
  const limited = await rateLimited(req);
  if (limited) return limited;
  const parsed = id.safeParse(new URL(req.url).searchParams.get("id"));
  if (!parsed.success) return Response.json({ error: "Missing or invalid id" }, { status: 400 });
  return forward(`/v1/consultations/${parsed.data}`, { method: "GET" }, req.signal);
}
