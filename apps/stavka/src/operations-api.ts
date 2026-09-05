import {
  CommanderHealth,
  InferenceStatus,
  ModelProbeResponse,
  ModelProbeFailure,
  SessionExport,
} from "@stavka/protocol";
import { Schema } from "effect";

const readJson = async (path: string, signal: AbortSignal): Promise<unknown> => {
  const response = await fetch(path, { signal, headers: { "x-requested-with": "XMLHttpRequest" } });
  if (!response.ok) throw new Error(`Service returned HTTP ${response.status}`);
  return response.json();
};

export const readInferenceStatus = async (signal: AbortSignal) =>
  Schema.decodeUnknownSync(InferenceStatus)(await readJson("/admin/status", signal));

export const readCommanderHealth = async (signal: AbortSignal) =>
  Schema.decodeUnknownSync(CommanderHealth)(await readJson("/api/system/commander", signal));

export const readSessionExport = async (
  sessionId: string,
  faction: string,
  signal: AbortSignal,
) => {
  const query = new URLSearchParams({ session_id: sessionId, faction });
  return Schema.decodeUnknownSync(SessionExport)(
    await readJson(`/api/commander/export?${query}`, signal),
  );
};

export const runModelProbe = async (tier: string, seat: "codex" | "claude") => {
  const prompt = "Reply with STAVKA_READY only.";
  const anthropic = seat === "claude";
  const response = await fetch(anthropic ? "/v1/messages" : "/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest" },
    body: JSON.stringify(
      anthropic
        ? {
            model: tier,
            max_tokens: 64,
            stream: false,
            messages: [{ role: "user", content: prompt }],
          }
        : { model: tier, stream: false, input: prompt },
    ),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) {
    const failure = Schema.decodeUnknownOption(ModelProbeFailure)(
      await response.json().catch(() => undefined),
    );
    throw new Error(
      `Model request failed (HTTP ${response.status}). ${failure._tag === "Some" ? failure.value.error.message : "Check provider authorization and system status."}`,
    );
  }
  const result = Schema.decodeUnknownSync(ModelProbeResponse)(await response.json());
  const content = result.content ?? result.output?.flatMap((item) => item.content ?? []) ?? [];
  return {
    model: result.model,
    usage: result.usage,
    cacheStatus: response.headers.get("x-maskirovka-cache"),
    text: content.flatMap((item) => (item.text ? [item.text] : [])).join("\n"),
  };
};
