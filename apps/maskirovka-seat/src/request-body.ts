import { Effect, Stream } from "effect";
import type { HttpServerRequest } from "effect/unstable/http";

export class RequestBodyError extends Error {
  constructor(
    readonly code: "INVALID_JSON" | "PAYLOAD_TOO_LARGE" | "UNSUPPORTED_ENCODING",
    message: string,
  ) {
    super(message);
  }
}

const MAX_JSON_BYTES = 1_048_576;

const collectBounded = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<ReadonlyArray<Uint8Array>, RequestBodyError> =>
  request.stream.pipe(
    Stream.mapAccumEffect(
      () => 0,
      (length, chunk) => {
        const nextLength = length + chunk.byteLength;
        return nextLength > MAX_JSON_BYTES
          ? Effect.fail(new RequestBodyError("PAYLOAD_TOO_LARGE", "Request payload exceeds 1 MiB"))
          : Effect.succeed([nextLength, [chunk]] as const);
      },
    ),
    Stream.runCollect,
    Effect.mapError((error) =>
      error instanceof RequestBodyError
        ? error
        : new RequestBodyError("INVALID_JSON", "Unable to read the JSON request body"),
    ),
  );

export const readBoundedJson = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<unknown, RequestBodyError> =>
  Effect.gen(function* () {
    const encoding = request.headers["content-encoding"];
    if (encoding && encoding !== "identity") {
      return yield* Effect.fail(
        new RequestBodyError("UNSUPPORTED_ENCODING", "Compressed request bodies are not accepted"),
      );
    }

    const declaredLength = Number(request.headers["content-length"] ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
      return yield* Effect.fail(
        new RequestBodyError("PAYLOAD_TOO_LARGE", "Request payload exceeds 1 MiB"),
      );
    }

    const chunks = yield* collectBounded(request);
    const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    if (length === 0) {
      return yield* Effect.fail(
        new RequestBodyError("INVALID_JSON", "A JSON request body is required"),
      );
    }

    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return yield* Effect.try({
      try: () => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
      catch: () => new RequestBodyError("INVALID_JSON", "Request body must be valid UTF-8 JSON"),
    });
  });
