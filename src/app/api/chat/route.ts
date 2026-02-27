import { streamText } from "ai";
import { gateway } from "@ai-sdk/gateway";
import { MEDICAL_CONSULTATION_PROMPT } from "@/lib/prompts";

const MODEL_MAP: Record<string, string> = {
  "gpt-4o": "openai/gpt-4o",
  "gpt-4o-mini": "openai/gpt-4o-mini",
  "claude-sonnet": "anthropic/claude-sonnet-4-20250514",
  "deepseek-chat": "deepseek/deepseek-chat",
};

export async function POST(req: Request) {
  const { messages, model = "gpt-4o-mini" } = await req.json();
  const gatewayModel = MODEL_MAP[model] || MODEL_MAP["gpt-4o-mini"];

  const result = streamText({
    model: gateway(gatewayModel),
    system: MEDICAL_CONSULTATION_PROMPT,
    messages,
    maxOutputTokens: 2000,
  });

  return result.toUIMessageStreamResponse();
}
