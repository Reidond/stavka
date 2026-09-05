#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Config, Effect } from "effect";
import { createEnfusionRuntime } from "./enfusion-runtime";
import { createEnfusionServer } from "./enfusion-server";

// SDK/runtime boundary. Stdout belongs exclusively to MCP JSON-RPC.
const main = async () => {
  const projectRoot = await Effect.runPromise(
    Config.string("ENFUSION_PROJECT_ROOT").pipe(
      Config.withDefault(resolve(dirname(fileURLToPath(import.meta.url)), "../../..")),
    ),
  );
  const runtime = createEnfusionRuntime(resolve(projectRoot));
  const server = createEnfusionServer(runtime);
  const transport = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: 1024 * 1024,
  });
  let stop = () => {};
  const stopped = new Promise<void>((resolveStopped) => {
    stop = resolveStopped;
  });
  process.stdin.once("end", stop);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  server.onclose = stop;
  server.onerror = (error) => console.error(`[enfusion-mcp] ${error.message}`);
  try {
    await server.connect(transport);
    await stopped;
  } finally {
    process.stdin.off("end", stop);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    try {
      await server.close();
    } finally {
      await runtime.dispose();
    }
  }
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
