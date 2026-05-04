import type { Pipeline, PipelineRun } from './types';

const BASE = '/api';

async function req<T>(url: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(BASE + url, opts);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.status === 204 ? (undefined as T) : r.json();
}

export const api = {
  getPipelines: () => req<Pipeline[]>('/pipelines'),

  getPipeline: (id: string) => req<Pipeline>(`/pipelines/${id}`),

  createPipeline: (p: Omit<Pipeline, 'id' | 'createdAt' | 'updatedAt'>) =>
    req<Pipeline>('/pipelines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(p),
    }),

  updatePipeline: (id: string, p: Pipeline) =>
    req<Pipeline>(`/pipelines/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(p),
    }),

  deletePipeline: (id: string) =>
    req<void>(`/pipelines/${id}`, { method: 'DELETE' }),

  getRuns: (pipelineId?: string) =>
    req<PipelineRun[]>(`/runs${pipelineId ? `?pipeline=${pipelineId}` : ''}`),

  getRunLog: async (runId: string): Promise<string> => {
    const r = await fetch(`${BASE}/runs/${runId}/log`);
    if (!r.ok) throw new Error(`${r.status}`);
    return r.text();
  },

  deleteRun: (id: string) =>
    req<void>(`/runs/${id}`, { method: 'DELETE' }),
};
