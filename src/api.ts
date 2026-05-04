import type { Pipeline, PipelineRun } from './types';

const BASE = '/api';

// ── Token management ─────────────────────────────────────────────────────────
// Stored in sessionStorage: scoped to the tab, cleared when the tab is closed.
const TOKEN_KEY = 'piperun_token';

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}
export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
async function req<T>(url: string, opts?: RequestInit): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(opts?.headers as Record<string, string>),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const r = await fetch(BASE + url, { ...opts, headers });
  if (r.status === 401) {
    // Token rejected — clear it and notify TokenGate to show the login form.
    clearToken();
    window.dispatchEvent(new Event('auth:logout'));
    throw new Error('401 Unauthorized');
  }
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
    const token = getToken();
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const r = await fetch(`${BASE}/runs/${runId}/log`, { headers });
    if (r.status === 401) {
      clearToken();
      window.dispatchEvent(new Event('auth:logout'));
      throw new Error('401 Unauthorized');
    }
    if (!r.ok) throw new Error(`${r.status}`);
    return r.text();
  },

  deleteRun: (id: string) =>
    req<void>(`/runs/${id}`, { method: 'DELETE' }),

  clearRuns: (pipelineId: string) =>
    req<void>(`/runs?pipeline=${pipelineId}`, { method: 'DELETE' }),
};
