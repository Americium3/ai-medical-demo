/**
 * Minimal API security for the demo (design doc §9): bearer API keys,
 * per-key rate limiting and a per-key daily consultation cap (a cost
 * control, design doc §12.7). Full sign-in comes later.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { RATE_SCRIPT, type RedisLike } from "./redis";

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

export interface RateLimiter {
  /** Count one request for `caller`; false once it is over the limit for the current window. */
  allow(caller: string): Promise<boolean>;
}

/** Fixed-window counter per caller. In memory: fine for one instance; use RedisRateLimiter when scaling out. */
export class InMemoryRateLimiter implements RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();

  constructor(
    private limit: number,
    private windowMs: number,
    private now: () => number = Date.now,
  ) {}

  async allow(caller: string): Promise<boolean> {
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

/** Fixed-window counter per caller, shared by every instance through Redis. */
export class RedisRateLimiter implements RateLimiter {
  constructor(
    private redis: RedisLike,
    private name: string,
    private limit: number,
    private windowMs: number,
    private now: () => number = Date.now,
  ) {}

  async allow(caller: string): Promise<boolean> {
    const window = Math.floor(this.now() / this.windowMs);
    const n = Number(await this.redis.eval(RATE_SCRIPT, 1, `rate:${this.name}:${caller}:${window}`, this.windowMs));
    return n <= this.limit;
  }
}
