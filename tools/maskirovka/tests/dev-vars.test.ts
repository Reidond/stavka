import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import test12Fixture from "../../../packages/protocol/fixtures/test-12-round-trip.json";
import type { Env as CommanderEnv } from "../../../services/commander/src/config";

import { readConfig } from "../src/config";
import { FileDevVarsRepository } from "../src/repositories/dev-vars-repository";
import { DoctorService } from "../src/services/doctor-service";

vi.mock("agents", () => ({
  getAgentByName: async (namespace: { getByName: (name: string) => unknown }, name: string) =>
    namespace.getByName(name),
  Agent: class {},
  routeAgentRequest: vi.fn(async () => null),
}));

const { handleRequest: handleCommanderRequest } =
  await import("../../../services/commander/src/api/router");

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "stavka-doctor-vars-"));
  directories.push(root);
  return root;
};

const runDoctor = async (root: string, repository: FileDevVarsRepository) => {
  const doctor = new DoctorService(
    readConfig({}, root),
    { run: () => Effect.succeed({ ok: true, output: "ok", exitCode: 0 }) },
    repository,
    root,
    () => Effect.void,
    () => false,
    {},
  );
  return Effect.runPromise(doctor.run({ live: false, write: true }));
};

describe("safe local development variables", () => {
  it("generates complete Commander and Poligon files with one non-production machine key", async () => {
    const root = await makeRoot();
    const repository = new FileDevVarsRepository();

    const report = await runDoctor(root, repository);
    const commander = await repository
      .read(join(root, "services/commander/.dev.vars"))
      .pipe(Effect.runPromise);
    const poligon = await repository
      .read(join(root, "apps/stavka/.dev.vars"))
      .pipe(Effect.runPromise);

    expect(report.ok).toBe(true);
    expect(report.wroteDevVars).toHaveLength(3);
    expect(commander.values).toMatchObject({
      ENVIRONMENT: "local",
      DEV_ACCESS_EMAIL: "developer@localhost",
      STAVKA_AI_PROVIDER: "openai",
      STAVKA_AI_BASE_URL: "http://127.0.0.1:4141",
      COMMANDER_MODEL: "stavka/commander",
      SERGEANT_MODEL: "stavka/sergeant",
      HEAVY_MODEL: "stavka/heavy",
    });
    expect(commander.values.API_KEY).toMatch(/^sk-stavka-local-[a-f0-9]{32}$/u);
    expect(poligon.values).toMatchObject({
      ENVIRONMENT: "local",
      DEV_ACCESS_EMAIL: "developer@localhost",
      COMMANDER_URL: "http://127.0.0.1:8787",
      COMMANDER_API_KEY: commander.values.API_KEY,
    });

    const handleTick = vi.fn(async () => test12Fixture.response);
    const commanderEnv = {
      ORCHESTRATOR: {
        getByName: vi.fn(() => ({ handleTick })),
      },
      TERRAIN_CACHE: {},
      ...commander.values,
    } as unknown as CommanderEnv;
    const health = await handleCommanderRequest(
      new Request("http://127.0.0.1/healthz"),
      commanderEnv,
    );
    const tickRequest = (authorization?: string) =>
      new Request("http://127.0.0.1/api/tick", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-stavka-mission-epoch": "1",
          ...(authorization ? { authorization } : {}),
        },
        body: JSON.stringify(test12Fixture.request),
      });
    const unauthenticated = await handleCommanderRequest(tickRequest(), commanderEnv);
    const authenticated = await handleCommanderRequest(
      tickRequest(`Bearer ${commander.values.API_KEY}`),
      commanderEnv,
    );

    expect(health.status).toBe(200);
    expect(unauthenticated.status).toBe(401);
    expect(authenticated.status).toBe(200);
    expect(handleTick).toHaveBeenCalledWith(test12Fixture.request);
  });

  it("preserves explicit operator values while replacing known placeholders", async () => {
    const root = await makeRoot();
    const repository = new FileDevVarsRepository();
    const commanderFile = join(root, "services/commander/.dev.vars");
    const poligonFile = join(root, "apps/stavka/.dev.vars");
    await repository
      .write(commanderFile, {} as Readonly<Record<string, string>>)
      .pipe(Effect.runPromise);
    await writeFile(
      commanderFile,
      "API_KEY=operator-secret\nENVIRONMENT=preview\nCUSTOM_VALUE=keep-me\n",
      "utf8",
    );
    await mkdir(join(root, "apps/stavka"), { recursive: true });
    await writeFile(poligonFile, "COMMANDER_API_KEY=sk-stavka-replace-me\n", "utf8");

    await runDoctor(root, repository);
    const commanderText = await readFile(commanderFile, "utf8");
    const commander = await Effect.runPromise(repository.read(commanderFile));
    const poligon = await Effect.runPromise(repository.read(poligonFile));

    expect(commander.values.API_KEY).toBe("operator-secret");
    expect(commander.values.ENVIRONMENT).toBe("preview");
    expect(commanderText).toContain("CUSTOM_VALUE=keep-me");
    expect(poligon.values.COMMANDER_API_KEY).toBe("operator-secret");
  });
});
