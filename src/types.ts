export interface Step {
  id: string;
  name: string;
  command: string;
  continueOnError: boolean;
}

export interface Stage {
  id: string;
  name: string;
  steps: Step[];
}

export interface Pipeline {
  id: string;
  name: string;
  description: string;
  stages: Stage[];
  createdAt?: string;
  updatedAt?: string;
}

export type StepStatus = 'waiting' | 'running' | 'done' | 'failed';

export interface PipelineRun {
  id: string;
  pipelineId: string;
  pipelineName: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  result: 'success' | 'failed' | 'timeout';
}

export interface Selection {
  type: 'stage' | 'step';
  si: number;
  sj?: number;
}
