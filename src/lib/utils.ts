import type { UIMessage } from "ai";

/**
 * Extract text content from a UIMessage.
 * Compatible with multiple AI SDK message shapes.
 */
export function getMessageText(message: UIMessage): string {
  const content = (message as UIMessage & { content?: unknown }).content;
  if (typeof content === "string" && content.trim()) {
    return content;
  }

  const parts = (message as UIMessage & { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return "";

  return parts
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const typedPart = part as {
        type?: string;
        text?: string;
        content?: string;
      };

      if (typedPart.type === "text" && typeof typedPart.text === "string") {
        return typedPart.text;
      }
      if (
        typedPart.type === "output_text" &&
        typeof typedPart.text === "string"
      ) {
        return typedPart.text;
      }
      if (typeof typedPart.content === "string") {
        return typedPart.content;
      }

      return "";
    })
    .join("");
}
