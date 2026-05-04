export interface Step {
  id: string;
  name: string;
  command: string;
  continueOnError: boolean;
  timeout?: number; // seconds, 0 = no timeout
  retries?: number; // retry count on failure, 0 = no retry
}

export interface Stage {
  id: string;
  name: string;
  steps: Step[];
}

export interface EnvVar {
  key: string;
  value: string;
}

export interface Pipeline {
  id: string;
  name: string;
  description: string;
  env: EnvVar[];
  stages: Stage[];
  createdAt?: string;
  updatedAt?: string;
}

export type StepStatus = 'waiting' | 'running' | 'done' | 'failed';
export type RunResult = 'success' | 'failed' | 'timeout' | 'stopped';

export interface PipelineRun {
  id: string;
  pipelineId: string;
  pipelineName: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  result: RunResult;
}

export interface Selection {
  type: 'stage' | 'step';
  si: number;
  sj?: number;
}
