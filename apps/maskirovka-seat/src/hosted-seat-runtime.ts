import { Context } from "effect";
import type {
  ProviderAccountPublic,
  ProviderId,
  ProvisionProviderAccountPayload,
} from "@stavka/provider-auth";

import type { SeatEnv, SeatProvider } from "./config";

export interface HostedSeatStatus {
  readonly ok: boolean;
  readonly service: "stavka-maskirovka-seat";
  readonly seat_id: string;
  readonly provider: SeatProvider;
  readonly aliases: Readonly<Record<string, string>>;
  readonly container: {
    readonly status: string;
    readonly last_change: number;
  };
  readonly auth: {
    readonly configured: boolean;
    readonly persisted: boolean;
    readonly revision: number;
    readonly updated_at?: number;
  };
  readonly controls: {
    readonly killed: boolean;
    readonly updated_at: number;
  };
}

export type HostedSeatDialect = "openai-responses" | "anthropic-messages";

export interface HostedSeatRequestLog {
  readonly request_id: string;
  readonly timestamp: number;
  readonly dialect: HostedSeatDialect;
  readonly alias: string;
  readonly model: string;
  readonly status: number;
  readonly latency_ms: number;
  readonly queue_depth: number;
}

export interface HostedSeatOperationsStatus extends HostedSeatStatus {
  readonly requests: {
    readonly retained: number;
    readonly limit: 200;
    readonly metadata_only: true;
  };
  readonly capabilities: {
    readonly scope: "single-hosted-seat";
    readonly tier_remap: "model-only";
    readonly kill_switch: "this-seat-only";
    readonly unsupported: readonly string[];
  };
}

export interface HostedSeatStub {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly getSeatStatus: () => Promise<HostedSeatStatus>;
  readonly getOperationsStatus: () => Promise<HostedSeatOperationsStatus>;
  readonly listRecentRequests: (limit: number) => Promise<readonly HostedSeatRequestLog[]>;
  readonly remapAlias: (alias: string, model: string) => Promise<HostedSeatOperationsStatus>;
  readonly setKillSwitch: (enabled: boolean) => Promise<HostedSeatOperationsStatus>;
  readonly listProviderAccounts: () => Promise<readonly ProviderAccountPublic[]>;
  readonly putProviderAccount: (
    provider: ProviderId,
    name: string,
    payload: ProvisionProviderAccountPayload,
  ) => Promise<ProviderAccountPublic>;
  readonly testProviderAccount: (
    provider: ProviderId,
    name: string,
  ) => Promise<ProviderAccountPublic>;
  readonly deleteProviderAccount: (provider: ProviderId, name: string) => Promise<void>;
}

export interface HostedSeatRuntimeShape {
  readonly env: SeatEnv;
  readonly resolveSeat: (env: SeatEnv) => HostedSeatStub;
}

export class HostedSeatRuntime extends Context.Service<HostedSeatRuntime, HostedSeatRuntimeShape>()(
  "stavka/maskirovka-seat/HostedSeatRuntime",
) {}

export class HostedMachineCredential extends Context.Service<
  HostedMachineCredential,
  { readonly value: string }
>()("stavka/maskirovka-seat/HostedMachineCredential") {}

export class HostedAccessRequest extends Context.Service<
  HostedAccessRequest,
  { readonly request: Request }
>()("stavka/maskirovka-seat/HostedAccessRequest") {}
