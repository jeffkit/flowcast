// dashboard/render.js — 把采集器的数据模型渲染成一个 self-contained HTML 文件。
//
// 设计：纯字符串拼接，零依赖、无 CDN、离线可看。数据通过 <script> 内嵌 JSON，
// 交互（筛选/搜索/选中/钻取）全用原生 JS 在浏览器里做——契合 flowcast「零运行时依赖」。
// 看板是只读快照：重跑 `flowcast dashboard` 才刷新（不轮询、不起服务）。

/** 把数据安全嵌进 <script>：闭合标签序列要转义，否则会提前结束 script。 */
function embedJson(data) {
  return JSON.stringify(data).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--')
}

/** 转义放进 HTML 属性的文本（标题里的 repo 路径等）。 */
function escapeAttr(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

/**
 * @param {object} model  collectRuns(...) 的返回值
 * @returns {string} 完整 HTML 文档
 */
export function renderHtml(model) {
  const json = embedJson(model)
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>flowcast dashboard · ${escapeAttr(model.repo ?? '')}</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <div class="brand">flowcast<span>dashboard</span></div>
  <div class="repo" id="repo"></div>
  <div class="gen" id="gen"></div>
</header>
<section class="stats" id="stats"></section>
<main>
  <aside class="list-pane">
    <div class="filters">
      <input type="search" id="search" placeholder="搜索 runId / feature…" autocomplete="off">
      <div class="chips" id="statusFilters"></div>
    </div>
    <div class="run-list" id="runList"></div>
  </aside>
  <article class="detail-pane" id="detail">
    <div class="empty">← 选择一个 run 查看详情</div>
  </article>
</main>
<script>
const MODEL = ${json};
${CLIENT_JS}
</script>
</body>
</html>`
}

const CSS = `
:root{
  --bg:#0f1115;--panel:#171a21;--panel2:#1e222b;--border:#2a2f3a;--text:#d6dae3;--muted:#8b93a3;
  --accent:#6ea8fe;--ok:#4ad991;--warn:#f5c451;--err:#f57272;--stale:#c084fc;--running:#5bc0de;
}
*{box-sizing:border-box}
body{margin:0;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--text)}
header{display:flex;align-items:baseline;gap:16px;padding:12px 20px;border-bottom:1px solid var(--border);background:var(--panel)}
.brand{font-weight:700;font-size:16px;letter-spacing:.5px}
.brand span{color:var(--accent);margin-left:6px;font-weight:500}
.repo{color:var(--muted);font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gen{color:var(--muted);font-size:11px}
.stats{display:flex;flex-wrap:wrap;gap:8px;padding:12px 20px;border-bottom:1px solid var(--border);background:var(--panel)}
.stat{background:var(--panel2);border:1px solid var(--border);border-radius:8px;padding:6px 12px;display:flex;gap:8px;align-items:baseline}
.stat b{font-size:16px}.stat span{color:var(--muted);font-size:11px}
main{display:flex;height:calc(100vh - 112px)}
.list-pane{width:360px;min-width:300px;border-right:1px solid var(--border);display:flex;flex-direction:column;background:var(--panel)}
.filters{padding:10px;border-bottom:1px solid var(--border)}
#search{width:100%;padding:7px 10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);outline:none}
#search:focus{border-color:var(--accent)}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.chip{cursor:pointer;user-select:none;padding:3px 9px;border-radius:12px;font-size:11px;border:1px solid var(--border);background:var(--panel2);color:var(--muted)}
.chip.on{color:var(--text);border-color:var(--accent)}
.run-list{overflow-y:auto;flex:1}
.run{padding:9px 12px;border-bottom:1px solid var(--border);cursor:pointer}
.run:hover{background:var(--panel2)}
.run.sel{background:var(--panel2);box-shadow:inset 3px 0 0 var(--accent)}
.run.child{padding-left:26px;background:rgba(0,0,0,.12)}
.run .rid{font-weight:600;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.run .meta{color:var(--muted);font-size:11px;display:flex;gap:8px;margin-top:2px;align-items:center;flex-wrap:wrap}
.badge{font-size:10px;padding:1px 7px;border-radius:10px;font-weight:600;white-space:nowrap}
.b-completed{background:rgba(74,217,145,.15);color:var(--ok)}
.b-running{background:rgba(91,192,222,.15);color:var(--running)}
.b-paused{background:rgba(245,196,81,.15);color:var(--warn)}
.b-stale{background:rgba(192,132,252,.16);color:var(--stale)}
.b-unknown,.b-other{background:rgba(139,147,163,.15);color:var(--muted)}
.dot{width:6px;height:6px;border-radius:50%;display:inline-block}
.detail-pane{flex:1;overflow-y:auto;padding:18px 22px}
.empty{color:var(--muted);text-align:center;margin-top:80px}
h2{margin:0 0 4px;font-size:18px;word-break:break-all}
.sub{color:var(--muted);font-size:12px;margin-bottom:14px}
.kv{display:flex;flex-wrap:wrap;gap:10px 22px;margin-bottom:16px}
.kv div span{color:var(--muted);font-size:11px;display:block}
.kv div b{font-weight:600}
.sig{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px}
.sigchip{background:var(--panel2);border:1px solid var(--border);border-radius:8px;padding:5px 10px;font-size:11px}
.sigchip b{font-size:14px;margin-right:5px}
.sigchip.warn b{color:var(--warn)}.sigchip.err b{color:var(--err)}.sigchip.ok b{color:var(--ok)}
.section-title{font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin:18px 0 8px;border-bottom:1px solid var(--border);padding-bottom:5px}
.timeline{display:flex;flex-direction:column;gap:3px}
.tl-row{display:grid;grid-template-columns:200px 1fr 70px;gap:8px;align-items:center;font-size:11px}
.tl-key{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)}
.tl-bar-wrap{background:var(--bg);border-radius:4px;height:14px;overflow:hidden;position:relative}
.tl-bar{height:100%;background:linear-gradient(90deg,var(--accent),#9b7dfb);border-radius:4px;min-width:2px}
.tl-bar.wait{background:var(--border);opacity:.6}
.tl-row.err .tl-key{color:var(--err)}
.tl-row.err .tl-bar{background:var(--err)}
.tl-row.skip .tl-key{color:var(--muted);font-style:italic}
.tl-row.skip .tl-bar{background:var(--muted);opacity:.35}
.tl-dur{text-align:right;color:var(--muted)}
.tl-model{color:var(--muted);font-size:10px;margin-left:6px;opacity:.8}
.tl-tok{display:block;font-size:9px;color:var(--accent);opacity:.75}
.tl-wait{display:block;font-size:9px;color:var(--muted);opacity:.6}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
.cell{background:var(--panel2);border:1px solid var(--border);border-radius:8px;padding:8px 10px;cursor:pointer}
.cell:hover{border-color:var(--accent)}
.cell .cn{font-size:11px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cell .cs{font-size:10px;margin-top:3px}
table.events{width:100%;border-collapse:collapse;font-size:11px}
table.events td,table.events th{text-align:left;padding:4px 8px;border-bottom:1px solid var(--border)}
table.events th{color:var(--muted);font-weight:500}
details{margin:6px 0;border:1px solid var(--border);border-radius:6px;background:var(--panel2)}
summary{cursor:pointer;padding:7px 10px;font-size:12px;font-weight:600}
pre{margin:0;padding:10px;overflow-x:auto;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg);color:#c9d1d9;max-height:340px;overflow-y:auto;border-top:1px solid var(--border)}
a.link{color:var(--accent);cursor:pointer;text-decoration:none}
`

// 浏览器端脚本：纯 DOM，无框架。
const CLIENT_JS = String.raw`
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s==null?'':s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmtDur = (ms) => ms==null?'-':(ms<1000?ms+'ms':ms<60000?(ms/1000).toFixed(1)+'s':(ms/60000).toFixed(1)+'m');
const fmtTok = (n) => (n==null||n===0)?'0':(n>=1e6?(n/1e6).toFixed(2)+'M':n>=1000?(n/1000).toFixed(1)+'k':String(n));
const fmtTime = (iso) => { if(!iso) return '-'; const d=new Date(iso); return isNaN(d)?'-':d.toLocaleString('zh-CN',{hour12:false}); };
const byId = Object.fromEntries(MODEL.runs.map(r=>[r.runId,r]));
let activeStatuses = new Set();
let search = '';
let selected = null;

function statusLabel(r){ return r.stale?'stale':r.status; }

function renderHeader(){
  $('repo').textContent = MODEL.repo;
  $('gen').textContent = '快照 ' + fmtTime(MODEL.generatedAt);
  const s = MODEL.stats;
  const items = [
    ['总计',s.total,''],['运行中',s.running,'running'],['僵尸',s.stale,'stale'],
    ['暂停',s.paused,'paused'],['完成',s.completed,'completed'],
    ['fallback',s.fallback,'warn'],['质量门红灯',s.gateFail,'err'],
    ...(s.skipped?[['续跑跳过',s.skipped,'']]:[]),
    ['Token',fmtTok(s.totalTokens),''],
  ];
  $('stats').innerHTML = items.map(([k,v,c])=>
    '<div class="stat"><b style="color:'+statColor(c)+'">'+v+'</b><span>'+k+'</span></div>').join('');
}
function statColor(c){return {running:'var(--running)',stale:'var(--stale)',paused:'var(--warn)',completed:'var(--ok)',warn:'var(--warn)',err:'var(--err)'}[c]||'var(--text)';}

function renderFilters(){
  const statuses = ['running','stale','paused','completed'];
  $('statusFilters').innerHTML = statuses.map(s=>
    '<span class="chip'+(activeStatuses.has(s)?' on':'')+'" data-s="'+s+'">'+s+'</span>').join('');
  $('statusFilters').querySelectorAll('.chip').forEach(c=>c.onclick=()=>{
    const s=c.dataset.s; activeStatuses.has(s)?activeStatuses.delete(s):activeStatuses.add(s); renderFilters(); renderList();
  });
}

function matchFilter(r){
  if(activeStatuses.size && !activeStatuses.has(statusLabel(r))) return false;
  if(search){ const q=search.toLowerCase(); return r.runId.toLowerCase().includes(q)||(r.feature||'').toLowerCase().includes(q); }
  return true;
}

function renderList(){
  // 树形：根在前，其子紧随。被筛掉的根仍显示其匹配的子（扁平兜底）。
  const roots = MODEL.runs.filter(r=>!r.parentId);
  const shown = new Set();
  let html='';
  const renderRun = (r,isChild)=>{
    shown.add(r.runId);
    const sl=statusLabel(r);
    html += '<div class="run'+(isChild?' child':'')+(selected===r.runId?' sel':'')+'" data-id="'+esc(r.runId)+'">'
      + '<div class="rid">'+esc(r.runId)+'</div>'
      + '<div class="meta"><span class="badge b-'+sl+'">'+sl+'</span>'
      + (r.feature?'<span>'+esc(r.feature)+'</span>':'')
      + '<span>'+r.completedCount+' steps'+(r.skippedCount?'<span style="color:var(--muted);font-size:10px"> +'+r.skippedCount+'↩</span>':'')+'</span>'
      + (r.signals.fallback?'<span title="fallback">↻'+r.signals.fallback+'</span>':'')
      + (r.signals.gateFail?'<span title="gate fail" style="color:var(--err)">✗gate</span>':'')
      + (r.children&&r.children.length?'<span>['+r.children.length+' 子]</span>':'')
      + '</div></div>';
  };
  for(const root of roots){
    const kids = (root.children||[]).map(id=>byId[id]).filter(Boolean);
    const rootMatch = matchFilter(root);
    const kidMatches = kids.filter(matchFilter);
    if(!rootMatch && kidMatches.length===0) continue;
    renderRun(root,false);
    for(const k of kids){ if(matchFilter(k)||rootMatch) renderRun(k,true); }
  }
  // 任何没被树覆盖的（孤儿）
  for(const r of MODEL.runs){ if(!shown.has(r.runId) && matchFilter(r)) renderRun(r,false); }
  $('runList').innerHTML = html || '<div class="empty" style="margin-top:30px">无匹配 run</div>';
  $('runList').querySelectorAll('.run').forEach(el=>el.onclick=()=>select(el.dataset.id));
}

function select(id){ selected=id; renderList(); renderDetail(byId[id]); location.hash=id; }

function renderDetail(r){
  if(!r){ $('detail').innerHTML='<div class="empty">未找到该 run</div>'; return; }
  const sl=statusLabel(r);
  let h = '<h2>'+esc(r.runId)+' <span class="badge b-'+sl+'">'+sl+'</span></h2>';
  h += '<div class="sub">'+esc(r.dir)+'</div>';
  if(r.stale) h+='<div class="sigchip err" style="margin-bottom:12px">⚠ 僵尸 run：status=running 但最近活动 '+fmtTime(r.lastActivity)+' 已超阈值，进程可能已崩溃/被 kill</div>';
  if(r.paused&&r.pauseReason) h+='<div class="sigchip warn" style="margin-bottom:12px">⏸ 暂停等人工：'+esc(r.pauseReason)+'</div>';

  const u = r.usage||{};
  const tokCell = u.hasTokens ? kv('Token (in/out)', fmtTok(u.inputTokens)+' / '+fmtTok(u.outputTokens)+' = '+fmtTok(u.totalTokens)) : '';
  const childTok = r.childUsage ? kv('子run Token 合计', fmtTok(r.childUsage.inputTokens)+' / '+fmtTok(r.childUsage.outputTokens)+' = '+fmtTok(r.childUsage.totalTokens)) : '';
  const modelCell = (r.models&&r.models.length) ? kv('模型', r.models.join(', ')) : '';
  h += '<div class="kv">'
    + kv('feature',r.feature||'-') + kv('开始',fmtTime(r.startedAt))
    + kv('耗时',fmtDur(r.durationMs)) + kv('最近活动',fmtTime(r.lastActivity))
    + kv('完成步骤',r.completedCount) + (r.currentStep?kv('当前步',r.currentStep):'')
    + modelCell + tokCell + childTok
    + '</div>';

  // 信号
  const sg=r.signals;
  const sigs=[];
  if(sg.fallback){
    const byScope=sg.fallbackByScope||{};
    const detail=Object.entries(byScope).map(([s,n])=>s+':'+n).join(' ');
    sigs.push('<span class="sigchip warn" title="'+esc(detail)+'"><b>'+sg.fallback+'</b>fallback</span>');
  }
  if(sg.gateFail) sigs.push('<span class="sigchip err"><b>'+sg.gateFail+'</b>质量门红灯</span>');
  if(sg.gatePass) sigs.push('<span class="sigchip ok"><b>'+sg.gatePass+'</b>质量门通过</span>');
  if(sg.fixRounds) sigs.push('<span class="sigchip warn"><b>'+sg.fixRounds+'</b>fix 轮</span>');
  if(sg.group.done||sg.group.failed) sigs.push('<span class="sigchip"><b>'+sg.group.done+'/'+(sg.group.done+sg.group.failed)+'</b>组完成</span>');
  if(sigs.length) h+='<div class="sig">'+sigs.join('')+'</div>';

  // 子 run 网格（drain 父）
  const kids=(r.children||[]).map(id=>byId[id]).filter(Boolean);
  if(kids.length){
    h+='<div class="section-title">子 run（'+kids.length+'）</div><div class="grid">';
    for(const k of kids){ const ks=statusLabel(k);
      h+='<div class="cell" data-id="'+esc(k.runId)+'"><div class="cn">'+esc(k.feature||k.runId)+'</div>'
       +'<div class="cs"><span class="badge b-'+ks+'">'+ks+'</span></div></div>';
    }
    h+='</div>';
  }

  // 步骤时间线
  const allSteps = r.steps||[];
  const skipped = r.skippedSteps||[];
  const errSteps = r.errorSteps||[];
  if(allSteps.length||skipped.length||errSteps.length){
    const max=Math.max(...allSteps.map(s=>s.durationMs||0),1);
    const totalLabel = allSteps.length+(skipped.length?' (续跑跳过 '+skipped.length+')':'');
    h+='<div class="section-title">步骤时间线（'+totalLabel+'）</div><div class="timeline">';
    for(const s of allSteps){
      const w=Math.max(2,Math.round((s.durationMs||0)/max*100));
      const tok=(s.inputTokens!=null||s.outputTokens!=null)?(fmtTok((s.inputTokens||0)+(s.outputTokens||0))+' tok'):'';
      const waitLabel = s.waitMs!=null && s.waitMs>100 ? 'wait '+fmtDur(s.waitMs) : '';
      const tip=esc(s.key)+(s.model?(' · '+s.model):'')+(tok?(' · '+tok):'')+(waitLabel?(' · '+waitLabel):'');
      h+='<div class="tl-row"><div class="tl-key" title="'+tip+'">'+esc(s.key)
        +(s.model?'<span class="tl-model">'+esc(s.model)+'</span>':'')+'</div>'
        +'<div class="tl-bar-wrap"><div class="tl-bar" style="width:'+w+'%"></div></div>'
        +'<div class="tl-dur">'+fmtDur(s.durationMs)
        +(tok?'<span class="tl-tok">'+tok+'</span>':'')
        +(waitLabel?'<span class="tl-wait">'+esc(waitLabel)+'</span>':'')
        +'</div></div>';
    }
    // 续跑跳过的步骤（灰显斜体）
    if(skipped.length){
      h+='<div style="margin-top:6px;font-size:10px;color:var(--muted)">↩ 续跑跳过（已完成）：</div>';
      for(const s of skipped){
        h+='<div class="tl-row skip"><div class="tl-key" title="skip: '+esc(s.key)+'">'+esc(s.key)+'</div>'
          +'<div class="tl-bar-wrap"><div class="tl-bar skip" style="width:15%"></div></div>'
          +'<div class="tl-dur">skip</div></div>';
      }
    }
    // 失败步
    for(const e of errSteps){
      h+='<div class="tl-row err" style="margin-top:4px"><div class="tl-key">✗ '+esc(e.key)+'</div>'
        +'<div style="color:var(--err);font-size:11px">'+esc(e.error||'error')+'</div><div></div></div>';
    }
    h+='</div>';
  }

  // 事件表
  if(r.events&&r.events.length){
    h+='<div class="section-title">事件（'+r.events.length+'）</div><table class="events"><tr><th>时间</th><th>事件</th><th>详情</th></tr>';
    for(const e of r.events){
      let d='';
      if(e.event==='fallback') d=esc(e.from)+' → '+esc(e.to)+' ('+esc(e.reason||'')+')';
      else if(e.event==='gate') d=esc(e.name)+' · '+esc(e.status)+(e.exitCode!=null?' exit '+e.exitCode:'');
      else if(e.event==='group') d=esc(e.name)+' · '+esc(e.status)+(e.reason?' ('+esc(e.reason)+')':'');
      else d=esc(JSON.stringify(e).slice(0,120));
      h+='<tr><td>'+fmtTime(e.ts)+'</td><td><b>'+esc(e.event)+'</b></td><td>'+d+'</td></tr>';
    }
    h+='</table>';
  }

  // 纯文本 .log 尾部（fanOut 子任务输出 / 失败根因）
  if(r.logs&&r.logs.length){
    h+='<div class="section-title">日志尾部（'+r.logs.length+'）</div>';
    for(const lg of r.logs){
      h+='<details><summary>'+esc(lg.name)+'</summary><pre>'+esc(lg.tail)+'</pre></details>';
    }
  }

  $('detail').innerHTML=h;
  $('detail').querySelectorAll('.cell').forEach(el=>el.onclick=()=>select(el.dataset.id));
}
function kv(k,v){return '<div><span>'+esc(k)+'</span><b>'+esc(v)+'</b></div>';}

$('search').addEventListener('input',e=>{search=e.target.value;renderList();});
renderHeader(); renderFilters(); renderList();
const initial = location.hash.slice(1);
if(initial && byId[initial]) select(initial);
`
