import { readSSEJson } from "./sse";

/**
 * Read the text out of an AI SDK v6 UI message stream
 * (the SSE body returned by `toUIMessageStreamResponse()`).
 *
 * Wire format: `data: {"type":"text-delta","id":"...","delta":"..."}` lines,
 * separated by blank lines, terminated by `data: [DONE]`.
 */
export async function readUIMessageText(
  body: ReadableStream<Uint8Array>,
  onText?: (fullText: string) => void,
): Promise<string> {
  let text = "";
  await readSSEJson<{ type?: string; delta?: string; errorText?: string }>(body, (event) => {
    if (event.type === "text-delta" && typeof event.delta === "string") {
      text += event.delta;
      onText?.(text);
    } else if (event.type === "error") {
      throw new Error(event.errorText || "Model stream returned an error");
    }
  });
  return text;
}
