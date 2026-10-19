import { InMemoryRateLimiter } from "../../backend/src/security";

/**
 * Per-IP rate limit for the /agent routes (#7). Off unless
 * AGENT_RATE_LIMIT_PER_MINUTE is set to a positive number. Counts live in the
 * memory of each server instance, so on Vercel the limit is per instance; the
 * backend behind /api/agent enforces its own per-key limits in Redis.
 */
let limiter: { limit: number; impl: InMemoryRateLimiter } | null = null;

function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("x-real-ip") || "unknown";
}

/** A 429 response when this IP is over its limit, otherwise null. */
export async function rateLimited(req: Request): Promise<Response | null> {
  const limit = Number(process.env.AGENT_RATE_LIMIT_PER_MINUTE ?? 0);
  if (!(limit > 0)) return null;
  if (limiter?.limit !== limit) limiter = { limit, impl: new InMemoryRateLimiter(limit, 60_000) };
  if (await limiter.impl.allow(clientIp(req))) return null;
  return Response.json({ error: "Too many requests, slow down" }, { status: 429, headers: { "retry-after": "60" } });
}
