/**
 * Model access. Nodes ask for one structured object at a time; two
 * implementations sit behind the same interface: Amazon Bedrock (via
 * LangChain's ChatBedrockConverse) and a deterministic offline mock.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { ChatBedrockConverse } from "@langchain/aws";
import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";

export type Task = "extract" | "triage" | "phrase" | "note" | "review";

/** Which model tier a task uses (design doc §12.4, mixed plan). */
export const TASK_TIER: Record<Task, "fast" | "smart"> = {
  extract: "fast",
  triage: "fast",
  phrase: "fast",
  note: "smart",
  review: "smart",
};

export interface StructuredCall<T> {
  task: Task;
  schema: z.ZodType<T>;
  system: string;
  user: string;
  /** Typed inputs the prompt was built from; only the offline mock reads them. */
  context: unknown;
}

export interface UsageRecord {
  task: Task;
  model: string;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  /** The consultation this call ran for; one LLM instance serves every consultation in the process. */
  consultationId?: string;
}

/** The service runs each consultation inside this scope, so usage records can be attributed to it. */
export const consultationScope = new AsyncLocalStorage<string>();

/**
 * USD per million tokens, Anthropic list prices (claude-api skill model table, 2026-10).
 * Bedrock bills Claude at its own rates (https://aws.amazon.com/bedrock/pricing/); check
 * them before quoting costs. Matched by substring of the model id.
 */
export const PRICE_PER_MTOK: { match: string; input: number; output: number }[] = [
  { match: "claude-haiku-4-5", input: 1, output: 5 },
  { match: "claude-sonnet-4-6", input: 3, output: 15 },
  { match: "claude-haiku-5-5", input: 0.1, output: 0.5 },
  { match: "claude-sonnet-5-5", input: 2, output: 10 },
  { match: "claude-opus-5-5", input: 4, output: 20 },
];

export interface UsageSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** null when a model in the records has no price in PRICE_PER_MTOK (e.g. the offline mock). */
  costUsd: number | null;
  ms: number;
}

export function summarizeUsage(records: UsageRecord[]): UsageSummary {
  let cost: number | null = 0;
  for (const r of records) {
    const price = PRICE_PER_MTOK.find((p) => r.model.includes(p.match));
    if (!price) cost = null;
    else if (cost !== null) cost += (r.inputTokens * price.input + r.outputTokens * price.output) / 1e6;
  }
  return {
    calls: records.length,
    inputTokens: records.reduce((n, r) => n + r.inputTokens, 0),
    outputTokens: records.reduce((n, r) => n + r.outputTokens, 0),
    costUsd: cost,
    ms: records.reduce((n, r) => n + r.ms, 0),
  };
}

export interface LLM {
  readonly kind: "bedrock" | "mock";
  invoke<T>(call: StructuredCall<T>): Promise<T>;
  readonly usage: UsageRecord[];
}

export class LLMError extends Error {
  constructor(
    readonly task: Task,
    message: string,
  ) {
    super(`[${task}] ${message}`);
  }
}

export interface BedrockOptions {
  region: string;
  fastModelId: string;
  smartModelId: string;
  maxTokens?: number;
  /** Explicit keys; when omitted the AWS SDK's default credential chain is used. */
  credentials?: { accessKeyId: string; secretAccessKey: string };
  /** Injected in tests to point at a local fake endpoint. */
  client?: BedrockRuntimeClient;
}

function toolFor<T>(call: StructuredCall<T>) {
  const parameters = z.toJSONSchema(call.schema) as Record<string, unknown>;
  delete parameters.$schema;
  return {
    type: "function" as const,
    function: { name: `submit_${call.task}`, description: `Submit the ${call.task} result.`, parameters },
  };
}

function decodeJsonString(v: unknown): unknown {
  if (typeof v !== "string" || !/^\s*[[{]/.test(v)) return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/**
 * Bedrock implementation.
 *
 * Current Claude models (Opus 5.5, Sonnet 5.5) reject forced tool choice and
 * non-default temperature, so the tool is offered with tool_choice "auto",
 * the prompt tells the model to call it, temperature is never sent, and the
 * arguments are validated here. Up to three retries if the reply does not validate.
 */
export function createBedrockLLM(opts: BedrockOptions): LLM {
  const usage: UsageRecord[] = [];
  const models = new Map<string, ChatBedrockConverse>();
  const modelFor = (id: string) => {
    let m = models.get(id);
    if (!m) {
      m = new ChatBedrockConverse({
        model: id,
        region: opts.region,
        maxTokens: opts.maxTokens ?? 1500,
        supportsToolChoiceValues: ["auto"],
        ...(opts.credentials ? { credentials: opts.credentials } : {}),
        ...(opts.client ? { client: opts.client } : {}),
      });
      models.set(id, m);
    }
    return m;
  };

  return {
    kind: "bedrock",
    usage,
    async invoke<T>(call: StructuredCall<T>): Promise<T> {
      const modelId = TASK_TIER[call.task] === "fast" ? opts.fastModelId : opts.smartModelId;
      const tool = toolFor(call);
      const runnable = modelFor(modelId).bindTools([tool], { tool_choice: "auto" });
      const system = `${call.system}\n\n请调用工具 ${tool.function.name} 提交结果，不要输出其他文字。参数中的对象和数组直接写成 JSON 结构，不要包成字符串。`;

      let lastError = "no tool call in reply";
      let feedback = "";
      for (let attempt = 1; attempt <= 4; attempt++) {
        const started = Date.now();
        let reply: AIMessage;
        try {
          reply = (await runnable.invoke([new SystemMessage(system + feedback), new HumanMessage(call.user)])) as AIMessage;
        } catch (err) {
          throw new LLMError(call.task, err instanceof Error ? err.message : String(err));
        }
        usage.push({
          task: call.task,
          model: modelId,
          inputTokens: reply.usage_metadata?.input_tokens ?? 0,
          outputTokens: reply.usage_metadata?.output_tokens ?? 0,
          ms: Date.now() - started,
          consultationId: consultationScope.getStore(),
        });
        const raw = reply.tool_calls?.find((c) => c.name === tool.function.name)?.args;
        // Models sometimes send a nested object or array as a JSON string; decode those before validating.
        const args = raw && Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, decodeJsonString(v)]));
        const parsed = call.schema.safeParse(args);
        if (parsed.success) return parsed.data;
        const issue = args ? parsed.error.issues[0] : undefined;
        lastError = issue?.message ?? (args ? "invalid arguments" : "no tool call in reply");
        // Retries repeat the same mistake unless the model is told what it was.
        feedback = issue
          ? `\n\n上一次提交未通过校验：字段 ${issue.path.join(".") || "(根)"} ${issue.message}。请按工具定义的类型重新提交。`
          : `\n\n上一次没有调用工具。这一次必须调用工具 ${tool.function.name}。`;
      }
      throw new LLMError(call.task, lastError);
    },
  };
}
