import { getModelById, DEFAULT_MODEL_ID } from "@/data/models";
import { createGatewayLLM, type AgentLLM } from "./llm";
import { createMockLLM } from "./mock-llm";

export class AgentConfigError extends Error {}

/**
 * Pick the LLM for a request. AGENT_MOCK=1 forces the offline mock (local dev
 * and UI tests without a key); otherwise a gateway key is required.
 */
export function resolveAgentLLM(modelId: string | undefined): AgentLLM {
  if (process.env.AGENT_MOCK === "1") return createMockLLM();
  if (!process.env.AI_GATEWAY_API_KEY) {
    throw new AgentConfigError(
      "Missing AI_GATEWAY_API_KEY. Configure it in .env.local or Vercel, or set AGENT_MOCK=1 for the offline demo.",
    );
  }
  const model = getModelById(modelId ?? DEFAULT_MODEL_ID) ?? getModelById(DEFAULT_MODEL_ID)!;
  return createGatewayLLM(model.gatewayId);
}
