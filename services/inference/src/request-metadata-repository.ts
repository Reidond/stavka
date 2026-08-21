import { Context, Effect } from "effect";

import {
  gatewayProviders,
  gatewaySeats,
  gatewayTiers,
  type GatewayProvider,
  type GatewaySeat,
  type GatewayTier,
} from "./config";
import { GatewayRepositoryError, repositoryEffect } from "./gateway-repository-error";

interface RequestRow extends Record<string, SqlStorageValue> {
  readonly request_id: string;
  readonly timestamp: number;
  readonly method: string;
  readonly provider: string | null;
  readonly seat: string | null;
  readonly tier: string | null;
  readonly model: string | null;
  readonly status: number;
  readonly latency_ms: number;
  readonly queue_depth: number;
}

export interface GatewayRequestMetadata {
  readonly requestId: string;
  readonly timestamp: number;
  readonly method: string;
  readonly provider?: GatewayProvider;
  readonly seat?: GatewaySeat;
  readonly tier?: GatewayTier;
  readonly model?: string;
  readonly status: number;
  readonly latencyMs: number;
  readonly queueDepth: number;
  readonly cacheHit?: boolean;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly actualCostUsd?: number;
  readonly listCostUsd?: number;
  readonly planCreditUsd?: number;
}

export interface RequestMetadataRepositoryService {
  readonly initialize: Effect.Effect<void, GatewayRepositoryError>;
  readonly append: (
    metadata: GatewayRequestMetadata,
  ) => Effect.Effect<void, GatewayRepositoryError>;
  readonly latest: (
    limit: number,
  ) => Effect.Effect<readonly GatewayRequestMetadata[], GatewayRepositoryError>;
  readonly count: Effect.Effect<number, GatewayRepositoryError>;
}

export class RequestMetadataRepository extends Context.Service<
  RequestMetadataRepository,
  RequestMetadataRepositoryService
>()("stavka/maskirovka-gateway/RequestMetadataRepository") {}

export class DurableRequestMetadataRepository implements RequestMetadataRepositoryService {
  constructor(
    private readonly sql: SqlStorage,
    private readonly retain = 500,
  ) {}

  readonly initialize = repositoryEffect("requests.initialize", () => {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS gateway_request_metadata (
      request_id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      method TEXT NOT NULL,
      provider TEXT,
      seat TEXT,
      tier TEXT,
      model TEXT,
      status INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      queue_depth INTEGER NOT NULL
    )`);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS gateway_request_metadata_timestamp
       ON gateway_request_metadata (timestamp DESC)`,
    );
  });

  append(metadata: GatewayRequestMetadata): Effect.Effect<void, GatewayRepositoryError> {
    return repositoryEffect("requests.append", () => {
      this.sql.exec(
        `INSERT OR REPLACE INTO gateway_request_metadata
         (request_id, timestamp, method, provider, seat, tier, model, status, latency_ms, queue_depth)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        metadata.requestId,
        metadata.timestamp,
        metadata.method,
        metadata.provider ?? null,
        metadata.seat ?? null,
        metadata.tier ?? null,
        metadata.model ?? null,
        metadata.status,
        metadata.latencyMs,
        metadata.queueDepth,
      );
      this.sql.exec(
        `DELETE FROM gateway_request_metadata
         WHERE request_id IN (
           SELECT request_id FROM gateway_request_metadata
           ORDER BY timestamp DESC LIMIT -1 OFFSET ?
         )`,
        this.retain,
      );
    });
  }

  latest(limit: number): Effect.Effect<readonly GatewayRequestMetadata[], GatewayRepositoryError> {
    return repositoryEffect("requests.latest", () =>
      this.sql
        .exec<RequestRow>(
          `SELECT request_id, timestamp, method, provider, seat, tier, model, status, latency_ms, queue_depth
           FROM gateway_request_metadata ORDER BY timestamp DESC LIMIT ?`,
          Math.max(1, Math.min(this.retain, Math.floor(limit))),
        )
        .toArray()
        .map((row) => ({
          requestId: row.request_id,
          timestamp: row.timestamp,
          method: row.method,
          ...(gatewayProviders.includes(row.provider as GatewayProvider)
            ? { provider: row.provider as GatewayProvider }
            : {}),
          ...(gatewaySeats.includes(row.seat as GatewaySeat)
            ? { seat: row.seat as GatewaySeat }
            : {}),
          ...(gatewayTiers.includes(row.tier as GatewayTier)
            ? { tier: row.tier as GatewayTier }
            : {}),
          ...(row.model ? { model: row.model } : {}),
          status: row.status,
          latencyMs: row.latency_ms,
          queueDepth: row.queue_depth,
        })),
    );
  }

  readonly count: Effect.Effect<number, GatewayRepositoryError> = repositoryEffect(
    "requests.count",
    () =>
      this.sql
        .exec<{ readonly count: number }>(`SELECT COUNT(*) as count FROM gateway_request_metadata`)
        .toArray()[0]?.count ?? 0,
  );
}
