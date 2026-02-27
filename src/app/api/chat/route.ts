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

  if (!process.env.AI_GATEWAY_API_KEY) {
    return Response.json(
      {
        error:
          "Missing AI_GATEWAY_API_KEY. Please configure it in local .env.local or Vercel Environment Variables.",
      },
      { status: 500 },
    );
  }

  const gatewayModel = MODEL_MAP[model] || MODEL_MAP["gpt-4o-mini"];

  const latestUserMessage = Array.isArray(messages)
    ? [...messages].reverse().find((m) => m?.role === "user")
    : null;

  const promptFromParts = Array.isArray(latestUserMessage?.parts)
    ? latestUserMessage.parts
        .map((part: { type?: string; text?: string }) =>
          part?.type === "text" && typeof part.text === "string"
            ? part.text
            : "",
        )
        .join("")
    : "";

  const promptFromContent =
    typeof latestUserMessage?.content === "string"
      ? latestUserMessage.content
      : "";

  const prompt = (promptFromParts || promptFromContent || "").trim();

  if (!prompt) {
    return Response.json(
      { error: "Missing user prompt content." },
      { status: 400 },
    );
  }

  const result = streamText({
    model: gateway(gatewayModel),
    system: MEDICAL_CONSULTATION_PROMPT,
    prompt,
    maxOutputTokens: 2000,
  });

  return result.toUIMessageStreamResponse();
}
