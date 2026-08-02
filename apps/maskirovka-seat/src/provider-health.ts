const degradedProviderLifecycle = new Set([
  "provider_auth_failed",
  "provider_exhausted",
  "provider_timed_out",
  "provider_unavailable",
]);

export const providerLifecycleTransition = (
  current: string | undefined,
  responseStatus: number,
): string | undefined => {
  if (responseStatus === 401 || responseStatus === 403 || responseStatus === 503) {
    return "provider_auth_failed";
  }
  if (responseStatus === 429) return "provider_exhausted";
  if (responseStatus === 504) return "provider_timed_out";
  if (responseStatus >= 500) return "provider_unavailable";
  if (
    responseStatus >= 200 &&
    responseStatus < 300 &&
    current &&
    degradedProviderLifecycle.has(current)
  ) {
    return "running";
  }
  return undefined;
};

export const providerLifecycleIsHealthy = (status: string | undefined): boolean =>
  status === undefined || !degradedProviderLifecycle.has(status);
