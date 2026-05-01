import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { dump as yamlDump, load as yamlLoad } from 'js-yaml';
import { api } from '../api';
import type { Pipeline, PipelineRun } from '../types';

function validateYaml(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'YAML 顶层必须是对象';
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== 'string' || !obj.name.trim()) return '缺少必填字段 name（字符串）';
  if (obj.stages !== undefined && !Array.isArray(obj.stages)) return 'stages 必须是数组';
  const stages = (Array.isArray(obj.stages) ? obj.stages : []) as unknown[];
  for (let si = 0; si < stages.length; si++) {
    const stage = stages[si];
    if (!stage || typeof stage !== 'object' || Array.isArray(stage)) return `阶段 ${si + 1} 格式错误（必须是对象）`;
    const s = stage as Record<string, unknown>;
    if (s.steps !== undefined && !Array.isArray(s.steps)) return `阶段 ${si + 1} 的 steps 必须是数组`;
    const steps = (Array.isArray(s.steps) ? s.steps : []) as unknown[];
    for (let sj = 0; sj < steps.length; sj++) {
      const step = steps[sj];
      if (!step || typeof step !== 'object' || Array.isArray(step)) return `阶段 ${si + 1} 步骤 ${sj + 1} 格式错误（必须是对象）`;
      const st = step as Record<string, unknown>;
      if (st.command !== undefined && typeof st.command !== 'string') return `阶段 ${si + 1} 步骤 ${sj + 1} 的 command 必须是字符串`;
      if (st.timeout !== undefined && (typeof st.timeout !== 'number' || st.timeout < 0)) return `阶段 ${si + 1} 步骤 ${sj + 1} 的 timeout 必须是非负整数（秒）`;
    }
  }
  if (obj.env !== undefined && !Array.isArray(obj.env)) return 'env 必须是数组';
  return null;
}

export default function PipelinesPage() {
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [runs, setRuns] = useState<PipelineRun[]>([]);
  const [historyPipeline, setHistoryPipeline] = useState<Pipeline | null>(null);
  const historyModalRef = useRef<HTMLDialogElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [copying, setCopying] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  // Build a map: pipelineId → most recent run (runs are returned newest-first)
  const lastRunMap = runs.reduce<Record<string, PipelineRun>>((acc, r) => {
    if (!acc[r.pipelineId]) acc[r.pipelineId] = r;
    return acc;
  }, {});

  function formatRelative(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
    return `${Math.floor(diff / 86400000)}天前`;
  }

  function formatDur(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  }

  const load = async () => {
    try {
      setLoading(true);
      setError(null);
      const [plist, rlist] = await Promise.all([api.getPipelines(), api.getRuns()]);
      setPipelines(plist);
      setRuns(rlist);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const handleDelete = async (id: string) => {
    if (!confirm('确认删除此流水线？')) return;
    setDeleteError(null);
    try {
      await api.deletePipeline(id);
      void load();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleCopy = async (p: Pipeline) => {
    setCopying(p.id);
    try {
      await api.createPipeline({ ...p, name: p.name + '（副本）', id: '' } as Pipeline);
      void load();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
    } finally {
      setCopying(null);
    }
  };

  const handleExport = (p: Pipeline) => {
    const data = {
      name: p.name,
      description: p.description || undefined,
      stages: p.stages.map(s => ({
        name: s.name,
        steps: s.steps.map(st => ({
          name: st.name,
          command: st.command || undefined,
          continueOnError: st.continueOnError || undefined,
          timeout: st.timeout ? st.timeout : undefined,
        })),
      })),
    };
    const yml = yamlDump(data, { lineWidth: 120, forceQuotes: false });
    const blob = new Blob([yml], { type: 'text/yaml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${p.name.replace(/[^a-z0-9一-龥_-]/gi, '_')}.yml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    try {
      const text = await file.text();
      let raw: unknown;
      try {
        raw = yamlLoad(text);
      } catch (yamlErr) {
        setDeleteError(`YAML 解析失败：${yamlErr instanceof Error ? yamlErr.message : String(yamlErr)}`);
        return;
      }
      const validationError = validateYaml(raw);
      if (validationError) {
        setDeleteError(`导入失败：${validationError}`);
        return;
      }
      await api.createPipeline(raw as unknown as Pipeline);
      void load();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
    }
  };

  const filtered = search.trim()
    ? pipelines.filter(p =>
        p.name.toLowerCase().includes(search.toLowerCase()) ||
        p.description?.toLowerCase().includes(search.toLowerCase())
      )
    : pipelines;

  return (
    <div className="min-h-screen bg-base-100">
      {/* Navbar */}
      <div className="navbar bg-base-200 border-b border-base-300 px-6 min-h-14">
        <div className="flex-1 gap-3">
          <div className="flex items-center gap-2">
            <img src="/logo.svg" alt="logo" className="w-7 h-7 rounded-lg" />
            <span className="text-base font-bold tracking-tight">Pipeline UI</span>
          </div>
          {!loading && !error && (
            <span className="text-xs text-base-content/30 hidden sm:inline">
              {pipelines.length} 条流水线
            </span>
          )}
        </div>
        <div className="flex-none flex items-center gap-2">
          <div className="relative">
            <input
              type="text"
              className="input input-sm input-bordered w-44 pl-8"
              placeholder="搜索..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-base-content/30 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
            </svg>
          </div>
          <input ref={importRef} type="file" accept=".yml,.yaml" className="hidden" onChange={handleImport} />
          <button className="btn btn-ghost btn-sm gap-1.5" onClick={() => importRef.current?.click()}>
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            导入
          </button>
          <button className="btn btn-primary btn-sm gap-1" onClick={() => navigate('/new')}>
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            新建
          </button>
        </div>
      </div>

      <div className="p-6 max-w-6xl mx-auto">
        {deleteError && (
          <div className="alert alert-error mt-4 mb-4">
            <span>{deleteError}</span>
            <button className="btn btn-ghost btn-xs" onClick={() => setDeleteError(null)}>✕</button>
          </div>
        )}
        {loading && (
          <div className="flex justify-center mt-24">
            <span className="loading loading-spinner loading-lg text-primary"></span>
          </div>
        )}
        {error && (
          <div className="alert alert-error mt-6">
            <span>{error}</span>
            <button className="btn btn-sm" onClick={() => void load()}>重试</button>
          </div>
        )}
        {!loading && !error && pipelines.length === 0 && (
          <div className="text-center mt-32 text-base-content/40">
            <div className="text-5xl mb-5 opacity-30">⚙</div>
            <p className="text-lg font-medium mb-2 text-base-content/50">还没有流水线</p>
            <p className="text-sm mb-8">创建第一条或导入 YAML 文件</p>
            <div className="flex items-center justify-center gap-3">
              <button className="btn btn-primary btn-sm" onClick={() => navigate('/new')}>
                + 新建流水线
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => importRef.current?.click()}>
                导入 YAML
              </button>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.length === 0 && !loading && !error && pipelines.length > 0 && (
            <div className="col-span-full text-center py-16 text-base-content/40">
              <p className="text-3xl mb-3">🔍</p>
              <p>没有匹配「{search}」的流水线</p>
            </div>
          )}
          {filtered.map((p) => {
            const totalSteps = p.stages.reduce((a, s) => a + s.steps.length, 0);
            const createdDate = p.createdAt
              ? new Date(p.createdAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
              : null;
            return (
              <div
                key={p.id}
                className="card bg-base-100 border border-base-300 hover:border-primary/40 hover:shadow-md transition-all duration-150"
              >
                <div className="card-body p-5 gap-3">
                  {/* Header */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <h2 className="font-semibold text-sm leading-snug truncate">{p.name}</h2>
                      {p.description
                        ? <p className="text-xs text-base-content/45 mt-0.5 line-clamp-2">{p.description}</p>
                        : <p className="text-xs text-base-content/25 mt-0.5 italic">暂无描述</p>
                      }
                    </div>
                    {/* More actions dropdown */}
                    <div className="dropdown dropdown-end flex-shrink-0">
                      <button tabIndex={0} className="btn btn-ghost btn-xs btn-square text-base-content/40 hover:text-base-content">
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                          <path d="M10 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm0 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm0 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4z" />
                        </svg>
                      </button>
                      <ul tabIndex={0} className="dropdown-content menu menu-sm bg-base-100 border border-base-300 rounded-lg shadow-lg w-32 z-10 p-1">
                        <li>
                          <button onClick={() => void handleCopy(p)} disabled={copying === p.id} className="gap-2">
                            {copying === p.id
                              ? <span className="loading loading-spinner loading-xs"></span>
                              : <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                            }
                            复制
                          </button>
                        </li>
                        <li>
                          <button onClick={() => handleExport(p)} className="gap-2">
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                            导出
                          </button>
                        </li>
                        <li className="mt-0.5 border-t border-base-300 pt-0.5">
                          <button onClick={() => {
                            setHistoryPipeline(p);
                            historyModalRef.current?.showModal();
                          }} className="gap-2">
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                            历史
                          </button>
                        </li>
                        <li className="mt-0.5 border-t border-base-300 pt-0.5">
                          <button onClick={() => void handleDelete(p.id)} className="text-error gap-2 hover:bg-error/10">
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                            删除
                          </button>
                        </li>
                      </ul>
                    </div>
                  </div>

                  {/* Stage flow visualization */}
                  <div className="flex items-center gap-1 flex-wrap min-h-5">
                    {p.stages.length === 0
                      ? <span className="text-xs text-base-content/25 italic">无阶段</span>
                      : p.stages.map((s, i) => (
                          <div key={s.id} className="flex items-center gap-1">
                            {i > 0 && <span className="text-base-content/20 text-xs">→</span>}
                            <span
                              className="inline-flex items-center gap-1 text-[11px] bg-base-200 border border-base-300 rounded px-1.5 py-0.5 text-base-content/60 max-w-[80px]"
                              title={s.name || `阶段 ${i + 1}`}
                            >
                              <span className="truncate">{s.name || `阶段${i + 1}`}</span>
                              <span className="text-base-content/30 flex-shrink-0">{s.steps.length}</span>
                            </span>
                          </div>
                        ))
                    }
                  </div>

                  {/* Footer */}
                  <div className="flex items-center justify-between pt-1 border-t border-base-200">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[11px] text-base-content/30">
                        {createdDate ? `${createdDate} · ${totalSteps} 步` : `${totalSteps} 个步骤`}
                      </span>
                      {lastRunMap[p.id] && (() => {
                        const r = lastRunMap[p.id];
                        return (
                          <span className="text-[11px] flex items-center gap-1">
                            <span className={r.result === 'success' ? 'text-success' : 'text-error'}>
                              {r.result === 'success' ? '✓' : '✗'}
                            </span>
                            <span className="text-base-content/40">{formatRelative(r.startedAt)} · {formatDur(r.durationMs)}</span>
                          </span>
                        );
                      })()}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        className="btn btn-ghost btn-xs"
                        onClick={() => navigate(`/edit/${p.id}`)}
                      >
                        编辑
                      </button>
                      <button
                        className="btn btn-primary btn-xs gap-1"
                        onClick={() => navigate(`/run/${p.id}`)}
                      >
                        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
                        </svg>
                        运行
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* History modal */}
      <dialog ref={historyModalRef} className="modal">
        <div className="modal-box w-full max-w-lg">
          <form method="dialog">
            <button className="btn btn-sm btn-circle btn-ghost absolute right-3 top-3">✕</button>
          </form>
          <h3 className="font-bold text-base mb-4">
            {historyPipeline?.name} · 运行历史
          </h3>
          {(() => {
            const pRuns = historyPipeline
              ? runs.filter(r => r.pipelineId === historyPipeline.id)
              : [];
            if (pRuns.length === 0) {
              return <p className="text-sm text-base-content/40 py-6 text-center">暂无运行记录</p>;
            }
            return (
              <div className="flex flex-col gap-1 max-h-80 overflow-y-auto pr-1">
                {pRuns.map(r => (
                  <div key={r.id} className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-base-200 text-sm">
                    <div className="flex items-center gap-2.5">
                      {r.result === 'success'
                        ? <span className="text-success font-bold text-base">✓</span>
                        : <span className="text-error font-bold text-base">✗</span>
                      }
                      <div>
                        <div className="text-xs text-base-content/60">
                          {new Date(r.startedAt).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </div>
                        <div className="text-[11px] text-base-content/35">{formatRelative(r.startedAt)}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-base-content/40">{formatDur(r.durationMs)}</span>
                      <span className={`badge badge-xs ${r.result === 'success' ? 'badge-success' : r.result === 'timeout' ? 'badge-warning' : 'badge-error'}`}>
                        {r.result === 'success' ? '成功' : r.result === 'timeout' ? '超时' : '失败'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
        <form method="dialog" className="modal-backdrop"><button>close</button></form>
      </dialog>
    </div>
  );
}
