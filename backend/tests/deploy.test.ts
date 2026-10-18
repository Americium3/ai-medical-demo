import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createCheckpointer, loadConfig } from "../src/config";
import type { LLM } from "../src/llm";
import { RedisLock } from "../src/lock";
import { createMockLLM } from "../src/mock-llm";
import { RedisRateLimiter } from "../src/security";
import { createApiServer, drain } from "../src/server";
import { ConflictError, ConsultationService } from "../src/service";
import { fakeRedis } from "./fake-redis";

// #11: settings and pieces needed to run several stateless instances on AWS.

const tmpDb = () => path.join(mkdtempSync(path.join(tmpdir(), "consult-")), "db.sqlite");

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

test("Bedrock without explicit keys uses the AWS default credential chain (IAM role)", () => {
  const cfg = loadConfig({ AGENT_LLM: "bedrock" });
  assert.equal(cfg.llm, "bedrock");
  assert.equal(cfg.credentials, undefined);
  const keyed = loadConfig({ AGENT_LLM: "bedrock", BEDROCK_ACCESS_KEY_ID: "a", BEDROCK_SECRET_ACCESS_KEY: "b" });
  assert.deepEqual(keyed.credentials, { accessKeyId: "a", secretAccessKey: "b" });
});

test("Postgres and Redis are picked from the environment", () => {
  const local = loadConfig({});
  assert.equal(local.postgres, null);
  assert.equal(local.redisUrl, null);
  assert.equal(loadConfig({ DATABASE_URL: "postgres://u:p@db:5432/consult" }).postgres?.connectionString, "postgres://u:p@db:5432/consult");
  // ECS injects the RDS secret as PGPASSWORD; node-postgres reads PG* variables itself.
  assert.deepEqual(loadConfig({ PGHOST: "db.internal", PGUSER: "app", PGPASSWORD: "x" }).postgres, { connectionString: undefined });
  assert.equal(loadConfig({ REDIS_URL: "rediss://cache:6379" }).redisUrl, "rediss://cache:6379");
});

test("Redis lock: one holder at a time, released only by its holder, expires after its TTL", async () => {
  let t = 0;
  const redis = fakeRedis(() => t);
  const lock = new RedisLock(redis, 1000);
  const release = await lock.tryAcquire("c1");
  assert.ok(release);
  assert.equal(await lock.tryAcquire("c1"), null);
  assert.ok(await lock.tryAcquire("c2"), "locks are per consultation");
  await release();
  const again = await lock.tryAcquire("c1");
  assert.ok(again);

  t += 1001; // the holder died; the lock expired and someone else took it
  const other = await new RedisLock(redis, 1000).tryAcquire("c1");
  assert.ok(other);
  await again(); // the stale holder must not release the new holder's lock
  assert.equal(await lock.tryAcquire("c1"), null);
});

test("Redis rate limit is shared by all instances", async () => {
  let t = 0;
  const redis = fakeRedis(() => t);
  const a = new RedisRateLimiter(redis, "minute", 3, 60_000, () => t);
  const b = new RedisRateLimiter(redis, "minute", 3, 60_000, () => t);
  assert.deepEqual([await a.allow("k"), await b.allow("k"), await a.allow("k"), await b.allow("k")], [true, true, true, false]);
  assert.equal(await a.allow("other"), true, "limits are per key");
  t += 60_000;
  assert.equal(await b.allow("k"), true, "a new window starts");
});

test("two instances sharing Redis: concurrent answers to one consultation, one runs, one is a conflict", async () => {
  const db = tmpDb();
  const redis = fakeRedis();
  const instance = () => new ConsultationService(slow(createMockLLM()), createCheckpointer(db), undefined, undefined, { lock: new RedisLock(redis, 60_000) });
  const [one, two] = [instance(), instance()];
  const v = await one.start("我胸闷两周了", "k");
  const results = await Promise.allSettled([one.answer(v.id, "没有出汗。", "k"), two.answer(v.id, "休息就好了。", "k")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.ok(results.some((r) => r.status === "rejected" && r.reason instanceof ConflictError));
});

async function listen(opts: Partial<Parameters<typeof createApiServer>[0]> & { service: ConsultationService }) {
  const server = createApiServer({ apiKeys: ["key-a"], ratePerMinute: 100, dailyConsultations: 100, log: () => {}, ...opts });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test("readiness: /readyz checks dependencies and turns 503 while draining", async () => {
  let dbUp = true;
  const service = new ConsultationService(createMockLLM(), createCheckpointer(tmpDb()));
  const { server, base } = await listen({
    service,
    ready: async () => {
      if (!dbUp) throw new Error("connection refused");
    },
  });
  try {
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
    dbUp = false;
    const down = await fetch(`${base}/readyz`);
    assert.equal(down.status, 503);
    assert.ok(!JSON.stringify(await down.json()).includes("refused"), "no internal error detail");
    dbUp = true;
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  } finally {
    server.close();
  }
});

test("graceful shutdown: an in-flight answer finishes, then the server closes", async () => {
  const service = new ConsultationService(slow(createMockLLM(), 150), createCheckpointer(tmpDb()));
  const { server, base } = await listen({ service });
  const headers = { authorization: "Bearer key-a", "content-type": "application/json" };
  const { id } = await (await fetch(`${base}/v1/consultations`, { method: "POST", headers, body: JSON.stringify({ complaint: "我胸闷两周了" }) })).json();

  const inFlight = fetch(`${base}/v1/consultations/${id}/answers`, { method: "POST", headers, body: JSON.stringify({ text: "没有出汗。" }) });
  await new Promise((r) => setTimeout(r, 50));
  const drained = drain(server, 5_000);
  const res = await inFlight;
  assert.equal(res.status, 200, "the request that was running when shutdown began completes");
  assert.equal((await res.json()).id, id);
  await drained;
  assert.equal(server.listening, false);
  await assert.rejects(fetch(`${base}/healthz`), "no new connections after shutdown");
});
