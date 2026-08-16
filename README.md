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

The Codex candidate is evaluated against the deterministic rule baseline on exactly the same held-out seeded scenarios. A final conclusion requires at least 10 seeds in each of three scenario families for both arms.

The result is `PASS` only when every gate holds:

- mean score improves by at least 5%;
- win rate improves by at least 5 percentage points;
- invalid decision rate is at most 2%;
- p95 decision latency is at most 5 seconds;
- no scenario family regresses by more than 10%.

Before the minimum sample is complete, the result is always **INCONCLUSIVE**.

## Product flow

1. Sign in to the hosted Warbench dashboard through Cloudflare Access.
2. Choose **Connect ChatGPT**.
3. Warbench starts OpenAI's Codex device authorization and displays the verification URL/code.
4. Complete ChatGPT authorization in the browser. Warbench encrypts the refreshable credentials at rest in its `AuthVault` Durable Object.
5. Run the rule baseline across the held-out seeds.
6. Run the Pi-backed Codex controller against the same states and rule opponent.
7. Warbench stores each result, computes the acceptance gates, and exposes a downloadable PDF evidence report.

Malformed or semantically illegal model decisions are counted as invalid. Warbench does not repair them before scoring.

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

The Worker is available only at `warbench.sands.red`; `workers.dev` and preview URLs are disabled, and Cloudflare Access protects the entire application.

See [`docs/DEPLOY.md`](docs/DEPLOY.md) for generation, deployment, Codex connection, study execution, and report instructions.

The simulator is deliberately small. Battlefield fidelity should grow only when the current world can no longer distinguish model capability from the deterministic baseline.
