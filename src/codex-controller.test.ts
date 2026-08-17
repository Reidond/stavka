import { afterEach, describe, expect, test, vi } from "vitest";
import { makeCodexFetch, makePiAccountToken } from "./codex-controller";

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
    expect(headers.has("openai-beta")).toBe(false);
  });
});
