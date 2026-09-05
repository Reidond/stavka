import { Data, Effect, Schema } from "effect";
import { AuthorizeExecution, ExecutionSession, ExecutionStatus } from "@stavka/protocol";

class ExecutionRequestError extends Data.TaggedError("ExecutionRequestError")<{
  readonly message: string;
}> {}

export const requestExecution = (
  action: "authorize" | "status" | "revoke",
  input: ExecutionSession | AuthorizeExecution,
) =>
  Effect.gen(function* () {
    const payload = yield* Schema.decodeUnknownEffect(
      action === "authorize" ? AuthorizeExecution : ExecutionSession,
    )(input);
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(`/admin/execution/${action}`, {
          method: "POST",
          signal,
          headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest" },
          body: JSON.stringify(payload),
        }),
      catch: () =>
        new ExecutionRequestError({ message: "Unable to reach AI session authorization." }),
    });
    if (!response.ok)
      return yield* Effect.fail(
        new ExecutionRequestError({
          message:
            response.status === 403
              ? "AI authorization belongs to another user, or your account cannot operate this session."
              : response.status === 401
                ? "Sign in again to manage AI authorization."
                : `AI authorization failed (HTTP ${response.status}).`,
        }),
      );
    const body = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () =>
        new ExecutionRequestError({ message: "AI authorization returned an invalid response." }),
    });
    return yield* Schema.decodeUnknownEffect(ExecutionStatus)(body);
  }).pipe(Effect.timeout("15 seconds"));
