/** Start the HTTP server: `npm run backend:server`. */
import { createLLM, createTracer, loadConfig, openStore } from "./config";
import { InMemoryLock, RedisLock } from "./lock";
import { createRedis } from "./redis";
import { InMemoryRateLimiter, RedisRateLimiter } from "./security";
import { createApiServer, drain } from "./server";
import { ConsultationService } from "./service";

async function main() {
  const cfg = loadConfig();
  if (cfg.apiKeys.length === 0) {
    console.error("Set API_KEYS (comma-separated) before starting the server.");
    process.exit(1);
  }
  const store = await openStore(cfg);
  // With Redis every instance shares the consultation locks and rate limits; without it they stay in this process.
  const redis = cfg.redisUrl ? createRedis(cfg.redisUrl) : null;
  const tracer = createTracer(cfg);
  const service = new ConsultationService(createLLM(cfg), store.checkpointer, undefined, tracer, {
    phrasing: cfg.phrasing,
    lock: redis ? new RedisLock(redis, cfg.lockTtlMs) : new InMemoryLock(),
  });
  const server = createApiServer({
    service,
    apiKeys: cfg.apiKeys,
    ratePerMinute: cfg.ratePerMinute,
    dailyConsultations: cfg.dailyConsultations,
    limiters: redis
      ? {
          perMinute: new RedisRateLimiter(redis, "minute", cfg.ratePerMinute, 60_000),
          daily: new RedisRateLimiter(redis, "daily", cfg.dailyConsultations, 24 * 3600_000),
        }
      : { perMinute: new InMemoryRateLimiter(cfg.ratePerMinute, 60_000), daily: new InMemoryRateLimiter(cfg.dailyConsultations, 24 * 3600_000) },
    ready: async () => {
      await store.ping();
      await redis?.ping();
    },
  });
  server.listen(cfg.port, () => {
    const credentials = cfg.llm === "bedrock" ? (cfg.credentials ? ", Bedrock keys from env" : ", AWS default credentials") : "";
    console.log(`consultation backend on http://localhost:${cfg.port} (model: ${cfg.llm}${credentials}, store: ${store.describe}, redis: ${redis ? "on" : "off"})`);
  });

  // Graceful shutdown (ECS sends SIGTERM, then SIGKILL after the stop timeout): finish in-flight
  // requests, then close the database pool and Redis, and send any batched Langfuse spans.
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      console.log(`${signal}: draining`);
      void drain(server, cfg.shutdownTimeoutMs)
        .then(() => Promise.allSettled([store.close(), redis?.quit(), tracer?.shutdown()]))
        .finally(() => process.exit(0));
    });
  }
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
