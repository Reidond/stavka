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

- Use direct granular `@cloudflare/kumo` imports for styled components and primitives, compose feature-specific UI in each app, and use Kumo semantic tokens in Tailwind classes.
- Import TanStack Table/Form/Virtual headless libraries directly only in the applications that need them; do not add a replacement shared UI package or generic compatibility facade.
- Run `pnpm lint:tailwind` for the same `better-tailwindcss` checks used by CI. The tracked VS Code settings and extension recommendations are also consumed by Cursor.
- Make every web application feel like a desktop shell: use `100vh` as a fallback immediately followed by `100dvh`, keep the document viewport bounded, and put overflow scrolling on explicit content panes with `min-height: 0`.
- Human surfaces must retain Cloudflare Access verification for HTTP and WebSocket upgrades.

## Tooling architecture

- Keep every root `package.json` script as a short single-command alias. Do not embed file lists, configuration matrices, or shell control operators such as `&&` and `||` in package scripts.
- Put multi-step repository orchestration in the Effect-first `@stavka/tasks` package. Execute child processes with Effect's scoped process APIs, inherited stdio, and typed nonzero-exit failures.

## Production deployment

- `.github/workflows/ci.yml` is verification-only. Production is the separate manual `.github/workflows/deploy.yml` workflow, restricted to `main` and the GitHub `production` environment.
- The production task deploys exactly three Cloudflare services sequentially: private inference, private Commander, then the unified Stavka app. The hosted Maskirovka seat is optional and is not part of production deployment.
- `stavka.sands.red` is the only public application origin and must stay behind Cloudflare Access. Commander and inference keep `workers_dev: false` and `preview_urls: false` and are reached through service bindings.
- Local, manual, and live deployment commands remain explicit operator actions. Never run `pnpm run deploy:production` during repository-only verification.
- Configure the GitHub `production` environment with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The account-scoped token needs Workers Scripts Edit and Containers Edit; add KV, R2, or route permissions only if a future CI task provisions or manages those resources.
- A successful deployment proves upload and Wrangler configuration only. Do not claim post-deploy health until the Access-protected custom domain and private service path are probed. Worker secrets and provider credentials stay out of band.
- Roll back with `wrangler rollback` per service in reverse dependency order (unified app, Commander, inference), or an equivalent documented version rollback.

## Warbench studies

- Warbench is an operator-local CLI and must remain independent of Commander, protocol, Cloudflare, and provider implementations through the `@stavka/warbench-core` firewall.
- Use an owner-only data directory outside the repository. Never print or commit Codex access tokens, refresh tokens, account IDs, cookies, passwords, or MFA data.
- Full and smoke studies require an explicit exact model. Probe that exact model before candidate execution; never select the first provider model implicitly.
- Results are one-attempt immutable slots. Resume by skipping recorded slots; never delete, overwrite, selectively retry, or inspect partial held-out tactical outcomes.
- Run `pnpm warbench calibrate` before any live study. Calibration seeds and held-out seeds must remain disjoint.
- A final export requires a completed, digest-verified study. JSON, PDF, CSV, and Markdown must derive from the same canonical evidence object.

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
- Run `pnpm eval -- --replay` before commit. Replay misses fail without touching a network. Use record, `doctor --live`, live sergeants, metered API, live Warbench candidate runs, and deployment only as explicit operator actions.
