import type { UIMessage } from "ai";

/**
 * Extract text content from a UIMessage (AI SDK v6 uses parts array)
 */
export function getMessageText(message: UIMessage): string {
  if (!message.parts) return "";
  return message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}
