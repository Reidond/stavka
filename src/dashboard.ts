export const dashboardHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Warbench</title>
<style>
:root{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color-scheme:dark}body{margin:0;background:#0d1117;color:#e6edf3}main{max-width:980px;margin:0 auto;padding:48px 24px}.card{border:1px solid #30363d;border-radius:12px;padding:20px;margin:16px 0;background:#161b22}button,input,select{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #30363d;background:#0d1117;color:#e6edf3}button{cursor:pointer}.ok{color:#3fb950}.bad{color:#f85149}.warn{color:#d29922}.muted{color:#8b949e}code{color:#79c0ff}a{color:#58a6ff}pre{white-space:pre-wrap;overflow-wrap:anywhere}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}</style>
</head>
<body><main>
<h1>Warbench</h1><p class="muted">Independent LLM commander hypothesis benchmark.</p>
<div class="card"><h2>Codex subscription</h2><p id="status">Checking…</p><div class="row"><button onclick="connect()">Connect ChatGPT</button><button onclick="disconnect()">Disconnect</button><select id="model"></select></div><div id="device"></div></div>
<div class="card"><h2>Study</h2><p>Final conclusion requires at least 10 held-out seeds in each of 3 scenario families for both controllers.</p><div class="row"><label>Seeds/family <input id="seeds" type="number" min="1" max="20" value="1" style="width:70px"></label><button onclick="runBaseline()">Run rule baseline</button><button onclick="runCodex()">Run Codex candidate</button><button onclick="downloadReport()">PDF report</button><button onclick="clearResults()">Clear</button></div><p id="progress" class="muted"></p><pre id="result">No results yet.</pre></div>
<div class="card"><h2>Acceptance gates</h2><p>Mean score +5%; win rate +5 percentage points; invalid decisions ≤2%; p95 decision latency ≤5s; no scenario-family score regression worse than 10%.</p></div>
<script>
const families=['balanced','north-pressure','south-pressure'];
async function api(path,init={}){const headers=new Headers(init.headers||{});if(init.body)headers.set('content-type','application/json');const r=await fetch(path,{...init,headers});const b=await r.json();if(!r.ok)throw new Error(b.error||JSON.stringify(b));return b}
async function status(){try{const s=await api('/api/auth/codex/status');document.getElementById('status').innerHTML=s.connected?'<span class="ok">Connected</span> '+(s.accountId||''):(s.pending?'<span class="warn">Waiting for authorization…</span>':'Not connected');if(s.pending)setTimeout(status,Math.max(2000,(s.intervalSeconds||5)*1000));if(s.connected)await models()}catch(e){document.getElementById('status').textContent=e.message}}
async function models(){const data=await api('/api/models/codex');const select=document.getElementById('model');select.innerHTML=data.models.map(m=>'<option value="'+m.id+'"'+(m.default?' selected':'')+'>'+m.id+'</option>').join('')}
async function connect(){try{const a=await api('/api/auth/codex/start',{method:'POST'});document.getElementById('device').innerHTML='<p>Open <a target="_blank" href="'+a.verificationUri+'">'+a.verificationUri+'</a> and enter:</p><h2><code>'+a.userCode+'</code></h2>';status()}catch(e){alert(e.message)}}
async function disconnect(){await api('/api/auth/codex/disconnect',{method:'POST'});document.getElementById('device').innerHTML='';status()}
function studyCount(){return Math.max(1,Math.min(20,Number(document.getElementById('seeds').value)||1))}
async function runArm(controller){const count=studyCount();const model=document.getElementById('model').value;let done=0;for(const family of families){for(let seed=1;seed<=count;seed++){document.getElementById('progress').textContent=controller+' '+family+' seed '+seed+' ('+(done+1)+'/'+(count*families.length)+')';await api('/api/benchmark/'+controller,{method:'POST',body:JSON.stringify({seed,family,model})});done++;await results()}}document.getElementById('progress').textContent='Completed '+controller+' arm.'}
async function runBaseline(){try{await runArm('baseline')}catch(e){document.getElementById('progress').textContent=e.message}}
async function runCodex(){try{await runArm('codex')}catch(e){document.getElementById('progress').textContent=e.message}}
async function results(){try{const r=await api('/api/benchmark/results');const statusClass=r.hypothesis.status==='PASS'?'ok':r.hypothesis.status==='FAIL'?'bad':'warn';document.getElementById('result').innerHTML='<span class="'+statusClass+'">'+r.hypothesis.status+'</span>\\n'+JSON.stringify(r,null,2)}catch(e){document.getElementById('result').textContent=e.message}}
async function downloadReport(){const r=await fetch('/api/benchmark/report.pdf');if(!r.ok){alert(await r.text());return}const blob=await r.blob();const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='warbench-test-report.pdf';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
async function clearResults(){await api('/api/benchmark/results',{method:'DELETE'});results()}
async function refreshAll(){await Promise.all([status(),results()])}
refreshAll();
</script>
</main></body></html>`;
