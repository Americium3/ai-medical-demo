import { RATE_SCRIPT, RELEASE_SCRIPT, type RedisLike } from "../src/redis";

/** In-memory stand-in for the few Redis commands the backend uses, with expiry on a controllable clock. */
export function fakeRedis(now: () => number = Date.now): RedisLike {
  const data = new Map<string, { value: string; expiresAt: number }>();
  const live = (key: string) => {
    const e = data.get(key);
    if (e && e.expiresAt <= now()) data.delete(key);
    return data.get(key);
  };
  return {
    async set(key, value, _px, ms) {
      if (live(key)) return null;
      data.set(key, { value, expiresAt: now() + ms });
      return "OK";
    },
    async eval(script, _numKeys, ...args) {
      const [key, arg] = args.map(String);
      if (script === RELEASE_SCRIPT) {
        if (live(key)?.value !== arg) return 0;
        data.delete(key);
        return 1;
      }
      if (script === RATE_SCRIPT) {
        const e = live(key);
        const n = (e ? Number(e.value) : 0) + 1;
        data.set(key, { value: String(n), expiresAt: e ? e.expiresAt : now() + Number(arg) });
        return n;
      }
      throw new Error("fake redis: unknown script");
    },
    async exists(key) {
      return live(key) ? 1 : 0;
    },
    async ping() {
      return "PONG";
    },
    async quit() {
      return "OK";
    },
  };
}
