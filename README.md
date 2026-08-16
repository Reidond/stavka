# Warbench

Independent benchmark for the core Stavka hypothesis: **does an LLM commander materially outperform a deterministic rule commander on repeatable battlefield scenarios?**

Warbench intentionally has no dependency on Stavka, Arma Reforger, Commander, Maskirovka, or Cloudflare Durable Objects from the Stavka repository.

## Stack

- Effect 4 for domain effects, errors, services, concurrency, and validation
- Vite+ for workspace tooling, tests, linting, formatting, and builds
- Cloudflare Workers + D1 for the hosted experiment dashboard and result store
- `@earendil-works/pi-ai` as the low-level model/provider layer
- ChatGPT Codex subscription authentication through OpenAI's device-code OAuth flow, with Pi used for refresh/model execution

## Hypothesis gate

The LLM candidate only passes when evaluated on held-out seeded scenarios against the same rule baseline:

- mean normalized score improves by at least 5%
- win rate improves by at least 5 percentage points
- invalid decision rate is at most 2%
- p95 decision latency is at most 5 seconds
- no scenario family regresses by more than 10%

Until a live Codex arm satisfies all gates, the conclusion is **INCONCLUSIVE**, never PASS.

## Product flow

1. Open the hosted Warbench dashboard.
2. Connect ChatGPT/Codex.
3. Warbench starts a device-code OAuth authorization and displays the OpenAI verification URL/code.
4. After authorization, credentials are stored server-side and refreshable.
5. Run deterministic rule-vs-rule controls.
6. Run Codex-vs-rule experiments on exactly the same seeds.
7. Warbench computes the acceptance gate and produces a report.

## Development

```bash
vp install
vp check
vp test --run
vp build
vp exec wrangler dev
```

## Deployment

GitHub Actions verifies every push/PR. A successful `main` verification deploys the Worker when these repository secrets are present:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

The initial implementation is deliberately small. Battlefield fidelity grows only when it is needed to distinguish model capability from the rule baseline.
