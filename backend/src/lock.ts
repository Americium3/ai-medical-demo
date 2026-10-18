import { randomUUID } from "node:crypto";
import { RELEASE_SCRIPT, type RedisLike } from "./redis";

/**
 * One run per consultation at a time (#6). Two answers (or an answer and a
 * retry) for the same consultation arriving together would otherwise both see
 * "waiting for an answer" and both resume the graph, overwriting state and
 * paying for the model calls twice. The second caller gets null and the API
 * answers 409.
 */
export interface ConsultationLock {
  /** Take the lock for `id`, or null if someone holds it. Call the returned function to release it. */
  tryAcquire(id: string): Promise<(() => Promise<void>) | null>;
}

/** Per-process lock. Enough for one instance; use RedisLock when running several. */
export class InMemoryLock implements ConsultationLock {
  private held = new Set<string>();

  async tryAcquire(id: string) {
    if (this.held.has(id)) return null;
    this.held.add(id);
    return async () => {
      this.held.delete(id);
    };
  }
}

/**
 * Lock shared by every instance through Redis. The key expires after `ttlMs`
 * so a crashed instance cannot block a consultation for good; keep it longer
 * than the slowest run (a note with two rewrites).
 */
export class RedisLock implements ConsultationLock {
  constructor(
    private redis: RedisLike,
    private ttlMs = 5 * 60_000,
  ) {}

  async tryAcquire(id: string) {
    const key = `consultation-lock:${id}`;
    const token = randomUUID();
    if ((await this.redis.set(key, token, "PX", this.ttlMs, "NX")) !== "OK") return null;
    return async () => {
      await this.redis.eval(RELEASE_SCRIPT, 1, key, token);
    };
  }
}
