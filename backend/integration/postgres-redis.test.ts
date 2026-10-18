/**
 * Integration tests against a real Postgres and Redis (#11). Not part of
 * `npm test`; run with both services up:
 *
 *   docker compose -f backend/docker-compose.yml up -d postgres redis
 *   DATABASE_URL=postgres://app:app@localhost:5432/consult REDIS_URL=redis://localhost:6379 npm run test:integration
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, openStore, type Store } from "../src/config";
import type { LLM } from "../src/llm";
import { RedisLock } from "../src/lock";
import { createMockLLM } from "../src/mock-llm";
import { createRedis } from "../src/redis";
import { RedisRateLimiter } from "../src/security";
import { ConflictError, ConsultationService } from "../src/service";

const cfg = loadConfig();
if (!cfg.postgres || !cfg.redisUrl) throw new Error("Set DATABASE_URL and REDIS_URL to run the integration tests.");

const stores: Store[] = [];
const redis = createRedis(cfg.redisUrl);
after(async () => {
  await Promise.all(stores.map((s) => s.close()));
  await redis.quit();
});

async function store() {
  const s = await openStore(cfg);
  stores.push(s);
  return s;
}

function slow(inner: LLM, ms = 40): LLM {
  return {
    kind: inner.kind,
    usage: inner.usage,
    async invoke(call) {
      await new Promise((r) => setTimeout(r, ms));
      return inner.invoke(call);
    },
  };
}

test("Postgres: a consultation started on one instance continues on another", async () => {
  const one = new ConsultationService(createMockLLM(), (await store()).checkpointer);
  const v = await one.start("我咳嗽发烧三天了", "k");
  assert.equal(v.status, "awaiting_answer");
  await one.answer(v.id, "没有喘。最高39度。", "k");

  const two = new ConsultationService(createMockLLM(), (await store()).checkpointer);
  const resumed = await two.get(v.id, "k");
  assert.equal(resumed.status, "awaiting_answer");
  assert.equal(resumed.rounds, 2);
  let w = await two.answer(v.id, "有黄痰。", "k");
  while (w.status === "awaiting_answer") w = await two.answer(v.id, "不清楚", "k");
  assert.equal(w.status, "completed");
  assert.match(w.output!, /门诊病历草稿/);
});

test("Postgres + Redis: concurrent answers on two instances, one runs, one is a conflict", async () => {
  const instance = async () =>
    new ConsultationService(slow(createMockLLM()), (await store()).checkpointer, undefined, undefined, { lock: new RedisLock(redis, 60_000) });
  const [one, two] = [await instance(), await instance()];
  const v = await one.start("我胸闷两周了", "k");
  const results = await Promise.allSettled([one.answer(v.id, "没有出汗。", "k"), two.answer(v.id, "休息就好了。", "k")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.ok(results.some((r) => r.status === "rejected" && r.reason instanceof ConflictError));
  const s = await one.state(v.id);
  assert.equal(s.transcript.filter((t) => t.role === "patient").length, 2, "only one answer was recorded");
});

test("Redis: rate limit shared by two limiter instances", async () => {
  const caller = `it-${Date.now()}`;
  const a = new RedisRateLimiter(redis, "it", 2, 60_000);
  const b = new RedisRateLimiter(redis, "it", 2, 60_000);
  assert.deepEqual([await a.allow(caller), await b.allow(caller), await a.allow(caller)], [true, true, false]);
});

test("readiness ping reaches both services", async () => {
  await (await store()).ping();
  assert.equal(await redis.ping(), "PONG");
});
