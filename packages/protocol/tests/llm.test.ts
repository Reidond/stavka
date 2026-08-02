import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  LlmContributorClientMessage,
  LlmContributorServerMessage,
  decodeLlmContributorClientMessage,
  decodeLlmContributorServerMessage,
  decodeLlmSeatRegistrationRequest,
} from "../src";

const contributorSeat = {
  id: "claude-home",
  name: "Home Claude",
  models: ["stavka/commander", "stavka/heavy"],
  monthlyBudgetUsd: 100,
  priority: 50,
  mode: "contributor",
  provider: "claude",
};

describe("contributor LLM protocol", () => {
  it("round-trips every client message variant", () => {
    const messages: ReadonlyArray<unknown> = [
      {
        protocol_version: 1,
        type: "register",
        seat: contributorSeat,
      },
      {
        protocol_version: 1,
        type: "heartbeat",
        seat_id: contributorSeat.id,
        status: "healthy",
        active: 1,
        queue_depth: 2,
      },
      {
        protocol_version: 1,
        type: "result",
        job_id: "job-1",
        seat_id: contributorSeat.id,
        ok: true,
        decision: { commands: [] },
        raw_response: "{}",
        resolved_model: "claude-sonnet",
        usage: {
          input_tokens: 120,
          output_tokens: 30,
          cached_input_tokens: 20,
          estimated_cost_usd: 0.012,
        },
      },
      {
        protocol_version: 1,
        type: "result",
        job_id: "job-2",
        seat_id: contributorSeat.id,
        ok: false,
        code: "seat_exhausted",
        message: "The seat has no remaining budget",
        retryable: true,
        exhausted: true,
      },
      {
        protocol_version: 1,
        type: "result",
        job_id: "job-3",
        seat_id: contributorSeat.id,
        ok: false,
        code: "provider_rate_limit",
        message: "The provider rejected the settled attempt",
        retryable: true,
        resolved_model: "claude-sonnet",
        usage: {
          input_tokens: 80,
          output_tokens: 0,
          cached_input_tokens: 20,
          estimated_cost_usd: 0.004,
        },
      },
    ];

    for (const message of messages) {
      const decoded = decodeLlmContributorClientMessage(message);
      expect(Schema.encodeSync(LlmContributorClientMessage)(decoded)).toEqual(message);
    }
  });

  it("round-trips every server message variant", () => {
    const messages: ReadonlyArray<unknown> = [
      {
        protocol_version: 1,
        type: "invoke",
        job_id: "job-1",
        seat_id: contributorSeat.id,
        deadline_at: "2026-08-02T20:00:00.000Z",
        invocation: {
          tier: "stavka/commander",
          model: "stavka/commander",
          dialect: "anthropic-messages",
          prompt: "Hold position",
          response_format: "stavka-decision-v1",
        },
      },
      {
        protocol_version: 1,
        type: "registered",
        seat_id: contributorSeat.id,
        heartbeat_ttl_seconds: 30,
      },
      {
        protocol_version: 1,
        type: "heartbeat_ack",
        seat_id: contributorSeat.id,
        expires_at: "2026-08-02T20:00:30.000Z",
      },
      {
        protocol_version: 1,
        type: "result_ack",
        job_id: "job-1",
        accepted: true,
        duplicate: false,
      },
      {
        protocol_version: 1,
        type: "error",
        code: "invalid_message",
        message: "The message could not be decoded",
      },
    ];

    for (const message of messages) {
      const decoded = decodeLlmContributorServerMessage(message);
      expect(Schema.encodeSync(LlmContributorServerMessage)(decoded)).toEqual(message);
    }
  });

  it("enforces contributor registration bounds and discriminators", () => {
    const invalidSeats: ReadonlyArray<unknown> = [
      { ...contributorSeat, id: " claude-home" },
      { ...contributorSeat, id: "claude home" },
      { ...contributorSeat, id: "a".repeat(129) },
      { ...contributorSeat, name: " Home Claude" },
      { ...contributorSeat, models: [] },
      {
        ...contributorSeat,
        models: ["stavka/commander", "stavka/sergeant", "stavka/heavy", "stavka/commander"],
      },
      { ...contributorSeat, monthlyBudgetUsd: -1 },
      { ...contributorSeat, monthlyBudgetUsd: Number.NaN },
      { ...contributorSeat, monthlyBudgetUsd: Number.POSITIVE_INFINITY },
      { ...contributorSeat, priority: 0.5 },
      { ...contributorSeat, priority: 1_001 },
      { ...contributorSeat, provider: "api" },
      { ...contributorSeat, mode: "container" },
    ];

    for (const seat of invalidSeats) {
      expect(() =>
        decodeLlmContributorClientMessage({
          protocol_version: 1,
          type: "register",
          seat,
        }),
      ).toThrow();
    }
  });

  it("rejects invalid counters, versions, and excess wire fields", () => {
    for (const active of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        decodeLlmContributorClientMessage({
          protocol_version: 1,
          type: "heartbeat",
          seat_id: contributorSeat.id,
          status: "healthy",
          active,
        }),
      ).toThrow();
    }

    expect(() =>
      decodeLlmContributorClientMessage({
        protocol_version: 1,
        type: "result",
        job_id: "job-1",
        seat_id: contributorSeat.id,
        ok: true,
        decision: {},
        usage: { input_tokens: 1.5, output_tokens: 0 },
      }),
    ).toThrow();

    for (const failureFields of [
      { resolved_model: "" },
      { usage: { input_tokens: -1, output_tokens: 0 } },
      { usage: { input_tokens: 1, output_tokens: 0, estimated_cost_usd: Number.NaN } },
      { usage: { input_tokens: 1, output_tokens: 0, unexpected: true } },
    ]) {
      expect(() =>
        decodeLlmContributorClientMessage({
          protocol_version: 1,
          type: "result",
          job_id: "job-failure",
          seat_id: contributorSeat.id,
          ok: false,
          code: "provider_failure",
          message: "Provider call failed after usage was measured",
          retryable: true,
          ...failureFields,
        }),
      ).toThrow();
    }

    for (const heartbeat_ttl_seconds of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        decodeLlmContributorServerMessage({
          protocol_version: 1,
          type: "registered",
          seat_id: contributorSeat.id,
          heartbeat_ttl_seconds,
        }),
      ).toThrow();
    }

    expect(() =>
      decodeLlmContributorClientMessage({
        protocol_version: 2,
        type: "heartbeat",
        seat_id: contributorSeat.id,
        status: "healthy",
      }),
    ).toThrow();

    expect(() =>
      decodeLlmContributorClientMessage({
        protocol_version: 1,
        type: "heartbeat",
        seat_id: contributorSeat.id,
        status: "healthy",
        unexpected: true,
      }),
    ).toThrow();
  });

  it("rejects direction mismatches and nested excess wire fields", () => {
    expect(() =>
      decodeLlmContributorClientMessage({
        protocol_version: 1,
        type: "registered",
        seat_id: contributorSeat.id,
        heartbeat_ttl_seconds: 30,
      }),
    ).toThrow();

    expect(() =>
      decodeLlmContributorServerMessage({
        protocol_version: 1,
        type: "heartbeat",
        seat_id: contributorSeat.id,
        status: "healthy",
      }),
    ).toThrow();

    expect(() =>
      decodeLlmContributorClientMessage({
        protocol_version: 1,
        type: "register",
        seat: { ...contributorSeat, unexpected: true },
      }),
    ).toThrow();

    expect(() =>
      decodeLlmContributorClientMessage({
        protocol_version: 1,
        type: "result",
        job_id: "job-1",
        seat_id: contributorSeat.id,
        ok: true,
        decision: {},
        usage: { input_tokens: 1, output_tokens: 0, unexpected: true },
      }),
    ).toThrow();

    expect(() =>
      decodeLlmContributorServerMessage({
        protocol_version: 1,
        type: "invoke",
        job_id: "job-1",
        seat_id: contributorSeat.id,
        deadline_at: "2026-08-02T20:00:00.000Z",
        invocation: {
          tier: "stavka/commander",
          model: "stavka/commander",
          dialect: "openai-responses",
          prompt: "Hold position",
          response_format: "stavka-decision-v1",
          unexpected: true,
        },
      }),
    ).toThrow();
  });

  it("accepts Maskirovka endpoints and rejects direct provider endpoints", () => {
    const registration = {
      id: "api-fallback",
      name: "Metered API fallback",
      models: ["stavka/commander", "stavka/sergeant", "stavka/heavy"],
      monthlyBudgetUsd: 25,
      priority: 0,
      mode: "api",
      provider: "api",
      endpoint: "https://maskirovka.example/v1",
    };

    expect(decodeLlmSeatRegistrationRequest(registration)).toEqual(registration);

    for (const endpoint of [
      "https://api.openai.com/v1",
      "https://api.anthropic.com/v1",
      "ftp://maskirovka.example/v1",
      " https://maskirovka.example/v1",
    ]) {
      expect(() => decodeLlmSeatRegistrationRequest({ ...registration, endpoint })).toThrow();
    }
  });
});
