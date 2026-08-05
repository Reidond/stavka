import { describe, expect, it } from "vitest";

import { providerLifecycleIsHealthy, providerLifecycleTransition } from "../src/provider-health";

describe("hosted provider health transitions", () => {
  it.each([
    [401, "provider_auth_failed"],
    [429, "provider_exhausted"],
    [502, "provider_unavailable"],
    [504, "provider_timed_out"],
  ] as const)("degrades health for HTTP %i", (status, lifecycle) => {
    expect(providerLifecycleTransition("running", status)).toBe(lifecycle);
    expect(providerLifecycleIsHealthy(lifecycle)).toBe(false);
  });

  it("recovers degraded health after a successful provider response", () => {
    expect(providerLifecycleTransition("provider_exhausted", 200)).toBe("running");
    expect(providerLifecycleIsHealthy("running")).toBe(true);
    expect(providerLifecycleTransition("running", 200)).toBeUndefined();
  });
});
