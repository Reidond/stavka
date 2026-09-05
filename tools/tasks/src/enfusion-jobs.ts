import { Cause, Context, Effect, Exit, Fiber, Layer, Semaphore } from "effect";
import { EnfusionBackend, validateRunInput } from "./enfusion-backend";
import { EnfusionError, type RunInput } from "./enfusion-contract";

type Job = {
  readonly runId: string;
  readonly action: RunInput["action"];
  state: "running" | "finished" | "cancelled";
  error: string | null;
  fiber?: Fiber.Fiber<void, never>;
};
export class EnfusionJobs extends Context.Service<
  EnfusionJobs,
  {
    readonly start: (
      input: RunInput,
    ) => Effect.Effect<{ runId: string; state: "running"; resource: string }, EnfusionError>;
    readonly get: (runId: string) => Effect.Effect<Record<string, unknown>, EnfusionError>;
    readonly cancel: (runId: string) => Effect.Effect<Record<string, unknown>, EnfusionError>;
  }
>()("stavka/EnfusionJobs") {}

export const EnfusionJobsLive = Layer.effect(
  EnfusionJobs,
  Effect.gen(function* () {
    const backend = yield* EnfusionBackend;
    const scope = yield* Effect.scope;
    const gate = yield* Semaphore.make(1);
    const jobs = new Map<string, Job>();
    let active: string | undefined;

    const get = (runId: string) =>
      Effect.gen(function* () {
        const job = jobs.get(runId);
        if (job?.state === "running")
          return { runId, action: job.action, state: job.state, result: null };
        if (!job) {
          const result = yield* backend.inspect(runId);
          return { runId, action: result.action, state: "finished", error: null, result };
        }
        const inspection = yield* backend.inspect(runId).pipe(
          Effect.match({
            onFailure: (error) => ({ result: null, inspectionError: error.message }),
            onSuccess: (result) => ({ result, inspectionError: null }),
          }),
        );
        return { runId, action: job.action, state: job.state, error: job.error, ...inspection };
      });

    return {
      start: (input) =>
        gate.withPermits(1)(
          Effect.gen(function* () {
            yield* validateRunInput(input);
            if (active)
              return yield* Effect.fail(
                new EnfusionError({
                  code: "BUSY",
                  message: `Native job ${active} is active. Poll or cancel it first.`,
                }),
              );
            const runId = yield* Effect.sync(() => crypto.randomUUID());
            const job: Job = { runId, action: input.action, state: "running", error: null };
            if (jobs.size >= 64) {
              const oldest = jobs.keys().next().value;
              if (oldest) jobs.delete(oldest);
            }
            jobs.set(runId, job);
            active = runId;
            job.fiber = yield* backend.run(runId, input).pipe(
              Effect.match({
                onFailure: (error) => {
                  job.state = "finished";
                  job.error = error.message;
                },
                onSuccess: () => {
                  job.state = "finished";
                },
              }),
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  if (Exit.isFailure(exit)) {
                    const cause = exit.cause;
                    if (Exit.hasInterrupts(exit)) {
                      job.state = "cancelled";
                      job.error = "Job cancelled; scoped cleanup completed.";
                    } else {
                      job.state = "finished";
                      job.error = Cause.pretty(cause);
                    }
                  }
                }),
              ),
              Effect.catchCause(() => Effect.void),
              Effect.ensuring(
                Effect.sync(() => {
                  if (active === runId) active = undefined;
                }),
              ),
              Effect.forkIn(scope),
            );
            return { runId, state: "running" as const, resource: `enfusion://runs/${runId}` };
          }),
        ),
      get,
      cancel: (runId) =>
        Effect.gen(function* () {
          const job = jobs.get(runId);
          if (!job)
            return yield* Effect.fail(
              new EnfusionError({
                code: "NOT_FOUND",
                message: "This MCP session does not own that job.",
              }),
            );
          if (job.state === "running" && job.fiber) yield* Fiber.interrupt(job.fiber);
          return yield* get(runId);
        }),
    };
  }),
);
