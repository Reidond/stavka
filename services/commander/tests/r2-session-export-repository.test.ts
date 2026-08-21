import { type SessionExport } from "@stavka/protocol";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  R2SessionExportRepository,
  SessionExportRepositoryError,
  decodeSessionExportKeySegment,
  sanitizeSessionExportKeySegment,
  sessionExportKey,
  type R2BucketLike,
  type R2ObjectBodyLike,
  type R2ObjectMetadataLike,
  type SessionExportBeginResult,
  type SessionExportHeader,
  type SessionExportPage,
  type SessionExportWriteLease,
  type SessionExportWriteOptions,
} from "../src/logging/r2-session-export-repository";

const makeExport = (
  sessionId = "session-1",
  faction = "OPFOR",
  missionEpoch = 3,
): SessionExport => ({
  export_version: 1,
  session: {
    protocol_version: 1,
    session_id: sessionId,
    faction,
    mission_epoch: missionEpoch,
    doctrine: "balanced",
    mode: "rule",
    exported_at: "2026-08-02T12:00:00.000Z",
  },
  logs: [],
  archive: { ticks: [], events: [], snapshots: [] },
  cost_aggregates: [],
});

interface FakeStoredObject {
  readonly body: string;
  readonly metadata: R2ObjectMetadataLike;
}

interface R2PutOptions {
  readonly httpMetadata?: { readonly contentType?: string };
  readonly customMetadata?: Record<string, string>;
  readonly onlyIf?: { readonly etagDoesNotMatch?: string };
}

class FakeR2Bucket implements R2BucketLike {
  readonly objects = new Map<string, FakeStoredObject>();
  readonly putKeys: string[] = [];
  failWrites = false;

  async put(
    key: string,
    value: string,
    options?: R2PutOptions,
  ): Promise<R2ObjectMetadataLike | null> {
    if (this.failWrites) throw new Error("simulated R2 write failure");
    if (options?.onlyIf?.etagDoesNotMatch === "*" && this.objects.has(key)) return null;
    this.putKeys.push(key);
    const metadata: R2ObjectMetadataLike = {
      key,
      size: new TextEncoder().encode(value).byteLength,
      etag: `etag:${key}`,
      uploaded: new Date("2026-08-02T12:00:00.000Z"),
      ...(options?.customMetadata === undefined
        ? {}
        : { customMetadata: { ...options.customMetadata } }),
    };
    this.objects.set(key, { body: value, metadata });
    return metadata;
  }

  async get(key: string): Promise<R2ObjectBodyLike | null> {
    const stored = this.objects.get(key);
    if (stored === undefined) return null;
    return { ...stored.metadata, text: async () => stored.body };
  }

  async list(options?: {
    readonly prefix?: string;
    readonly limit?: number;
    readonly cursor?: string;
    readonly include?: ("customMetadata" | "httpMetadata")[];
  }): Promise<{
    readonly objects: readonly R2ObjectMetadataLike[];
    readonly truncated?: boolean;
    readonly cursor?: string;
  }> {
    const prefix = options?.prefix ?? "";
    const all = [...this.objects.values()]
      .map(({ metadata }) => metadata)
      .filter(({ key }) => key.startsWith(prefix))
      .sort((left, right) => left.key.localeCompare(right.key));
    const start = options?.cursor === undefined ? 0 : Number(options.cursor);
    const limit = options?.limit ?? all.length;
    const objects = all.slice(start, start + limit);
    const next = start + objects.length;
    return next < all.length
      ? { objects, truncated: true, cursor: String(next) }
      : { objects, truncated: false };
  }

  seed(key: string, body: string, customMetadata: Record<string, string>): void {
    this.objects.set(key, {
      body,
      metadata: {
        key,
        size: new TextEncoder().encode(body).byteLength,
        etag: `etag:${key}`,
        uploaded: new Date("2026-08-02T12:00:00.000Z"),
        customMetadata,
      },
    });
  }
}

const headerOf = (data: SessionExport): SessionExportHeader => ({
  export_version: data.export_version,
  session: data.session,
  cost_aggregates: data.cost_aggregates,
});

const pendingLease = (result: SessionExportBeginResult): SessionExportWriteLease => {
  if (result._tag !== "pending") throw new Error("Expected a pending export reservation");
  return result.lease;
};

const event = (index: number) => ({
  id: `event-${index}`,
  type: "semantic_replay_marker" as const,
  timestamp: index,
  significance: "routine" as const,
  details: { note: `event-${index}` },
});

const page = (index: number): SessionExportPage => ({
  logs: [],
  ticks: [],
  events: [event(index)],
  snapshots: [],
});

const digest = async (value: string): Promise<string> => {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

describe("R2 session export repository", () => {
  it("validates, persists, lists, and reads an inline canonical export through a bounded page", async () => {
    const bucket = new FakeR2Bucket();
    const repository = new R2SessionExportRepository(bucket);
    const data = makeExport();

    const written = await Effect.runPromise(
      repository.write(data, { exportedAt: 1_775_131_200_000 }),
    );
    const listed = await Effect.runPromise(
      repository.list({
        sessionId: "session-1",
        faction: "OPFOR",
        missionEpoch: 3,
      }),
    );
    const downloaded = await Effect.runPromise(repository.readPage(written.key));

    expect(listed).toEqual({ exports: [written] });
    expect(downloaded).toMatchObject({
      metadata: written,
      header: headerOf(data),
      page: { logs: [], ticks: [], events: [], snapshots: [] },
      index: 0,
    });
    expect(downloaded.cursor).toBeUndefined();
  });

  it("rejects invalid identities and write options before creating an R2 object", async () => {
    const bucket = new FakeR2Bucket();
    const repository = new R2SessionExportRepository(bucket);
    const invalidWrites: readonly (readonly [SessionExport, SessionExportWriteOptions])[] = [
      [makeExport("", "OPFOR", 3), { exportedAt: 1_775_131_200_000 }],
      [makeExport("session-1", "", 3), { exportedAt: 1_775_131_200_000 }],
      [makeExport("session-1", "OPFOR", -1), { exportedAt: 1_775_131_200_000 }],
      [makeExport(), { exportedAt: -1 }],
      [makeExport(), { exportedAt: 1_775_131_200_000, id: " " }],
    ];

    for (const [data, options] of invalidWrites) {
      const failure = await Effect.runPromise(Effect.flip(repository.write(data, options)));
      expect(failure.operation).toBe("encode");
    }
    expect(bucket.objects.size).toBe(0);
  });

  it("writes unequal bounded pages, publishes the manifest last, and downloads one page at a time", async () => {
    const bucket = new FakeR2Bucket();
    const repository = new R2SessionExportRepository(bucket);
    const data = makeExport("incremental-session", "BLUFOR", 12);
    const options = { exportedAt: 1_775_131_200_000, id: "incremental" } as const;
    const lease = pendingLease(
      await Effect.runPromise(repository.begin(headerOf(data), options, 2)),
    );

    const first = await Effect.runPromise(repository.writePage(lease, 0, page(0)));
    const second = await Effect.runPromise(
      repository.writePage(lease, 1, {
        ...page(1),
        events: [event(1), event(2), event(3)],
      }),
    );
    const completed = await Effect.runPromise(repository.complete(lease, [first, second]));
    const firstDownload = await Effect.runPromise(repository.readPage(completed.key));
    const secondDownload = await Effect.runPromise(
      repository.readPage(completed.key, firstDownload.cursor),
    );

    expect(completed.storage).toBe("chunked");
    expect(completed.chunkCount).toBe(2);
    expect(bucket.putKeys.at(-1)).toBe(completed.key);
    expect(firstDownload.page.events).toEqual([event(0)]);
    expect(firstDownload.cursor).toBe("1");
    expect(secondDownload.page.events).toEqual([event(1), event(2), event(3)]);
    expect(secondDownload.cursor).toBeUndefined();
  });

  it("downloads a canonical empty page from a zero-page manifest", async () => {
    const bucket = new FakeR2Bucket();
    const repository = new R2SessionExportRepository(bucket);
    const data = makeExport("empty-incremental-session");
    const lease = pendingLease(
      await Effect.runPromise(
        repository.begin(headerOf(data), { exportedAt: 1_775_131_200_000, id: "empty" }, 0),
      ),
    );

    const completed = await Effect.runPromise(repository.complete(lease, []));
    const downloaded = await Effect.runPromise(repository.readPage(completed.key));

    expect(completed).toMatchObject({ storage: "chunked", chunkCount: 0, payloadSize: 0 });
    expect(downloaded).toMatchObject({
      header: headerOf(data),
      page: { logs: [], ticks: [], events: [], snapshots: [] },
      index: 0,
    });
    expect(downloaded.cursor).toBeUndefined();
  });

  it("preflights the page capacity before reservation or page writes", async () => {
    const bucket = new FakeR2Bucket();
    const repository = new R2SessionExportRepository(bucket, { maxPages: 1 });
    const data = makeExport("bounded-session");

    const failure = await Effect.runPromise(
      Effect.flip(repository.begin(headerOf(data), { exportedAt: 1_775_131_200_000 }, 2)),
    );

    expect(failure).toBeInstanceOf(SessionExportRepositoryError);
    if (!(failure instanceof SessionExportRepositoryError)) throw failure;
    expect(failure.operation).toBe("encode");
    expect(bucket.putKeys).toEqual([]);
  });

  it("makes export_id first-writer-wins and rejects a different in-progress page plan before it writes pages", async () => {
    const bucket = new FakeR2Bucket();
    const repository = new R2SessionExportRepository(bucket);
    const data = makeExport("idempotent-session");
    const options = { exportedAt: 1_775_131_200_000, id: "stable-export" } as const;
    const lease = pendingLease(
      await Effect.runPromise(repository.begin(headerOf(data), options, 1)),
    );
    const descriptor = await Effect.runPromise(repository.writePage(lease, 0, page(0)));

    const conflicting = await Effect.runPromise(
      Effect.flip(repository.begin(headerOf(data), options, 2)),
    );
    expect(conflicting.operation).toBe("conflict");
    expect(bucket.putKeys).toHaveLength(2); // reservation + one page, no competing page write

    const published = await Effect.runPromise(repository.complete(lease, [descriptor]));
    const retried = await Effect.runPromise(
      repository.write(
        {
          ...data,
          archive: { ...data.archive, events: [event(99)] },
        },
        { exportedAt: 1_775_131_200_999, id: "stable-export" },
      ),
    );

    expect(retried).toEqual(published);
    expect(bucket.putKeys.filter((key) => key === published.key)).toHaveLength(1);
  });

  it("covers inline payloads and chunked manifest/header/pages with integrity checks", async () => {
    const inlineBucket = new FakeR2Bucket();
    const inlineRepository = new R2SessionExportRepository(inlineBucket);
    const inline = await Effect.runPromise(
      inlineRepository.write(makeExport("inline-corruption"), { exportedAt: 1_775_131_200_000 }),
    );
    const inlineStored = inlineBucket.objects.get(inline.key);
    if (inlineStored === undefined) throw new Error("Expected inline object");
    inlineBucket.seed(
      inline.key,
      inlineStored.body.replace("inline-corruption", "inline-corruptioX"),
      inlineStored.metadata.customMetadata ?? {},
    );
    const inlineFailure = await Effect.runPromise(
      Effect.flip(inlineRepository.readPage(inline.key)),
    );
    if (!(inlineFailure instanceof SessionExportRepositoryError)) throw inlineFailure;
    expect(inlineFailure.operation).toBe("decode");
    expect(String(inlineFailure.cause)).toContain("checksum");

    const bucket = new FakeR2Bucket();
    const repository = new R2SessionExportRepository(bucket);
    const data = makeExport("manifest-corruption");
    const options = { exportedAt: 1_775_131_200_000, id: "manifest" } as const;
    const lease = pendingLease(
      await Effect.runPromise(repository.begin(headerOf(data), options, 1)),
    );
    const descriptor = await Effect.runPromise(repository.writePage(lease, 0, page(0)));
    const chunked = await Effect.runPromise(repository.complete(lease, [descriptor]));
    const manifest = bucket.objects.get(chunked.key);
    if (manifest === undefined) throw new Error("Expected manifest");
    const altered = JSON.stringify({
      ...(JSON.parse(manifest.body) as Record<string, unknown>),
      header: { ...headerOf(makeExport("changed-header")) },
    });
    const customMetadata = manifest.metadata.customMetadata;
    if (customMetadata === undefined) throw new Error("Expected manifest metadata");
    const metadata = { ...customMetadata };
    metadata.objectSha256 = await digest(altered);
    bucket.seed(chunked.key, altered, metadata);

    const manifestFailure = await Effect.runPromise(Effect.flip(repository.readPage(chunked.key)));
    if (!(manifestFailure instanceof SessionExportRepositoryError)) throw manifestFailure;
    expect(manifestFailure.operation).toBe("decode");
    expect(String(manifestFailure.cause)).toContain("integrity");
  });

  it("uses an injective reversible identity encoding for distinct Unicode forms", async () => {
    const composed = "café";
    const decomposed = "cafe\u0301";
    const fullWidth = "Ａ";
    const ascii = "A";
    const loneSurrogate = "\ud800";

    expect(sanitizeSessionExportKeySegment(composed)).not.toBe(
      sanitizeSessionExportKeySegment(decomposed),
    );
    expect(sanitizeSessionExportKeySegment(fullWidth)).not.toBe(
      sanitizeSessionExportKeySegment(ascii),
    );
    expect(decodeSessionExportKeySegment(sanitizeSessionExportKeySegment(""))).toBe("");
    expect(decodeSessionExportKeySegment(sanitizeSessionExportKeySegment(composed))).toBe(composed);
    expect(decodeSessionExportKeySegment(sanitizeSessionExportKeySegment(loneSurrogate))).toBe(
      loneSurrogate,
    );

    const bucket = new FakeR2Bucket();
    const repository = new R2SessionExportRepository(bucket);
    const first = await Effect.runPromise(
      repository.write(makeExport(fullWidth, composed, 4), {
        exportedAt: 1_775_131_200_000,
        id: "unicode",
      }),
    );
    const second = await Effect.runPromise(
      repository.write(makeExport(ascii, decomposed, 4), {
        exportedAt: 1_775_131_200_000,
        id: "unicode",
      }),
    );
    expect(first.key).not.toBe(second.key);
    expect(first.key).not.toContain("../");
  });

  it("returns and consumes a native continuation cursor after the 1,000-object R2 page", async () => {
    const bucket = new FakeR2Bucket();
    const repository = new R2SessionExportRepository(bucket);
    const base = makeExport("listed-session", "OPFOR", 1);
    for (let index = 0; index < 1_001; index += 1) {
      const options = { exportedAt: index, id: `export-${String(index).padStart(4, "0")}` };
      const key = sessionExportKey(base, options);
      bucket.seed(key, "{}", {
        kind: "stavka-session-export",
        schemaVersion: "3",
        exportVersion: "1",
        sessionId: base.session.session_id,
        faction: base.session.faction,
        missionEpoch: String(base.session.mission_epoch),
        exportedAt: String(index),
        exportId: options.id,
        storage: "inline",
        chunkCount: "0",
        payloadSize: "2",
        payloadSha256: "a".repeat(64),
        headerSha256: "b".repeat(64),
        objectSha256: "a".repeat(64),
      });
    }

    const first = await Effect.runPromise(
      repository.list({
        sessionId: base.session.session_id,
        faction: base.session.faction,
        missionEpoch: 1,
        limit: 1_000,
      }),
    );
    if (first.cursor === undefined) throw new Error("Expected a continuation cursor");
    const second = await Effect.runPromise(
      repository.list({
        sessionId: base.session.session_id,
        faction: base.session.faction,
        missionEpoch: 1,
        limit: 1_000,
        cursor: first.cursor,
      }),
    );

    expect(first.exports).toHaveLength(1_000);
    expect(first.cursor).toBeDefined();
    expect(second.exports).toHaveLength(1);
    expect(second.cursor).toBeUndefined();
  });
});
