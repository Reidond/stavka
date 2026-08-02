import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = resolve(appRoot, "src");

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory)
    .flatMap((entry) => {
      const path = resolve(directory, entry);
      return statSync(path).isDirectory() ? sourceFiles(path) : [path];
    })
    .filter((path) => path.endsWith(".ts"));

describe("hosted seat architecture boundaries", () => {
  it("keeps raw SQL inside repository modules", () => {
    const violations = sourceFiles(sourceRoot)
      .filter((path) => !path.endsWith("repository.ts"))
      .filter((path) =>
        /(?:CREATE|SELECT|INSERT|UPDATE|DELETE)\s+(?:TABLE|FROM|INTO|SET)/iu.test(
          readFileSync(path, "utf8"),
        ),
      );
    expect(violations).toEqual([]);
  });

  it("uses Effect HttpApi contracts and runtime adapters without pathname dispatch", () => {
    const contract = readFileSync(resolve(sourceRoot, "http-contract.ts"), "utf8");
    const worker = readFileSync(resolve(sourceRoot, "router.ts"), "utf8");
    const container = readFileSync(resolve(sourceRoot, "container/app.ts"), "utf8");
    const main = readFileSync(resolve(sourceRoot, "container/main.ts"), "utf8");

    expect(contract).toContain("HttpApiGroup.make");
    expect(contract).toContain("HttpApiEndpoint.post");
    expect(worker).toContain("HttpApiBuilder.group");
    expect(worker).toContain("HttpRouter.toWebHandler");
    expect(container).toContain("HttpApiBuilder.group");
    expect(main).toContain("HttpRouter.serve");
    expect(`${contract}\n${worker}\n${container}\n${main}`).not.toMatch(
      /pathname\s*===|switch\s*\([^)]*pathname|from\s+["']hono["']/u,
    );
  });

  it("exposes repository operations as Effects", () => {
    const repository = readFileSync(resolve(sourceRoot, "seat-state-repository.ts"), "utf8");
    expect(repository).toContain("Effect.Effect");
    expect(repository).not.toContain("Promise<");
  });

  it("persists request metadata only and generates its own correlation id", () => {
    const repository = readFileSync(resolve(sourceRoot, "seat-state-repository.ts"), "utf8");
    const router = readFileSync(resolve(sourceRoot, "router.ts"), "utf8");
    const tableStart = repository.indexOf("CREATE TABLE IF NOT EXISTS seat_request_log");
    const tableEnd = repository.indexOf("`);", tableStart);
    const requestTable = repository.slice(tableStart, tableEnd);
    const recordStart = repository.indexOf("recordRequest(");
    const recordEnd = repository.indexOf("listRecentRequests(", recordStart);
    const recordRequest = repository.slice(recordStart, recordEnd);

    expect(tableStart).toBeGreaterThanOrEqual(0);
    expect(requestTable).toContain("request_id TEXT PRIMARY KEY");
    expect(requestTable).toContain("latency_ms INTEGER NOT NULL");
    expect(requestTable).not.toMatch(/\b(?:prompt|body|authorization|auth|error|content)\b/iu);
    expect(recordRequest).not.toMatch(/log\.(?:prompt|body|authorization|auth|error|content)\b/iu);
    expect(router).toContain('"x-maskirovka-request-id": crypto.randomUUID()');
    expect(router).not.toContain('headers["x-request-id"]');
  });

  it("declares scale-to-zero, reconnect, and checkpoint behavior", () => {
    const source = readFileSync(resolve(sourceRoot, "seat-container.ts"), "utf8");
    expect(source).toContain("sleepAfter");
    expect(source).toContain("startAndWaitForPorts");
    expect(source).toContain("SEAT_DISCONNECTED");
    expect(source).toContain("headers.delete(AUTH_CHECKPOINT_HEADER)");
    expect(source).toContain("checkpointAuth");
  });

  it("runs the image as a non-root user and never bakes provider credentials", () => {
    const dockerfile = readFileSync(resolve(appRoot, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("USER maskirovka");
    expect(dockerfile).not.toMatch(/(?:sk-|oauth)[A-Za-z0-9_-]{12,}/u);
  });
});
