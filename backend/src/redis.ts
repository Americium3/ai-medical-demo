/**
 * The few Redis commands the backend needs (#11): a lock per consultation and
 * rate-limit counters shared by every instance. Kept behind a small interface
 * so tests can use an in-memory fake.
 */
import { Redis } from "ioredis";

export interface RedisLike {
  set(key: string, value: string, px: "PX", ms: number, nx: "NX"): Promise<"OK" | null>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  exists(key: string): Promise<number>;
  ping(): Promise<string>;
  quit(): Promise<unknown>;
}

/** Delete KEYS[1] only if it still holds ARGV[1], so a holder never releases someone else's lock. */
export const RELEASE_SCRIPT = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end`;

/** Count a request in KEYS[1]; the first one in a window sets its expiry to ARGV[1] ms. */
export const RATE_SCRIPT = `local n = redis.call("INCR", KEYS[1]) if n == 1 then redis.call("PEXPIRE", KEYS[1], ARGV[1]) end return n`;

/** Connect to Redis (`rediss://` for TLS, as on ElastiCache with in-transit encryption). */
export function createRedis(url: string): RedisLike {
  const client = new Redis(url, { maxRetriesPerRequest: 2, enableOfflineQueue: false, lazyConnect: false });
  client.on("error", (err: Error) => console.error(`redis: ${err.message}`));
  return {
    set: (key, value, px, ms, nx) => client.set(key, value, px, ms, nx),
    eval: (script, numKeys, ...args) => client.eval(script, numKeys, ...args),
    exists: (key) => client.exists(key),
    ping: () => client.ping(),
    quit: () => client.quit(),
  };
}
