import type { RunResult, StepStatus } from './types';

const STEP_START_RE = /\x01STEP_START:(\d+):(\d+)\x01\r?\n?/g;
const STEP_END_RE = /\x01STEP_END:(\d+):(\d+):(\d+)(?::(\d+))?\x01\r?\n?/g;
const STEP_VARS_RE = /\x01STEP_VARS:(\d+):(\d+):([^\x01]*)\x01\r?\n?/g;
const RUN_END_RE = /\x01RUN_END:(success|failed|timeout|stopped)\x01\r?\n?/g;

export interface ReplayCallbacks {
  onStepStatus?: (si: number, sj: number, status: StepStatus, durationMs?: number) => void;
  onStepVars?: (si: number, sj: number, vars: Record<string, string>) => void;
  onRunResult?: (result: RunResult) => void;
}

function reset(re: RegExp) {
  re.lastIndex = 0;
}

export function parseReplayMarkers(data: string, callbacks: ReplayCallbacks): void {
  const started = new Set<string>();
  let m: RegExpExecArray | null;

  reset(STEP_START_RE);
  while ((m = STEP_START_RE.exec(data)) !== null) started.add(`${m[1]}:${m[2]}`);

  reset(STEP_END_RE);
  while ((m = STEP_END_RE.exec(data)) !== null) {
    const [, si, sj, code, dt] = m;
    started.delete(`${si}:${sj}`);
    callbacks.onStepStatus?.(+si, +sj, +code === 0 ? 'done' : 'failed', dt !== undefined ? +dt : undefined);
  }

  for (const key of started) {
    const [si, sj] = key.split(':');
    callbacks.onStepStatus?.(+si, +sj, 'failed');
  }

  reset(STEP_VARS_RE);
  while ((m = STEP_VARS_RE.exec(data)) !== null) {
    try {
      const vars = JSON.parse(m[3]) as Record<string, string>;
      if (Object.keys(vars).length > 0) callbacks.onStepVars?.(+m[1], +m[2], vars);
    } catch { /* ignore malformed */ }
  }

  reset(RUN_END_RE);
  while ((m = RUN_END_RE.exec(data)) !== null) {
    callbacks.onRunResult?.(m[1] as RunResult);
  }
}

export function stripProtocolMarkers(data: string): string {
  return data
    .replace(/\x01STEP_START:\d+:\d+\x01\r?\n?/g, '')
    .replace(/\x01STEP_END:\d+:\d+:\d+(?::\d+)?\x01\r?\n?/g, '')
    .replace(/\x01STEP_VARS:\d+:\d+:[^\x01]*\x01\r?\n?/g, '')
    .replace(/\x01RUN_END:(?:success|failed|timeout|stopped)\x01\r?\n?/g, '');
}
