# Effect v4 contract-first HTTP

This reference targets `effect@4.0.0-beta.102`.

## Contract and handlers

- Import API contracts from `effect/unstable/httpapi` and runtime routing from
  `effect/unstable/http`.
- Define method, path, params, headers, payload, success, and expected errors
  with `HttpApi`, `HttpApiGroup`, and `HttpApiEndpoint`.
- Implement groups with `HttpApiBuilder.group` and assemble them with
  `HttpApiBuilder.layer`.
- In beta.102, endpoint schemas belong in constructor options. Older examples
  using `setPayload`, `setSuccess`, or `addError` are not the installed API.
- Use `HttpApiMiddleware.Service` and `HttpApiSecurity` for contract auth and
  cross-cutting middleware. Raw pre-upgrade verification is acceptable when a
  third-party WebSocket router owns the handshake.
- Use raw handlers only for streaming, upgrades, static assets, or transparent
  proxy responses; the path itself still belongs to `HttpRouter`.

## Runtime adapters

- Node servers use `@effect/platform-node` and `NodeHttpServer`.
- Fetch/Cloudflare handlers use `HttpRouter.toWebHandler` with
  `HttpServer.layerServices`; construct the handler once at module scope.
- Agents SDK and Cloudflare asset fallbacks compose through `HttpRouter`; never
  branch on `new URL(request.url).pathname`.

## Clients, docs, and tests

- Derive typed clients with `HttpApiClient` rather than duplicating request
  contracts by hand.
- Generate OpenAPI from the same API and expose Swagger/Scalar only when bundle
  size and auth posture are deliberate.
- Test typed in-memory contracts, real Node sockets where relevant, Fetch
  handler disposal, auth failures, schema failures, 404/405 behavior, raw proxy
  fidelity, cancellation, and WebSocket upgrade authorization.
