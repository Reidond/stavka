import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { Effect } from "effect";
import { authorizeOwner, type OwnerAccessEnv } from "./access-control";
import { AuthVault, type Env } from "./auth-vault";
import {
  evaluateHypothesis,
  runCodexSeed,
  runRuleSeed,
  scenarioFamilies,
  scenarioFor,
  summarize,
  type ScenarioFamily,
} from "./benchmark";
import { BenchmarkStore } from "./benchmark-store";
import {
  pollDeviceAuthorization,
  refreshCodexCredentials,
  startDeviceAuthorization,
  type CodexCredentials,
} from "./codex-auth";
import { decideWithCodex } from "./codex-controller";
import { dashboardHtml } from "./dashboard";
import { renderHypothesisPdf } from "./pdf-report";

export { AuthVault, BenchmarkStore };

interface AppEnv extends Env, OwnerAccessEnv {
  readonly BENCHMARK_STORE: DurableObjectNamespace<BenchmarkStore>;
  readonly WAR_BENCH_CODEX_MODEL?: string;
}

const json = (body: unknown, init: ResponseInit = {}) =>
  Response.json(body, {
    ...init,
    headers: { "cache-control": "no-store", ...init.headers },
  });

const getVault = (env: AppEnv, objectName: string) => env.AUTH_VAULT.getByName(objectName);
const getResultsStore = (env: AppEnv, objectName: string) =>
  env.BENCHMARK_STORE.getByName(objectName);

const readRunRequest = async (
  request: Request,
): Promise<{ seed: number; family: ScenarioFamily; model?: string }> => {
  const body = (await request.json()) as Record<string, unknown>;
  const seed = Number(body.seed);
  const family = body.family;
  if (!Number.isSafeInteger(seed) || seed < 1 || seed > 1_000_000) {
    throw new Error("seed must be a positive safe integer");
  }
  if (typeof family !== "string" || !scenarioFamilies.includes(family as ScenarioFamily)) {
    throw new Error(`family must be one of ${scenarioFamilies.join(", ")}`);
  }
  return {
    seed,
    family: family as ScenarioFamily,
    ...(typeof body.model === "string" && body.model.trim() ? { model: body.model.trim() } : {}),
  };
};

const readOptionalModel = async (request: Request): Promise<string | undefined> => {
  const text = await request.text();
  if (!text.trim()) return undefined;
  const body = JSON.parse(text) as Record<string, unknown>;
  return typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
};

const freshCredentials = async (
  authVault: DurableObjectStub<AuthVault>,
): Promise<CodexCredentials> => {
  const current = await authVault.getCredentials();
  if (!current) throw new Error("Codex is not connected");
  if (!current.accountId) {
    throw new Error(
      "Stored Codex authorization has no ChatGPT account id; disconnect and reconnect",
    );
  }
  if (current.expires > Date.now() + 60_000) return current;
  const refreshed: CodexCredentials = await Effect.runPromise(
    refreshCodexCredentials(current.refresh, current.accountId),
  );
  await authVault.putCredentials(refreshed);
  return refreshed;
};

const hypothesisFromRows = async (benchmarkStore: DurableObjectStub<BenchmarkStore>) => {
  const rows = await benchmarkStore.list();
  const baselineRows = rows.filter((row) => row.controller === "rule");
  const candidateRows = rows.filter((row) => row.controller === "codex");
  const baseline = summarize("rule", baselineRows);
  const candidate = candidateRows.length > 0 ? summarize("codex", candidateRows) : undefined;
  return { rows, hypothesis: evaluateHypothesis(baseline, candidate) };
};

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") return json({ ok: true, service: "warbench" });

      const authorization = await authorizeOwner(ctx.access, env);
      if (!authorization.authorized) {
        if (authorization.reason === "misconfigured") {
          console.error(JSON.stringify({ message: "Warbench owner access is not configured" }));
        }
        return json({ error: "forbidden" }, { status: authorization.status });
      }

      const authVault = getVault(env, authorization.objectName);
      const benchmarkStore = getResultsStore(env, authorization.objectName);

      if (url.pathname === "/")
        return new Response(dashboardHtml, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });

      if (url.pathname === "/api/auth/codex/start" && request.method === "POST") {
        const result = await Effect.runPromise(startDeviceAuthorization);
        await authVault.setPending({ ...result, createdAt: Date.now() });
        return json(result);
      }

      if (url.pathname === "/api/auth/codex/status" && request.method === "GET") {
        let credentials: CodexCredentials | undefined = await authVault.getCredentials();
        if (credentials && !credentials.accountId) {
          return json({
            connected: false,
            pending: false,
            reauthorizationRequired: true,
            error: "Stored authorization has no ChatGPT account id; disconnect and reconnect",
          });
        }
        if (credentials && credentials.expires <= Date.now() + 60_000) {
          credentials = await freshCredentials(authVault);
        }
        if (credentials)
          return json({
            connected: true,
            accountId: credentials.accountId,
            expires: credentials.expires,
          });

        const pending = await authVault.getPending();
        if (!pending) return json({ connected: false, pending: false });
        const polled = await Effect.runPromise(
          pollDeviceAuthorization(pending.deviceAuthId, pending.userCode),
        );
        if (polled.pending)
          return json({
            connected: false,
            pending: true,
            intervalSeconds: pending.intervalSeconds,
          });
        await authVault.putCredentials(polled.credentials);
        return json({
          connected: true,
          accountId: polled.credentials.accountId,
          expires: polled.credentials.expires,
        });
      }

      if (url.pathname === "/api/auth/codex/disconnect" && request.method === "POST") {
        await authVault.clearPending();
        await authVault.clearCredentials();
        return json({ ok: true });
      }

      if (url.pathname === "/api/auth/codex/probe" && request.method === "POST") {
        const credentials = await freshCredentials(authVault);
        const requestedModel = await readOptionalModel(request);
        const result = await Effect.runPromise(
          Effect.result(
            decideWithCodex(
              scenarioFor(1, "balanced"),
              "blue",
              credentials,
              requestedModel ?? env.WAR_BENCH_CODEX_MODEL,
            ),
          ),
        );
        if (result._tag === "Failure") {
          return json(
            {
              ok: false,
              reason: result.failure.reason,
              error: result.failure.message,
              latencyMs: result.failure.latencyMs,
              model: result.failure.model,
            },
            { status: 502 },
          );
        }
        return json({
          ok: true,
          model: result.success.model,
          latencyMs: result.success.latencyMs,
          orderCount: result.success.decision.orders.length,
        });
      }

      if (url.pathname === "/api/models/codex" && request.method === "GET") {
        const models = openaiCodexProvider().getModels();
        const defaultModel =
          env.WAR_BENCH_CODEX_MODEL &&
          models.some((model) => model.id === env.WAR_BENCH_CODEX_MODEL)
            ? env.WAR_BENCH_CODEX_MODEL
            : models[0]?.id;
        return json({
          models: models.map((model) => ({ id: model.id, default: model.id === defaultModel })),
        });
      }

      if (url.pathname === "/api/benchmark/baseline" && request.method === "POST") {
        const input = await readRunRequest(request);
        const result = await Effect.runPromise(runRuleSeed(input.seed, input.family));
        await benchmarkStore.put(result);
        return json(result);
      }

      if (url.pathname === "/api/benchmark/codex" && request.method === "POST") {
        const input = await readRunRequest(request);
        const credentials = await freshCredentials(authVault);
        const result = await Effect.runPromise(
          runCodexSeed(
            input.seed,
            input.family,
            credentials,
            input.model ?? env.WAR_BENCH_CODEX_MODEL,
          ),
        );
        await benchmarkStore.put(result);
        return json(result);
      }

      if (url.pathname === "/api/benchmark/results" && request.method === "GET") {
        return json(await hypothesisFromRows(benchmarkStore));
      }

      if (url.pathname === "/api/benchmark/report.pdf" && request.method === "GET") {
        const { hypothesis } = await hypothesisFromRows(benchmarkStore);
        return new Response(renderHypothesisPdf(hypothesis), {
          headers: {
            "content-type": "application/pdf",
            "content-disposition": 'attachment; filename="warbench-test-report.pdf"',
            "cache-control": "no-store",
          },
        });
      }

      if (url.pathname === "/api/benchmark/results" && request.method === "DELETE") {
        await benchmarkStore.clear();
        return json({ ok: true });
      }

      return json({ error: "not found" }, { status: 404 });
    } catch (cause) {
      console.error("Warbench request failed", cause);
      return json(
        { error: cause instanceof Error ? cause.message : "request failed" },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<AppEnv>;
