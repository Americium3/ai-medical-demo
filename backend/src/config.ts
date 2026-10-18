import path from "node:path";
import { mkdirSync } from "node:fs";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import pg from "pg";
import { createBedrockLLM, type LLM } from "./llm";
import { createMockLLM } from "./mock-llm";
import { createTracing, tracingOptionsFromEnv, type Tracing, type TracingOptions } from "../../shared/tracing/langfuse";

export interface Config {
  llm: "mock" | "bedrock";
  region: string;
  fastModelId: string;
  smartModelId: string;
  /** Explicit Bedrock keys; when absent the AWS default credential chain is used (on ECS, the task's IAM role). */
  credentials?: { accessKeyId: string; secretAccessKey: string };
  /** SQLite file for a single machine; ignored when `postgres` is set. */
  dbPath: string;
  /**
   * Postgres checkpointer, so instances keep no state of their own. Set by
   * DATABASE_URL, or by PGHOST with the other PG* variables (node-postgres reads them).
   */
  postgres: { connectionString: string | undefined } | null;
  /** Redis for the per-consultation lock and shared rate limits; null keeps both in memory. */
  redisUrl: string | null;
  /** How long a consultation lock lives in Redis if its holder dies. */
  lockTtlMs: number;
  /** How long graceful shutdown waits for in-flight requests. */
  shutdownTimeoutMs: number;
  port: number;
  apiKeys: string[];
  ratePerMinute: number;
  dailyConsultations: number;
  /** "model" rewrites follow-up questions (in parallel with triage); "template" asks the template wording. */
  phrasing: "model" | "template";
  /** Langfuse tracing; null unless LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL are set. */
  tracing: TracingOptions | null;
}

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const llm = (env.AGENT_LLM ?? "mock") as Config["llm"];
  if (llm !== "mock" && llm !== "bedrock") throw new ConfigError(`AGENT_LLM must be "mock" or "bedrock", got "${llm}"`);
  const cfg: Config = {
    llm,
    // Defaults match the company Bedrock account already used by autoclaw.
    region: env.BEDROCK_REGION ?? "us-east-2",
    fastModelId: env.BEDROCK_FAST_MODEL_ID ?? "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    smartModelId: env.BEDROCK_SMART_MODEL_ID ?? "us.anthropic.claude-sonnet-4-6",
    credentials:
      env.BEDROCK_ACCESS_KEY_ID && env.BEDROCK_SECRET_ACCESS_KEY
        ? { accessKeyId: env.BEDROCK_ACCESS_KEY_ID, secretAccessKey: env.BEDROCK_SECRET_ACCESS_KEY }
        : undefined,
    dbPath: env.DB_PATH ?? path.join("backend", "data", "consultations.sqlite"),
    postgres: env.DATABASE_URL || env.PGHOST ? { connectionString: env.DATABASE_URL || undefined } : null,
    redisUrl: env.REDIS_URL || null,
    lockTtlMs: Number(env.LOCK_TTL_MS ?? 5 * 60_000),
    shutdownTimeoutMs: Number(env.SHUTDOWN_TIMEOUT_MS ?? 25_000),
    port: Number(env.PORT ?? 8787),
    apiKeys: (env.API_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean),
    ratePerMinute: Number(env.RATE_LIMIT_PER_MINUTE ?? 30),
    dailyConsultations: Number(env.DAILY_CONSULTATION_LIMIT ?? 200),
    phrasing: env.AGENT_PHRASING === "template" ? "template" : "model",
    tracing: tracingOptionsFromEnv(env),
  };
  return cfg;
}

export function createLLM(cfg: Config): LLM {
  return cfg.llm === "bedrock"
    ? createBedrockLLM({
        region: cfg.region,
        fastModelId: cfg.fastModelId,
        smartModelId: cfg.smartModelId,
        credentials: cfg.credentials,
      })
    : createMockLLM();
}

/** The Langfuse tracer, or undefined when tracing is off. */
export function createTracer(cfg: Config): Tracing | undefined {
  if (!cfg.tracing) return undefined;
  const tracing = createTracing({ ...cfg.tracing, exportMode: "batched" });
  console.log(
    `（Langfuse 追踪已开启：${cfg.tracing.baseUrl}，${tracing.maskAllText ? "非自托管地址，全部文本已隐藏" : "自托管，仅隐藏手机号和身份证号"}）`,
  );
  return tracing;
}

export function createCheckpointer(dbPath: string): SqliteSaver {
  return SqliteSaver.fromConnString(dbPath);
}

export interface Store {
  checkpointer: BaseCheckpointSaver;
  /** Throws if the database is unreachable. */
  ping(): Promise<void>;
  close(): Promise<void>;
  describe: string;
}

/** Postgres when configured (creating its tables on first use), otherwise the SQLite file. */
export async function openStore(cfg: Config): Promise<Store> {
  if (cfg.postgres) {
    const pool = new pg.Pool({ connectionString: cfg.postgres.connectionString, max: 10 });
    const checkpointer = new PostgresSaver(pool);
    await checkpointer.setup();
    return {
      checkpointer,
      ping: async () => void (await pool.query("select 1")),
      close: () => pool.end(),
      describe: "postgres",
    };
  }
  mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
  const checkpointer = createCheckpointer(cfg.dbPath);
  return { checkpointer, ping: async () => {}, close: async () => {}, describe: `sqlite ${cfg.dbPath}` };
}
