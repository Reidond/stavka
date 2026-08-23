import { ModelProviderError } from "@stavka/model-provider";

export interface ServerSentEvent {
  readonly event?: string;
  readonly data: string;
}

const frames = (
  buffer: string,
): { readonly complete: readonly string[]; readonly remainder: string } => {
  const normalized = buffer.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
  const parts = normalized.split("\n\n");
  return { complete: parts.slice(0, -1), remainder: parts.at(-1) ?? "" };
};

const parseFrame = (frame: string): ServerSentEvent | undefined => {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /u, ""));
  }
  if (data.length === 0) return undefined;
  return { ...(event ? { event } : {}), data: data.join("\n") };
};

export async function* parseServerSentEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<ServerSentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const abort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const split = frames(buffer);
      buffer = split.remainder;
      for (const frame of split.complete) {
        const parsed = parseFrame(frame);
        if (parsed) yield parsed;
      }
    }
    buffer += decoder.decode();
    const trailing = parseFrame(buffer.trim());
    if (trailing) yield trailing;
  } catch (cause) {
    if (cause instanceof ModelProviderError) throw cause;
    throw cause;
  } finally {
    signal?.removeEventListener("abort", abort);
    try {
      await reader.cancel();
    } catch {
      // Reader may already be closed by the provider.
    }
    try {
      reader.releaseLock();
    } catch {
      // Ignore an already released lock.
    }
  }
}
