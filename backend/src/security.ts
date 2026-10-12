/**
 * Minimal API security for the demo (design doc §9): bearer API keys,
 * per-key rate limiting and a per-key daily consultation cap (a cost
 * control, design doc §12.7). Full sign-in comes later.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export class ApiKeyAuth {
  private hashes: Buffer[];

  constructor(keys: string[]) {
    if (keys.length === 0) throw new Error("At least one API key is required (API_KEYS).");
    this.hashes = keys.map((k) => Buffer.from(hashKey(k), "hex"));
  }

  /** Returns the caller's key hash, or null. Constant-time comparison on hashes. */
  verify(authorization: string | undefined): string | null {
    const m = /^Bearer\s+(\S+)$/.exec(authorization ?? "");
    if (!m) return null;
    const candidate = Buffer.from(hashKey(m[1]), "hex");
    let match: Buffer | null = null;
    for (const h of this.hashes) if (timingSafeEqual(h, candidate)) match = h;
    return match ? match.toString("hex") : null;
  }
}

/** Fixed-window counter per caller. In memory: fine for one instance; use Redis when scaling out. */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();

  constructor(
    private limit: number,
    private windowMs: number,
    private now: () => number = Date.now,
  ) {}

  allow(caller: string): boolean {
    const t = this.now();
    const w = this.windows.get(caller);
    if (!w || t - w.start >= this.windowMs) {
      this.windows.set(caller, { start: t, count: 1 });
      return true;
    }
    if (w.count >= this.limit) return false;
    w.count++;
    return true;
  }
}
