import type { AccessConfig } from "@stavka/access-auth";

export interface Env {
  readonly SIM_WORLD: DurableObjectNamespace<import("./sim-world").SimWorld>;
  readonly WAR_BENCH_STUDY_STORE: DurableObjectNamespace<
    import("./durable-objects/warbench-study-store").WarbenchStudyStore
  >;
  readonly ENVIRONMENT?: string;
  readonly DEV_ACCESS_EMAIL?: string;
  readonly ACCESS_TEAM_DOMAIN?: string;
  readonly ACCESS_AUD?: string;
  readonly COMMANDER_URL?: string;
  readonly COMMANDER_API_KEY?: string;
  /** Private service binding to Commander; replaces the public URL in production. */
  readonly COMMANDER_SERVICE?: Fetcher;
}

export const accessConfig = (env: Env): AccessConfig => ({
  environment:
    env.ENVIRONMENT === "local" || env.ENVIRONMENT === "preview" ? env.ENVIRONMENT : "production",
  teamDomain: env.ACCESS_TEAM_DOMAIN ?? "",
  audience: env.ACCESS_AUD ?? "",
  ...(env.ENVIRONMENT === "local" && env.DEV_ACCESS_EMAIL
    ? { devEmail: env.DEV_ACCESS_EMAIL }
    : {}),
});
