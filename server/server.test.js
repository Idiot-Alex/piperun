import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { buildBashScript, envExportLine, sanitizePipeline } from './server.js';

function runBash(script, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-s'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('bash test timed out'));
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(script);
  });
}

test('envExportLine safely quotes single quotes', async () => {
  const script = [
    envExportLine('GREETING', "it's ok"),
    'printf "%s" "$GREETING"',
  ].join('\n');

  const { code, stdout, stderr } = await runBash(script);
  assert.equal(code, 0, stderr);
  assert.equal(stdout, "it's ok");
});

test('buildBashScript injects pipeline env and emits step markers', async () => {
  const pipeline = sanitizePipeline({
    name: 'env smoke',
    env: [{ key: 'SMOKE_VALUE', value: 'ok' }],
    stages: [{
      name: 'stage',
      steps: [{ name: 'echo', command: 'echo "value:$SMOKE_VALUE"' }],
    }],
  });

  const { code, stdout, stderr } = await runBash(buildBashScript(pipeline));
  assert.equal(code, 0, stderr);
  assert.match(stdout, /value:ok/);
  assert.match(stdout, /\x01STEP_START:0:0\x01/);
  assert.match(stdout, /\x01STEP_END:0:0:0:\d+\x01/);
});

test('continueOnError keeps later steps running while marking failed step done', async () => {
  const pipeline = sanitizePipeline({
    name: 'continue smoke',
    stages: [{
      name: 'stage',
      steps: [
        { name: 'allowed failure', command: 'false', continueOnError: true },
        { name: 'next', command: 'echo next-ran' },
      ],
    }],
  });

  const { code, stdout, stderr } = await runBash(buildBashScript(pipeline));
  assert.equal(code, 0, stderr);
  assert.match(stdout, /next-ran/);
  assert.match(stdout, /\x01STEP_END:0:0:0:\d+\x01/);
  assert.match(stdout, /\x01STEP_END:0:1:0:\d+\x01/);
});

test('retries rerun a failing command until it succeeds', async () => {
  const pipeline = sanitizePipeline({
    name: 'retry smoke',
    stages: [{
      name: 'stage',
      steps: [{
        name: 'retry',
        retries: 1,
        command: 'n=${RETRY_N:-0}; export RETRY_N=$((n+1)); [ "$n" -ge 1 ]',
      }],
    }],
  });

  const { code, stdout, stderr } = await runBash(buildBashScript(pipeline));
  assert.equal(code, 0, stderr);
  assert.match(stdout, /\[重试 1\/1\]/);
  assert.match(stdout, /\x01STEP_END:0:0:0:\d+\x01/);
});

test('step timeout fails the step', async () => {
  const pipeline = sanitizePipeline({
    name: 'timeout smoke',
    stages: [{
      name: 'stage',
      steps: [{ name: 'timeout', timeout: 1, command: 'sleep 5' }],
    }],
  });

  const { code, stdout } = await runBash(buildBashScript(pipeline), 7000);
  assert.notEqual(code, 0);
  assert.match(stdout, /\x01STEP_END:0:0:(?!0:)\d+:\d+\x01/);
});
