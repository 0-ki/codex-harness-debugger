// Codex Harness Debugger — zero-dependency Node server.
// Reads ~/.codex/sessions/**/rollout-*.jsonl read-only, streams new lines over SSE,
// and (optionally) greps a local Codex Rust checkout (CODEX_SRC) for source mapping.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { execFile } = require('child_process');

const args = process.argv.slice(2);
const DEMO = args.includes('--demo');
const PORT = Number(process.env.PORT || 4173);
const CODEX_HOME = DEMO ? path.join(__dirname, 'examples', 'demo-home') : process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const SESSION_DIRS = [path.join(CODEX_HOME, 'sessions'), path.join(CODEX_HOME, 'archived_sessions')];
// Local checkout of github.com/openai/codex. Default lives inside this project (git-ignored)
// so a fresh clone works with one click; CODEX_SRC can point at an existing checkout instead.
const SRC_REPO = path.resolve(process.env.CODEX_SRC || path.join(__dirname, '.codex-src'));
const SRC_URL = process.env.CODEX_SRC_URL || 'https://github.com/openai/codex.git';
const rsRoot = () => fs.existsSync(path.join(SRC_REPO, 'codex-rs')) ? path.join(SRC_REPO, 'codex-rs') : SRC_REPO;
const PUBLIC = path.join(__dirname, 'public');

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/^rollout-.*\.jsonl$/.test(e.name)) out.push(p);
  }
  return out;
}

function idFromFile(f) { return path.basename(f, '.jsonl').replace(/^rollout-/, ''); }

let fileIndex = new Map();
function listSessions() {
  fileIndex = new Map();
  const items = [];
  for (const d of SESSION_DIRS) {
    for (const f of walk(d)) {
      const st = fs.statSync(f);
      const id = idFromFile(f);
      fileIndex.set(id, f);
      items.push({ id, archived: f.startsWith(SESSION_DIRS[1]), size: st.size, mtime: st.mtimeMs, ...peek(f) });
    }
  }
  return items.sort((a, b) => b.mtime - a.mtime);
}

// Read only the head of the file to find cwd + first user prompt for the sidebar.
function peek(f) {
  const info = { cwd: '', title: '' };
  try {
    const fd = fs.openSync(f, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const line of buf.slice(0, n).toString('utf8').split('\n')) {
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type === 'session_meta') info.cwd = o.payload?.cwd || '';
      const it = o.payload?.item;
      if (o.payload?.type === 'item_completed' && it?.type === 'UserMessage') {
        info.title = (it.content || []).map(c => c.text || '').join(' ').slice(0, 120);
        break;
      }
    }
  } catch {}
  return info;
}

function resolve(id) {
  if (!fileIndex.has(id)) listSessions();
  return fileIndex.get(id);
}

// ---------- source index (optional) ----------
let srcIndex = null;
function buildSrcIndex() {
  const CODEX_SRC = rsRoot();
  if (!fs.existsSync(CODEX_SRC)) return null;
  const files = [];
  (function w(d) {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (e.name === 'target' || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'tests') w(p); }
      else if (e.name.endsWith('.rs') && !/_tests?\.rs$|^tests\.rs$/.test(e.name)) files.push(p);
    }
  })(CODEX_SRC);
  const docs = files.map(f => ({ f: path.relative(CODEX_SRC, f).replace(/\\/g, '/'), text: fs.readFileSync(f, 'utf8') }));
  for (const d of docs) d.lines = d.text.split('\n').map(l => l.replace(/\r$/, ''));
  console.log(`source index: ${docs.length} .rs files`);
  return docs.length ? docs : null;
}

// ---------- source checkout sync (git) ----------
const sync = { running: false, log: [], error: null };

function git(argv, cwd) {
  // longpaths: codex-rs has deep paths that exceed MAX_PATH on Windows checkouts
  return new Promise((ok, fail) => execFile('git', ['-c', 'core.longpaths=true', ...argv], { cwd, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
    sync.log.push(`$ git ${argv.join(' ')}`);
    if (stderr.trim()) sync.log.push(stderr.trim().split('\n').slice(-3).join('\n'));
    err ? fail(new Error(stderr.trim() || err.message)) : ok(stdout.trim());
  }));
}
const gitQuiet = (argv, cwd) => new Promise(ok => execFile('git', argv, { cwd }, (err, out) => ok(err ? null : out.trim())));

async function srcStatus() {
  const present = fs.existsSync(path.join(SRC_REPO, '.git'));
  const st = { present, running: sync.running, log: sync.log.slice(-12), error: sync.error, gitAvailable: (await gitQuiet(['--version'])) !== null };
  if (!present) return st;
  // checkout created by `npm run sync` from another process while this server was running
  if (!srcIndex && !sync.running) srcIndex = buildSrcIndex();
  st.commit = await gitQuiet(['rev-parse', '--short', 'HEAD'], SRC_REPO);
  st.date = await gitQuiet(['log', '-1', '--format=%cI'], SRC_REPO);
  st.tag = await gitQuiet(['describe', '--tags', '--exact-match', 'HEAD'], SRC_REPO);
  st.version = st.tag?.startsWith('rust-v') ? st.tag.slice(6) : null;
  st.files = srcIndex?.length || 0;
  return st;
}

// mode: 'version' checks out tag rust-v<version>, 'latest' fetches main. Clones on first use.
async function runSync(mode, version) {
  if (sync.running) return;
  if (mode === 'version' && !/^[0-9A-Za-z.\-]+$/.test(version || '')) throw new Error('invalid version');
  const ref = mode === 'version' ? `rust-v${version}` : 'main';
  Object.assign(sync, { running: true, log: [], error: null });
  try {
    if (!fs.existsSync(path.join(SRC_REPO, '.git'))) {
      await git(['clone', '--depth', '1', '--branch', ref, SRC_URL, SRC_REPO]);
    } else if (mode === 'version') {
      await git(['fetch', '--depth', '1', 'origin', 'tag', ref], SRC_REPO);
      await git(['-c', 'advice.detachedHead=false', 'checkout', '-q', ref], SRC_REPO);
    } else {
      await git(['fetch', '--depth', '1', 'origin', 'main'], SRC_REPO);
      await git(['-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD'], SRC_REPO);
    }
    srcIndex = buildSrcIndex();
    sync.log.push(`indexed ${srcIndex?.length || 0} files`);
  } catch (e) {
    sync.error = e.message.split('\n').slice(-2).join(' ');
  } finally {
    sync.running = false;
  }
}


const escRe = t => [...t].map(c => '.*+?^${}()|[]'.includes(c) || c.charCodeAt(0) === 92 ? String.fromCharCode(92) + c : c).join('');
const rank = (f, line) => (/\b(fn|struct|enum|trait|impl)\b/.test(line) ? 0 : 2) + (f.startsWith('core/src') ? 0 : f.startsWith('protocol/') ? 1 : 2);

function snippet(d, i) {
  const start = Math.max(0, i - 3);
  return { file: d.f, line: i + 1, start: start + 1, snippet: d.lines.slice(start, i + 8).join('\n') };
}

// Literal grep for each term; at most 6 hits per term, definitions and core/src first.
function searchSource(terms) {
  if (!srcIndex) return { enabled: false, hits: [] };
  const hits = [];
  for (const term of terms) {
    const re = new RegExp(escRe(term));
    const found = [];
    for (const d of srcIndex) {
      for (let i = 0; i < d.lines.length; i++) if (re.test(d.lines[i])) found.push({ d, i, r: rank(d.f, d.lines[i]) });
    }
    found.sort((a, b) => a.r - b.r);
    // overlapping snippets from the same file add nothing; keep the first of each cluster
    const picked = [];
    for (const x of found) {
      if (picked.length === 6) break;
      if (!picked.some(y => y.d === x.d && Math.abs(y.i - x.i) < 8)) picked.push(x);
    }
    for (const x of picked) hits.push({ term, total: found.length, ...snippet(x.d, x.i) });
  }
  return { enabled: true, hits };
}

// Resolve symbol names to their definition site (fn / struct / enum / trait).
function findDefs(names) {
  if (!srcIndex) return { enabled: false, defs: [] };
  return { enabled: true, defs: names.map(name => {
    const [owner, fn] = name.includes('::') ? name.split('::') : [null, name];
    const re = new RegExp(`\\b(fn|struct|enum|trait)\\s+${escRe(fn)}\\b`);
    let best = null;
    for (const d of srcIndex) {
      for (let i = 0; i < d.lines.length; i++) {
        if (!re.test(d.lines[i])) continue;
        const r = (d.f.startsWith('core/src') ? 0 : 1) + (owner && !d.text.includes(owner) ? 2 : 0);
        if (!best || r < best.r) best = { r, ...snippet(d, i) };
      }
    }
    return { name, ...(best || { missing: true }) };
  }) };
}

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function json(res, obj, code = 200) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readLines(f, from = 0) {
  const st = fs.statSync(f);
  if (st.size <= from) return { lines: [], offset: from };
  const fd = fs.openSync(f, 'r');
  const buf = Buffer.alloc(st.size - from);
  fs.readSync(fd, buf, 0, buf.length, from);
  fs.closeSync(fd);
  // Only consume complete lines; a partial trailing line waits for the next poll.
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) return { lines: [], offset: from };
  const lines = buf.slice(0, lastNl).toString('utf8').split('\n').filter(Boolean);
  return { lines, offset: from + lastNl + 1 };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/api/sessions') return json(res, { demo: DEMO, sessions: listSessions() });
    if (p === '/api/src/status') return srcStatus().then(st => json(res, st));
    if (p === '/api/src/sync' && req.method === 'POST') {
      runSync(url.searchParams.get('mode'), url.searchParams.get('version')).catch(e => { sync.error = e.message; });
      return json(res, { started: true });
    }

    if (p === '/api/stream') {
      const f = resolve(url.searchParams.get('id'));
      if (!f) return json(res, { error: 'not found' }, 404);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      let offset = 0;
      const push = () => {
        let r;
        try { r = readLines(f, offset); } catch { return; }
        offset = r.offset;
        if (r.lines.length) res.write(`data: ${JSON.stringify(r.lines)}\n\n`);
      };
      push();
      res.write(`event: ready\ndata: {}\n\n`);
      const t = setInterval(push, 400);
      const ka = setInterval(() => res.write(': ka\n\n'), 15000);
      req.on('close', () => { clearInterval(t); clearInterval(ka); });
      return;
    }

    if (p === '/api/source') {
      const terms = (url.searchParams.get('q') || '').split('|').filter(Boolean);
      return json(res, searchSource(terms));
    }
    if (p === '/api/defs') return json(res, findDefs((url.searchParams.get('q') || '').split('|').filter(Boolean)));

    let fp = path.join(PUBLIC, p === '/' ? 'index.html' : p);
    if (!fp.startsWith(PUBLIC) || !fs.existsSync(fp)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(fp)] || 'application/octet-stream' });
    fs.createReadStream(fp).pipe(res);
  } catch (e) {
    json(res, { error: String(e) }, 500);
  }
});

srcIndex = buildSrcIndex();

// CLI: `node server.js --sync [version]` fetches the Codex source without starting the UI.
const syncAt = args.indexOf('--sync');
if (syncAt >= 0) {
  const v = args[syncAt + 1];
  runSync(v ? 'version' : 'latest', v).then(() => {
    console.log(sync.log.join('\n'));
    if (sync.error) { console.error(sync.error); process.exit(1); }
    process.exit(0);
  });
} else server.listen(PORT, '127.0.0.1', () => {
  console.log(`Codex Harness Debugger  http://localhost:${PORT}`);
  console.log(`sessions: ${SESSION_DIRS.join(', ')}`);
  if (DEMO) console.log('demo mode: bundled sample session');
  if (!srcIndex) console.log('Codex source not found yet: use the "소스 가져오기" button in the UI, or run: npm run sync');
});
