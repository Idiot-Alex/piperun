import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const PIPELINES_FILE = path.join(DATA_DIR, 'pipelines.json');
const RUNS_FILE = path.join(DATA_DIR, 'runs.json');
const LOGS_DIR = path.join(DATA_DIR, 'runs');
const DIST_DIR = path.join(__dirname, '..', 'dist');
const PORT = Number(process.env.PORT ?? 3001);

// Configurable allowed origins (comma-separated). Defaults to common local dev origins.
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://localhost:3001,http://127.0.0.1:5173,http://127.0.0.1:3001')
    .split(',').map(s => s.trim()).filter(Boolean)
);

// Optional API token for non-localhost access. If set, remote requests must supply
// "Authorization: Bearer <token>". Local (127.x / ::1) requests are always allowed.
const API_TOKEN = process.env.API_TOKEN ?? null;

// When running behind a reverse proxy (nginx, Caddy, etc.) the socket address is
// always the proxy's loopback IP, so isLocalRequest() would incorrectly return true
// for every request. Set TRUST_PROXY=true to disable the local auto-trust and require
// API_TOKEN for ALL connections, including those arriving from 127.0.0.1.
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

if (API_TOKEN && API_TOKEN.length < 32) {
  console.warn('[security] API_TOKEN is shorter than 32 characters; use a long random token for remote access.');
}
if (TRUST_PROXY && !API_TOKEN) {
  console.warn('[security] TRUST_PROXY=true without API_TOKEN will reject all non-public API and WebSocket requests.');
}

const PIPELINE_ID_RE = /^[a-f0-9]{16}$/;
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
};

// ── Storage ──────────────────────────────────────────────────────────────────
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(LOGS_DIR, { recursive: true });
if (!fs.existsSync(PIPELINES_FILE)) fs.writeFileSync(PIPELINES_FILE, '[]');
if (!fs.existsSync(RUNS_FILE)) fs.writeFileSync(RUNS_FILE, '[]');

function uid() {
  return randomBytes(8).toString('hex');
}

function readPipelines() {
  try {
    const data = JSON.parse(fs.readFileSync(PIPELINES_FILE, 'utf8'));
    // Migrate old flat steps[] format
    return data.map(p => {
      if (Array.isArray(p.steps) && !p.stages) {
        const { steps, ...rest } = p;
        return { ...rest, stages: [{ id: uid(), name: '默认阶段', steps }] };
      }
      return p;
    });
  } catch (e) {
    console.error('pipelines.json parse error, resetting:', e.message);
    writePipelines([]);
    return [];
  }
}

function writePipelines(list) {
  const tmp = PIPELINES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, PIPELINES_FILE);
}

// ── Write mutex ───────────────────────────────────────────────────────────────
// Prevents concurrent read-modify-write races on the JSON files.
// Node.js is single-threaded but async I/O can interleave awaited operations.
let writeLock = Promise.resolve();

function withLock(fn) {
  // Chain fn off the current lock. The lock itself is reset even on error
  // (so subsequent callers are never blocked), but the returned promise
  // propagates the error to THIS caller instead of silently resolving.
  const result = writeLock.then(fn);
  writeLock = result.catch(() => {});
  return result;
}

function readRuns() {
  try {
    return JSON.parse(fs.readFileSync(RUNS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function logReadRange(totalSize, tailBytes = 0, maxBytes = 50 * 1024 * 1024) {
  const readSize = Math.min(totalSize, tailBytes || maxBytes);
  const start = Math.max(0, totalSize - readSize);
  return { start, readSize, truncated: start > 0 };
}

function appendRun(run) {
  return withLock(() => {
    const runs = readRuns();
    runs.push(run);
    // Keep only the most recent 500 runs total
    const trimmed = runs.slice(-500);
    const tmp = RUNS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2));
    fs.renameSync(tmp, RUNS_FILE);
  });
}

async function appendRunSafely(run) {
  try {
    await appendRun(run);
  } catch (e) {
    console.error('append run failed:', e.message);
  }
}

function killChildProcessGroup(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* noop */ }
  }
}

function terminateChildProcessGroup(child) {
  killChildProcessGroup(child, 'SIGTERM');
  return setTimeout(() => killChildProcessGroup(child, 'SIGKILL'), 3000);
}

function sanitizePipeline(p) {
  return {
    id: p.id || uid(),
    name: String(p.name ?? '').slice(0, 200),
    description: String(p.description ?? '').slice(0, 500),
    env: (Array.isArray(p.env) ? p.env : []).map(e => ({
      key: String(e.key ?? '').slice(0, 200).replace(/[^A-Za-z0-9_]/g, ''),
      value: String(e.value ?? '').slice(0, 2000),
    })).filter(e => e.key),
    stages: (Array.isArray(p.stages) ? p.stages : []).map(stage => ({
      id: String(stage.id || uid()),
      name: String(stage.name ?? '').slice(0, 200),
      steps: (Array.isArray(stage.steps) ? stage.steps : []).map(step => ({
        id: String(step.id || uid()),
        name: String(step.name ?? '').slice(0, 200),
        command: String(step.command ?? '').slice(0, 50000),
        continueOnError: Boolean(step.continueOnError),
        timeout: (typeof step.timeout === 'number' && step.timeout > 0)
          ? Math.min(Math.floor(step.timeout), 86400) : undefined,
        retries: (typeof step.retries === 'number' && step.retries > 0)
          ? Math.min(Math.floor(step.retries), 10) : undefined,
      })),
    })),
    createdAt: p.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// Escape single quotes for use inside single-quoted printf strings
function sqEscape(str) {
  return str.replace(/'/g, "'\\''")
}

function envExportLine(key, value) {
  const escaped = sqEscape(value);
  return `export ${key}='${escaped}'`;
}

// ── Pipeline executor ────────────────────────────────────────────────────────
function buildBashScript(pipeline) {
  const { stages, env = [] } = pipeline;
  const lines = [
    'set -eo pipefail',
    'export FORCE_COLOR=1',
    // Helper: print current time in milliseconds (macOS + Linux compatible)
    '_ms() { python3 -c "import time; print(int(time.time()*1000))" 2>/dev/null || echo $(( $(date +%s) * 1000 )); }',
    // Helper: capture exported user var names (skip vars starting with _)
    '_capvars() { compgen -e | grep -v "^_" | sort 2>/dev/null || true; }',
    // Helper: run a command with a wall-clock timeout (pure bash, macOS compatible)
    '_with_timeout() { local _t=$1; shift; "$@" & local _p=$!; ( sleep "$_t" && kill -TERM "$_p" 2>/dev/null; sleep 3; kill -KILL "$_p" 2>/dev/null ) & local _k=$!; wait "$_p"; local _r=$?; kill "$_k" 2>/dev/null; wait "$_k" 2>/dev/null; return $_r; };',
    '',
  ];
  // Inject pipeline-level env vars
  if (env.length > 0) {
    lines.push('# ── Pipeline environment variables ──────────────────────────────');
    env.forEach(({ key, value }) => {
      lines.push(envExportLine(key, value));
    });
    lines.push('');
  }
  stages.forEach((stage, si) => {
    const stageName = sqEscape(stage.name || '未命名');
    lines.push(`printf '\\033[1;34m╔══ 阶段 ${si + 1}: %s ══╗\\033[0m\\n' '${stageName}'`);
    stage.steps.forEach((step, sj) => {
      const stepName = sqEscape(step.name || '未命名');
      lines.push(`printf '\\x01STEP_START:${si}:${sj}\\x01\\n'`);
      lines.push(`printf '\\033[0;36m── 步骤 ${sj + 1}: %s ──\\033[0m\\n' '${stepName}'`);
      const cmd = (step.command || '').trim();
      // Echo each line of the command in dim color before running
      if (cmd) {
        cmd.split('\n').forEach(line => {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#')) {
            lines.push(`printf '\\033[2m$ %s\\033[0m\\n' '${sqEscape(trimmed)}'`);
          }
        });
      }
      // Use a bash function (not a subshell) so that `export`ed variables
      // persist to subsequent steps and stages in the same shell process.
      const fnName = `_step_${si}_${sj}`;
      lines.push(`${fnName}() {`);
      lines.push('  set -e');
      if (cmd) {
        cmd.split('\n').forEach(l => lines.push('  ' + l));
      } else {
        lines.push('  true');
      }
      lines.push('}');
      lines.push('_step_t0=$(_ms)');
      lines.push('_vars_before=$(_capvars)');
      // If a per-step timeout is configured, run in a subshell via _with_timeout so
      // the parent process is not blocked. Note: exports from timed steps don't propagate.
      const call = (step.timeout > 0)
        ? `_with_timeout ${step.timeout} bash -c "$(declare -f ${fnName}); ${fnName}"`
        : fnName;
      // Retry loop: attempt up to (retries+1) times on failure
      const retries = step.retries > 0 ? step.retries : 0;
      if (retries > 0) {
        lines.push(`_retry_max=${retries}; _retry_n=0; _st=1`);
        lines.push(`while [ $_retry_n -le $_retry_max ]; do`);
        lines.push(`  [ $_retry_n -gt 0 ] && printf '\\033[33m[重试 %d/%d]\\033[0m\\n' $_retry_n $_retry_max`);
        lines.push(`  ${call} && _st=0 && break`);
        lines.push(`  _st=$?; _retry_n=$((_retry_n+1))`);
        lines.push(`done`);
      }
      if (step.continueOnError) {
        if (retries > 0) {
          lines.push('true'); // _st already set
        } else {
          lines.push(`${call} || true`);
        }
        lines.push('_step_dt=$(( $(_ms) - _step_t0 ))');
        lines.push(`printf "\\x01STEP_END:${si}:${sj}:0:$_step_dt\\x01\\n"`);
      } else {
        if (retries === 0) {
          lines.push('_st=0');
          lines.push(`${call} || _st=$?`);
        }
        lines.push('_step_dt=$(( $(_ms) - _step_t0 ))');
        lines.push(`printf "\\x01STEP_END:${si}:${sj}:$_st:$_step_dt\\x01\\n"`);
        lines.push('[ "$_st" -eq 0 ] || exit "$_st"');
      }
      // Emit new exported vars (compare before/after by name, look up values via python env)
      lines.push('_vars_after=$(_capvars)');
      lines.push('_vars_new=$(comm -13 <(echo "$_vars_before") <(echo "$_vars_after") 2>/dev/null || true)');
      lines.push('if [ -n "$_vars_new" ]; then');
      lines.push(`  _vars_json=$(echo "$_vars_new" | python3 -c "import sys,json,os; names=[n for n in sys.stdin.read().split() if n]; print(json.dumps({n:os.environ.get(n,'')[:200] for n in names},ensure_ascii=False))" 2>/dev/null || echo '{}')`);
      lines.push(`  printf "\\x01STEP_VARS:${si}:${sj}:$_vars_json\\x01\\n"`);
      lines.push('fi');
    });
    lines.push('');
  });
  return lines.join('\n');
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MB — prevents memory exhaustion from large payloads

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', c => {
      if (tooLarge) return; // stop accumulating after limit
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        // Drain the socket so the connection stays usable, then reject.
        // Calling req.destroy() would also destroy res (shared socket) and
        // prevent the caller from sending a 413 response.
        req.resume();
        const err = new Error('Request body too large');
        err.code = 'PAYLOAD_TOO_LARGE';
        reject(err);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, filePath) {
  if (!fs.existsSync(DIST_DIR)) {
    res.writeHead(404); res.end('dist/ not found – run npm run build');
    return;
  }
  const full = path.join(DIST_DIR, filePath);
  // Prevent path traversal
  if (!full.startsWith(DIST_DIR + path.sep) && full !== DIST_DIR) {
    res.writeHead(400); res.end(); return;
  }
  const target = fs.existsSync(full) && fs.statSync(full).isFile()
    ? full
    : path.join(DIST_DIR, 'index.html');
  const ext = path.extname(target);
  res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
  fs.createReadStream(target).pipe(res);
}

// ── HTTP server ──────────────────────────────────────────────────────────────
let runningPipelineId = null;

/** Returns true when the TCP connection originates from the loopback interface.
 *  Always returns false when TRUST_PROXY=true (reverse proxy deployment). */
function isLocalRequest(req) {
  if (TRUST_PROXY) return false;
  const addr = req.socket.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/** Constant-time token comparison to prevent timing attacks. */
function checkToken(provided) {
  if (!API_TOKEN) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(API_TOKEN);
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function wsAuthRequired(req) {
  return !isLocalRequest(req) && !!API_TOKEN;
}

function waitForWsAuth(ws, req, onAuthed) {
  if (!wsAuthRequired(req)) {
    onAuthed();
    return;
  }

  const timer = setTimeout(() => ws.close(1008, 'Auth timeout'), 10_000);
  ws.once('message', data => {
    clearTimeout(timer);
    try {
      const parsed = JSON.parse(data.toString());
      const token = String(parsed.token ?? '');
      if (parsed.type !== 'auth' || !checkToken(token)) {
        ws.close(1008, 'Unauthorized');
        return;
      }
      onAuthed();
    } catch {
      ws.close(1008, 'Invalid auth message');
    }
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  const { pathname } = url;

  // CORS — reflect origin only when it is in the allowlist
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // /api/ping — publicly accessible; lets the frontend detect whether auth is required
  // or remote access is disabled by configuration.
  if (pathname === '/api/ping' && req.method === 'GET') {
    const remote = !isLocalRequest(req);
    return json(res, 200, {
      authRequired: remote && !!API_TOKEN,
      remoteDisabled: remote && !API_TOKEN,
    });
  }

  // Auth guard — non-localhost API requests require a valid Bearer token
  if (pathname.startsWith('/api') && !isLocalRequest(req)) {
    if (!API_TOKEN) {
      return json(res, 403, { error: 'Remote access is disabled. Set API_TOKEN to enable.' });
    }
    const authHeader = req.headers['authorization'] ?? '';
    const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!checkToken(provided)) {
      return json(res, 401, { error: 'Unauthorized' });
    }
  }

  // ── REST API ──────────────────────────────────────────────────────────────
  if (pathname === '/api/runs' && req.method === 'GET') {
    const pipelineId = url.searchParams.get('pipeline');
    let runs = readRuns();
    if (pipelineId) {
      if (!PIPELINE_ID_RE.test(pipelineId)) return json(res, 400, { error: 'Invalid id' });
      runs = runs.filter(r => r.pipelineId === pipelineId);
    }
    // Return most recent 100 (already appended in order)
    return json(res, 200, runs.slice(-100).reverse());
  }

  if (pathname === '/api/runs' && req.method === 'DELETE') {
    const pipelineId = url.searchParams.get('pipeline');
    if (!pipelineId || !PIPELINE_ID_RE.test(pipelineId)) return json(res, 400, { error: 'Invalid id' });
    let toDelete = [];
    await withLock(() => {
      const all = readRuns();
      toDelete = all.filter(r => r.pipelineId === pipelineId);
      const remaining = all.filter(r => r.pipelineId !== pipelineId);
      const tmp = RUNS_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(remaining, null, 2));
      fs.renameSync(tmp, RUNS_FILE);
    });
    toDelete.forEach(r => {
      try { fs.rmSync(path.join(LOGS_DIR, `${r.id}.log`)); } catch { /* noop */ }
    });
    res.writeHead(204); res.end();
    return;
  }

  const runLogMatch = pathname.match(/^\/api\/runs\/([a-f0-9]{16})\/log$/);
  if (runLogMatch && req.method === 'GET') {
    // Apply the same auth guard as all other API endpoints
    if (!isLocalRequest(req)) {
      if (!API_TOKEN) return json(res, 403, { error: 'Remote access is disabled. Set API_TOKEN to enable.' });
      const authHeader = req.headers['authorization'] ?? '';
      const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (!checkToken(provided)) return json(res, 401, { error: 'Unauthorized' });
    }
    const runId = runLogMatch[1];
    const logPath = path.join(LOGS_DIR, `${runId}.log`);
    if (!fs.existsSync(logPath)) return json(res, 404, { error: 'Log not found' });
    const stat = fs.statSync(logPath);
    const MAX_LOG_BYTES = 50 * 1024 * 1024;
    const tailParam = Number(url.searchParams.get('tail') ?? 0);
    const tailBytes = Number.isFinite(tailParam) && tailParam > 0
      ? Math.min(Math.floor(tailParam), MAX_LOG_BYTES)
      : 0;
    const { start, readSize, truncated } = logReadRange(stat.size, tailBytes, MAX_LOG_BYTES);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': readSize,
      'X-Log-Truncated': truncated ? 'true' : 'false',
      'X-Log-Size': String(stat.size),
    });
    if (readSize === 0) { res.end(); return; }
    fs.createReadStream(logPath, { start, end: stat.size - 1 }).pipe(res);
    return;
  }

  const runDeleteMatch = pathname.match(/^\/api\/runs\/([a-f0-9]{16})$/);
  if (runDeleteMatch && req.method === 'DELETE') {
    const runId = runDeleteMatch[1];
    let found = false;
    await withLock(() => {
      const runs = readRuns();
      const idx = runs.findIndex(r => r.id === runId);
      if (idx === -1) return;
      runs.splice(idx, 1);
      const tmp = RUNS_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(runs, null, 2));
      fs.renameSync(tmp, RUNS_FILE);
      found = true;
    });
    if (!found) return json(res, 404, { error: 'Not found' });
    const logPath = path.join(LOGS_DIR, `${runId}.log`);
    try { fs.rmSync(logPath); } catch { /* file may not exist */ }
    res.writeHead(204); res.end();
    return;
  }

  if (pathname === '/api/pipelines' && req.method === 'GET') {
    const list = readPipelines();
    list.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    return json(res, 200, list);
  }

  if (pathname === '/api/pipelines' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); }
    catch (e) {
      if (e.code === 'PAYLOAD_TOO_LARGE') return json(res, 413, { error: 'Request body too large' });
      return json(res, 400, { error: 'Invalid JSON' });
    }
    const p = sanitizePipeline({ ...body, id: uid() });
    await withLock(() => {
      const list = readPipelines();
      list.push(p);
      writePipelines(list);
    });
    return json(res, 201, p);
  }

  const pipelineMatch = pathname.match(/^\/api\/pipelines\/([a-f0-9]{16})$/);
  if (pipelineMatch) {
    const id = pipelineMatch[1];

    if (req.method === 'GET') {
      const list = readPipelines();
      const p = list.find(p => p.id === id);
      if (!p) return json(res, 404, { error: 'Not found' });
      return json(res, 200, p);
    }
    if (req.method === 'PUT') {
      let body;
      try { body = await readBody(req); }
      catch (e) {
        if (e.code === 'PAYLOAD_TOO_LARGE') return json(res, 413, { error: 'Request body too large' });
        return json(res, 400, { error: 'Invalid JSON' });
      }
      let updated;
      await withLock(() => {
        const list = readPipelines();
        const idx = list.findIndex(p => p.id === id);
        if (idx === -1) { updated = null; return; }
        list[idx] = sanitizePipeline({ ...body, id, createdAt: list[idx].createdAt });
        updated = list[idx];
        writePipelines(list);
      });
      if (!updated) return json(res, 404, { error: 'Not found' });
      return json(res, 200, updated);
    }
    if (req.method === 'DELETE') {
      let found = false;
      await withLock(() => {
        const list = readPipelines();
        const idx = list.findIndex(p => p.id === id);
        if (idx === -1) return;
        list.splice(idx, 1);
        writePipelines(list);
        found = true;
      });
      if (!found) return json(res, 404, { error: 'Not found' });
      res.writeHead(204); res.end();
      return;
    }
  }

  // ── Static files (production) ─────────────────────────────────────────────
  if (!pathname.startsWith('/api')) {
    const rel = pathname === '/' ? '/index.html' : pathname;
    serveStatic(res, rel);
    return;
  }

  json(res, 404, { error: 'Not found' });
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

function handleSandbox(ws, req) {
  let child = null;
  let childExited = false;
  let timer = null;
  let killTimer = null;
  let cleanup = null;

  const waitForCommand = () => ws.once('message', (data) => {
    let cmd, cols = 120, rows = 30;
    try {
      const parsed = JSON.parse(data.toString());
      cmd = String(parsed.cmd ?? '').slice(0, 50000);
      cols = Math.max(40, Math.min(500, Number(parsed.cols) || 120));
      rows = Math.max(10, Math.min(100, Number(parsed.rows) || 30));
    } catch {
      ws.close(1008, 'Invalid message');
      return;
    }

    if (!cmd.trim()) {
      ws.send('\x1b[33m[空命令]\x1b[0m\r\n');
      ws.close();
      return;
    }

    // Create an isolated temp directory for this sandbox session
    const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piperun-sandbox-'));

    cleanup = () => {
      try { fs.rmSync(sandboxDir, { recursive: true, force: true }); } catch { /* noop */ }
    };

    // Safe env: strip HOME/USER so scripts can't easily target real user dirs
    const safeEnv = {
      PATH: process.env.PATH,
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      FORCE_COLOR: '1',
      TERM: 'xterm-256color',
      COLUMNS: String(cols),
      LINES: String(rows),
      TMPDIR: sandboxDir,
      HOME: sandboxDir,
    };

    child = spawn('bash', ['-c', cmd], {
      env: safeEnv,
      cwd: sandboxDir,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const send = (d) => { if (ws.readyState === 1) ws.send(d.toString()); };
    child.stdout.on('data', send);
    child.stderr.on('data', send);

    timer = setTimeout(() => {
      if (!childExited) killTimer = terminateChildProcessGroup(child);
      if (ws.readyState === 1) ws.send('\r\n\x1b[33m[超时：已强制终止 (60s)]\x1b[0m\r\n');
      ws.close();
    }, 60_000);

    child.on('close', code => {
      childExited = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      cleanup();
      const msg = code === 0
        ? '\r\n\x1b[32m✓ 完成 (退出码 0)\x1b[0m\r\n'
        : `\r\n\x1b[31m✗ 退出码: ${code}\x1b[0m\r\n`;
      if (ws.readyState === 1) ws.send(msg);
      ws.close();
    });
  });

  waitForWsAuth(ws, req, waitForCommand);

  ws.on('close', () => {
    clearTimeout(timer);
    if (!childExited && !killTimer) killTimer = terminateChildProcessGroup(child);
    cleanup?.();
  });
}

server.on('upgrade', (req, socket, head) => {
  // Reject WebSocket connections from non-local origins to prevent CSRF attacks
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  // Auth guard for non-localhost WebSocket connections
  const wsUrl = new URL(req.url, 'http://localhost');
  if (!isLocalRequest(req)) {
    if (!API_TOKEN) {
      socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
  }
  if (wsUrl.pathname === '/pty') {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else if (wsUrl.pathname === '/sandbox') {
    wss.handleUpgrade(req, socket, head, ws => handleSandbox(ws, req));
  } else {
    socket.destroy();
  }
});

async function handlePty(ws, req) {
  const url = new URL(req.url, 'http://localhost');
  const pipelineId = url.searchParams.get('pipeline') ?? '';

  if (!PIPELINE_ID_RE.test(pipelineId)) {
    ws.close(1008, 'Invalid pipeline id');
    return;
  }

  const list = readPipelines();
  const pipeline = list.find(p => p.id === pipelineId);
  if (!pipeline) { ws.close(1008, 'Pipeline not found'); return; }

  const hasSteps = pipeline.stages?.some(s => s.steps?.length > 0);
  if (!hasSteps) {
    ws.send('\r\n\x1b[33m[无步骤，请先在编辑器中添加步骤]\x1b[0m\r\n');
    ws.close();
    // Record the attempt so it appears in history
    await appendRunSafely({
      id: uid(),
      pipelineId,
      pipelineName: pipeline.name,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      result: 'failed',
    });
    return;
  }

  if (runningPipelineId) {
    ws.send('\r\n\x1b[31m[另一条流水线正在运行，请稍后再试]\x1b[0m\r\n');
    ws.close();
    return;
  }

  runningPipelineId = pipelineId;
  const script = buildBashScript(pipeline);

  // Pre-generate runId so the log file can be opened before bash exits
  const runId = uid();
  const logPath = path.join(LOGS_DIR, `${runId}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: 'w' });
  let logEnded = false;

  const writeLog = (str) => {
    if (logEnded || logStream.destroyed || !logStream.writable) return;
    logStream.write(str);
  };

  const endLog = () => new Promise(resolve => {
    if (logEnded) { resolve(); return; }
    logEnded = true;
    if (logStream.closed || logStream.destroyed) { resolve(); return; }
    logStream.end(resolve);
  });

  // Wait for the initial RESIZE message so we know the terminal dimensions
  // before spawning bash. If no RESIZE arrives within 300ms, use defaults.
  let child = null;
  let childExited = false;
  let killTimer = null;
  let runStartedAt = null;
  let isTimeout = false;
  let clientClosed = false;
  const DEFAULT_COLS = 220;
  const DEFAULT_ROWS = 50;

  const startBash = (cols, rows) => {
    if (child) return;
    runStartedAt = new Date().toISOString();
    child = spawn('bash', ['-s'], {
      env: {
        ...process.env,
        FORCE_COLOR: '1',
        TERM: 'xterm-256color',
        COLUMNS: String(cols),
        LINES: String(rows),
      },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const send = (data) => {
      const str = data.toString();
      if (ws.readyState === 1) ws.send(str);
      writeLog(str);
    };

    child.stdout.on('data', send);
    child.stderr.on('data', send);

    child.on('close', async code => {
      childExited = true;
      clearTimeout(runTimeout);
      clearTimeout(killTimer);
      if (runningPipelineId === pipelineId) runningPipelineId = null;
      const finishedAt = new Date().toISOString();
      const durationMs = runStartedAt ? Date.now() - new Date(runStartedAt).getTime() : 0;
      const result = clientClosed ? 'stopped' : (isTimeout ? 'timeout' : (code === 0 ? 'success' : 'failed'));
      const marker = `\x01RUN_END:${result}\x01\n`;
      writeLog(marker);
      if (ws.readyState === 1) ws.send(marker);
      await endLog();
      await appendRunSafely({
        id: runId,
        pipelineId,
        pipelineName: pipeline.name,
        startedAt: runStartedAt,
        finishedAt,
        durationMs,
        result,
      });
      const msg = code === 0
        ? '\r\n\x1b[32m✓ 执行完成\x1b[0m\r\n'
        : `\r\n\x1b[31m✗ 退出码: ${code}\x1b[0m\r\n`;
      if (ws.readyState === 1) ws.send(msg);
      ws.close();
    });

    child.stdin.write(script);
    child.stdin.end();
  };

  const startTimer = setTimeout(() => startBash(DEFAULT_COLS, DEFAULT_ROWS), 300);

  const MAX_RUNTIME_MS = 30 * 60 * 1000; // 30 minutes
  const runTimeout = setTimeout(() => {
    isTimeout = true;
    if (!childExited && !killTimer) killTimer = terminateChildProcessGroup(child);
    if (ws.readyState === 1) {
      ws.send('\r\n\x1b[33m[超时：已强制终止 (30min)]\x1b[0m\r\n');
    }
  }, MAX_RUNTIME_MS);

  ws.on('message', (data) => {
    const str = data.toString();
    const m = str.match(/^\x1b\[RESIZE:(\d+);(\d+)\]$/);
    if (m) {
      const cols = Math.max(40, +m[1]);
      const rows = Math.max(10, +m[2]);
      if (!child) {
        clearTimeout(startTimer);
        startBash(cols, rows);
      }
    }
  });

  ws.on('close', () => {
    clearTimeout(runTimeout);
    clearTimeout(startTimer);
    if (child && !childExited) {
      clientClosed = true;
      if (!killTimer) killTimer = terminateChildProcessGroup(child);
      return;
    }
    if (runningPipelineId === pipelineId) runningPipelineId = null;
    void endLog();
  });
}

wss.on('connection', (ws, req) => {
  waitForWsAuth(ws, req, () => void handlePty(ws, req));
});

export {
  buildBashScript,
  sanitizePipeline,
  envExportLine,
  logReadRange,
  sqEscape,
  server,
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => {
    console.log(`server listening on http://localhost:${PORT}`);
  });
}
