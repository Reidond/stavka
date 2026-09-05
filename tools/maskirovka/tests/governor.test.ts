import { sanitizeClaudeSubscriptionEnvironment } from "@stavka/model-provider-claude";
import { Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import { FairGovernor } from "../src/services/fair-governor";

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("Claude subscription environment guardrails", () => {
  it("strips API key variables and installs only the selected subscription token", () => {
    expect(
      sanitizeClaudeSubscriptionEnvironment(
        {
          CODEX_API_KEY: "codex-secret",
          OPENAI_API_KEY: "openai-secret",
          ANTHROPIC_API_KEY: "anthropic-secret",
          PATH: "/usr/bin",
          UNDEFINED_VALUE: undefined,
        },
        "subscription-token",
      ),
    ).toEqual({ PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "subscription-token" });
  });
});

describe("fair seat governor", () => {
  it("caps concurrency and starts queued work in FIFO order", async () => {
    const governor = new FairGovernor(2);
    const started: number[] = [];
    const release: Array<() => void> = [];
    const jobs = [0, 1, 2, 3].map((id) =>
      Effect.runPromise(
        governor.run(
          Effect.callback<number>((resume) => {
            started.push(id);
            release.push(() => resume(Effect.succeed(id)));
          }),
        ),
      ),
    );
    await nextTurn();
    expect(started).toEqual([0, 1]);
    expect(governor.snapshot()).toMatchObject({ active: 2, queueDepth: 2 });
    release.shift()?.();
    await nextTurn();
    expect(started).toEqual([0, 1, 2]);
    release.shift()?.();
    await nextTurn();
    expect(started).toEqual([0, 1, 2, 3]);
    release.splice(0).forEach((resolve) => resolve());
    await expect(Promise.all(jobs)).resolves.toEqual([0, 1, 2, 3]);
  });

  it("releases capacity when queued and active work is interrupted", async () => {
    const governor = new FairGovernor(1);
    await Effect.runPromise(
      Effect.gen(function* () {
        const active = yield* Effect.forkChild(governor.run(Effect.never));
        yield* Effect.yieldNow;
        const queued = yield* Effect.forkChild(governor.run(Effect.never));
        yield* Effect.yieldNow;
        expect(governor.snapshot()).toMatchObject({ active: 1, queueDepth: 1 });
        yield* Fiber.interrupt(queued);
        yield* Fiber.interrupt(active);
        expect(governor.snapshot()).toMatchObject({ active: 0, queueDepth: 0 });
      }),
    );
  });

  it("checks plan headroom at governor admission before starting work", async () => {
    const governor = new FairGovernor(1);
    let invoked = false;
    await expect(
      Effect.runPromise(
        governor.run(
          Effect.sync(() => {
            invoked = true;
          }),
          Effect.fail(new Error("plan window exhausted")),
        ),
      ),
    ).rejects.toThrow("plan window exhausted");
    expect(invoked).toBe(false);
    expect(governor.snapshot()).toMatchObject({ active: 0, queueDepth: 0 });
  });
});
