import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReplayMarkers, stripProtocolMarkers } from '../src/terminalProtocol.ts';

test('parseReplayMarkers reconstructs finished steps, vars, and run result', () => {
  const statuses = [];
  const vars = [];
  const results = [];
  const data = [
    '\x01STEP_START:0:0\x01\n',
    'hello\n',
    '\x01STEP_VARS:0:0:{"ARTIFACT":"dist"}\x01\n',
    '\x01STEP_END:0:0:0:123\x01\n',
    '\x01RUN_END:success\x01\n',
  ].join('');

  parseReplayMarkers(data, {
    onStepStatus: (...args) => statuses.push(args),
    onStepVars: (...args) => vars.push(args),
    onRunResult: result => results.push(result),
  });

  assert.deepEqual(statuses, [[0, 0, 'done', 123]]);
  assert.deepEqual(vars, [[0, 0, { ARTIFACT: 'dist' }]]);
  assert.deepEqual(results, ['success']);
});

test('parseReplayMarkers marks interrupted started steps as failed', () => {
  const statuses = [];

  parseReplayMarkers('\x01STEP_START:1:2\x01\npartial output\n', {
    onStepStatus: (...args) => statuses.push(args),
  });

  assert.deepEqual(statuses, [[1, 2, 'failed']]);
});

test('stripProtocolMarkers removes all protocol markers but keeps user output', () => {
  const stripped = stripProtocolMarkers([
    '\x01STEP_START:0:0\x01\n',
    'user output\n',
    '\x01STEP_END:0:0:1:88\x01\n',
    '\x01STEP_VARS:0:0:{"A":"B"}\x01\n',
    '\x01RUN_END:failed\x01\n',
  ].join(''));

  assert.equal(stripped, 'user output\n');
});
