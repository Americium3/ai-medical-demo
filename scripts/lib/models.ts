/**
 * Models for the simulated patient and the judges in the evals.
 *
 * A spec is either a Vercel AI Gateway id ("openai/gpt-4o-mini") or a Bedrock
 * model id prefixed with "bedrock:" ("bedrock:us.amazon.nova-pro-v1:0").
 * Bedrock needs only the AWS credentials the backend already uses
 * (BEDROCK_ACCESS_KEY_ID / BEDROCK_SECRET_ACCESS_KEY, or the default chain).
 */
import { ChatBedrockConverse } from "@langchain/aws";
import { invokeWithTool } from "../../backend/src/llm";
import { createGatewayLLM, type AgentLLM, type StructuredCall, type UsageRecord } from "../../src/lib/sim/gateway";

const BEDROCK = "bedrock:";

/** Model family: the provider part of the id (openai, anthropic, amazon, deepseek, meta ...). */
export function familyOf(spec: string): string {
  if (!spec.startsWith(BEDROCK)) return spec.split("/")[0];
  // Bedrock ids look like "us.amazon.nova-pro-v1:0" or "deepseek.v3-v1:0"; a region prefix is optional.
  const parts = spec.slice(BEDROCK.length).split(".");
  return /^(us|eu|apac|global)$/.test(parts[0]) ? parts[1] : parts[0];
}

export function needsGateway(spec: string): boolean {
  return !spec.startsWith(BEDROCK);
}

export function createEvalLLM(spec: string, maxTokens = 1200): AgentLLM {
  if (needsGateway(spec)) return createGatewayLLM(spec);
  const modelId = spec.slice(BEDROCK.length);
  const model = new ChatBedrockConverse({
    model: modelId,
    region: process.env.BEDROCK_REGION ?? "us-east-2",
    maxTokens,
    supportsToolChoiceValues: ["auto"],
    ...(process.env.BEDROCK_ACCESS_KEY_ID && process.env.BEDROCK_SECRET_ACCESS_KEY
      ? { credentials: { accessKeyId: process.env.BEDROCK_ACCESS_KEY_ID, secretAccessKey: process.env.BEDROCK_SECRET_ACCESS_KEY } }
      : {}),
  });
  const usage: UsageRecord[] = [];
  return {
    kind: "bedrock",
    model: modelId,
    usage,
    invoke<T>(call: StructuredCall<T>): Promise<T> {
      return invokeWithTool(model, { name: call.task, ...call }, (reply, ms) =>
        usage.push({ task: call.task, inputTokens: reply.usage_metadata?.input_tokens ?? 0, outputTokens: reply.usage_metadata?.output_tokens ?? 0, ms }),
      );
    },
  };
}
