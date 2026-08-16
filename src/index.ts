import { Effect } from "effect";
import { AuthVault, type Env } from "./auth-vault";
import { pollDeviceAuthorization, refreshCodexCredentials, startDeviceAuthorization } from "./codex-auth";

export { AuthVault };

const json = (body: unknown, init: ResponseInit = {}) =>
  Response.json(body, {
    ...init,
    headers: { "cache-control": "no-store", ...(init.headers ?? {}) },
  });

const safeEqual = (left: string, right: string): boolean => {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index]! ^ b[index]!;
  return diff === 0;
};

const requireAdmin = (request: Request, env: Env & { readonly WAR_BENCH_ADMIN_KEY?: string }): Response | undefined => {
  if (!env.WAR_BENCH_ADMIN_KEY) return json({ error: "WAR_BENCH_ADMIN_KEY is not configured" }, { status: 503 });
  const supplied = request.headers.get("x-warbench-admin-key") ?? "";
  return safeEqual(supplied, env.WAR_BENCH_ADMIN_KEY) ? undefined : json({ error: "unauthorized" }, { status: 401 });
};

const vault = (env: Env) => env.AUTH_VAULT.getByName("owner");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Warbench</title>
<style>
:root{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color-scheme:dark}body{margin:0;background:#0d1117;color:#e6edf3}main{max-width:920px;margin:0 auto;padding:48px 24px}.card{border:1px solid #30363d;border-radius:12px;padding:20px;margin:16px 0;background:#161b22}button,input{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #30363d;background:#0d1117;color:#e6edf3}button{cursor:pointer}.ok{color:#3fb950}.muted{color:#8b949e}code{color:#79c0ff}a{color:#58a6ff}</style>
</head>
<body><main>
<h1>Warbench</h1><p class="muted">Independent LLM commander hypothesis benchmark.</p>
<div class="card"><h2>Operator access</h2><input id="key" type="password" placeholder="WAR_BENCH_ADMIN_KEY"><button onclick="saveKey()">Use key</button></div>
<div class="card"><h2>Codex subscription</h2><p id="status">Checking…</p><button onclick="connect()">Connect ChatGPT</button> <button onclick="disconnect()">Disconnect</button><div id="device"></div></div>
<div class="card"><h2>Hypothesis</h2><p>Codex must beat the deterministic rule commander on held-out seeded scenarios: +5% mean score, +5pp win rate, ≤2% invalid decisions, p95 ≤5s, and no family regression worse than 10%.</p><p>Benchmark execution UI is the next implementation slice.</p></div>
<script>
let adminKey=sessionStorage.getItem('warbench-admin-key')||'';document.getElementById('key').value=adminKey;
function saveKey(){adminKey=document.getElementById('key').value;sessionStorage.setItem('warbench-admin-key',adminKey);status()}
async function api(path,init={}){const headers=new Headers(init.headers||{});headers.set('x-warbench-admin-key',adminKey);const r=await fetch(path,{...init,headers});const b=await r.json();if(!r.ok)throw new Error(b.error||JSON.stringify(b));return b}
async function status(){try{const s=await api('/api/auth/codex/status');document.getElementById('status').innerHTML=s.connected?'<span class="ok">Connected</span> '+(s.accountId||''):(s.pending?'Waiting for authorization…':'Not connected');if(s.pending)setTimeout(status,Math.max(2000,(s.intervalSeconds||5)*1000))}catch(e){document.getElementById('status').textContent=e.message}}
async function connect(){try{const a=await api('/api/auth/codex/start',{method:'POST'});document.getElementById('device').innerHTML='<p>Open <a target="_blank" href="'+a.verificationUri+'">'+a.verificationUri+'</a> and enter:</p><h2><code>'+a.userCode+'</code></h2>';status()}catch(e){alert(e.message)}}
async function disconnect(){await api('/api/auth/codex/disconnect',{method:'POST'});document.getElementById('device').innerHTML='';status()}
if(adminKey)status();else document.getElementById('status').textContent='Enter operator key first.';
</script>
</main></body></html>`;

export default {
  async fetch(request: Request, env: Env & { readonly WAR_BENCH_ADMIN_KEY?: string }): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return json({ ok: true, service: "warbench" });
    if (url.pathname === "/") return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });

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
      let credentials = await authVault.getCredentials();
      if (credentials && credentials.expires <= Date.now() + 60_000) {
        credentials = await Effect.runPromise(refreshCodexCredentials(credentials.refresh));
        await authVault.putCredentials(credentials);
      }
      if (credentials) return json({ connected: true, accountId: credentials.accountId, expires: credentials.expires });

      const pending = await authVault.getPending();
      if (!pending) return json({ connected: false, pending: false });
      const polled = await Effect.runPromise(pollDeviceAuthorization(pending.deviceAuthId, pending.userCode));
      if (polled.pending) return json({ connected: false, pending: true, intervalSeconds: pending.intervalSeconds });
      await authVault.putCredentials(polled.credentials);
      return json({ connected: true, accountId: polled.credentials.accountId, expires: polled.credentials.expires });
    }

    if (url.pathname === "/api/auth/codex/disconnect" && request.method === "POST") {
      await authVault.clearPending();
      await authVault.clearCredentials();
      return json({ ok: true });
    }

    return json({ error: "not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env & { readonly WAR_BENCH_ADMIN_KEY?: string }>;
