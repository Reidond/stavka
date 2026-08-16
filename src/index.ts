import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { Effect } from "effect";
import { AuthVault, type Env } from "./auth-vault";
import {
  evaluateHypothesis,
  runCodexSeed,
  runRuleSeed,
  scenarioFamilies,
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

export { AuthVault, BenchmarkStore };

interface AppEnv extends Env {
  readonly BENCHMARK_STORE: DurableObjectNamespace<BenchmarkStore>;
  readonly WAR_BENCH_ADMIN_KEY?: string;
  readonly WAR_BENCH_CODEX_MODEL?: string;
}

const json = (body: unknown, init: ResponseInit = {}) =>
  Response.json(body, {
    ...init,
    headers: { "cache-control": "no-store", ...init.headers },
  });

const safeEqual = (left: string, right: string): boolean => {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index]! ^ b[index]!;
  return diff === 0;
};

const requireAdmin = (request: Request, env: AppEnv): Response | undefined => {
  if (!env.WAR_BENCH_ADMIN_KEY)
    return json({ error: "WAR_BENCH_ADMIN_KEY is not configured" }, { status: 503 });
  const supplied = request.headers.get("x-warbench-admin-key") ?? "";
  return safeEqual(supplied, env.WAR_BENCH_ADMIN_KEY)
    ? undefined
    : json({ error: "unauthorized" }, { status: 401 });
};

const vault = (env: AppEnv) => env.AUTH_VAULT.getByName("owner");
const resultsStore = (env: AppEnv) => env.BENCHMARK_STORE.getByName("primary");

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

const freshCredentials = async (env: AppEnv): Promise<CodexCredentials> => {
  const authVault = vault(env);
  const current = await authVault.getCredentials();
  if (!current) throw new Error("Codex is not connected");
  if (current.expires > Date.now() + 60_000) return current;
  const refreshed: CodexCredentials = await Effect.runPromise(
    refreshCodexCredentials(current.refresh),
  );
  await authVault.putCredentials(refreshed);
  return refreshed;
};

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Warbench</title>
<style>
:root{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color-scheme:dark}body{margin:0;background:#0d1117;color:#e6edf3}main{max-width:980px;margin:0 auto;padding:48px 24px}.card{border:1px solid #30363d;border-radius:12px;padding:20px;margin:16px 0;background:#161b22}button,input,select{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #30363d;background:#0d1117;color:#e6edf3}button{cursor:pointer}.ok{color:#3fb950}.bad{color:#f85149}.warn{color:#d29922}.muted{color:#8b949e}code{color:#79c0ff}a{color:#58a6ff}pre{white-space:pre-wrap;overflow-wrap:anywhere}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}</style>
</head>
<body><main>
<h1>Warbench</h1><p class="muted">Independent LLM commander hypothesis benchmark.</p>
<div class="card"><h2>Operator access</h2><div class="row"><input id="key" type="password" placeholder="WAR_BENCH_ADMIN_KEY"><button onclick="saveKey()">Use key</button></div></div>
<div class="card"><h2>Codex subscription</h2><p id="status">Checking…</p><div class="row"><button onclick="connect()">Connect ChatGPT</button><button onclick="disconnect()">Disconnect</button><select id="model"></select></div><div id="device"></div></div>
<div class="card"><h2>Study</h2><p>Final conclusion requires at least 10 held-out seeds in each of 3 scenario families for both controllers.</p><div class="row"><label>Seeds/family <input id="seeds" type="number" min="1" max="20" value="1" style="width:70px"></label><button onclick="runBaseline()">Run rule baseline</button><button onclick="runCodex()">Run Codex candidate</button><button onclick="clearResults()">Clear</button></div><p id="progress" class="muted"></p><pre id="result">No results yet.</pre></div>
<div class="card"><h2>Acceptance gates</h2><p>Mean score +5%; win rate +5 percentage points; invalid decisions ≤2%; p95 decision latency ≤5s; no scenario-family score regression worse than 10%.</p></div>
<script>
let adminKey=sessionStorage.getItem('warbench-admin-key')||'';document.getElementById('key').value=adminKey;
const families=['balanced','north-pressure','south-pressure'];
function saveKey(){adminKey=document.getElementById('key').value;sessionStorage.setItem('warbench-admin-key',adminKey);refreshAll()}
async function api(path,init={}){const headers=new Headers(init.headers||{});headers.set('x-warbench-admin-key',adminKey);if(init.body)headers.set('content-type','application/json');const r=await fetch(path,{...init,headers});const b=await r.json();if(!r.ok)throw new Error(b.error||JSON.stringify(b));return b}
async function status(){try{const s=await api('/api/auth/codex/status');document.getElementById('status').innerHTML=s.connected?'<span class="ok">Connected</span> '+(s.accountId||''):(s.pending?'<span class="warn">Waiting for authorization…</span>':'Not connected');if(s.pending)setTimeout(status,Math.max(2000,(s.intervalSeconds||5)*1000));if(s.connected)await models()}catch(e){document.getElementById('status').textContent=e.message}}
async function models(){const data=await api('/api/models/codex');const select=document.getElementById('model');select.innerHTML=data.models.map(m=>'<option value="'+m.id+'"'+(m.default?' selected':'')+'>'+m.id+'</option>').join('')}
async function connect(){try{const a=await api('/api/auth/codex/start',{method:'POST'});document.getElementById('device').innerHTML='<p>Open <a target="_blank" href="'+a.verificationUri+'">'+a.verificationUri+'</a> and enter:</p><h2><code>'+a.userCode+'</code></h2>';status()}catch(e){alert(e.message)}}
async function disconnect(){await api('/api/auth/codex/disconnect',{method:'POST'});document.getElementById('device').innerHTML='';status()}
function studyCount(){return Math.max(1,Math.min(20,Number(document.getElementById('seeds').value)||1))}
async function runArm(controller){const count=studyCount();const model=document.getElementById('model').value;let done=0;for(const family of families){for(let seed=1;seed<=count;seed++){document.getElementById('progress').textContent=controller+' '+family+' seed '+seed+' ('+(done+1)+'/'+(count*families.length)+')';await api('/api/benchmark/'+controller,{method:'POST',body:JSON.stringify({seed,family,model})});done++;await results()}}document.getElementById('progress').textContent='Completed '+controller+' arm.'}
async function runBaseline(){try{await runArm('baseline')}catch(e){document.getElementById('progress').textContent=e.message}}
async function runCodex(){try{await runArm('codex')}catch(e){document.getElementById('progress').textContent=e.message}}
async function results(){try{const r=await api('/api/benchmark/results');const statusClass=r.hypothesis.status==='PASS'?'ok':r.hypothesis.status==='FAIL'?'bad':'warn';document.getElementById('result').innerHTML='<span class="'+statusClass+'">'+r.hypothesis.status+'</span>\n'+JSON.stringify(r,null,2)}catch(e){document.getElementById('result').textContent=e.message}}
async function clearResults(){await api('/api/benchmark/results',{method:'DELETE'});results()}
async function refreshAll(){await Promise.all([status(),results()])}
if(adminKey)refreshAll();else document.getElementById('status').textContent='Enter operator key first.';
</script>
</main></body></html>`;

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") return json({ ok: true, service: "warbench" });
      if (url.pathname === "/")
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });

      if (url.pathname.startsWith("/api/")) {
        const denied = requireAdmin(request, env);
        if (denied) return denied;
      }

      const authVault = vault(env);

      if (url.pathname === "/api/auth/codex/start" && request.method === "POST") {
        const result = await Effect.runPromise(startDeviceAuthorization);
        await authVault.setPending({ ...result, createdAt: Date.now() });
        return json(result);
      }

      if (url.pathname === "/api/auth/codex/status" && request.method === "GET") {
        let credentials: CodexCredentials | undefined = await authVault.getCredentials();
        if (credentials && credentials.expires <= Date.now() + 60_000) {
          credentials = await freshCredentials(env);
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
        await resultsStore(env).put(result);
        return json(result);
      }

      if (url.pathname === "/api/benchmark/codex" && request.method === "POST") {
        const input = await readRunRequest(request);
        const credentials = await freshCredentials(env);
        const result = await Effect.runPromise(
          runCodexSeed(
            input.seed,
            input.family,
            credentials,
            input.model ?? env.WAR_BENCH_CODEX_MODEL,
          ),
        );
        await resultsStore(env).put(result);
        return json(result);
      }

      if (url.pathname === "/api/benchmark/results" && request.method === "GET") {
        const rows = await resultsStore(env).list();
        const baselineRows = rows.filter((row) => row.controller === "rule");
        const candidateRows = rows.filter((row) => row.controller === "codex");
        const baseline = summarize("rule", baselineRows);
        const candidate = candidateRows.length > 0 ? summarize("codex", candidateRows) : undefined;
        return json({ rows, hypothesis: evaluateHypothesis(baseline, candidate) });
      }

      if (url.pathname === "/api/benchmark/results" && request.method === "DELETE") {
        await resultsStore(env).clear();
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
