import test from 'node:test';
import assert from 'node:assert/strict';
import { pipelineToYamlData, validatePipelineYaml } from '../src/pipelineYaml.ts';

test('pipelineToYamlData keeps pipeline env vars during export', () => {
  const data = pipelineToYamlData({
    id: 'pipeline-id',
    name: 'Export smoke',
    description: 'desc',
    env: [{ key: 'NODE_ENV', value: 'production' }],
    stages: [{
      id: 'stage-id',
      name: 'Build',
      steps: [{
        id: 'step-id',
        name: 'Compile',
        command: 'pnpm build',
        continueOnError: false,
        timeout: 120,
        retries: 2,
      }],
    }],
  });

  assert.deepEqual(data.env, [{ key: 'NODE_ENV', value: 'production' }]);
  assert.equal(data.stages[0].steps[0].timeout, 120);
  assert.equal(data.stages[0].steps[0].retries, 2);
});

test('validatePipelineYaml accepts a valid env block', () => {
  const error = validatePipelineYaml({
    name: 'Import smoke',
    env: [{ key: 'DEPLOY_TARGET', value: 'staging' }],
    stages: [{ name: 'Check', steps: [{ name: 'Echo', command: 'echo ok' }] }],
  });

  assert.equal(error, null);
});

test('validatePipelineYaml rejects malformed env entries', () => {
  assert.match(
    validatePipelineYaml({ name: 'Bad env', env: [{ key: 'TOKEN', value: 123 }] }) ?? '',
    /value 必须是字符串/,
  );
  assert.match(
    validatePipelineYaml({ name: 'Bad env', env: [{ key: '' }] }) ?? '',
    /缺少 key/,
  );
});

test('validatePipelineYaml rejects malformed step options', () => {
  assert.match(
    validatePipelineYaml({
      name: 'Bad retry',
      stages: [{ name: 'Stage', steps: [{ name: 'Step', command: 'echo ok', retries: 11 }] }],
    }) ?? '',
    /retries 必须是 0-10/,
  );
});
