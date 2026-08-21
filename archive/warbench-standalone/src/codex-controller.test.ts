import { afterEach, describe, expect, test, vi } from "vitest";
import { codexFailureMessage, makeCodexFetch, makePiAccountToken } from "./codex-controller";

const accountClaim = "https://api.openai.com/auth";
const credentials = {
  access: "real-oauth-access-token",
  refresh: "refresh-token",
  expires: Date.now() + 60_000,
  accountId: "acct_test+/worker",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Pi Codex Worker adapter", () => {
  test("provides Pi with an atob-compatible account claim", () => {
    const token = makePiAccountToken(credentials.accountId);
    const payload = token.split(".")[1];

    expect(payload).toBeDefined();
    expect(JSON.parse(atob(payload ?? ""))).toEqual({
      [accountClaim]: { chatgpt_account_id: credentials.accountId },
    });
  });

  test("replaces the local account carrier with the real OAuth credential", async () => {
    const mockedFetch = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", mockedFetch);

    const authenticatedFetch = makeCodexFetch(credentials);
    await authenticatedFetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      headers: {
        Authorization: "Bearer local-carrier",
        "ChatGPT-Account-ID": "wrong-account",
        "OpenAI-Beta": "responses=experimental",
      },
    });

    expect(mockedFetch).toHaveBeenCalledOnce();
    const init = mockedFetch.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${credentials.access}`);
    expect(headers.get("chatgpt-account-id")).toBe(credentials.accountId);
    expect(headers.get("originator")).toBe("Codex Warbench");
    expect(headers.get("user-agent")).toBe("Codex-Warbench/0.1.0 (Cloudflare-Workers)");
    expect(headers.has("openai-beta")).toBe(false);
  });

  test("captures a response for request-local upstream diagnostics", async () => {
    const upstreamResponse = new Response("blocked", {
      status: 403,
      headers: { "cf-ray": "test-ray", "x-request-id": "test-request" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => upstreamResponse),
    );
    const observed: Response[] = [];

    const authenticatedFetch = makeCodexFetch(credentials, (response) => observed.push(response));
    const response = await authenticatedFetch("https://chatgpt.com/backend-api/codex/responses");

    expect(response).toBe(upstreamResponse);
    expect(observed).toEqual([upstreamResponse]);
  });

  test("uses diagnostics and HTTP status when Pi returns a blank error", () => {
    expect(codexFailureMessage({ errorMessage: "", rawStopReason: "" }, { status: 403 })).toBe(
      "Codex upstream returned HTTP 403",
    );
    expect(
      codexFailureMessage({
        errorMessage: "",
        diagnostics: [
          {
            type: "request",
            timestamp: 1,
            error: { message: "Bearer secret-token was rejected" },
          },
        ],
      }),
    ).toBe("Bearer [redacted] was rejected");
  });

  test("replaces a Cloudflare challenge page with a concise failure", () => {
    expect(
      codexFailureMessage(
        { errorMessage: "<html>challenge body</html>" },
        { status: 403, cfMitigated: "challenge" },
      ),
    ).toBe(
      "ChatGPT blocked this Cloudflare Worker request with HTTP 403 before OAuth verification",
    );
    expect(
      codexFailureMessage(
        { errorMessage: "<!DOCTYPE html><html>challenge body</html>" },
        { status: 403 },
      ),
    ).toBe(
      "ChatGPT blocked this Cloudflare Worker request with HTTP 403 before OAuth verification",
    );
  });
});
