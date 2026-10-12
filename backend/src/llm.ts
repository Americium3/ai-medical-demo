/**
 * Model access. Nodes ask for one structured object at a time; two
 * implementations sit behind the same interface: Amazon Bedrock (via
 * LangChain's ChatBedrockConverse) and a deterministic offline mock.
 */
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
