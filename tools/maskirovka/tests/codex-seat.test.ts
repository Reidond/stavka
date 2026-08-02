import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { SeatInvocation } from "../src/domain/types";
import { CodexSeat, type CodexThreadFactory } from "../src/seats/codex-seat";

const invocation = (prompt: string): SeatInvocation => ({
  dialect: "openai-responses",
  tier: "stavka/commander",
  request: {
    model: "stavka/commander",
    input: prompt,
    reasoning: { effort: "high" },
  },
  prompt,
  model: "gpt-5.6-sol",
});

describe("Codex subscription seat isolation", () => {
  it("starts a fresh thread for every independent Responses request", async () => {
    let sequence = 0;
    const prompts: string[] = [];
    const createThread = vi.fn<CodexThreadFactory>(async (_environment, options) => {
      const threadNumber = ++sequence;
      expect(options.modelReasoningEffort).toBe("high");
      return {
        run: async (prompt) => {
          prompts.push(prompt);
          return {
            finalResponse: `thread-${threadNumber}`,
            usage: {
              input_tokens: 1,
              cached_input_tokens: 0,
              cache_write_input_tokens: 0,
              output_tokens: 1,
              reasoning_output_tokens: 0,
            },
          };
        },
      };
    });
    const seat = new CodexSeat("/tmp/stavka-codex-isolation", createThread);

    const first = await Effect.runPromise(seat.invoke(invocation("first independent request")));
    const second = await Effect.runPromise(seat.invoke(invocation("second independent request")));

    expect(createThread).toHaveBeenCalledTimes(2);
    expect(first.text).toBe("thread-1");
    expect(second.text).toBe("thread-2");
    expect(prompts[0]).toContain("first independent request");
    expect(prompts[0]).not.toContain("second independent request");
    expect(prompts[1]).toContain("second independent request");
    expect(prompts[1]).not.toContain("first independent request");
  });
});
