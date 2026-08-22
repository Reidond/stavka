import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
}));
vi.mock("@cloudflare/containers", () => ({
  Container: class {},
}));

import { limitStreamBytes } from "../src/gateway-container";
import { isHtmlNavigation } from "../src/router";

const streamOf = (chunks: readonly string[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });

const collect = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) text += decoder.decode(chunk);
  return text;
};

describe("streamed byte limits", () => {
  it("passes responses below the byte limit through intact", async () => {
    const limited = limitStreamBytes(streamOf(["hello ", "world"]), 64);
    expect(await collect(limited as ReadableStream<Uint8Array>)).toBe("hello world");
  });

  it("errors the stream once the actual byte count exceeds the limit", async () => {
    // Content-Length is not consulted: the real streamed bytes decide.
    const limited = limitStreamBytes(streamOf(["a".repeat(40), "b".repeat(40)]), 64);
    await expect(collect(limited as ReadableStream<Uint8Array>)).rejects.toThrow(/byte limit/u);
  });
});

describe("html navigation detection for SPA fallback", () => {
  it("treats sec-fetch-mode navigate as navigation", () => {
    const request = new Request("https://inference.test/whatever", {
      headers: { "sec-fetch-mode": "navigate" },
    });
    expect(isHtmlNavigation(request, "/whatever")).toBe(true);
  });

  it("never treats asset-like paths or non-HTML accepts as navigation", () => {
    expect(
      isHtmlNavigation(
        new Request("https://inference.test/assets/app.js", {
          headers: { accept: "*/*" },
        }),
        "assets/app.js",
      ),
    ).toBe(false);
    expect(
      isHtmlNavigation(
        new Request("https://inference.test/assets/app.js.map", {
          headers: { accept: "text/html" },
        }),
        "assets/app.js.map",
      ),
    ).toBe(false);
  });

  it("falls back to accept headers when sec-fetch-mode is absent", () => {
    expect(
      isHtmlNavigation(
        new Request("https://inference.test/sessions", { headers: { accept: "text/html" } }),
        "sessions",
      ),
    ).toBe(true);
  });
});

describe("trusted routing metadata sources", () => {
  it("strips caller-supplied x-maskirovka-* headers before the container sees them", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/gateway-container.ts", import.meta.url), "utf8"),
    );
    expect(source).toContain('name.toLowerCase().startsWith("x-maskirovka-")');
    // Metadata must be read from the container response, not the request.
    expect(source).toContain("new Headers(response.headers)");
    expect(source).not.toMatch(/headers\.get\("x-maskirovka-(provider|seat|model|queue-depth)"\)/u);
  });

  it("emits provider, resolved model, usage, and cost metadata from the gateway", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../../../tools/maskirovka/src/router.ts", import.meta.url), "utf8"),
    );
    for (const header of [
      '"x-maskirovka-tier"',
      '"x-maskirovka-seat"',
      '"x-maskirovka-provider"',
      '"x-maskirovka-model"',
      '"x-maskirovka-input-tokens"',
      '"x-maskirovka-output-tokens"',
      '"x-maskirovka-cost-actual-usd"',
      '"x-maskirovka-cost-list-usd"',
      '"x-maskirovka-cost-plan-credit-usd"',
    ]) {
      expect(source).toContain(header);
    }
  });
});
