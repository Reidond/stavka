# Effect v4 engineering guide

Stavka pins `effect@4.0.0-beta.102` and the matching Effect ecosystem packages.
The unstable API surface can change, so upgrade all Effect packages together and
compile every HTTP boundary before accepting a version bump.

## Where Effect is required

Use Effect for application services, repositories, use cases, provider adapters,
configuration, validation, HTTP routing, retries, timeouts, queues, concurrency,
resource lifecycles, logging, and orchestration. Pure simulation, projections,
math, and React rendering remain ordinary TypeScript.

Promise APIs and framework hooks are boundary adapters. Wrap external Promises
with `Effect.tryPromise`, callbacks with `Effect.callback`, and run the composed
program only from a Worker, Durable Object, Container, Node, React, or third-party
SDK entrypoint. Do not call `Effect.runPromise` from a repository, service, or use
case.

## Services and repositories

- Define ports with `Context.Service` and operations that return `Effect`.
- In class methods, preserve `this` inside generators with
  `Effect.gen({ self: this }, function* () { ... })`; do not alias `this` to a
  local variable.
- Supply implementations through `Layer.succeed`, `Layer.effect`, or scoped
  resource Layers, then compose those Layers once at the application root.
- Model expected failures as tagged typed errors. Preserve interruption and
  defects instead of converting every failure into a generic exception.
- Decode untrusted wire, persistence, and configuration data before invoking
  business logic.
- Keep SQL and persistence schema details exclusively in files ending in
  `repository.ts`. Business logic knows repository operations, never queries.

## HTTP APIs

Import contract modules from `effect/unstable/httpapi` and runtime routing from
`effect/unstable/http`.

- Define paths, parameters, headers, payloads, success values, and expected
  errors with `HttpApi`, `HttpApiGroup`, and `HttpApiEndpoint`.
- Implement endpoint groups with `HttpApiBuilder.group` and assemble the API
  with `HttpApiBuilder.layer`.
- Use `HttpApiMiddleware.Service` for authentication and cross-cutting contract
  middleware.
- Compose raw static assets, WebSocket upgrades, or third-party handlers through
  `HttpRouter`; never inspect `URL.pathname` manually.
- Serve Node applications with `@effect/platform-node` and expose Fetch/Worker
  applications with `HttpRouter.toWebHandler` plus `HttpServer.layerServices`.
- Derive clients and OpenAPI from the same contract. Do not maintain a duplicate
  handwritten route client when `HttpApiClient` can express it.

For beta.102, endpoint schemas are constructor options. Older examples using
`setPayload`, `setSuccess`, or `HttpApiBuilder.toWebHandler` do not match the
installed API.

## Schema and concurrency

- Keep encoded wire types distinct from decoded domain types when a schema
  transforms data.
- Prefer `Schema.decodeUnknownEffect` inside effectful boundaries and
  `Schema.toStandardSchemaV1` for TanStack integration.
- Use `Queue`, `Semaphore`, `Ref`, `Deferred`, `Schedule`, `Clock`, and supervised
  fibers instead of mutable Promise queues, ad hoc timers, or fire-and-forget
  work.
- Make retries finite, failure-specific, observable, interruptible, and bounded
  by integration timeouts.

## Repository tooling

Treat repository automation as application orchestration rather than shell text.
Root `package.json` scripts are short aliases only; they must not contain long
file lists, per-application configuration matrices, or `&&`/`||` chains.
Multi-step tasks live in `@stavka/tasks`, use Effect's scoped child-process API,
inherit terminal streams, and fail through a typed error when a command exits
nonzero. This keeps the manifest readable while preserving cancellation and
resource cleanup.

## Verification

Before finishing Effect work, run:

```bash
pnpm check
pnpm lint:tailwind
pnpm test
pnpm typecheck
pnpm build
pnpm eval -- --replay
```

Also inspect boundary leaks with:

```bash
rg -n "Effect\.runPromise|async |Promise<|fetch\(|process\.env|\.sql\b" apps packages tools
rg -n "location\.pathname|url\.pathname|new URL\(" apps packages tools
```

Every result must be either a justified external boundary or a migration defect.
The repository architecture tests additionally reject Hono, manual pathname
dispatch, Effect version drift, SQL outside repositories, and frontend code that
drifts from the direct Kumo and app-local composition contract.
