import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { dashboardHtml } from "./dashboard";

describe("dashboard browser script", () => {
  it("loads and starts the Codex connection flow", async () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(dashboardHtml)?.[1];
    expect(script).toBeDefined();

    const elements = new Map(
      ["status", "device", "model", "seeds", "progress", "result"].map((id) => [
        id,
        { innerHTML: "", textContent: "", value: id === "seeds" ? "1" : "" },
      ]),
    );
    const requests: Array<{ path: string; method: string }> = [];
    const fetch = vi.fn(async (path: string, init: RequestInit = {}) => {
      requests.push({ path, method: init.method ?? "GET" });
      if (path === "/api/auth/codex/start") {
        return Response.json({
          verificationUri: "https://auth.openai.test/device",
          userCode: "TEST-CODE",
        });
      }
      if (path === "/api/auth/codex/status") {
        return Response.json({ connected: false, pending: false });
      }
      if (path === "/api/benchmark/results") {
        return Response.json({ hypothesis: { status: "INCONCLUSIVE" } });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    });
    const context = vm.createContext({
      alert: vi.fn(),
      document: {
        getElementById: (id: string) => elements.get(id),
      },
      fetch,
      Headers,
      Math,
      Promise,
      Response,
      setTimeout,
    });

    const initialRefresh = new vm.Script(script).runInContext(context) as Promise<void>;
    await initialRefresh;
    const connect = context.connect as () => Promise<void>;
    expect(connect).toBeTypeOf("function");

    await connect();

    expect(requests).toContainEqual({ path: "/api/auth/codex/start", method: "POST" });
    expect(elements.get("device")?.innerHTML).toContain("TEST-CODE");
    expect(elements.get("device")?.innerHTML).toContain("https://auth.openai.test/device");
  });
});
