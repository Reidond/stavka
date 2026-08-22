# Warbench

Independent benchmark for the core Stavka hypothesis: **does an LLM commander materially outperform a deterministic rule commander on repeatable battlefield scenarios?**

Warbench intentionally has no dependency on Stavka, Arma Reforger, Commander, Maskirovka, or any Stavka package.

## Stack

- Effect 4 for effects, typed errors, validation, and benchmark orchestration
- Vite+ for installation, formatting/linting, tests, and verification
- Cloudflare Workers with Durable Objects for the hosted dashboard, encrypted OAuth vault, and durable benchmark evidence
- `@earendil-works/pi-ai` as the low-level Codex subscription model/provider layer
- OpenAI Codex device-code OAuth for a fully hosted ChatGPT Plus/Pro connection with no local runner

## Independent hypothesis gate

The Codex candidate is evaluated against the deterministic rule baseline on exactly the same held-out seeded scenarios. A final conclusion requires at least 10 seeds in each of three scenario families for both arms, current-schema rows only, and at least one actual live model response in every family.

The result is `PASS` only when every gate holds:

- mean score improves by at least 5%;
- win rate improves by at least 5 percentage points;
- invalid model-decision rate is at most 2%;
- provider request-failure rate is at most 2%;
- p95 successful model-response latency is at most 5 seconds;
- no scenario family regresses by more than 10%.

Before the minimum sample and valid live-model evidence are complete, the result is always **INCONCLUSIVE**. Authentication, transport, timeout, and provider failures are reported separately and are never converted into tactical model failures.

## Product flow

1. Sign in to the hosted Warbench dashboard through Cloudflare Access.
2. Choose **Connect ChatGPT**.
3. Warbench starts OpenAI's Codex device authorization and displays the verification URL/code.
4. Complete ChatGPT authorization in the browser. Warbench encrypts the refreshable credentials at rest in an `AuthVault` Durable Object bound to the validated Cloudflare Access JWT `sub`.
5. Choose **Test Codex connection**. The candidate arm stays disabled until Pi receives and validates a real model response.
6. Clear evidence created under an older benchmark/integration protocol.
7. Run the rule baseline across the held-out seeds.
8. Run the Pi-backed Codex controller against the same states and rule opponent.
9. Warbench stores each result, computes the acceptance gates, and exposes a downloadable PDF evidence report.

Malformed or semantically illegal model decisions are counted as invalid. Warbench does not repair them before scoring. Provider request failures are counted independently and the report remains `INCONCLUSIVE` when no valid live-model evidence exists.

## Development

```bash
cp .dev.vars.example .dev.vars
vp install
vp check
vp exec tsc --noEmit
vp test --run
vp run build
vp exec wrangler dev
```

## Deployment

GitHub Actions verifies every pull request and `main` push. Production deployment requires these stable GitHub environment secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `WAR_BENCH_ENCRYPTION_KEY`
- `WAR_BENCH_OWNER_SUB`

The Worker is available only at `warbench.sands.red`; `workers.dev` and preview URLs are disabled. Cloudflare Access protects the entire application, and the Worker independently verifies the Access JWT signature, issuer, audience, token type, and owner `sub` before selecting per-user Durable Objects.

See [`docs/DEPLOY.md`](docs/DEPLOY.md) for generation, deployment, Codex connection, study execution, and report instructions.

The simulator is deliberately small. Battlefield fidelity should grow only when the current world can no longer distinguish model capability from the deterministic baseline.
