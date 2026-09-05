import { afterEach, describe, expect, it, vi } from "vitest";
import { runModelProbe } from "../src/operations-api";

afterEach(() => vi.unstubAllGlobals());
describe("explicit model connection test", () => {
  it.each(["codex", "claude"] as const)(
    "uses the %s dialect and displays provider-reported usage",
    async (seat) => {
      const fetch = vi.fn(async () =>
        Response.json({
          model: "reported-model",
          usage: { input_tokens: 12, output_tokens: 3 },
          ...(seat === "claude"
            ? { content: [{ type: "text", text: "STAVKA_READY" }] }
            : {
                output: [
                  { type: "message", content: [{ type: "output_text", text: "STAVKA_READY" }] },
                ],
              }),
        }),
      );
      vi.stubGlobal("fetch", fetch);
      expect(await runModelProbe("stavka/heavy", seat)).toEqual({
        model: "reported-model",
        usage: { input_tokens: 12, output_tokens: 3 },
        text: "STAVKA_READY",
        cacheStatus: null,
      });
      const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(seat === "claude" ? "/v1/messages" : "/v1/responses");
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toMatchObject({ model: "stavka/heavy", stream: false });
      // ChatGPT subscription transport rejects the API-only output-token limit.
      if (seat === "codex") {
        expect(JSON.parse(String(init.body))).not.toHaveProperty("max_output_tokens");
      }
      expect(fetch).toHaveBeenCalledOnce();
    },
  );
  it("rejects an HTTP failure without retrying or inventing usage", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 403 }));
    vi.stubGlobal("fetch", fetch);
    await expect(runModelProbe("stavka/heavy", "codex")).rejects.toThrow("HTTP 403");
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("rejects a response without reported usage", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ model: "unknown", content: [] }));
    await expect(runModelProbe("stavka/commander", "claude")).rejects.toThrow();
  });
  it("shows the provider's failure reason without retrying", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ error: { message: "Live sergeant budget exhausted" } }, { status: 429 }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(runModelProbe("stavka/sergeant", "codex")).rejects.toThrow(
      "Live sergeant budget exhausted",
    );
    expect(fetch).toHaveBeenCalledOnce();
  });
});
