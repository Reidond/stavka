# Stavka engineering contract

## Python

- Use `uv` for every Python command, environment, dependency, and tool. Never invoke `python`, `python3`, `pip`, `pip3`, `venv`, or `.venv/bin/*` directly.

## Backend architecture

- Use Effect v4 for application, domain, service, orchestration, validation, configuration, concurrency, and infrastructure code. Follow the `effect-v4` skill when writing or reviewing Effect code.
- Define every HTTP API contract-first with Effect v4 `HttpApi`, `HttpApiGroup`, and `HttpApiEndpoint`, implement it with `HttpApiBuilder`, and run it through the appropriate Node or web-standard Effect adapter. Do not add Hono, `effect-http`, or hand-written URL pathname dispatch.
- Keep Promise- and callback-based code at unavoidable framework boundaries only (React rendering, Cloudflare/SDK inheritance hooks, and tiny runtime adapters); enter Effect immediately at the boundary.
- Model dependencies as Effect services and Layers, expected failures as typed errors, configuration with Effect Config, and wire/persistence validation with Effect Schema. Avoid `Effect.runPromise` below an application entrypoint or framework adapter.
- Keep raw SQL and schema details inside repository modules whose filenames end in `repository.ts`. Repositories expose Effect operations; agents, use cases, route handlers, and domain services call those operations and never contain SQL.
- Keep wire validation at boundaries with `@stavka/protocol` Effect Schemas. Preserve protocol versions, fields, status codes, auth gates, and full/delta semantics.

## Frontend architecture

- Use `tailwind-variants` `tv` for typed component variants and `cn` for Tailwind-aware class composition. Do not build conditional class strings manually.
- Put variants, tokens, and interactive primitives in `@stavka/ui`; apps consume the shared components rather than importing Base UI, TanStack Table/Form/Virtual, or class-composition packages directly.
- Run `pnpm lint:tailwind` for the same `better-tailwindcss` checks used by CI. The tracked VS Code settings and extension recommendations are also consumed by Cursor.
- Make every web application feel like a desktop shell: use `100vh` as a fallback immediately followed by `100dvh`, keep the document viewport bounded, and put overflow scrolling on explicit content panes with `min-height: 0`.
- Human surfaces must retain Cloudflare Access verification for HTTP and WebSocket upgrades.

## LLM development

- Start the local gateway with `pnpm ai:up`. It binds to `127.0.0.1:4141`, runs the non-billing doctor, and generates the Wrangler `.dev.vars` files. Never add real provider API keys to development files.
- Code requests only `stavka/commander`, `stavka/sergeant`, or `stavka/heavy`; Maskirovka owns concrete seat/model resolution.
- OpenAI clients use Responses only:

  ```sh
  curl -sS http://127.0.0.1:4141/v1/responses -H 'content-type: application/json' -d '{"model":"stavka/commander","input":"Hold position"}'
  ```

- Anthropic clients use Messages only:

  ```sh
  curl -sS http://127.0.0.1:4141/v1/messages -H 'content-type: application/json' -d '{"model":"stavka/sergeant","max_tokens":64,"messages":[{"role":"user","content":"Hold position"}]}'
  ```

- `GET /healthz` is the machine-readable seat/budget view; `GET /v1/models` lists aliases and current resolutions; the local operations SPA is at `/_/`.
- Run `pnpm eval -- --replay` before commit. Replay misses fail without touching a network. Use record, `doctor --live`, live sergeants, metered API, and deployment only as explicit operator actions.
