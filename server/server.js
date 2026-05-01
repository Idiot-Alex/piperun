import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const PIPELINES_FILE = path.join(DATA_DIR, 'pipelines.json');
const RUNS_FILE = path.join(DATA_DIR, 'runs.json');
const DIST_DIR = path.join(__dirname, '..', 'dist');
const PORT = Number(process.env.PORT ?? 3001);

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

function readRuns() {
  try {
    return JSON.parse(fs.readFileSync(RUNS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function appendRun(run) {
  const runs = readRuns();
  runs.push(run);
  // Keep only the most recent 500 runs total
  const trimmed = runs.slice(-500);
  const tmp = RUNS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2));
  fs.renameSync(tmp, RUNS_FILE);
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
      lines.push(`export ${key}=${sqEscape(value) ? `'${sqEscape(value)}'` : "''"}`);
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
      if (step.continueOnError) {
        lines.push(`${call} || true`);
        lines.push('_step_dt=$(( $(_ms) - _step_t0 ))');
        lines.push(`printf "\\x01STEP_END:${si}:${sj}:0:$_step_dt\\x01\\n"`);
      } else {
        lines.push('_st=0');
        lines.push(`${call} || _st=$?`);
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  const { pathname } = url;

  // CORS for dev proxy
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

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

  if (pathname === '/api/pipelines' && req.method === 'GET') {
    const list = readPipelines();
    list.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    return json(res, 200, list);
  }

  if (pathname === '/api/pipelines' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const p = sanitizePipeline({ ...body, id: uid() });
      const list = readPipelines();
      list.push(p);
      writePipelines(list);
      return json(res, 201, p);
    } catch { return json(res, 400, { error: 'Invalid JSON' }); }
  }

  const pipelineMatch = pathname.match(/^\/api\/pipelines\/([a-f0-9]{16})$/);
  if (pipelineMatch) {
    const id = pipelineMatch[1];
    const list = readPipelines();
    const idx = list.findIndex(p => p.id === id);

    if (req.method === 'GET') {
      if (idx === -1) return json(res, 404, { error: 'Not found' });
      return json(res, 200, list[idx]);
    }
    if (req.method === 'PUT') {
      if (idx === -1) return json(res, 404, { error: 'Not found' });
      try {
        const body = await readBody(req);
        list[idx] = sanitizePipeline({ ...body, id, createdAt: list[idx].createdAt });
        writePipelines(list);
        return json(res, 200, list[idx]);
      } catch { return json(res, 400, { error: 'Invalid JSON' }); }
    }
    if (req.method === 'DELETE') {
      if (idx === -1) return json(res, 404, { error: 'Not found' });
      list.splice(idx, 1);
      writePipelines(list);
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

function handleSandbox(ws) {
  let child = null;
  let timer = null;
  let cleanup = null;

  ws.once('message', (data) => {
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
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Keep stdin open — subsequent WS messages will be piped in

    const send = (d) => { if (ws.readyState === 1) ws.send(d.toString()); };
    child.stdout.on('data', send);
    child.stderr.on('data', send);

    // Pipe subsequent WebSocket messages (keystrokes) to bash stdin
    ws.on('message', (data) => {
      if (child && child.stdin.writable) {
        child.stdin.write(data.toString());
      }
    });

    timer = setTimeout(() => {
      try { child?.kill('SIGTERM'); } catch { /* noop */ }
      if (ws.readyState === 1) ws.send('\r\n\x1b[33m[超时：已强制终止 (60s)]\x1b[0m\r\n');
      ws.close();
    }, 60_000);

    child.on('close', code => {
      clearTimeout(timer);
      cleanup();
      const msg = code === 0
        ? '\r\n\x1b[32m✓ 完成 (退出码 0)\x1b[0m\r\n'
        : `\r\n\x1b[31m✗ 退出码: ${code}\x1b[0m\r\n`;
      if (ws.readyState === 1) ws.send(msg);
      ws.close();
    });
  });

  ws.on('close', () => {
    clearTimeout(timer);
    try { child?.kill('SIGTERM'); } catch { /* noop */ }
    cleanup?.();
  });
}

server.on('upgrade', (req, socket, head) => {
  // Reject WebSocket connections from non-local origins to prevent CSRF attacks
  const origin = req.headers.origin;
  const ALLOWED_ORIGINS = new Set(['http://localhost:5173', 'http://localhost:3001', 'http://127.0.0.1:5173', 'http://127.0.0.1:3001']);
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/pty') {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else if (url.pathname === '/sandbox') {
    wss.handleUpgrade(req, socket, head, ws => handleSandbox(ws));
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, req) => {
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
  if (!hasSteps) { ws.send('\r\n\x1b[33m[无步骤]\x1b[0m\r\n'); ws.close(); return; }

  if (runningPipelineId) {
    ws.send('\r\n\x1b[31m[另一条流水线正在运行，请稍后再试]\x1b[0m\r\n');
    ws.close();
    return;
  }

  runningPipelineId = pipelineId;
  const script = buildBashScript(pipeline);

  // Wait for the initial RESIZE message so we know the terminal dimensions
  // before spawning bash. If no RESIZE arrives within 300ms, use defaults.
  let child = null;
  let runStartedAt = null;
  let isTimeout = false;
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
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const send = (data) => {
      if (ws.readyState === 1) ws.send(data.toString());
    };

    child.stdout.on('data', send);
    child.stderr.on('data', send);

    child.on('close', code => {
      clearTimeout(runTimeout);
      runningPipelineId = null;
      const finishedAt = new Date().toISOString();
      const durationMs = runStartedAt ? Date.now() - new Date(runStartedAt).getTime() : 0;
      appendRun({
        id: uid(),
        pipelineId,
        pipelineName: pipeline.name,
        startedAt: runStartedAt,
        finishedAt,
        durationMs,
        result: isTimeout ? 'timeout' : (code === 0 ? 'success' : 'failed'),
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
    try { child?.kill('SIGTERM'); } catch { /* noop */ }
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
    if (runningPipelineId === pipelineId) runningPipelineId = null;
    try { child?.kill('SIGTERM'); } catch { /* noop */ }
  });
});

server.listen(PORT, () => {
  console.log(`server listening on http://localhost:${PORT}`);
});
