import { Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import { readConfig } from "../src/config";
import type {
  CliProbeRepositoryService,
  ProbeResult,
} from "../src/repositories/cli-probe-repository";
import type { DevVarsRepositoryService } from "../src/repositories/dev-vars-repository";
import { sanitizeCodexSubscriptionEnvironment } from "../src/seats/codex-seat";
import { DoctorService } from "../src/services/doctor-service";
import { FairGovernor } from "../src/services/fair-governor";

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("codex subscription environment guardrails", () => {
  it("strips both Codex API key variables without dropping ordinary environment values", () => {
    expect(
      sanitizeCodexSubscriptionEnvironment({
        CODEX_API_KEY: "codex-secret",
        OPENAI_API_KEY: "openai-secret",
        PATH: "/usr/bin",
        UNDEFINED_VALUE: undefined,
      }),
    ).toEqual({ PATH: "/usr/bin" });
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

describe("doctor guardrails", () => {
  it("checks tools, login, override trap, pings, then writes dev vars", async () => {
    const order: string[] = [];
    const probes: CliProbeRepositoryService = {
      run: (program, arguments_): Effect.Effect<ProbeResult> =>
        Effect.sync(() => {
          order.push(`${program}:${arguments_.join(" ")}`);
          return { ok: true, output: "ok", exitCode: 0 };
        }),
    };
    const writes: string[] = [];
    const writtenValues = new Map<string, Readonly<Record<string, string>>>();
    const devVars: DevVarsRepositoryService = {
      read: () => Effect.succeed({ values: {}, explicitKeys: new Set() }),
      write: (filename, values) =>
        Effect.sync(() => {
          writes.push(filename);
          writtenValues.set(filename, values);
          expect(values.OPENAI_API_KEY).toBeUndefined();
          expect(values.CODEX_API_KEY).toBeUndefined();
          expect(values.ANTHROPIC_API_KEY).toBeUndefined();
        }),
    };
    const doctor = new DoctorService(
      readConfig({}, "/tmp/stavka-maskirovka-doctor"),
      probes,
      devVars,
      "/repo",
      (seat) =>
        Effect.sync(() => {
          order.push(`ping:${seat}`);
        }),
      {
        OPENAI_API_KEY: "openai-secret-value",
        CODEX_API_KEY: "codex-secret-value",
        ANTHROPIC_API_KEY: "anthropic-secret-value",
      },
    );
    const report = await Effect.runPromise(doctor.run({ live: true, write: true }));
    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.id)).toEqual([
      "codex-installed",
      "claude-installed",
      "codex-login",
      "claude-login",
      "api-key-override",
      "codex-ping",
      "claude-ping",
      "dev-vars",
    ]);
    expect(order).toEqual([
      "codex:--version",
      "claude:--version",
      "codex:login status",
      "claude:auth status",
      "ping:codex",
      "ping:claude",
    ]);
    expect(writes).toEqual([
      "/repo/.dev.vars",
      "/repo/apps/commander/.dev.vars",
      "/repo/apps/poligon/.dev.vars",
    ]);
    const commanderValues = writtenValues.get("/repo/apps/commander/.dev.vars");
    const poligonValues = writtenValues.get("/repo/apps/poligon/.dev.vars");
    expect(commanderValues).toMatchObject({
      ENVIRONMENT: "local",
      DEV_ACCESS_EMAIL: "developer@localhost",
      STAVKA_AI_PROVIDER: "openai",
    });
    expect(commanderValues?.API_KEY).toMatch(/^sk-stavka-local-/u);
    expect(poligonValues?.COMMANDER_API_KEY).toBe(commanderValues?.API_KEY);
    const overrideCheck = report.checks.find((check) => check.id === "api-key-override");
    expect(overrideCheck?.message).toContain("OPENAI_API_KEY");
    expect(overrideCheck?.message).toContain("CODEX_API_KEY");
    expect(overrideCheck?.message).toContain("ANTHROPIC_API_KEY");
    const serializedReport = JSON.stringify(report);
    expect(serializedReport).not.toContain("openai-secret-value");
    expect(serializedReport).not.toContain("codex-secret-value");
    expect(serializedReport).not.toContain("anthropic-secret-value");
  });

  it("never pings a seat unless --live is explicit", async () => {
    let pings = 0;
    const doctor = new DoctorService(
      readConfig({}, "/tmp/stavka-maskirovka-doctor"),
      { run: () => Effect.succeed({ ok: true, output: "ok", exitCode: 0 }) },
      {
        read: () => Effect.succeed({ values: {}, explicitKeys: new Set() }),
        write: () => Effect.void,
      },
      "/repo",
      () =>
        Effect.sync(() => {
          pings += 1;
        }),
      {},
    );
    const report = await Effect.runPromise(doctor.run({ live: false, write: false }));
    expect(pings).toBe(0);
    expect(
      report.checks
        .filter((check) => check.id.endsWith("-ping"))
        .every((check) => check.status === "skip"),
    ).toBe(true);
  });
});
