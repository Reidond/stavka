import { Context, Effect, Layer } from "effect";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
} from "effect/unstable/http";

export interface TransportService {
  readonly postJson: (path: string, body: unknown) => Effect.Effect<unknown, unknown>;
}

export class Transport extends Context.Service<Transport, TransportService>()(
  "@stavka/sim-link/Transport",
) {}

export interface RestTransportOptions {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly missionEpoch?: number;
  readonly fetch?: typeof globalThis.fetch;
}

const fetchHttpClientLayer = (fetch: typeof globalThis.fetch) =>
  Layer.merge(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, fetch));

const unwrapFetchFailure = (error: unknown): unknown =>
  HttpClientError.isHttpClientError(error) &&
  "cause" in error.reason &&
  error.reason.cause !== undefined
    ? error.reason.cause
    : error;

export class RestTransport implements TransportService {
  readonly #endpoint: string;
  readonly #apiKey: string;
  readonly #missionEpoch: number;
  readonly #httpClientLayer: ReturnType<typeof fetchHttpClientLayer>;

  constructor(options: RestTransportOptions) {
    this.#endpoint = options.endpoint.replace(/\/$/, "");
    this.#apiKey = options.apiKey;
    this.#missionEpoch = options.missionEpoch ?? 1;
    this.#httpClientLayer = fetchHttpClientLayer(
      options.fetch ?? globalThis.fetch.bind(globalThis),
    );
  }

  static layer(options: RestTransportOptions): Layer.Layer<Transport> {
    return Layer.succeed(Transport, new RestTransport(options));
  }

  readonly postJson = (path: string, body: unknown): Effect.Effect<unknown, unknown> => {
    const program = Effect.gen({ self: this }, function* () {
      const json = yield* Effect.try({
        try: () => JSON.stringify(body),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      });
      const request = HttpClientRequest.post(`${this.#endpoint}${path}`).pipe(
        HttpClientRequest.setHeaders({
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
          "x-stavka-mission-epoch": String(this.#missionEpoch),
        }),
        HttpClientRequest.setBody(HttpBody.raw(json, { contentType: "application/json" })),
      );
      const response = yield* HttpClient.execute(request);
      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail(new Error(`Commander returned HTTP ${response.status}`));
      }
      if (response.status === 204) return undefined;
      const responseText = yield* response.text;
      return yield* Effect.try({
        try: (): unknown => JSON.parse(responseText),
        catch: (cause) => cause,
      });
    });

    return program.pipe(Effect.mapError(unwrapFetchFailure), Effect.provide(this.#httpClientLayer));
  };
}
