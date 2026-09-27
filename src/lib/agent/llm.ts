import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { z } from "zod";

export type AgentTask =
  | "intake"
  | "red_flag"
  | "ask"
  | "differential"
  | "plan"
  | "self_check"
  | "patient";

export interface StructuredCall<T> {
  task: AgentTask;
  schema: z.ZodType<T>;
  system: string;
  user: string;
  /**
   * The same data the prompt was built from, in typed form. Real models ignore
   * it; the offline mock reads it instead of parsing prompt text.
   */
  context: unknown;
}

export interface UsageRecord {
  task: AgentTask;
  inputTokens: number;
  outputTokens: number;
  ms: number;
}

export interface AgentLLM {
  readonly kind: "gateway" | "mock";
  readonly model: string;
  invoke<T>(call: StructuredCall<T>): Promise<T>;
  /** Every call made through this instance, for cost/latency reporting. */
  readonly usage: UsageRecord[];
}

export class AgentLLMError extends Error {
  constructor(
    readonly task: AgentTask,
    message: string,
  ) {
    super(`[${task}] ${message}`);
  }
}

export const AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";

/**
 * LangChain chat model pointed at Vercel AI Gateway's OpenAI-compatible API,
 * so the agent shares the app's single AI_GATEWAY_API_KEY and can use any
 * gateway model (openai/*, anthropic/*, deepseek/*).
 */
export function createGatewayChatModel(
  gatewayModelId: string,
  opts: { apiKey?: string; baseURL?: string; maxTokens?: number } = {},
): ChatOpenAI {
  return new ChatOpenAI({
    model: gatewayModelId,
    apiKey: opts.apiKey ?? process.env.AI_GATEWAY_API_KEY,
    configuration: { baseURL: opts.baseURL ?? AI_GATEWAY_BASE_URL },
    temperature: 0.2,
    maxTokens: opts.maxTokens ?? 1200,
    maxRetries: 2,
    timeout: 45_000,
  });
}

export function createGatewayLLM(
  gatewayModelId: string,
  opts: { apiKey?: string; baseURL?: string } = {},
): AgentLLM {
  const chat = createGatewayChatModel(gatewayModelId, opts);
  const usage: UsageRecord[] = [];

  return {
    kind: "gateway",
    model: gatewayModelId,
    usage,
    async invoke<T>(call: StructuredCall<T>): Promise<T> {
      // functionCalling: the most portable structured-output method across
      // the providers the gateway fronts.
      const runnable = chat.withStructuredOutput(call.schema, {
        name: call.task,
        method: "functionCalling",
        includeRaw: true,
      });
      const started = Date.now();
      let res: Awaited<ReturnType<typeof runnable.invoke>>;
      try {
        res = await runnable.invoke([
          new SystemMessage(call.system),
          new HumanMessage(call.user),
        ]);
      } catch (err) {
        throw new AgentLLMError(
          call.task,
          err instanceof Error ? err.message : String(err),
        );
      }
      const meta = AIMessage.isInstance(res.raw) ? res.raw.usage_metadata : undefined;
      usage.push({
        task: call.task,
        inputTokens: meta?.input_tokens ?? 0,
        outputTokens: meta?.output_tokens ?? 0,
        ms: Date.now() - started,
      });
      if (res.parsed == null) {
        throw new AgentLLMError(call.task, "model returned no valid structured output");
      }
      return res.parsed as T;
    },
  };
}
