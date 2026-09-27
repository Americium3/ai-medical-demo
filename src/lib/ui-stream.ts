/**
 * Read the text out of an AI SDK v6 UI message stream
 * (the SSE body returned by `toUIMessageStreamResponse()`).
 *
 * Wire format: `data: {"type":"text-delta","id":"...","delta":"..."}` lines,
 * separated by blank lines, terminated by `data: [DONE]`.
 * Network chunks can split a line anywhere, so we buffer until a newline.
 */
export async function readUIMessageText(
  body: ReadableStream<Uint8Array>,
  onText?: (fullText: string) => void,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";

  const handleLine = (line: string) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;

    let event: { type?: string; delta?: string; errorText?: string };
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }

    if (event.type === "text-delta" && typeof event.delta === "string") {
      text += event.delta;
      onText?.(text);
    } else if (event.type === "error") {
      throw new Error(event.errorText || "Model stream returned an error");
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  }
  buffer += decoder.decode();
  if (buffer) handleLine(buffer);

  return text;
}
