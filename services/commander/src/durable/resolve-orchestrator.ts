import { getAgentByName } from "agents";
import { Data, Effect } from "effect";
import type { Env } from "../config";

export class OrchestratorInitializationError extends Data.TaggedError(
  "OrchestratorInitializationError",
)<{ readonly cause: unknown }> {}

/** The SDK handshake runs onStart before callers invoke custom RPC methods. */
export const resolveOrchestrator = (env: Env, name: string) =>
  Effect.tryPromise({
    try: () => getAgentByName(env.ORCHESTRATOR, name),
    catch: (cause) => new OrchestratorInitializationError({ cause }),
  });
