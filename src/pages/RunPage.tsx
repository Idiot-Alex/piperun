import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import type { Pipeline, RunResult, StepStatus } from '../types';
import XTerm, { type XTermHandle } from '../components/XTerm';

// Module-level cache: persists across navigation within the same session.
// Capped at 10 entries (FIFO) to bound memory usage (~10 MB × 10 = 100 MB worst case).
const MAX_CACHE_ENTRIES = 10;
const terminalOutputCache = new Map<string, string>();

function cacheSet(key: string, value: string) {
  // Re-insert to move key to end (most-recently-used position)
  terminalOutputCache.delete(key);
  terminalOutputCache.set(key, value);
  if (terminalOutputCache.size > MAX_CACHE_ENTRIES) {
    // Delete the oldest (first) entry
    terminalOutputCache.delete(terminalOutputCache.keys().next().value!);
  }
}

function clearPipelineCache(pipelineId: string) {
  for (const key of terminalOutputCache.keys()) {
    if (key.startsWith(`${pipelineId}:`)) terminalOutputCache.delete(key);
  }
}

type StatusMap = Record<string, StepStatus>; // key: `${si}:${sj}`
type DurationMap = Record<string, number>; // key: `${si}:${sj}`, value: ms
type VarsMap = Record<string, Record<string, string>>; // key: `${si}:${sj}`

function formatDur(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

function statusIcon(status: StepStatus) {
  switch (status) {
    case 'running':
      return <span className="loading loading-spinner loading-xs"></span>;
    case 'done':
      return <span className="text-success font-bold">✓</span>;
    case 'failed':
      return <span className="text-error font-bold">✗</span>;
    default:
      return <span className="text-base-content/20">○</span>;
  }
}

export default function RunPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [statusMap, setStatusMap] = useState<StatusMap>({});
  const [durationMap, setDurationMap] = useState<DurationMap>({});
  const [varsMap, setVarsMap] = useState<VarsMap>({});
  const [running, setRunning] = useState(false);
  const [totalDuration, setTotalDuration] = useState<number | null>(null);
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  // Log data waiting to be replayed once XTerm mounts (after pipeline state is set)
  const [pendingReplay, setPendingReplay] = useState<string | null>(null);
  const xtermRef = useRef<XTermHandle>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const runStartRef = useRef<number>(0);
  const runningRef = useRef(false);
  const runResultRef = useRef<RunResult | null>(null);
  // Mirror of statusMap kept in sync for use in callbacks without stale closures
  const statusMapRef = useRef<StatusMap>({});

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    api.getPipeline(id).then(async p => {
      if (cancelled) return;
      setPipeline(p);
      try {
        const runs = await api.getRuns(id);
        if (cancelled) return;
        if (runs.length > 0) {
          if (!runningRef.current) {
            runResultRef.current = runs[0].result;
            setRunResult(runs[0].result);
            setTotalDuration(runs[0].durationMs);
          }
          const cacheKey = `${id}:${runs[0].id}`;
          const cached = terminalOutputCache.get(cacheKey);
          if (cached) {
            if (runningRef.current) return;
            setPendingReplay(cached);
            return;
          }
          const log = await api.getRunLog(runs[0].id);
          if (cancelled) return;
          if (log) {
            cacheSet(cacheKey, log);
            if (runningRef.current) return;
            setPendingReplay(log);
          }
        }
      } catch { /* no log available, terminal stays empty */ }
    }).catch(console.error);
    return () => { cancelled = true; };
  }, [id]);

  // Replay log after XTerm mounts (pipeline state change causes XTerm to mount,
  // so we can't call replay() in the same tick as setPipeline())
  useEffect(() => {
    if (pendingReplay === null) return;
    if (!xtermRef.current) return;
    if (runningRef.current) {
      setPendingReplay(null);
      return;
    }
    xtermRef.current.replay(pendingReplay);
    setPendingReplay(null);
  }, [pendingReplay, pipeline]);

  const handleStepStatus = useCallback((si: number, sj: number, status: StepStatus, durationMs?: number) => {
    setStatusMap(prev => {
      const next = { ...prev, [`${si}:${sj}`]: status };
      statusMapRef.current = next;
      return next;
    });
    if (durationMs !== undefined) {
      setDurationMap(prev => ({ ...prev, [`${si}:${sj}`]: durationMs }));
    }
    // Auto-scroll sidebar to running step
    if (status === 'running') {
      requestAnimationFrame(() => {
        const el = sidebarRef.current?.querySelector<HTMLElement>(`[data-step="${si}:${sj}"]`);
        el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    }
  }, []);

  const handleRunningChange = useCallback((r: boolean) => {
    runningRef.current = r;
    if (r) {
      runStartRef.current = Date.now();
      runResultRef.current = null;
      setPendingReplay(null);
      setTotalDuration(null);
      setRunResult(null);
    } else {
      const dur = Date.now() - runStartRef.current;
      setTotalDuration(dur);
      // The server appends a new run before closing the websocket; clear older
      // cached logs so the next visit fetches that newest run by id.
      if (id) {
        clearPipelineCache(id);
      }
      // Derive result from ref (always reflects the latest statusMap)
      const statuses = Object.values(statusMapRef.current);
      if (!runResultRef.current) {
        if (statuses.length > 0 && statuses.some(s => s === 'failed' || s === 'running')) setRunResult('failed');
        else if (statuses.length > 0) setRunResult('success');
      }
    }
    setRunning(r);
  }, [id]);;

  const handleRunResult = useCallback((result: RunResult) => {
    runResultRef.current = result;
    setRunResult(result);
  }, []);

  const handleStepVars = useCallback((si: number, sj: number, vars: Record<string, string>) => {
    setVarsMap(prev => ({ ...prev, [`${si}:${sj}`]: vars }));
  }, []);

  const startRun = useCallback(() => {
    if (!pipeline || running) return;
    setStatusMap({});
    statusMapRef.current = {};
    setDurationMap({});
    setVarsMap({});
    setTotalDuration(null);
    setRunResult(null);
    // start() is called in next tick so statusMap reset has flushed
    setTimeout(() => xtermRef.current?.start(pipeline.id), 0);
  }, [pipeline, running]);

  const stopRun = useCallback(() => {
    xtermRef.current?.stop();
  }, []);

  if (!pipeline) {
    return (
      <div className="flex justify-center items-center min-h-screen">
        <span className="loading loading-spinner loading-lg text-primary"></span>
      </div>
    );
  }

  const totalSteps = pipeline.stages.reduce((a, s) => a + s.steps.length, 0);
  const completedSteps = Object.values(statusMap).filter(s => s === 'done' || s === 'failed').length;

  const getStageStatus = (si: number): StepStatus => {
    const stage = pipeline.stages[si];
    if (!stage.steps.length) return 'waiting';
    const statuses = stage.steps.map((_, sj) => statusMap[`${si}:${sj}`] ?? 'waiting');
    if (statuses.some(s => s === 'running')) return 'running';
    if (statuses.every(s => s === 'done')) return 'done';
    if (statuses.some(s => s === 'failed')) return 'failed';
    return 'waiting';
  };

  return (
    <div className="flex flex-col h-screen bg-base-100">
      {/* Navbar */}
      <div className="navbar bg-base-200 border-b border-base-300 px-4 flex-shrink-0 min-h-12">
        <div className="flex-1 gap-2 min-w-0">
          <button
            className="btn btn-ghost btn-sm flex-shrink-0"
            onClick={() => { stopRun(); navigate('/'); }}
          >
            ← 返回
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="text-sm font-semibold truncate">{pipeline.name}</div>
              {running && (
                <span className="text-xs text-base-content/40 flex-shrink-0">{completedSteps}/{totalSteps}</span>
              )}
              {!running && runResult === 'success' && (
                <span className="badge badge-success badge-sm gap-1 flex-shrink-0">✓ 成功</span>
              )}
              {!running && runResult === 'failed' && (
                <span className="badge badge-error badge-sm gap-1 flex-shrink-0">✗ 失败</span>
              )}
              {!running && runResult === 'timeout' && (
                <span className="badge badge-warning badge-sm gap-1 flex-shrink-0">⏱ 超时</span>
              )}
              {!running && runResult === 'stopped' && (
                <span className="badge badge-neutral badge-sm gap-1 flex-shrink-0">■ 已停止</span>
              )}
            </div>
            {pipeline.description && (
              <div className="text-xs text-base-content/40 truncate">{pipeline.description}</div>
            )}
          </div>
        </div>
        <div className="flex-none gap-2">
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => xtermRef.current?.clear()}
            title="清屏"
          >
            ⌫ 清屏
          </button>
          {running ? (
            <button className="btn btn-error btn-sm" onClick={stopRun}>
              ■ 停止
            </button>
          ) : (
            <button className="btn btn-primary btn-sm" onClick={startRun}>
              ▶ 开始执行
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <div ref={sidebarRef} className="w-60 flex-shrink-0 border-r border-base-300 bg-base-200 overflow-y-auto flex flex-col">
          <div className="px-4 py-2.5 border-b border-base-300">
            <span className="text-[11px] font-semibold text-base-content/35 uppercase tracking-widest">
              {pipeline.stages.length} 个阶段 · {totalSteps} 个步骤
            </span>
          </div>

          <div className="py-2 flex-1">
            {pipeline.stages.map((stage, si) => {
              const stageStatus = getStageStatus(si);
              return (
                <div key={stage.id}>
                  {/* Stage row */}
                  <div
                    className={`flex items-center gap-2.5 px-4 py-2 border-l-2 transition-colors
                      ${stageStatus === 'running'
                        ? 'border-primary bg-primary/5'
                        : stageStatus === 'done'
                          ? 'border-success/50'
                          : stageStatus === 'failed'
                            ? 'border-error/50'
                            : 'border-transparent'}`}
                  >
                    <span className="w-4 flex items-center justify-center flex-shrink-0 text-xs">
                      {statusIcon(stageStatus)}
                    </span>
                    <span
                          className={`text-sm font-medium truncate flex-1 min-w-0
                        ${stageStatus === 'running'
                          ? 'text-primary'
                          : stageStatus === 'done'
                            ? 'text-success'
                            : stageStatus === 'failed'
                              ? 'text-error'
                              : 'text-base-content/50'}`}
                    >
                      {stage.name || `阶段 ${si + 1}`}
                    </span>
                    {(stageStatus === 'done' || stageStatus === 'failed') && (() => {
                      const total = stage.steps.reduce((sum, _, sj) => sum + (durationMap[`${si}:${sj}`] ?? 0), 0);
                      return total > 0 ? (
                        <span className="text-[10px] text-base-content/35 flex-shrink-0 ml-1">
                          {formatDur(total)}
                        </span>
                      ) : null;
                    })()}
                  </div>

                  {/* Step rows */}
                  {stage.steps.map((step, sj) => {
                    const stepStatus = statusMap[`${si}:${sj}`] ?? 'waiting';
                    const stepVars = (stepStatus === 'done' || stepStatus === 'failed')
                      ? varsMap[`${si}:${sj}`]
                      : undefined;
                    return (
                      <div key={step.id}>
                      <div
                        data-step={`${si}:${sj}`}
                        className={`flex items-center gap-2 pl-10 pr-4 py-1.5 transition-colors
                          ${stepStatus === 'running' ? 'bg-primary/5' : ''}`}
                      >
                        <span className="w-3 flex items-center justify-center flex-shrink-0 text-xs">
                          {statusIcon(stepStatus)}
                        </span>
                        <span
                          className={`text-xs truncate flex-1 min-w-0
                            ${stepStatus === 'running'
                              ? 'text-primary'
                              : stepStatus === 'done'
                                ? 'text-success'
                                : stepStatus === 'failed'
                                  ? 'text-error'
                                  : 'text-base-content/35'}`}
                        >
                          {step.name || `步骤 ${sj + 1}`}
                        </span>
                        {durationMap[`${si}:${sj}`] !== undefined && (
                          <span className="text-[10px] text-base-content/35 flex-shrink-0 ml-1">
                            {formatDur(durationMap[`${si}:${sj}`])}
                          </span>
                        )}
                      </div>
                      {/* Exported vars — only shown when step is done/failed and has vars */}
                      {stepVars && Object.keys(stepVars).length > 0 && (
                        <div className="pl-14 pr-4 pb-1.5 flex flex-col gap-0.5">
                          {Object.entries(stepVars).map(([k, v]) => (
                            <div key={k} className="flex items-baseline gap-1 text-[10px] font-mono leading-snug">
                              <span className="text-amber-600/80 flex-shrink-0">{k}</span>
                              <span className="text-base-content/25">=</span>
                              <span className="text-base-content/50 truncate" title={v}>{v || '""'}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
          {/* Pipeline env vars */}
          {(pipeline.env ?? []).length > 0 && (
            <details className="border-t border-base-300 group">
              <summary className="px-4 py-2 text-[11px] font-semibold text-base-content/35 uppercase tracking-widest cursor-pointer select-none hover:text-base-content/60 list-none flex items-center justify-between">
                <span>环境变量 ({pipeline.env.length})</span>
                <span className="group-open:rotate-180 transition-transform text-base-content/25">▾</span>
              </summary>
              <div className="px-4 pb-2 flex flex-col gap-0.5">
                {pipeline.env.map(ev => (
                  <div key={ev.key} className="flex items-baseline gap-1 text-[10px] font-mono leading-snug">
                    <span className="text-violet-500/70 flex-shrink-0">{ev.key}</span>
                    <span className="text-base-content/25">=</span>
                    <span className="text-base-content/50 truncate" title={ev.value}>{ev.value || '""'}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
          {/* Total run time footer */}
          {totalDuration !== null && (
            <div className="px-4 py-2 border-t border-base-300 flex-shrink-0">
              <span className="text-[11px] text-base-content/40">
                总耗时 {formatDur(totalDuration)}
              </span>
            </div>
          )}
        </div>

        {/* Terminal area */}
        <div className="flex-1 overflow-hidden min-w-0">
          <XTerm
            ref={xtermRef}
            onStepStatus={handleStepStatus}
            onRunningChange={handleRunningChange}
            onRunResult={handleRunResult}
            onStepVars={handleStepVars}
          />
        </div>
      </div>
    </div>
  );
}
