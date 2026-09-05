import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { EnfusionBackend, type Inspection } from "../src/enfusion-backend";
import { EnfusionError } from "../src/enfusion-contract";
import { EnfusionJobsLive } from "../src/enfusion-jobs";
import { createEnfusionServer } from "../src/enfusion-server";

const fixture = async (outcome: "running" | "passed" | "failed" = "running") => {
  const results = new Map<string, Inspection>();
  let active = 0;
  const backend = Layer.succeed(EnfusionBackend, {
    doctor: Effect.succeed({ ready: true, toolsVersion: "1.8.0.13" }),
    docs: (query) =>
      Effect.succeed({
        engineVersion: "1.8.0.13",
        query,
        totalMatches: 0,
        matches: [],
        cache: "test-cache",
      }),
    inspect: (runId) =>
      results.has(runId)
        ? Effect.succeed(results.get(runId)!)
        : Effect.fail(new EnfusionError({ code: "NOT_FOUND", message: "No saved result" })),
    run: (runId, input) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          active++;
        }),
        () =>
          outcome === "running"
            ? Effect.never
            : outcome === "failed"
              ? Effect.fail(
                  new EnfusionError({ code: "FAILED", message: "Native assertion failed" }),
                )
              : Effect.succeed({
                  schemaVersion: 1 as const,
                  runId,
                  action: input.action,
                  status: "passed" as const,
                  startedAt: "test",
                  finishedAt: "test",
                  sourceHash: "test",
                  installation: null,
                  diagnostics: [],
                  artifacts: [],
                  message: "completed",
                }),
        () =>
          Effect.sync(() => {
            active--;
            results.set(runId, {
              schemaVersion: 1,
              runId,
              action: input.action,
              status: outcome === "running" ? "cancelled" : outcome,
              startedAt: "test",
              finishedAt: "test",
              sourceHash: "test",
              installation: null,
              diagnostics: [],
              artifacts: [],
              message: "cancelled",
              artifactIntegrity: "verified",
              invalidArtifacts: [],
            });
          }),
      ),
  });
  const runtime = ManagedRuntime.make(EnfusionJobsLive.pipe(Layer.provideMerge(backend)));
  const server = createEnfusionServer(runtime);
  const client = new Client({ name: "enfusion-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    runtime,
    active: () => active,
    close: async () => {
      await client.close();
      await server.close();
      await runtime.dispose();
    },
  };
};

describe("Enfusion MCP protocol", () => {
  it("negotiates typed tools and rejects unknown arguments and engine flag injection", async () => {
    const test = await fixture();
    try {
      const tools = await test.client.listTools();
      expect(tools.tools).toHaveLength(6);
      const doctor = await test.client.callTool({ name: "enfusion_doctor", arguments: {} });
      expect(doctor.structuredContent).toMatchObject({ ready: true });
      const extra = await test.client.callTool({
        name: "enfusion_start",
        arguments: { action: "smoke", command: "unexpected" },
      });
      expect(extra.isError).toBe(true);
      const flags = await test.client.callTool({
        name: "enfusion_start",
        arguments: { action: "resources", query: "-scriptAuthorizeAll" },
      });
      expect(flags.isError).toBe(true);
      const narrowing = await test.client.callTool({
        name: "enfusion_start",
        arguments: { action: "pack", target: "PC" },
      });
      expect(narrowing.isError).toBe(true);
      const resources = await test.client.listResourceTemplates();
      expect(resources.resourceTemplates[0]?.uriTemplate).toBe("enfusion://runs/{runId}");
    } finally {
      await test.close();
    }
  });

  it("returns promptly, rejects overlapping native work and cancels only owned jobs", async () => {
    const test = await fixture();
    try {
      const started = await test.client.callTool({
        name: "enfusion_start",
        arguments: { action: "smoke" },
      });
      const runId = Schema.decodeUnknownSync(Schema.Struct({ runId: Schema.String }))(
        started.structuredContent,
      ).runId;
      expect(started.structuredContent).toMatchObject({ state: "running" });
      await expect.poll(test.active).toBe(1);
      const busy = await test.client.callTool({
        name: "enfusion_start",
        arguments: { action: "validate" },
      });
      expect(busy.structuredContent).toMatchObject({ error: { code: "BUSY" } });
      const foreign = await test.client.callTool({
        name: "enfusion_cancel",
        arguments: { runId: "11111111-1111-1111-1111-111111111111" },
      });
      expect(foreign.isError).toBe(true);
      expect(test.active()).toBe(1);
      const cancelled = await test.client.callTool({
        name: "enfusion_cancel",
        arguments: { runId },
      });
      expect(cancelled.structuredContent).toMatchObject({
        state: "cancelled",
        result: { status: "cancelled" },
      });
      expect(test.active()).toBe(0);
      const evidence = await test.client.readResource({ uri: `enfusion://runs/${String(runId)}` });
      expect(evidence.contents[0]?.mimeType).toBe("application/json");
      await expect(test.client.readResource({ uri: "file:///unrelated" })).rejects.toThrow();
      await test.client.callTool({ name: "enfusion_start", arguments: { action: "smoke" } });
      await expect.poll(test.active).toBe(1);
      await test.runtime.dispose();
      expect(test.active()).toBe(0);
    } finally {
      await test.close();
    }
  });

  it.each(["passed", "failed"] as const)(
    "retains %s evidence and releases the active job slot",
    async (outcome) => {
      const test = await fixture(outcome);
      try {
        const started = await test.client.callTool({
          name: "enfusion_start",
          arguments: { action: "smoke" },
        });
        const { runId } = Schema.decodeUnknownSync(Schema.Struct({ runId: Schema.String }))(
          started.structuredContent,
        );
        await expect
          .poll(
            async () =>
              (await test.client.callTool({ name: "enfusion_job", arguments: { runId } }))
                .structuredContent,
          )
          .toMatchObject({
            state: "finished",
            result: { status: outcome, artifactIntegrity: "verified" },
          });
        expect(test.active()).toBe(0);
        const next = await test.client.callTool({
          name: "enfusion_start",
          arguments: { action: "validate" },
        });
        expect(next.isError).toBe(false);
      } finally {
        await test.close();
      }
    },
  );
});
