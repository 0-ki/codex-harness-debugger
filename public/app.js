const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const state = {
  sessions: [], current: null, es: null, model: new SessionModel(),
  cursor: -1, playing: false, selected: null, tab: 'detail', newest: null,
  turnEls: new Map(), nodeEls: [],
};

// ---------- sessions ----------
async function loadSessions() {
  const r = await fetch('/api/sessions').then(r => r.json()).catch(() => null);
  if (!r) return setLive('off');
  state.sessions = r.sessions;
  document.body.classList.toggle('demo', !!r.demo);
  state.src = r.codexSrc;
  renderSessions();
  const newest = r.sessions[0]?.id;
  if (!state.current && newest) open(newest);
  else if ($('#follow').checked && newest && state.newest && newest !== state.newest && state.current === state.newest) open(newest);
  state.newest = newest;
}

function renderSessions() {
  const q = $('#filter').value.toLowerCase();
  $('#sessionList').innerHTML = state.sessions
    .filter(s => !q || (s.title + s.cwd + s.id).toLowerCase().includes(q))
    .map(s => {
      const fresh = Date.now() - s.mtime < 60_000;
      return `<div class="sess ${s.id === state.current ? 'on' : ''}" data-id="${s.id}">
        <div class="t">${fresh ? '<span class="pulse"></span>' : ''}${esc(s.title || '(프롬프트 없음)')}</div>
        <div class="s">${esc(s.cwd.split(/[\\/]/).slice(-2).join('/'))} · ${new Date(s.mtime).toLocaleString()} · ${(s.size / 1024).toFixed(0)}KB${s.archived ? ' · archived' : ''}</div>
      </div>`;
    }).join('');
}

function open(id) {
  if (state.es) state.es.close();
  state.current = id; state.model = new SessionModel();
  state.cursor = -1; state.selected = null; state.turnEls = new Map(); state.nodeEls = [];
  $('#flow').innerHTML = '';
  renderSessions();
  setLive('loading');
  const es = new EventSource('/api/stream?id=' + encodeURIComponent(id));
  state.es = es;
  let ready = false;
  es.onmessage = e => {
    const lines = JSON.parse(e.data);
    const wasAtEnd = state.cursor >= state.model.nodes.length - 1;
    const before = state.model.nodes.length;
    for (const l of lines) state.model.ingest(l);
    for (let i = before; i < state.model.nodes.length; i++) renderNode(state.model.nodes[i]);
    if (!state.playing && (wasAtEnd || !ready) && $('#follow').checked) setCursor(state.model.nodes.length - 1, ready);
    else updateScrub();
    if (ready) flashLive();
    renderHeader();
    if (state.model.meta.cli !== state.shownCli) { state.shownCli = state.model.meta.cli; renderSrc(); }
  };
  es.addEventListener('ready', () => { ready = true; setLive('live'); if (state.cursor < 0) setCursor(state.model.nodes.length - 1); applyDeepLink(); });
  es.onerror = () => setLive('off');
}

// ---------- rendering ----------
const LANE_ORDER = ['user', 'model', 'harness', 'agent'];
const ICON = { user: '👤', reasoning: '💭', assistant: '💬', inference: '⚡', function_call: '🔧', custom_tool_call: '⌨', tool_output: '📤', spawn_agent: '🧬', agent_message: '✉', compacted: '🗜', task_started: '▶', task_complete: '■', turn_aborted: '⨯', context: '📎', session_meta: '◆', turn_context: '⚙', world_state: '🌐', settings: '⚙', token_count: '#', other: '·' };

function turnEl(t) {
  let el = state.turnEls.get(t);
  if (el) return el;
  el = document.createElement('div');
  el.className = 'turn';
  el.innerHTML = `<div class="turn-head"><span class="tn">Turn ${t.idx}</span><span class="tp"></span><span class="tstat"></span></div><div class="rows"></div>`;
  $('#flow').appendChild(el);
  state.turnEls.set(t, el);
  return el;
}

function renderNode(n) {
  const tEl = turnEl(n.turn);
  const row = document.createElement('div');
  row.className = `row lane-${n.lane}${n.noise ? ' noise' : ''}${n.boundary ? ' boundary' : ''}`;
  row.dataset.i = n.i;
  const col = LANE_ORDER.indexOf(n.lane);
  row.innerHTML = `<div class="node k-${n.kind}${n.pill ? ' pill' : ''}${n.hot ? ' hot' : ''}" style="grid-column:${col + 1}">
      <div class="nh"><span class="ic">${ICON[n.kind] || '·'}</span><span class="nt">${esc(n.title)}</span><span class="tm">${n.ts ? new Date(n.ts).toLocaleTimeString() : ''}</span></div>
      ${n.sub ? `<div class="ns">${esc(n.sub)}</div>` : ''}
      ${n.body ? '<div class="full"></div>' : ''}
    </div>`;
  const nodeEl = row.querySelector('.node');
  nodeEl.onclick = () => select(n);
  // hover shows the full body (filled lazily), leaving collapses it
  const full = nodeEl.querySelector('.full');
  if (full) {
    nodeEl.onmouseenter = () => { if (!full.textContent) full.textContent = String(n.body).slice(0, 50000); nodeEl.classList.add('expanded'); };
    nodeEl.onmouseleave = () => { nodeEl.classList.remove('expanded'); full.scrollTop = 0; };
  }
  if (n.callId) {
    row.onmouseenter = () => document.querySelectorAll(`[data-call="${CSS.escape(n.callId)}"]`).forEach(e => e.classList.add('pair'));
    row.onmouseleave = () => document.querySelectorAll('.pair').forEach(e => e.classList.remove('pair'));
    row.dataset.call = n.callId;
  }
  tEl.querySelector('.rows').appendChild(row);
  state.nodeEls[n.i] = row;
  // a tool result arriving updates the call row's timing text
  if (n.call) { const cr = state.nodeEls[n.call.i]; cr?.querySelector('.node').classList.add('resolved'); }
  updateTurnHead(n.turn);
}

function updateTurnHead(t) {
  const el = state.turnEls.get(t);
  el.querySelector('.tp').textContent = t.prompt ? t.prompt.replace(/\s+/g, ' ').slice(0, 120) : (t.id === 'pre' ? 'session setup' : '');
  const dur = t.start && t.end ? ((t.end - t.start) / 1000).toFixed(1) + 's' : t.status === 'running' && t.id !== 'pre' ? 'running…' : '';
  el.querySelector('.tstat').innerHTML = `<b>${t.inference}</b> LLM · <b>${t.tools}</b> tools · ${dur}`;
  el.classList.toggle('running', t.status === 'running' && t.id !== 'pre');
  el.classList.toggle('aborted', t.status === 'aborted');
}

function renderHeader() {
  const m = state.model.meta, s = state.model.stats;
  $('#meta').innerHTML = [m.model && `<b>${esc(m.model)}</b>`, m.effort && `effort ${esc(m.effort)}`, m.cli && `cli ${esc(m.cli)}`, m.cwd && esc(m.cwd)].filter(Boolean).join('<span class="sep">/</span>');
  const cacheRate = s.inTok ? Math.round(s.cachedTok / s.inTok * 100) : 0;
  $('#stats').innerHTML = [
    ['Turns', s.turns], ['LLM calls', s.inference], ['Tool calls', s.tools], ['Sub-agents', s.agents], ['Compactions', s.compactions],
    ['Input tok', fmt(s.inTok)], ['Cache hit', cacheRate + '%'], ['Output tok', fmt(s.outTok)], ['Reasoning tok', fmt(s.reasoningTok)],
  ].map(([k, v]) => `<div class="st"><span>${k}</span><b>${v}</b></div>`).join('');
}

// ---------- replay ----------
function setCursor(i, scroll = true) {
  state.cursor = Math.max(-1, Math.min(i, state.model.nodes.length - 1));
  for (let k = 0; k < state.nodeEls.length; k++) state.nodeEls[k]?.classList.toggle('future', k > state.cursor);
  for (const [t, el] of state.turnEls) el.classList.toggle('future', !t.nodes.length || t.nodes[0].i > state.cursor);
  state.nodeEls.forEach(e => e?.classList.remove('cur'));
  const cur = state.nodeEls[state.cursor];
  cur?.classList.add('cur');
  if (scroll && cur) cur.scrollIntoView({ block: 'nearest', behavior: state.playing ? 'smooth' : 'auto' });
  updateScrub();
  // context gauge reflects the most recent token_count at or before the cursor
  let ctx = null;
  for (let k = state.cursor; k >= 0; k--) if (state.model.nodes[k].ctx) { ctx = state.model.nodes[k].ctx; break; }
  const pct = ctx?.window ? Math.min(100, ctx.used / ctx.window * 100) : 0;
  $('#ctxBar').style.width = pct + '%';
  $('#ctxBar').className = pct > 80 ? 'hi' : pct > 50 ? 'mid' : '';
  $('#ctxText').textContent = ctx ? `${fmt(ctx.used)} / ${fmt(ctx.window)} (${pct.toFixed(0)}%)` : '–';
}

function updateScrub() {
  const n = state.model.nodes.length;
  $('#scrub').max = Math.max(0, n - 1);
  $('#scrub').value = state.cursor;
  $('#pos').textContent = `${state.cursor + 1} / ${n}`;
}

async function play() {
  if (state.playing) { state.playing = false; $('#play').textContent = '▶'; return; }
  state.playing = true; $('#play').textContent = '❚❚';
  $('#follow').checked = false;
  if (state.cursor >= state.model.nodes.length - 1) setCursor(-1);
  const hide = $('#showNoise').checked ? () => false : n => n.noise;
  while (state.playing && state.cursor < state.model.nodes.length - 1) {
    let next = state.cursor + 1;
    while (next < state.model.nodes.length - 1 && hide(state.model.nodes[next])) next++;
    const a = state.model.nodes[state.cursor]?.ts, b = state.model.nodes[next].ts;
    const speed = Number($('#speed').value);
    const gap = speed === 0 ? 0 : Math.min(1500, Math.max(120, ((b && a) ? b - a : 300) / speed));
    await new Promise(r => setTimeout(r, gap));
    if (!state.playing) break;
    setCursor(next);
    if (!state.selected || state.selected.kind !== 'user') select(state.model.nodes[next], true);
  }
  state.playing = false; $('#play').textContent = '▶';
}

// ---------- inspector ----------
function select(n, quiet) {
  state.selected = n;
  document.querySelectorAll('.node.sel').forEach(e => e.classList.remove('sel'));
  state.nodeEls[n.i]?.querySelector('.node').classList.add('sel');
  if (!quiet) setCursor(Math.max(state.cursor, n.i), false);
  renderInspector();
}

function prov(kind) {
  return { observed: '<span class="prov obs" title="rollout 로그에 실제로 기록된 사실">OBSERVED</span>', source: '<span class="prov src" title="로컬 소스에서 문자열이 매칭된 위치">SOURCE</span>', inferred: '<span class="prov inf" title="이벤트 종류로부터 추정한 모듈. 실행 사실 아님">INFERRED</span>' }[kind];
}

function renderInspector() {
  const n = state.selected, body = $('#insBody');
  if (!n) return;
  if (state.tab === 'raw') { body.innerHTML = `<div class="ih">${prov('observed')} raw JSONL record #${n.i}</div><pre class="code">${esc(JSON.stringify(n.raw, null, 2).slice(0, 300000))}</pre>`; return; }
  if (state.tab === 'source') return renderSource(n);
  const pair = n.result || n.call;
  const t = n.turn;
  body.innerHTML = `
    <div class="ih">${prov('observed')}<span class="lanechip lane-${n.lane}">${n.lane}</span></div>
    <h3>${ICON[n.kind] || ''} ${esc(n.title)}</h3>
    <dl class="kv">
      <dt>time</dt><dd>${n.ts ? new Date(n.ts).toLocaleString() : '–'}</dd>
      <dt>turn</dt><dd>#${t.idx} · ${esc(t.id)}</dd>
      ${n.callId ? `<dt>call_id</dt><dd>${esc(n.callId)}</dd>` : ''}
      ${n.result?.dur != null ? `<dt>duration</dt><dd>${(n.result.dur / 1000).toFixed(2)}s (call → result)</dd>` : ''}
      ${n.dur != null ? `<dt>duration</dt><dd>${(n.dur / 1000).toFixed(2)}s (call → result)</dd>` : ''}
      ${t.start && n.ts ? `<dt>+turn</dt><dd>${((n.ts - t.start) / 1000).toFixed(2)}s since turn start</dd>` : ''}
    </dl>
    ${pair ? `<button class="jump" id="jumpPair">${n.result ? '→ 결과로 이동' : '← 호출로 이동'} (${esc(pair.title)})</button>` : ''}
    <div class="blabel">${esc(n.bodyLabel || 'content')}</div>
    <pre class="${n.lang ? 'code' : 'text'}">${esc(String(n.body ?? '').slice(0, 200000))}</pre>`;
  if (pair) $('#jumpPair').onclick = () => { select(pair); state.nodeEls[pair.i]?.scrollIntoView({ block: 'center', behavior: 'smooth' }); };
}

const srcCache = new Map();
async function renderSource(n) {
  const body = $('#insBody');
  const hint = MODULE_HINTS[n.kind] || MODULE_HINTS.other;
  const terms = [...hint.terms, n.toolName].filter(Boolean);
  body.innerHTML = `
    <div class="ih">${prov('inferred')}</div>
    <h3>추정 담당 모듈</h3>
    <p class="hint">${esc(hint.mod)}</p>
    <p class="muted">이 매핑은 이벤트 종류 기반 추정입니다. 실제로 해당 함수가 실행됐다는 증거가 아닙니다. 검색어: ${terms.map(t => `<code>${esc(t)}</code>`).join(' ')}</p>
    ${hint.path ? '<h3>추정 실행 경로</h3><ol class="chain" id="chain">' + hint.path.map(p => '<li><code>' + esc(p) + '</code> <span class="loc" data-n="' + esc(p) + '"></span></li>').join('') + '</ol>' : ''}
    <h3>문자열 매칭</h3>
    <div id="srcHits"><div class="muted">소스 검색 중…</div></div>`;
  const key = terms.join('|');
  let r = srcCache.get(key);
  if (!r) { r = await fetch('/api/source?q=' + encodeURIComponent(key)).then(r => r.json()); srcCache.set(key, r); }
  if (state.selected !== n || state.tab !== 'source') return;
  if (hint.path && r.enabled) {
    const d = await fetch('/api/defs?q=' + encodeURIComponent(hint.path.join('|'))).then(r => r.json());
    if (state.selected !== n || state.tab !== 'source') return;
    for (const def of d.defs) {
      const el = document.querySelector('#chain .loc[data-n="' + CSS.escape(def.name) + '"]');
      if (!el) continue;
      if (def.missing) { el.textContent = '(정의 못 찾음)'; continue; }
      el.innerHTML = prov('source') + ' ' + esc(def.file) + ':' + def.line;
      el.onclick = () => { const p = document.getElementById('defsnip'); p.innerHTML = '<div class="hf"><b>' + esc(def.file) + '</b>:' + def.line + '</div><pre class="code">' + def.snippet.split('\n').map((l, k) => '<span class="ln' + (def.start + k === def.line ? ' on' : '') + '">' + String(def.start + k).padStart(5) + '</span> ' + esc(l)).join('\n') + '</pre>'; };
    }
    document.getElementById('chain').insertAdjacentHTML('afterend', '<div id="defsnip"></div>');
  }
  const box = $('#srcHits');
  if (!r.enabled) {
    box.innerHTML = '<div class="callout">로컬 Codex 소스가 아직 없습니다. 상단 배너의 <b>가져오기</b> 버튼을 누르면 자동으로 받아옵니다. 받은 뒤에는 여기서 매칭된 Rust 코드(' + prov('source') + ')를 보여줍니다.</div>';
    return;
  }
  if (src.present && state.model.meta.cli && src.version !== state.model.meta.cli) box.insertAdjacentHTML('beforebegin', '<div class="warnline">⚠ 소스(' + esc(srcLabel()) + ')와 세션(v' + esc(state.model.meta.cli) + ') 버전이 다릅니다. 줄 번호가 어긋날 수 있습니다.</div>');
  if (!r.hits.length) { box.innerHTML = '<div class="muted">매칭 없음.</div>'; return; }
  box.innerHTML = r.hits.map(h => `
    <div class="hit"><div class="hf">${prov('source')} <b>${esc(h.file)}</b>:${h.line} <span class="muted">“${esc(h.term)}” · ${h.total}곳</span></div>
    <pre class="code">${h.snippet.split('\n').map((l, k) => `<span class="ln${h.start + k === h.line ? ' on' : ''}">${String(h.start + k).padStart(5)}</span> ${esc(l)}`).join('\n')}</pre></div>`).join('');
}

// ---------- deep link: ?node=<i>&tab=source&hover=<i> ----------
const params = new URLSearchParams(location.search);
let deepLinked = false;
async function applyDeepLink() {
  if (deepLinked || !params.toString()) return; deepLinked = true;
  await srcReady;
  if (params.has('tab')) document.querySelector('.tabs button[data-tab="' + params.get('tab') + '"]')?.click();
  const n = params.has('node') && state.model.nodes[Number(params.get('node'))];
  if (n) { select(n, true); state.nodeEls[n.i]?.scrollIntoView({ block: 'center' }); }
  const h = params.has('hover') && state.nodeEls[Number(params.get('hover'))]?.querySelector('.node');
  if (h) { h.onmouseenter(); h.onmouseleave = null; h.scrollIntoView({ block: 'center' }); }
}

// ---------- Codex source checkout ----------
// Compares the checkout's tag (rust-v<ver>) with the cli_version recorded in the open session.
let src = { present: false };
async function loadSrc() {
  src = await fetch('/api/src/status').then(r => r.json()).catch(() => ({ present: false }));
  renderSrc();
  if (src.running) setTimeout(loadSrc, 1500);
}

function srcLabel() {
  if (src.version) return 'v' + src.version;
  return 'main@' + (src.commit || '?') + (src.date ? ' (' + src.date.slice(0, 10) + ')' : '');
}

function renderSrc() {
  const cli = state.model.meta.cli;
  const pill = $('#srcPill'), banner = $('#srcBanner');
  $('#pullBtn').disabled = !!src.running;
  if (src.running) {
    pill.className = 'srcpill busy'; pill.textContent = 'source: syncing…';
    banner.innerHTML = '<div class="banner busy"><span class="spin"></span><div><b>Codex 소스 동기화 중</b><div class="muted">' + esc(src.log?.slice(-1)[0] || 'git…') + '</div></div></div>';
    return;
  }
  const btnV = cli ? '<button class="bbtn primary" data-sync="version" data-v="' + esc(cli) + '">이 세션 버전(v' + esc(cli) + ')으로 맞추기</button>' : '';
  const btnL = '<button class="bbtn" data-sync="latest">최신 main 가져오기</button>';
  const err = src.error ? '<div class="err">' + esc(src.error) + '</div>' : '';
  if (src.gitAvailable === false) {
    pill.className = 'srcpill warn'; pill.textContent = 'source: git 없음';
    banner.innerHTML = '<div class="banner warn"><span class="bi">!</span><div><b>git을 찾을 수 없습니다.</b> 소스 매핑을 쓰려면 git을 설치하고 서버를 다시 시작하세요. 로그 시각화는 그대로 동작합니다.</div></div>';
    return;
  }
  if (!src.present) {
    pill.className = 'srcpill off'; pill.textContent = 'source: 없음';
    banner.innerHTML = '<div class="banner info"><span class="bi">i</span><div><b>Codex 소스가 아직 없습니다.</b> Source 탭의 함수 위치 매핑에 필요합니다 (github.com/openai/codex, shallow clone 약 100MB).' + err + '<div class="bacts">' + btnV + btnL + '</div></div></div>';
    return;
  }
  const match = cli && src.version === cli;
  pill.className = 'srcpill ' + (match ? 'ok' : cli ? 'warn' : '');
  pill.textContent = 'source ' + srcLabel() + (match ? ' ✓' : cli ? ' ≠ v' + cli : '');
  pill.title = src.files + ' .rs files indexed';
  banner.innerHTML = (!cli || match) && !src.error ? '' :
    '<div class="banner warn"><span class="bi">!</span><div><b>소스 버전 불일치</b> 이 세션은 Codex <code>v' + esc(cli) + '</code>로 실행됐는데 로컬 소스는 <code>' + esc(srcLabel()) + '</code>입니다. 함수 위치·줄 번호가 실제 실행된 코드와 다를 수 있습니다.' + err + '<div class="bacts">' + btnV + btnL + '<button class="bbtn ghost" data-dismiss>닫기</button></div></div></div>';
}

async function startSync(mode, version) {
  await fetch('/api/src/sync?mode=' + mode + (version ? '&version=' + encodeURIComponent(version) : ''), { method: 'POST' });
  srcCache.clear();
  setTimeout(loadSrc, 300);
}

$('#srcBanner').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  if ('dismiss' in b.dataset) { $('#srcBanner').innerHTML = ''; return; }
  startSync(b.dataset.sync, b.dataset.v);
};
$('#pullBtn').onclick = () => startSync('latest');

// ---------- live indicator ----------
function setLive(s) {
  const el = $('#live');
  el.className = 'live ' + s;
  $('#liveText').textContent = { live: 'LIVE · watching', loading: 'loading…', off: 'disconnected', idle: 'idle' }[s];
}
let flashT;
function flashLive() { const el = $('#live'); el.classList.add('flash'); clearTimeout(flashT); flashT = setTimeout(() => el.classList.remove('flash'), 600); }

// ---------- wiring ----------
$('#sessionList').onclick = e => { const s = e.target.closest('.sess'); if (s) open(s.dataset.id); };
$('#filter').oninput = renderSessions;
$('#refresh').onclick = loadSessions;
$('#showNoise').onchange = e => $('#flow').classList.toggle('show-noise', e.target.checked);
$('#follow').onchange = e => { if (e.target.checked) setCursor(state.model.nodes.length - 1); };
$('#scrub').oninput = e => { $('#follow').checked = false; setCursor(Number(e.target.value)); const n = state.model.nodes[state.cursor]; if (n) select(n, true); };
$('#play').onclick = play;
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
  state.tab = b.dataset.tab; renderInspector();
});
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
  if (e.key === ' ') { e.preventDefault(); play(); }
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault(); $('#follow').checked = false;
    const d = e.key === 'ArrowRight' ? 1 : -1;
    let i = state.cursor + d;
    while (!$('#showNoise').checked && state.model.nodes[i]?.noise) i += d;
    setCursor(i); const n = state.model.nodes[state.cursor]; if (n) select(n, true);
  }
});

loadSessions();
const srcReady = loadSrc();
setInterval(loadSessions, 5000);
