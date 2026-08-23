import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NodeHttpPlatform, NodeServices } from "@effect/platform-node";
import { Effect, Layer, Schema } from "effect";
import { Etag, HttpRouter } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import { ProviderAuthError, type CodexOAuthCredential } from "./accounts";
import {
  CODEX_AUTH_BASE_URL,
  CODEX_CLIENT_ID,
  exchangeCodexAuthorizationCode,
} from "./codex-oauth";

const encodeBase64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

const randomValue = (bytes: number): string =>
  encodeBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));

const browserCommand = (url: string): readonly [string, readonly string[]] => {
  if (process.platform === "darwin") return ["open", [url]];
  if (process.platform === "win32") return ["cmd", ["/c", "start", "", url]];
  return ["xdg-open", [url]];
};

export interface CodexBrowserLogin {
  readonly authorizationUrl: string;
  readonly credential: CodexOAuthCredential;
}

class OAuthCallbackError extends Schema.ErrorClass<OAuthCallbackError>(
  "stavka/provider-auth/OAuthCallbackError",
)({ message: Schema.String }, { httpApiStatus: 400 }) {}

const OAuthCallbackApi = HttpApi.make("stavka-codex-oauth").add(
  HttpApiGroup.make("oauth").add(
    HttpApiEndpoint.get("callback", "/auth/callback", {
      query: {
        code: Schema.optional(Schema.String),
        state: Schema.optional(Schema.String),
        error: Schema.optional(Schema.String),
      },
      success: Schema.String,
      error: OAuthCallbackError,
    }),
  ),
);

type CallbackOutcome =
  | { readonly code: string; readonly error?: never }
  | { readonly code?: never; readonly error: Error };

const callbackApplication = (
  expectedState: string,
  observed: (outcome: CallbackOutcome) => void,
) => {
  const handlers = HttpApiBuilder.group(OAuthCallbackApi, "oauth", (group) =>
    group.handle("callback", ({ query }) => {
      if (query.state !== expectedState) {
        const error = new Error("OAuth state mismatch");
        observed({ error });
        return Effect.fail(new OAuthCallbackError({ message: "State validation failed" }));
      }
      if (!query.code) {
        const error = new Error(query.error ?? "Authorization code missing");
        observed({ error });
        return Effect.fail(new OAuthCallbackError({ message: error.message }));
      }
      observed({ code: query.code });
      return Effect.succeed("Authentication complete. Return to the terminal.");
    }),
  );
  return HttpRouter.toWebHandler(
    HttpApiBuilder.layer(OAuthCallbackApi).pipe(
      Layer.provide(handlers),
      Layer.provide(Layer.mergeAll(NodeHttpPlatform.layer, NodeServices.layer, Etag.layer)),
    ),
    { disableLogger: true },
  );
};

export const loginCodexWithBrowser = (
  options: {
    readonly openBrowser?: boolean;
    readonly timeoutMs?: number;
    readonly fetcher?: typeof fetch;
  } = {},
): Effect.Effect<CodexBrowserLogin, ProviderAuthError> =>
  Effect.tryPromise({
    try: async () => {
      const verifier = randomValue(64);
      const challenge = encodeBase64Url(
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
      );
      const state = randomValue(32);
      const redirectUri = "http://localhost:1455/auth/callback";
      const authorization = new URL(`${CODEX_AUTH_BASE_URL}/oauth/authorize`);
      authorization.search = new URLSearchParams({
        response_type: "code",
        client_id: CODEX_CLIENT_ID,
        redirect_uri: redirectUri,
        scope: "openid profile email offline_access api.connectors.read api.connectors.invoke",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
        originator: "stavka",
      }).toString();

      let resolveCallback!: (code: string) => void;
      let rejectCallback!: (error: Error) => void;
      let pendingOutcome: CallbackOutcome | undefined;
      const callback = new Promise<string>((resolve, reject) => {
        resolveCallback = resolve;
        rejectCallback = reject;
      });
      const web = callbackApplication(state, (outcome) => {
        pendingOutcome = outcome;
      });
      const server = createServer((request, response) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) {
          if (typeof value === "string") headers.set(name, value);
          else if (value) for (const item of value) headers.append(name, item);
        }
        void web
          .handler(
            new Request(new URL(request.url ?? "/", "http://localhost:1455"), {
              method: request.method ?? "GET",
              headers,
            }),
          )
          .then(async (webResponse) => {
            const body = Buffer.from(await webResponse.arrayBuffer());
            response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
            response.end(body, () => {
              if (pendingOutcome?.code) resolveCallback(pendingOutcome.code);
              else if (pendingOutcome?.error) rejectCallback(pendingOutcome.error);
            });
          })
          .catch((cause: unknown) => {
            response.writeHead(500).end();
            rejectCallback(cause instanceof Error ? cause : new Error(String(cause)));
          });
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(1455, "127.0.0.1", resolve);
      });
      const timeout = setTimeout(
        () => rejectCallback(new Error("Codex browser login timed out")),
        options.timeoutMs ?? 10 * 60 * 1_000,
      );
      timeout.unref();
      let code: string;
      try {
        if (options.openBrowser !== false) {
          const [command, args] = browserCommand(authorization.toString());
          await promisify(execFile)(command, [...args]);
        }
        code = await callback;
      } finally {
        clearTimeout(timeout);
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await web.dispose();
      }
      const credential = await Effect.runPromise(
        exchangeCodexAuthorizationCode(code, verifier, redirectUri, options.fetcher),
      );
      return { authorizationUrl: authorization.toString(), credential };
    },
    catch: (cause) =>
      cause instanceof ProviderAuthError
        ? cause
        : new ProviderAuthError({
            operation: "codex.browser.login",
            message: cause instanceof Error ? cause.message : String(cause),
          }),
  });
