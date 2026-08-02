import {
  ArchivedSnapshot as ArchivedSnapshotSchema,
  ArchivedTick as ArchivedTickSchema,
  CommanderCostAggregate as CommanderCostAggregateSchema,
  DecisionLogEntry as DecisionLogEntrySchema,
  GameEvent as GameEventSchema,
  ReplaySessionMetadata as ReplaySessionMetadataSchema,
  SessionExport as SessionExportSchema,
  type ArchivedSnapshot,
  type ArchivedTick,
  type CommanderCostAggregate,
  type DecisionLogEntry,
  type GameEvent,
  type ReplaySessionMetadata,
  type SessionExport,
} from "@stavka/protocol";
import { Context, Data, Effect, Layer, Schema } from "effect";

const NaturalNumber = Schema.Number.pipe(
  Schema.check(Schema.isFinite(), Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
);
const PositiveInteger = NaturalNumber.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1)));
const NonEmptyString = Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()));
const Sha256 = NonEmptyString;

const SessionExportWriteOptionsSchema = Schema.Struct({
  exportedAt: NaturalNumber,
  id: Schema.optional(NonEmptyString),
});

export const SessionExportHeader = Schema.Struct({
  export_version: Schema.Literal(1),
  session: ReplaySessionMetadataSchema,
  cost_aggregates: Schema.Array(CommanderCostAggregateSchema),
});
export interface SessionExportHeader {
  readonly export_version: 1;
  readonly session: ReplaySessionMetadata;
  readonly cost_aggregates: readonly CommanderCostAggregate[];
}

export const SessionExportPage = Schema.Struct({
  logs: Schema.Array(DecisionLogEntrySchema),
  ticks: Schema.Array(ArchivedTickSchema),
  events: Schema.Array(GameEventSchema),
  snapshots: Schema.Array(ArchivedSnapshotSchema),
});
export interface SessionExportPage {
  readonly logs: readonly DecisionLogEntry[];
  readonly ticks: readonly ArchivedTick[];
  readonly events: readonly GameEvent[];
  readonly snapshots: readonly ArchivedSnapshot[];
}

const SessionExportPageCounts = Schema.Struct({
  logs: NaturalNumber,
  ticks: NaturalNumber,
  events: NaturalNumber,
  snapshots: NaturalNumber,
});
export type SessionExportPageCounts = typeof SessionExportPageCounts.Type;

export const SessionExportPageDescriptor = Schema.Struct({
  index: NaturalNumber,
  key: NonEmptyString,
  byteLength: PositiveInteger,
  sha256: Sha256,
  counts: SessionExportPageCounts,
});
export type SessionExportPageDescriptor = typeof SessionExportPageDescriptor.Type;

const PersistedSessionExportPage = Schema.Struct({
  repositoryVersion: Schema.Literal(2),
  kind: Schema.Literal("session-export-page"),
  exportVersion: Schema.Literal(1),
  sessionId: NonEmptyString,
  faction: NonEmptyString,
  missionEpoch: NaturalNumber,
  index: NaturalNumber,
  headerSha256: Sha256,
  data: SessionExportPage,
});
type PersistedSessionExportPage = typeof PersistedSessionExportPage.Type;

const ChunkedSessionExportManifest = Schema.Struct({
  repositoryVersion: Schema.Literal(2),
  kind: Schema.Literal("chunked-session-export"),
  header: SessionExportHeader,
  headerSha256: Sha256,
  exportedAt: NaturalNumber,
  exportId: Schema.optional(NonEmptyString),
  encoding: Schema.Literal("structured-json-pages"),
  payloadSize: NaturalNumber,
  payloadSha256: Sha256,
  pages: Schema.Array(SessionExportPageDescriptor),
}).check(
  Schema.makeFilter((manifest) => {
    const issues: Schema.FilterIssue[] = [];
    const describedBytes = manifest.pages.reduce((total, page, index) => {
      if (page.index !== index) {
        issues.push({
          path: ["pages", index, "index"],
          issue: "page indexes must be contiguous and zero-based",
        });
      }
      return total + page.byteLength;
    }, 0);
    if (describedBytes !== manifest.payloadSize) {
      issues.push({
        path: ["payloadSize"],
        issue: "manifest payload size must equal the sum of its pages",
      });
    }
    return issues;
  }),
);
type ChunkedSessionExportManifest = typeof ChunkedSessionExportManifest.Type;

const SessionExportReservation = Schema.Struct({
  repositoryVersion: Schema.Literal(2),
  kind: Schema.Literal("session-export-reservation"),
  header: SessionExportHeader,
  headerSha256: Sha256,
  exportedAt: NaturalNumber,
  exportId: Schema.optional(NonEmptyString),
  pageCount: NaturalNumber,
});
type SessionExportReservation = typeof SessionExportReservation.Type;

const SessionExportCustomMetadata = Schema.Struct({
  kind: Schema.Literal("stavka-session-export"),
  schemaVersion: Schema.Literal("3"),
  exportVersion: Schema.Literal("1"),
  sessionId: NonEmptyString,
  faction: NonEmptyString,
  missionEpoch: Schema.NumberFromString.pipe(
    Schema.check(Schema.isFinite(), Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
  exportedAt: Schema.NumberFromString.pipe(
    Schema.check(Schema.isFinite(), Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
  exportId: Schema.optional(NonEmptyString),
  storage: Schema.Literals(["inline", "chunked"]),
  chunkCount: Schema.NumberFromString.pipe(
    Schema.check(Schema.isFinite(), Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
  payloadSize: Schema.NumberFromString.pipe(
    Schema.check(Schema.isFinite(), Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
  payloadSha256: Sha256,
  headerSha256: Sha256,
  objectSha256: Sha256,
});
type SessionExportCustomMetadata = typeof SessionExportCustomMetadata.Type;

export interface R2ObjectMetadataLike {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly uploaded: Date;
  readonly customMetadata?: Record<string, string>;
}

export interface R2ObjectBodyLike extends R2ObjectMetadataLike {
  readonly text: () => Promise<string>;
}

interface R2PutOptionsLike {
  readonly httpMetadata?: { readonly contentType?: string };
  readonly customMetadata?: Record<string, string>;
  /** `If-None-Match: *`; a failed condition resolves to null in R2. */
  readonly onlyIf?: { readonly etagDoesNotMatch?: string };
}

export interface R2BucketLike {
  put(
    key: string,
    value: string,
    options?: R2PutOptionsLike,
  ): Promise<R2ObjectMetadataLike | null>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  list(options?: {
    readonly prefix?: string;
    readonly limit?: number;
    readonly cursor?: string;
    readonly include?: ("customMetadata" | "httpMetadata")[];
  }): Promise<{
    readonly objects: readonly R2ObjectMetadataLike[];
    readonly truncated?: boolean;
    readonly cursor?: string;
  }>;
}

export interface SessionExportWriteOptions {
  /** Caller-supplied epoch milliseconds keep retries deterministic. */
  readonly exportedAt: number;
  /** An immutable idempotency key scoped to session/faction/mission epoch. */
  readonly id?: string;
}

const normalizeWriteOptions = (
  options: typeof SessionExportWriteOptionsSchema.Type,
): SessionExportWriteOptions => ({
  exportedAt: options.exportedAt,
  ...(options.id === undefined ? {} : { id: options.id }),
});

export interface SessionExportListScope {
  readonly sessionId: string;
  readonly faction: string;
  readonly missionEpoch?: number;
  /** One bounded R2 page: defaults to 100 objects and is capped at 1,000. */
  readonly limit?: number;
  /** Opaque R2 continuation token returned by the preceding list page. */
  readonly cursor?: string;
}

export interface R2SessionExportRepositoryOptions {
  /** Inline threshold and target size used by the bounded convenience writer. */
  readonly chunkSizeBytes?: number;
  /** Hard upper bound for each schema-validated page object. */
  readonly maxPageBytes?: number;
  /** Hard upper bound for page descriptors in a manifest. */
  readonly maxPages?: number;
  /** Hard upper bound for the manifest object itself. */
  readonly maxManifestBytes?: number;
}

export interface SessionExportMetadata {
  readonly key: string;
  readonly sessionId: string;
  readonly faction: string;
  readonly missionEpoch: number;
  readonly exportedAt: number;
  readonly exportId?: string;
  readonly storage: "inline" | "chunked";
  readonly chunkCount: number;
  /** Logical replay/page bytes; `size` is only the inline object or manifest size. */
  readonly payloadSize: number;
  readonly size: number;
  readonly etag: string;
  readonly uploadedAt: string;
}

export interface SessionExportListPage {
  readonly exports: readonly SessionExportMetadata[];
  readonly cursor?: string;
}

export interface StoredSessionExport {
  readonly metadata: SessionExportMetadata;
  /** Convenience reassembly for trusted in-process callers; HTTP uses readPage. */
  readonly data: SessionExport;
}

/** A bounded slice of the canonical shared SessionExport envelope. */
export interface StoredSessionExportPage {
  readonly metadata: SessionExportMetadata;
  readonly header: SessionExportHeader;
  readonly page: SessionExportPage;
  readonly index: number;
  /** Opaque continuation token; absent after the final page. */
  readonly cursor?: string;
}

export interface SessionExportWriteLease {
  readonly key: string;
  readonly reservationKey: string;
  readonly header: SessionExportHeader;
  readonly headerSha256: string;
  readonly options: SessionExportWriteOptions;
  readonly pageCount: number;
}

export type SessionExportBeginResult =
  | { readonly _tag: "published"; readonly metadata: SessionExportMetadata }
  | { readonly _tag: "pending"; readonly lease: SessionExportWriteLease };

export class SessionExportRepositoryError extends Data.TaggedError("SessionExportRepositoryError")<{
  readonly operation: "encode" | "write" | "read" | "decode" | "list" | "reserve" | "conflict";
  readonly key?: string;
  readonly cause: unknown;
}> {}

export class SessionExportNotFoundError extends Data.TaggedError("SessionExportNotFoundError")<{
  readonly key: string;
}> {}

export interface SessionExportObjectRepositoryService {
  /** Bounded convenience path for already assembled, small-to-medium exports. */
  readonly write: (
    data: SessionExport,
    options: SessionExportWriteOptions,
  ) => Effect.Effect<SessionExportMetadata, SessionExportRepositoryError>;
  /** Reserves a complete page plan before its first page is written. */
  readonly begin: (
    header: SessionExportHeader,
    options: SessionExportWriteOptions,
    pageCount: number,
  ) => Effect.Effect<SessionExportBeginResult, SessionExportRepositoryError>;
  readonly writePage: (
    lease: SessionExportWriteLease,
    index: number,
    page: SessionExportPage,
  ) => Effect.Effect<SessionExportPageDescriptor, SessionExportRepositoryError>;
  /** Publishes the root manifest only after every bounded page is verified. */
  readonly complete: (
    lease: SessionExportWriteLease,
    pages: readonly SessionExportPageDescriptor[],
  ) => Effect.Effect<SessionExportMetadata, SessionExportRepositoryError>;
  readonly read: (
    key: string,
  ) => Effect.Effect<
    StoredSessionExport,
    SessionExportRepositoryError | SessionExportNotFoundError
  >;
  /** Bounded read path for HTTP downloads; it fetches at most one R2 data page. */
  readonly readPage: (
    key: string,
    cursor?: string,
  ) => Effect.Effect<
    StoredSessionExportPage,
    SessionExportRepositoryError | SessionExportNotFoundError
  >;
  readonly list: (
    scope: SessionExportListScope,
  ) => Effect.Effect<SessionExportListPage, SessionExportRepositoryError>;
}

export class SessionExportObjectRepository extends Context.Service<
  SessionExportObjectRepository,
  SessionExportObjectRepositoryService
>()("@stavka/commander/SessionExportObjectRepository") {}

const KEY_PREFIX = "session-exports/v2";
const PAGE_KEY_PREFIX = "session-export-pages/v2";
const RESERVATION_KEY_PREFIX = "session-export-reservations/v2";
const DEFAULT_CHUNK_SIZE_BYTES = 4 * 1_024 * 1_024;
const DEFAULT_MAX_PAGE_BYTES = 8 * 1_024 * 1_024;
const DEFAULT_MAX_PAGES = 20_000;
const DEFAULT_MAX_MANIFEST_BYTES = 8 * 1_024 * 1_024;

/**
 * A UTF-16-code-unit encoding is injective even for malformed JS strings,
 * unlike UTF-8 replacement encoding. It uses only one safe key alphabet and
 * deliberately does not trim or normalize caller identities.
 */
export const sanitizeSessionExportKeySegment = (value: string): string =>
  `u${Array.from({ length: value.length }, (_, index) =>
    value.charCodeAt(index).toString(16).padStart(4, "0")).join("")}`;

export const decodeSessionExportKeySegment = (value: string): string => {
  if (!/^u(?:[0-9a-f]{4})*$/u.test(value)) {
    throw new Error("Invalid session export key segment");
  }
  let decoded = "";
  for (let index = 1; index < value.length; index += 4) {
    decoded += String.fromCharCode(Number.parseInt(value.slice(index, index + 4), 16));
  }
  return decoded;
};

const identityPath = (sessionId: string, faction: string, missionEpoch?: number): string => {
  const base = `${sanitizeSessionExportKeySegment(sessionId)}/${sanitizeSessionExportKeySegment(faction)}`;
  return missionEpoch === undefined ? `${base}/` : `${base}/epoch-${missionEpoch}/`;
};

const keyPrefix = (sessionId: string, faction: string, missionEpoch?: number): string =>
  `${KEY_PREFIX}/${identityPath(sessionId, faction, missionEpoch)}`;

const reservationPrefix = (sessionId: string, faction: string, missionEpoch: number): string =>
  `${RESERVATION_KEY_PREFIX}/${identityPath(sessionId, faction, missionEpoch)}`;

const exportLeaf = (options: SessionExportWriteOptions): string =>
  options.id === undefined
    ? `at-${options.exportedAt}`
    : `id-${sanitizeSessionExportKeySegment(options.id)}`;

export const sessionExportKey = (
  data: Pick<SessionExport, "session">,
  options: SessionExportWriteOptions,
): string =>
  `${keyPrefix(
    data.session.session_id,
    data.session.faction,
    data.session.mission_epoch,
  )}${exportLeaf(options)}.json`;

export const sessionExportPageKey = (
  header: SessionExportHeader,
  options: SessionExportWriteOptions,
  index: number,
): string =>
  `${PAGE_KEY_PREFIX}/${identityPath(
    header.session.session_id,
    header.session.faction,
    header.session.mission_epoch,
  )}${exportLeaf(options)}/page-${String(index).padStart(6, "0")}.json`;

const sessionExportReservationKey = (
  header: SessionExportHeader,
  options: SessionExportWriteOptions,
): string =>
  `${reservationPrefix(
    header.session.session_id,
    header.session.faction,
    header.session.mission_epoch,
  )}${exportLeaf(options)}.json`;

interface IntegrityMetadata {
  readonly payloadSha256: string;
  readonly headerSha256: string;
  readonly objectSha256: string;
}

const metadataStrings = (
  header: SessionExportHeader,
  options: SessionExportWriteOptions,
  storage: SessionExportMetadata["storage"],
  chunkCount: number,
  payloadSize: number,
  integrity: IntegrityMetadata,
): Record<string, string> => ({
  kind: "stavka-session-export",
  schemaVersion: "3",
  exportVersion: "1",
  sessionId: header.session.session_id,
  faction: header.session.faction,
  missionEpoch: String(header.session.mission_epoch),
  exportedAt: String(options.exportedAt),
  ...(options.id === undefined ? {} : { exportId: options.id }),
  storage,
  chunkCount: String(chunkCount),
  payloadSize: String(payloadSize),
  payloadSha256: integrity.payloadSha256,
  headerSha256: integrity.headerSha256,
  objectSha256: integrity.objectSha256,
});

const objectMetadata = (
  object: R2ObjectMetadataLike,
  custom: SessionExportCustomMetadata,
): Effect.Effect<SessionExportMetadata, SessionExportRepositoryError> =>
  Effect.try({
    try: () => ({
      key: object.key,
      sessionId: custom.sessionId,
      faction: custom.faction,
      missionEpoch: custom.missionEpoch,
      exportedAt: custom.exportedAt,
      ...(custom.exportId === undefined ? {} : { exportId: custom.exportId }),
      storage: custom.storage,
      chunkCount: custom.chunkCount,
      payloadSize: custom.payloadSize,
      size: object.size,
      etag: object.etag,
      uploadedAt: object.uploaded.toISOString(),
    }),
    catch: (cause) =>
      new SessionExportRepositoryError({ operation: "decode", key: object.key, cause }),
  });

const decodeObjectMetadata = (
  object: R2ObjectMetadataLike,
  operation: "read" | "list",
): Effect.Effect<
  { readonly metadata: SessionExportMetadata; readonly integrity: IntegrityMetadata },
  SessionExportRepositoryError
> =>
  Schema.decodeUnknownEffect(SessionExportCustomMetadata)(object.customMetadata ?? {}, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError(
      (cause) => new SessionExportRepositoryError({ operation, key: object.key, cause }),
    ),
    Effect.flatMap((custom) =>
      objectMetadata(object, custom).pipe(
        Effect.map((metadata) => ({
          metadata,
          integrity: {
            payloadSha256: custom.payloadSha256,
            headerSha256: custom.headerSha256,
            objectSha256: custom.objectSha256,
          },
        })),
      )),
  );

const writeOptionsFromMetadata = (metadata: SessionExportMetadata): SessionExportWriteOptions => ({
  exportedAt: metadata.exportedAt,
  ...(metadata.exportId === undefined ? {} : { id: metadata.exportId }),
});

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

const sha256 = (value: string): Effect.Effect<string, SessionExportRepositoryError> =>
  Effect.tryPromise({
    try: async () => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    },
    catch: (cause) => new SessionExportRepositoryError({ operation: "encode", cause }),
  });

const encodeHeader = (
  header: SessionExportHeader,
): Effect.Effect<string, SessionExportRepositoryError> =>
  Schema.encodeEffect(Schema.fromJsonString(SessionExportHeader))(header).pipe(
    Effect.mapError((cause) => new SessionExportRepositoryError({ operation: "encode", cause })),
  );

const headerDigest = (
  header: SessionExportHeader,
): Effect.Effect<string, SessionExportRepositoryError> =>
  encodeHeader(header).pipe(Effect.flatMap(sha256));

const payloadDigestInput = (
  headerSha256: string,
  pages: readonly SessionExportPageDescriptor[],
): string => JSON.stringify({
  headerSha256,
  pages: pages.map((page) => ({
    index: page.index,
    key: page.key,
    byteLength: page.byteLength,
    sha256: page.sha256,
    counts: page.counts,
  })),
});

const payloadDigest = (
  headerSha256: string,
  pages: readonly SessionExportPageDescriptor[],
): Effect.Effect<string, SessionExportRepositoryError> => sha256(payloadDigestInput(headerSha256, pages));

const decodeSessionExport = (
  encoded: string,
  key: string,
): Effect.Effect<SessionExport, SessionExportRepositoryError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(SessionExportSchema), {
    onExcessProperty: "error",
  })(encoded).pipe(
    Effect.mapError(
      (cause) => new SessionExportRepositoryError({ operation: "decode", key, cause }),
    ),
  );

const headerOf = (data: SessionExport): SessionExportHeader => ({
  export_version: data.export_version,
  session: data.session,
  cost_aggregates: data.cost_aggregates,
});

const emptyPage = (): SessionExportPage => ({ logs: [], ticks: [], events: [], snapshots: [] });

const pageOf = (data: SessionExport): SessionExportPage => ({
  logs: data.logs,
  ticks: data.archive.ticks,
  events: data.archive.events,
  snapshots: data.archive.snapshots,
});

const pageHasItems = (page: SessionExportPage): boolean =>
  page.logs.length + page.ticks.length + page.events.length + page.snapshots.length > 0;

/** Deterministic fallback for already assembled exports; long producers page at the SQL boundary. */
const splitSessionExport = (
  data: SessionExport,
  targetBytes: number,
): readonly SessionExportPage[] => {
  const singletons: SessionExportPage[] = [
    ...data.logs.map((log) => ({ ...emptyPage(), logs: [log] })),
    ...data.archive.ticks.map((tick) => ({ ...emptyPage(), ticks: [tick] })),
    ...data.archive.events.map((event) => ({ ...emptyPage(), events: [event] })),
    ...data.archive.snapshots.map((snapshot) => ({ ...emptyPage(), snapshots: [snapshot] })),
  ];
  if (singletons.length === 0) return [emptyPage()];

  const pages: SessionExportPage[] = [];
  let current = emptyPage();
  for (const singleton of singletons) {
    const candidate: SessionExportPage = {
      logs: [...current.logs, ...singleton.logs],
      ticks: [...current.ticks, ...singleton.ticks],
      events: [...current.events, ...singleton.events],
      snapshots: [...current.snapshots, ...singleton.snapshots],
    };
    if (pageHasItems(current) && utf8ByteLength(JSON.stringify(candidate)) > targetBytes) {
      pages.push(current);
      current = singleton;
    } else {
      current = candidate;
    }
  }
  pages.push(current);
  return pages;
};

const expectedMetadataKey = (metadata: SessionExportMetadata): string =>
  `${keyPrefix(metadata.sessionId, metadata.faction, metadata.missionEpoch)}${exportLeaf(
    writeOptionsFromMetadata(metadata),
  )}.json`;

const sameIdentity = (
  session: ReplaySessionMetadata,
  identity: { readonly sessionId: string; readonly faction: string; readonly missionEpoch: number },
): boolean =>
  session.session_id === identity.sessionId &&
  session.faction === identity.faction &&
  session.mission_epoch === identity.missionEpoch;

const sameReplayIdentity = (
  left: ReplaySessionMetadata,
  right: ReplaySessionMetadata,
): boolean =>
  left.session_id === right.session_id &&
  left.faction === right.faction &&
  left.mission_epoch === right.mission_epoch;

const sameCounts = (left: SessionExportPageCounts, right: SessionExportPageCounts): boolean =>
  left.logs === right.logs &&
  left.ticks === right.ticks &&
  left.events === right.events &&
  left.snapshots === right.snapshots;

const countsOf = (page: SessionExportPage): SessionExportPageCounts => ({
  logs: page.logs.length,
  ticks: page.ticks.length,
  events: page.events.length,
  snapshots: page.snapshots.length,
});

const conflict = (key: string, message: string): SessionExportRepositoryError =>
  new SessionExportRepositoryError({ operation: "conflict", key, cause: new Error(message) });

const validateMetadataKey = (
  metadata: SessionExportMetadata,
  operation: "read" | "list",
): Effect.Effect<SessionExportMetadata, SessionExportRepositoryError> => {
  const expectedKey = expectedMetadataKey(metadata);
  return metadata.key === expectedKey && (metadata.storage !== "inline" || metadata.chunkCount === 0)
    ? Effect.succeed(metadata)
    : Effect.fail(new SessionExportRepositoryError({
        operation,
        key: metadata.key,
        cause: new Error(`Export metadata belongs at ${expectedKey}`),
      }));
};

const parsePageCursor = (cursor: string | undefined, key: string): Effect.Effect<number, SessionExportRepositoryError> =>
  Effect.try({
    try: () => {
      if (cursor === undefined) return 0;
      if (!/^(?:0|[1-9][0-9]*)$/u.test(cursor)) throw new Error("Invalid session export page cursor");
      const index = Number(cursor);
      if (!Number.isSafeInteger(index)) throw new Error("Invalid session export page cursor");
      return index;
    },
    catch: (cause) => new SessionExportRepositoryError({ operation: "decode", key, cause }),
  });

export class R2SessionExportRepository implements SessionExportObjectRepositoryService {
  readonly #chunkSizeBytes: number;
  readonly #maxPageBytes: number;
  readonly #maxPages: number;
  readonly #maxManifestBytes: number;

  constructor(
    private readonly bucket: R2BucketLike,
    options: R2SessionExportRepositoryOptions = {},
  ) {
    this.#chunkSizeBytes = Schema.decodeUnknownSync(PositiveInteger)(
      options.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES,
    );
    this.#maxPageBytes = Schema.decodeUnknownSync(PositiveInteger)(
      options.maxPageBytes ?? DEFAULT_MAX_PAGE_BYTES,
    );
    this.#maxPages = Schema.decodeUnknownSync(PositiveInteger)(
      options.maxPages ?? DEFAULT_MAX_PAGES,
    );
    this.#maxManifestBytes = Schema.decodeUnknownSync(PositiveInteger)(
      options.maxManifestBytes ?? DEFAULT_MAX_MANIFEST_BYTES,
    );
  }

  write(
    data: SessionExport,
    options: SessionExportWriteOptions,
  ): Effect.Effect<SessionExportMetadata, SessionExportRepositoryError> {
    return Effect.all({
      data: Schema.decodeUnknownEffect(SessionExportSchema)(data, { onExcessProperty: "error" }),
      encoded: Schema.encodeEffect(Schema.fromJsonString(SessionExportSchema))(data),
      options: Schema.decodeUnknownEffect(SessionExportWriteOptionsSchema)(options, {
        onExcessProperty: "error",
      }).pipe(Effect.map(normalizeWriteOptions)),
    }).pipe(
      Effect.mapError((cause) => new SessionExportRepositoryError({ operation: "encode", cause })),
      Effect.flatMap(({ data: validData, encoded, options: validOptions }) => {
        const header = headerOf(validData);
        if (utf8ByteLength(encoded) <= this.#chunkSizeBytes) {
          return this.begin(header, validOptions, 0).pipe(
            Effect.flatMap((result) => result._tag === "published"
              ? Effect.succeed(result.metadata)
              : this.#writeInline(result.lease, encoded)),
          );
        }
        const pages = splitSessionExport(validData, this.#chunkSizeBytes);
        return headerDigest(header).pipe(
          Effect.flatMap((digest) =>
            Effect.forEach(pages, (page, index) =>
              this.#encodePage(header, digest, index, page).pipe(Effect.asVoid))),
          Effect.flatMap(() => this.begin(header, validOptions, pages.length)),
          Effect.flatMap((result) => result._tag === "published"
            ? Effect.succeed(result.metadata)
            : Effect.forEach(pages, (page, index) => this.writePage(result.lease, index, page)).pipe(
                Effect.flatMap((descriptors) => this.complete(result.lease, descriptors)),
              )),
        );
      }),
    );
  }

  begin(
    header: SessionExportHeader,
    options: SessionExportWriteOptions,
    pageCount: number,
  ): Effect.Effect<SessionExportBeginResult, SessionExportRepositoryError> {
    return Effect.all({
      header: Schema.decodeUnknownEffect(SessionExportHeader)(header, { onExcessProperty: "error" }),
      options: Schema.decodeUnknownEffect(SessionExportWriteOptionsSchema)(options, {
        onExcessProperty: "error",
      }).pipe(Effect.map(normalizeWriteOptions)),
      pageCount: Schema.decodeUnknownEffect(NaturalNumber)(pageCount),
    }).pipe(
      Effect.mapError((cause) => new SessionExportRepositoryError({ operation: "encode", cause })),
      Effect.flatMap(({ header: validHeader, options: validOptions, pageCount: validPageCount }) => {
        const key = sessionExportKey(validHeader, validOptions);
        if (validPageCount > this.#maxPages) {
          return Effect.fail(new SessionExportRepositoryError({
            operation: "encode",
            key,
            cause: new Error(`Session export has ${validPageCount} pages; maximum is ${this.#maxPages}`),
          }));
        }
        return headerDigest(validHeader).pipe(
          Effect.flatMap((digest) => this.#beginReserved(
            validHeader,
            validOptions,
            validPageCount,
            digest,
          )),
        );
      }),
    );
  }

  writePage(
    lease: SessionExportWriteLease,
    index: number,
    page: SessionExportPage,
  ): Effect.Effect<SessionExportPageDescriptor, SessionExportRepositoryError> {
    return Effect.all({
      index: Schema.decodeUnknownEffect(NaturalNumber)(index),
      page: Schema.decodeUnknownEffect(SessionExportPage)(page, { onExcessProperty: "error" }),
    }).pipe(
      Effect.mapError((cause) => new SessionExportRepositoryError({ operation: "encode", cause })),
      Effect.flatMap(({ index: validIndex, page: validPage }) =>
        this.#assertLease(lease).pipe(
          Effect.flatMap(() => {
            if (validIndex >= lease.pageCount) {
              return Effect.fail(new SessionExportRepositoryError({
                operation: "encode",
                key: lease.key,
                cause: new Error(`Page index ${validIndex} exceeds reserved page count ${lease.pageCount}`),
              }));
            }
            return this.#encodePage(lease.header, lease.headerSha256, validIndex, validPage).pipe(
              Effect.flatMap(({ encoded, descriptor }) => this.#putPageIfAbsent(lease, encoded, descriptor)),
            );
          }),
        )),
    );
  }

  complete(
    lease: SessionExportWriteLease,
    pages: readonly SessionExportPageDescriptor[],
  ): Effect.Effect<SessionExportMetadata, SessionExportRepositoryError> {
    return Schema.decodeUnknownEffect(Schema.Array(SessionExportPageDescriptor))(pages, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError((cause) => new SessionExportRepositoryError({ operation: "encode", key: lease.key, cause })),
      Effect.flatMap((validPages) => this.#assertLease(lease).pipe(
        Effect.flatMap(() => this.#completeReserved(lease, validPages)),
      )),
    );
  }

  read(
    key: string,
  ): Effect.Effect<StoredSessionExport, SessionExportRepositoryError | SessionExportNotFoundError> {
    return Effect.gen({ self: this }, function* () {
      const root = yield* this.#readRoot(key);
      if (root.metadata.storage === "inline") {
        const data = yield* this.#decodeInline(root);
        return { metadata: root.metadata, data };
      }
      const manifest = yield* this.#decodeManifest(root);
      const pages = yield* Effect.forEach(manifest.pages, (descriptor) =>
        this.#readVerifiedPage(key, manifest.header, manifest.headerSha256, descriptor),
      );
      const data = yield* Schema.decodeUnknownEffect(SessionExportSchema)(
        {
          ...manifest.header,
          logs: pages.flatMap((page) => page.logs),
          archive: {
            ticks: pages.flatMap((page) => page.ticks),
            events: pages.flatMap((page) => page.events),
            snapshots: pages.flatMap((page) => page.snapshots),
          },
        },
        { onExcessProperty: "error" },
      ).pipe(Effect.mapError(
        (cause) => new SessionExportRepositoryError({ operation: "decode", key, cause }),
      ));
      return { metadata: root.metadata, data };
    });
  }

  readPage(
    key: string,
    cursor?: string,
  ): Effect.Effect<
    StoredSessionExportPage,
    SessionExportRepositoryError | SessionExportNotFoundError
  > {
    return Effect.gen({ self: this }, function* () {
      const root = yield* this.#readRoot(key);
      if (root.metadata.storage === "inline") {
        const data = yield* this.#decodeInline(root);
        if (cursor !== undefined && cursor !== "0") {
          return yield* new SessionExportRepositoryError({
            operation: "decode",
            key,
            cause: new Error("Inline session export has no continuation page"),
          });
        }
        return {
          metadata: root.metadata,
          header: headerOf(data),
          page: pageOf(data),
          index: 0,
        };
      }
      const manifest = yield* this.#decodeManifest(root);
      const index = yield* parsePageCursor(cursor, key);
      // A snapshot can legitimately contain no logs, ticks, events, or
      // snapshots. It still has a manifest (the producer publishes it last),
      // so expose its canonical empty page without requiring a synthetic R2
      // page object solely for the download endpoint.
      if (manifest.pages.length === 0) {
        if (index !== 0) {
          return yield* new SessionExportRepositoryError({
            operation: "decode",
            key,
            cause: new Error("Session export page cursor is outside the manifest"),
          });
        }
        return {
          metadata: root.metadata,
          header: manifest.header,
          page: emptyPage(),
          index: 0,
        };
      }
      const descriptor = manifest.pages[index];
      if (descriptor === undefined) {
        return yield* new SessionExportRepositoryError({
          operation: "decode",
          key,
          cause: new Error("Session export page cursor is outside the manifest"),
        });
      }
      const page = yield* this.#readVerifiedPage(key, manifest.header, manifest.headerSha256, descriptor);
      return {
        metadata: root.metadata,
        header: manifest.header,
        page,
        index,
        ...(index + 1 < manifest.pages.length ? { cursor: String(index + 1) } : {}),
      };
    });
  }

  list(
    scope: SessionExportListScope,
  ): Effect.Effect<SessionExportListPage, SessionExportRepositoryError> {
    const limit = Math.min(1_000, Math.max(1, Math.floor(scope.limit ?? 100)));
    const prefix = keyPrefix(scope.sessionId, scope.faction, scope.missionEpoch);
    return Effect.tryPromise({
      try: () => this.bucket.list({
        prefix,
        limit,
        ...(scope.cursor === undefined ? {} : { cursor: scope.cursor }),
        include: ["customMetadata"],
      }),
      catch: (cause) => new SessionExportRepositoryError({ operation: "list", cause }),
    }).pipe(
      Effect.flatMap((listed) =>
        Effect.forEach(listed.objects, (object) =>
          decodeObjectMetadata(object, "list").pipe(
            Effect.flatMap(({ metadata }) => validateMetadataKey(metadata, "list")),
          )).pipe(
          Effect.flatMap((exports) => {
            if (listed.truncated === true && (listed.cursor === undefined || listed.cursor.length === 0)) {
              return Effect.fail(new SessionExportRepositoryError({
                operation: "list",
                cause: new Error("R2 returned a truncated export list without a continuation cursor"),
              }));
            }
            return Effect.succeed({
              exports,
              ...(listed.truncated === true ? { cursor: listed.cursor } : {}),
            });
          }),
        )),
    );
  }

  #beginReserved(
    header: SessionExportHeader,
    options: SessionExportWriteOptions,
    pageCount: number,
    digest: string,
  ): Effect.Effect<SessionExportBeginResult, SessionExportRepositoryError> {
    const key = sessionExportKey(header, options);
    const reservationKey = sessionExportReservationKey(header, options);
    const lease: SessionExportWriteLease = {
      key,
      reservationKey,
      header,
      headerSha256: digest,
      options,
      pageCount,
    };
    const reservation: SessionExportReservation = {
      repositoryVersion: 2,
      kind: "session-export-reservation",
      header,
      headerSha256: digest,
      exportedAt: options.exportedAt,
      ...(options.id === undefined ? {} : { exportId: options.id }),
      pageCount,
    };
    return Effect.gen({ self: this }, function* () {
      const published = yield* this.#publishedMetadata(key);
      if (published !== undefined) {
        if (options.id !== undefined) return { _tag: "published", metadata: published } as const;
        return yield* conflict(key, "A timestamp-derived session export key already exists");
      }
      const encodedReservation = yield* Schema.encodeEffect(
        Schema.fromJsonString(SessionExportReservation),
      )(reservation).pipe(Effect.mapError(
        (cause) => new SessionExportRepositoryError({ operation: "encode", key: reservationKey, cause }),
      ));
      const created = yield* Effect.tryPromise({
        try: () => this.bucket.put(reservationKey, encodedReservation, {
          httpMetadata: { contentType: "application/json; charset=utf-8" },
          customMetadata: { kind: "stavka-session-export-reservation", parentKey: key },
          onlyIf: { etagDoesNotMatch: "*" },
        }),
        catch: (cause) => new SessionExportRepositoryError({ operation: "reserve", key: reservationKey, cause }),
      });
      if (created !== null) return { _tag: "pending", lease } as const;

      const afterRace = yield* this.#publishedMetadata(key);
      if (afterRace !== undefined) {
        if (options.id !== undefined) return { _tag: "published", metadata: afterRace } as const;
        return yield* conflict(key, "A timestamp-derived session export key was published concurrently");
      }
      const existingReservation = yield* this.#readReservation(reservationKey);
      if (existingReservation === undefined || !sameReservation(existingReservation, reservation)) {
        return yield* conflict(key, "export_id is already reserved by a different export plan");
      }
      return { _tag: "pending", lease } as const;
    });
  }

  #writeInline(
    lease: SessionExportWriteLease,
    encoded: string,
  ): Effect.Effect<SessionExportMetadata, SessionExportRepositoryError> {
    const payloadSize = utf8ByteLength(encoded);
    return this.#assertLease(lease).pipe(
      Effect.flatMap(() => sha256(encoded)),
      Effect.flatMap((digest) => Effect.tryPromise({
        try: () => this.bucket.put(lease.key, encoded, {
          httpMetadata: { contentType: "application/json; charset=utf-8" },
          customMetadata: metadataStrings(lease.header, lease.options, "inline", 0, payloadSize, {
            payloadSha256: digest,
            headerSha256: lease.headerSha256,
            objectSha256: digest,
          }),
          onlyIf: { etagDoesNotMatch: "*" },
        }),
        catch: (cause) => new SessionExportRepositoryError({ operation: "write", key: lease.key, cause }),
      }).pipe(
        Effect.flatMap((object) => object === null
          ? this.#sameInlineOrConflict(lease.key, encoded)
          : decodeObjectMetadata(object, "read").pipe(
              Effect.flatMap(({ metadata }) => validateMetadataKey(metadata, "read")),
            )),
      )),
    );
  }

  #encodePage(
    header: SessionExportHeader,
    digest: string,
    index: number,
    page: SessionExportPage,
  ): Effect.Effect<
    { readonly encoded: string; readonly descriptor: Omit<SessionExportPageDescriptor, "key"> },
    SessionExportRepositoryError
  > {
    const persisted: PersistedSessionExportPage = {
      repositoryVersion: 2,
      kind: "session-export-page",
      exportVersion: 1,
      sessionId: header.session.session_id,
      faction: header.session.faction,
      missionEpoch: header.session.mission_epoch,
      index,
      headerSha256: digest,
      data: page,
    };
    return Schema.encodeEffect(Schema.fromJsonString(PersistedSessionExportPage))(persisted).pipe(
      Effect.mapError((cause) => new SessionExportRepositoryError({ operation: "encode", cause })),
      Effect.flatMap((encoded) => {
        const byteLength = utf8ByteLength(encoded);
        if (byteLength > this.#maxPageBytes) {
          return Effect.fail(new SessionExportRepositoryError({
            operation: "encode",
            cause: new Error(
              `Session export page is ${byteLength} bytes; maximum is ${this.#maxPageBytes}`,
            ),
          }));
        }
        return sha256(encoded).pipe(Effect.map((pageDigest) => ({
          encoded,
          descriptor: {
            index,
            byteLength,
            sha256: pageDigest,
            counts: countsOf(page),
          },
        })));
      }),
    );
  }

  #putPageIfAbsent(
    lease: SessionExportWriteLease,
    encoded: string,
    descriptor: Omit<SessionExportPageDescriptor, "key">,
  ): Effect.Effect<SessionExportPageDescriptor, SessionExportRepositoryError> {
    const key = sessionExportPageKey(lease.header, lease.options, descriptor.index);
    const completeDescriptor: SessionExportPageDescriptor = { ...descriptor, key };
    return Effect.tryPromise({
      try: () => this.bucket.put(key, encoded, {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
        customMetadata: {
          kind: "stavka-session-export-page",
          parentKey: lease.key,
          index: String(descriptor.index),
          sha256: descriptor.sha256,
          headerSha256: lease.headerSha256,
        },
        onlyIf: { etagDoesNotMatch: "*" },
      }),
      catch: (cause) => new SessionExportRepositoryError({ operation: "write", key, cause }),
    }).pipe(
      Effect.flatMap((object) => object === null
        ? this.#samePageOrConflict(lease, encoded, completeDescriptor)
        : Effect.succeed(completeDescriptor)),
    );
  }

  #completeReserved(
    lease: SessionExportWriteLease,
    pages: readonly SessionExportPageDescriptor[],
  ): Effect.Effect<SessionExportMetadata, SessionExportRepositoryError> {
    if (pages.length !== lease.pageCount) {
      return Effect.fail(new SessionExportRepositoryError({
        operation: "encode",
        key: lease.key,
        cause: new Error(`Expected ${lease.pageCount} page descriptors, received ${pages.length}`),
      }));
    }
    if (pages.length > this.#maxPages) {
      return Effect.fail(new SessionExportRepositoryError({
        operation: "encode",
        key: lease.key,
        cause: new Error(`Session export has ${pages.length} pages; maximum is ${this.#maxPages}`),
      }));
    }
    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index];
      const expectedKey = sessionExportPageKey(lease.header, lease.options, index);
      if (
        page === undefined ||
        page.index !== index ||
        page.key !== expectedKey ||
        page.byteLength > this.#maxPageBytes
      ) {
        return Effect.fail(new SessionExportRepositoryError({
          operation: "encode",
          key: lease.key,
          cause: new Error(`Page descriptor ${index} does not belong to this export`),
        }));
      }
    }
    const payloadSize = pages.reduce((total, page) => total + page.byteLength, 0);
    return payloadDigest(lease.headerSha256, pages).pipe(
      Effect.flatMap((digest) => {
        const manifest: ChunkedSessionExportManifest = {
          repositoryVersion: 2,
          kind: "chunked-session-export",
          header: lease.header,
          headerSha256: lease.headerSha256,
          exportedAt: lease.options.exportedAt,
          ...(lease.options.id === undefined ? {} : { exportId: lease.options.id }),
          encoding: "structured-json-pages",
          payloadSize,
          payloadSha256: digest,
          pages,
        };
        return Schema.encodeEffect(Schema.fromJsonString(ChunkedSessionExportManifest))(manifest).pipe(
          Effect.mapError((cause) => new SessionExportRepositoryError({
            operation: "encode",
            key: lease.key,
            cause,
          })),
          Effect.flatMap((encoded) => {
            const manifestBytes = utf8ByteLength(encoded);
            if (manifestBytes > this.#maxManifestBytes) {
              return Effect.fail(new SessionExportRepositoryError({
                operation: "encode",
                key: lease.key,
                cause: new Error(
                  `Session export manifest is ${manifestBytes} bytes; maximum is ${this.#maxManifestBytes}`,
                ),
              }));
            }
            return Effect.forEach(pages, (page) =>
              this.#readVerifiedPage(lease.key, lease.header, lease.headerSha256, page).pipe(
                Effect.asVoid,
              ),
            ).pipe(
              Effect.flatMap(() => sha256(encoded)),
              Effect.flatMap((manifestDigest) => Effect.tryPromise({
                try: () => this.bucket.put(lease.key, encoded, {
                  httpMetadata: { contentType: "application/json; charset=utf-8" },
                  customMetadata: metadataStrings(
                    lease.header,
                    lease.options,
                    "chunked",
                    pages.length,
                    payloadSize,
                    {
                      payloadSha256: digest,
                      headerSha256: lease.headerSha256,
                      objectSha256: manifestDigest,
                    },
                  ),
                  onlyIf: { etagDoesNotMatch: "*" },
                }),
                catch: (cause) => new SessionExportRepositoryError({
                  operation: "write",
                  key: lease.key,
                  cause,
                }),
              }).pipe(
                Effect.flatMap((object) => object === null
                  ? this.#sameManifestOrConflict(lease.key, encoded)
                  : decodeObjectMetadata(object, "read").pipe(
                      Effect.flatMap(({ metadata }) => validateMetadataKey(metadata, "read")),
                    )),
              )),
            );
          }),
        );
      }),
    );
  }

  #publishedMetadata(
    key: string,
  ): Effect.Effect<SessionExportMetadata | undefined, SessionExportRepositoryError> {
    return Effect.tryPromise({
      try: () => this.bucket.get(key),
      catch: (cause) => new SessionExportRepositoryError({ operation: "read", key, cause }),
    }).pipe(
      Effect.flatMap((object) => object === null
        ? Effect.succeed(undefined)
        : decodeObjectMetadata(object, "read").pipe(
            Effect.flatMap(({ metadata }) => validateMetadataKey(metadata, "read")),
          )),
    );
  }

  #readReservation(
    key: string,
  ): Effect.Effect<SessionExportReservation | undefined, SessionExportRepositoryError> {
    return Effect.tryPromise({
      try: async () => {
        const object = await this.bucket.get(key);
        return object === null ? null : await object.text();
      },
      catch: (cause) => new SessionExportRepositoryError({ operation: "reserve", key, cause }),
    }).pipe(
      Effect.flatMap((encoded) => encoded === null
        ? Effect.succeed(undefined)
        : Schema.decodeUnknownEffect(Schema.fromJsonString(SessionExportReservation), {
            onExcessProperty: "error",
          })(encoded).pipe(Effect.mapError(
            (cause) => new SessionExportRepositoryError({ operation: "decode", key, cause }),
          ))),
    );
  }

  #assertLease(lease: SessionExportWriteLease): Effect.Effect<void, SessionExportRepositoryError> {
    const expectedKey = sessionExportKey(lease.header, lease.options);
    const expectedReservationKey = sessionExportReservationKey(lease.header, lease.options);
    if (
      lease.key !== expectedKey ||
      lease.reservationKey !== expectedReservationKey ||
      lease.pageCount > this.#maxPages
    ) {
      return Effect.fail(conflict(lease.key, "Invalid session export write lease"));
    }
    return this.#readReservation(lease.reservationKey).pipe(
      Effect.flatMap((reservation) => {
        const expected: SessionExportReservation = {
          repositoryVersion: 2,
          kind: "session-export-reservation",
          header: lease.header,
          headerSha256: lease.headerSha256,
          exportedAt: lease.options.exportedAt,
          ...(lease.options.id === undefined ? {} : { exportId: lease.options.id }),
          pageCount: lease.pageCount,
        };
        return reservation !== undefined && sameReservation(reservation, expected)
          ? Effect.succeed(undefined)
          : Effect.fail(conflict(lease.key, "Session export reservation is missing or does not match"));
      }),
      Effect.flatMap(() => this.#publishedMetadata(lease.key)),
      Effect.flatMap((published) => published === undefined
        ? Effect.succeed(undefined)
        : Effect.fail(conflict(lease.key, "Session export was already published"))),
    );
  }

  #sameInlineOrConflict(
    key: string,
    encoded: string,
  ): Effect.Effect<SessionExportMetadata, SessionExportRepositoryError> {
    return this.#readRoot(key).pipe(
      Effect.flatMap((root) => root.encoded === encoded && root.metadata.storage === "inline"
        ? Effect.succeed(root.metadata)
        : Effect.fail(conflict(key, "export_id already refers to a different inline export"))),
      Effect.mapError((error) => error instanceof SessionExportNotFoundError
        ? new SessionExportRepositoryError({ operation: "write", key, cause: error })
        : error),
    );
  }

  #sameManifestOrConflict(
    key: string,
    encoded: string,
  ): Effect.Effect<SessionExportMetadata, SessionExportRepositoryError> {
    return this.#readRoot(key).pipe(
      Effect.flatMap((root) => root.encoded === encoded && root.metadata.storage === "chunked"
        ? Effect.succeed(root.metadata)
        : Effect.fail(conflict(key, "export_id already refers to a different page manifest"))),
      Effect.mapError((error) => error instanceof SessionExportNotFoundError
        ? new SessionExportRepositoryError({ operation: "write", key, cause: error })
        : error),
    );
  }

  #samePageOrConflict(
    lease: SessionExportWriteLease,
    encoded: string,
    descriptor: SessionExportPageDescriptor,
  ): Effect.Effect<SessionExportPageDescriptor, SessionExportRepositoryError> {
    return Effect.tryPromise({
      try: async () => {
        const object = await this.bucket.get(descriptor.key);
        return object === null ? null : await object.text();
      },
      catch: (cause) => new SessionExportRepositoryError({
        operation: "read",
        key: descriptor.key,
        cause,
      }),
    }).pipe(
      Effect.flatMap((stored) => stored === encoded
        ? Effect.succeed(descriptor)
        : Effect.fail(conflict(lease.key, `Page ${descriptor.index} differs from its reserved export`))),
    );
  }

  #readRoot(
    key: string,
  ): Effect.Effect<
    { readonly object: R2ObjectBodyLike; readonly encoded: string; readonly metadata: SessionExportMetadata; readonly integrity: IntegrityMetadata },
    SessionExportRepositoryError | SessionExportNotFoundError
  > {
    return Effect.gen({ self: this }, function* () {
      const stored = yield* Effect.tryPromise({
        try: async () => {
          const object = await this.bucket.get(key);
          return object === null ? null : { object, encoded: await object.text() };
        },
        catch: (cause) => new SessionExportRepositoryError({ operation: "read", key, cause }),
      });
      if (stored === null) return yield* new SessionExportNotFoundError({ key });
      const decoded = yield* decodeObjectMetadata(stored.object, "read");
      const metadata = yield* validateMetadataKey(decoded.metadata, "read");
      return { ...stored, metadata, integrity: decoded.integrity };
    });
  }

  #decodeInline(
    root: { readonly object: R2ObjectBodyLike; readonly encoded: string; readonly metadata: SessionExportMetadata; readonly integrity: IntegrityMetadata },
  ): Effect.Effect<SessionExport, SessionExportRepositoryError> {
    const { encoded, integrity, key, metadata, object } = {
      ...root,
      key: root.metadata.key,
    };
    return Effect.gen(function* () {
      const byteLength = utf8ByteLength(encoded);
      if (
        metadata.storage !== "inline" ||
        metadata.chunkCount !== 0 ||
        metadata.payloadSize !== byteLength ||
        metadata.size !== byteLength ||
        object.size !== byteLength
      ) {
        return yield* new SessionExportRepositoryError({
          operation: "decode",
          key,
          cause: new Error("Inline export metadata does not match its object size"),
        });
      }
      const digest = yield* sha256(encoded);
      if (digest !== integrity.payloadSha256 || digest !== integrity.objectSha256) {
        return yield* new SessionExportRepositoryError({
          operation: "decode",
          key,
          cause: new Error("Inline export checksum does not match its metadata"),
        });
      }
      const data = yield* decodeSessionExport(encoded, key);
      const actualHeaderSha = yield* headerDigest(headerOf(data));
      if (actualHeaderSha !== integrity.headerSha256 || !sameIdentity(data.session, metadata)) {
        return yield* new SessionExportRepositoryError({
          operation: "decode",
          key,
          cause: new Error("Inline export header does not match its metadata integrity record"),
        });
      }
      return data;
    });
  }

  #decodeManifest(
    root: { readonly object: R2ObjectBodyLike; readonly encoded: string; readonly metadata: SessionExportMetadata; readonly integrity: IntegrityMetadata },
  ): Effect.Effect<ChunkedSessionExportManifest, SessionExportRepositoryError> {
    const { encoded, integrity, key, metadata, object } = {
      ...root,
      key: root.metadata.key,
    };
    return Effect.gen({ self: this }, function* () {
      const byteLength = utf8ByteLength(encoded);
      if (
        metadata.storage !== "chunked" ||
        byteLength > this.#maxManifestBytes ||
        metadata.size !== byteLength ||
        object.size !== byteLength
      ) {
        return yield* new SessionExportRepositoryError({
          operation: "decode",
          key,
          cause: new Error("Session export manifest exceeds its configured or stored byte bound"),
        });
      }
      const objectSha = yield* sha256(encoded);
      if (objectSha !== integrity.objectSha256) {
        return yield* new SessionExportRepositoryError({
          operation: "decode",
          key,
          cause: new Error("Session export manifest checksum does not match its metadata"),
        });
      }
      const manifest = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(ChunkedSessionExportManifest),
        { onExcessProperty: "error" },
      )(encoded).pipe(Effect.mapError(
        (cause) => new SessionExportRepositoryError({ operation: "decode", key, cause }),
      ));
      const actualHeaderSha = yield* headerDigest(manifest.header);
      const actualPayloadSha = yield* payloadDigest(manifest.headerSha256, manifest.pages);
      if (
        manifest.pages.length > this.#maxPages ||
        manifest.exportedAt !== metadata.exportedAt ||
        manifest.exportId !== metadata.exportId ||
        manifest.pages.length !== metadata.chunkCount ||
        manifest.payloadSize !== metadata.payloadSize ||
        manifest.headerSha256 !== integrity.headerSha256 ||
        manifest.payloadSha256 !== integrity.payloadSha256 ||
        actualHeaderSha !== manifest.headerSha256 ||
        actualPayloadSha !== manifest.payloadSha256 ||
        !sameIdentity(manifest.header.session, metadata)
      ) {
        return yield* new SessionExportRepositoryError({
          operation: "decode",
          key,
          cause: new Error("Page manifest does not match R2 metadata or its integrity coverage"),
        });
      }
      const options = writeOptionsFromMetadata(metadata);
      for (let index = 0; index < manifest.pages.length; index += 1) {
        const descriptor = manifest.pages[index];
        const expectedKey = sessionExportPageKey(manifest.header, options, index);
        if (
          descriptor === undefined ||
          descriptor.index !== index ||
          descriptor.key !== expectedKey ||
          descriptor.byteLength > this.#maxPageBytes
        ) {
          return yield* new SessionExportRepositoryError({
            operation: "decode",
            key,
            cause: new Error(`Page descriptor ${index} does not belong to this export`),
          });
        }
      }
      return manifest;
    });
  }

  #readVerifiedPage(
    manifestKey: string,
    header: SessionExportHeader,
    headerSha: string,
    descriptor: SessionExportPageDescriptor,
  ): Effect.Effect<SessionExportPage, SessionExportRepositoryError> {
    return Effect.gen({ self: this }, function* () {
      const object = yield* Effect.tryPromise({
        try: () => this.bucket.get(descriptor.key),
        catch: (cause) => new SessionExportRepositoryError({
          operation: "read",
          key: descriptor.key,
          cause,
        }),
      });
      if (object === null) {
        return yield* new SessionExportRepositoryError({
          operation: "read",
          key: descriptor.key,
          cause: new Error(`Missing session export page for ${manifestKey}`),
        });
      }
      const encoded = yield* Effect.tryPromise({
        try: () => object.text(),
        catch: (cause) => new SessionExportRepositoryError({
          operation: "read",
          key: descriptor.key,
          cause,
        }),
      });
      if (utf8ByteLength(encoded) !== descriptor.byteLength || object.size !== descriptor.byteLength) {
        return yield* new SessionExportRepositoryError({
          operation: "decode",
          key: descriptor.key,
          cause: new Error("Session export page has the wrong byte length"),
        });
      }
      const digest = yield* sha256(encoded);
      if (digest !== descriptor.sha256) {
        return yield* new SessionExportRepositoryError({
          operation: "decode",
          key: descriptor.key,
          cause: new Error("Session export page checksum does not match its descriptor"),
        });
      }
      const persisted = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(PersistedSessionExportPage),
        { onExcessProperty: "error" },
      )(encoded).pipe(Effect.mapError(
        (cause) => new SessionExportRepositoryError({
          operation: "decode",
          key: descriptor.key,
          cause,
        }),
      ));
      if (
        persisted.index !== descriptor.index ||
        persisted.headerSha256 !== headerSha ||
        !sameIdentity(header.session, persisted) ||
        !sameCounts(countsOf(persisted.data), descriptor.counts)
      ) {
        return yield* new SessionExportRepositoryError({
          operation: "decode",
          key: descriptor.key,
          cause: new Error("Session export page identity or counts do not match its manifest"),
        });
      }
      return persisted.data;
    });
  }
}

const sameReservation = (
  left: SessionExportReservation,
  right: SessionExportReservation,
): boolean =>
  left.repositoryVersion === right.repositoryVersion &&
  left.kind === right.kind &&
  left.headerSha256 === right.headerSha256 &&
  left.exportedAt === right.exportedAt &&
  left.exportId === right.exportId &&
  left.pageCount === right.pageCount &&
  sameReplayIdentity(left.header.session, right.header.session);

export const R2SessionExportRepositoryLive = (
  bucket: R2BucketLike,
  options: R2SessionExportRepositoryOptions = {},
): Layer.Layer<SessionExportObjectRepository> =>
  Layer.succeed(SessionExportObjectRepository, new R2SessionExportRepository(bucket, options));
