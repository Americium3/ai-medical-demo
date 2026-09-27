/**
 * Read a server-sent-events body and hand each `data:` payload, parsed as
 * JSON, to `onData`. Network chunks can split a line anywhere, so input is
 * buffered until a newline. `[DONE]` sentinels and non-JSON lines are skipped.
 */
export async function readSSEJson<T>(
  body: ReadableStream<Uint8Array>,
  onData: (data: T) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const handleLine = (line: string) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let data: T;
    try {
      data = JSON.parse(payload);
    } catch {
      return;
    }
    onData(data);
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
}
