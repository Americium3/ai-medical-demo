import path from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { createBedrockLLM, type LLM } from "./llm";
import { createMockLLM } from "./mock-llm";

export interface Config {
  llm: "mock" | "bedrock";
  region: string;
  fastModelId: string;
  smartModelId: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
  dbPath: string;
  port: number;
  apiKeys: string[];
  ratePerMinute: number;
  dailyConsultations: number;
}

export class ConfigError extends Error {}

export function loadConfig(env = process.env): Config {
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
    port: Number(env.PORT ?? 8787),
    apiKeys: (env.API_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean),
    ratePerMinute: Number(env.RATE_LIMIT_PER_MINUTE ?? 30),
    dailyConsultations: Number(env.DAILY_CONSULTATION_LIMIT ?? 200),
  };
  if (llm === "bedrock" && !cfg.credentials) {
    throw new ConfigError(
      "AGENT_LLM=bedrock needs BEDROCK_ACCESS_KEY_ID and BEDROCK_SECRET_ACCESS_KEY (the company Bedrock account's keys).",
    );
  }
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

export function createCheckpointer(dbPath: string): SqliteSaver {
  return SqliteSaver.fromConnString(dbPath);
}
