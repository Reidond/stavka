# Cloudflare development and CI

Use the deployed application at [stavka.sands.red](https://stavka.sands.red) for app development review, visual checks, provider tests, and integration acceptance. The same Cloudflare Access identity and private service bindings apply to every live check. Local app servers, local provider profiles, the standalone model gateway, and the local Playwright stack have been removed.

## Source and CI checks

Use Node 22 and pnpm 11.18.0. Install dependencies with `pnpm install --frozen-lockfile`.

| Command                               | Purpose                                                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `pnpm verify`                         | Lint/format, Tailwind, deterministic tests, typechecks/builds, replay, and in-process mock gateway smoke |
| `pnpm exec vp test --run <test-file>` | Focused CI behavior tests                                                                                |
| `pnpm eval -- --replay`               | Replay corpus verification with no provider invocation                                                   |

These checks do not launch a browser stack, create a local account, load subscription credentials, or deploy. Worker builds are dry runs. Container image validation stays part of the image build, with its smoke step running without network access. Test fixtures may synthesize identities and services in memory; they are not a supported application environment.

## Cloudflare acceptance

1. Finish the source and CI checks on the intended revision.
2. After deployment is explicitly authorized, use the production workflow or the documented operator command in [the deployment runbook](runbooks/deployment.md). Production deploys inference, Commander, then the unified app. Record the commit and service versions.
3. Open the custom domain through Cloudflare Access. Check Home, Simulations, Sessions, Models, Providers, Access, and Health at the relevant viewport sizes.
4. Verify private Commander/inference health and confirm anonymous HTTP and WebSocket upgrades are intercepted by Access.
5. When live model tests are authorized, run them from Models using the signed-in owner's provider accounts. Distinguish a cached response, a fresh provider response, and a successfully applied simulation command.
6. Exercise persistence, exports, provider lifecycle, and other integration behavior on Cloudflare when that behavior is in scope. Record errors and outcomes against the deployed version.

A passing CI run does not prove a deployed integration. A production page still on an earlier version does not verify uncommitted source. Existing gaps are tracked in [REMAINING_WORK.md](REMAINING_WORK.md).

Provider sign-in/provisioning and the independent Warbench CLI remain operator tools. This workflow change does not move or rewrite immutable study data. Arma/Workbench and dedicated-server validation remain separate.
