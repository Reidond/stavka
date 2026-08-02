---
name: effect-v4
description: Build, migrate, and review Stavka Effect v4 TypeScript code with Context services, Layers, Schema, typed errors, structured concurrency, repository boundaries, and contract-first HttpApi servers. Use for any backend, HTTP, persistence, provider, concurrency, or Effect migration work in this project.
---

# Effect v4

Stavka pins `effect@4.0.0-beta.102` and matching ecosystem packages. Inspect the
installed declarations before using unstable APIs; do not copy v3 tutorials.

## Workflow

1. Read [references/practices.md](references/practices.md) before changing
   services, repositories, provider adapters, or concurrent workflows.
2. Read [references/httpapi.md](references/httpapi.md) before changing an HTTP
   contract, handler, runtime adapter, WebSocket upgrade, or static route.
3. Define Effect Schemas for untrusted wire, persistence, and configuration
   boundaries before implementing behavior.
4. Define dependencies with `Context.Service`; provide implementations with
   explicit `Layer`s at the application root.
5. Keep repositories, services, use cases, and adapters in `Effect`. Run the
   composed program only at a Node, Worker, Durable Object, React, or SDK hook.
6. Model expected failures in the typed error channel and use scoped Effect
   resources/concurrency primitives for cancellation, queues, retry, and time.
7. Run focused tests, typecheck, architecture checks, and the complete project
   acceptance matrix before finishing.

## Non-negotiable checks

- HTTP is contract-first `HttpApi`/`HttpApiBuilder`, composed with
  `HttpRouter`. Never inspect URL pathnames or add Hono/`effect-http`.
- Raw SQL and schema migration text live only in `*-repository.ts` modules.
- Package scripts stay short and declarative. Multi-command repository
  automation belongs in the Effect-first `@stavka/tasks` package, not shell
  chains or embedded file/configuration lists.
- Business logic never invokes SQL, environment variables, filesystem,
  network, or provider SDKs directly; inject an Effect port.
- `Effect.runPromise` is permitted only at framework/application boundaries.
- Do not use fire-and-forget Promises, unbounded retry, swallowed errors,
  unvalidated casts, or v3-only APIs.
- Pure simulation, projection, math, and React rendering stay ordinary
  TypeScript; Effect describes effects rather than decorating arithmetic.

## Verification

```sh
pnpm check
pnpm lint:tailwind
pnpm test
pnpm typecheck
pnpm build
pnpm eval -- --replay
```

Also run the architecture suite and classify every boundary found by:

```sh
rg -n "Effect\\.runPromise|async |Promise<|fetch\\(|process\\.env|\\.sql\\b" apps packages tools
rg -n "location\\.pathname|url\\.pathname|new URL\\(" apps packages tools
```
