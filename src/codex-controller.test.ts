import { describe, expect, test } from "vitest";
import { makePiAccountToken } from "./codex-controller";

const accountClaim = "https://api.openai.com/auth";

describe("Pi Codex Worker adapter", () => {
  test("provides Pi with an atob-compatible account claim", () => {
    const accountId = "acct_test+/worker";
    const token = makePiAccountToken(accountId);
    const payload = token.split(".")[1];

    expect(payload).toBeDefined();
    expect(JSON.parse(atob(payload ?? ""))).toEqual({
      [accountClaim]: { chatgpt_account_id: accountId },
    });
  });
});
