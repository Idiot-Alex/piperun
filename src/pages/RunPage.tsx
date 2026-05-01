import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import type { Pipeline, StepStatus } from '../types';
import XTerm, { type XTermHandle } from '../components/XTerm';

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
  const [runResult, setRunResult] = useState<'success' | 'failed' | null>(null);
  const xtermRef = useRef<XTermHandle>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const runStartRef = useRef<number>(0);

  useEffect(() => {
    if (id) api.getPipeline(id).then(setPipeline).catch(console.error);
  }, [id]);

  const handleStepStatus = useCallback((si: number, sj: number, status: StepStatus, durationMs?: number) => {
    setStatusMap(prev => ({ ...prev, [`${si}:${sj}`]: status }));
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
    if (r) {
      runStartRef.current = Date.now();
      setTotalDuration(null);
      setRunResult(null);
    } else {
      const dur = Date.now() - runStartRef.current;
      setTotalDuration(dur);
      // Derive result from statusMap snapshot via a callback to get latest state
      setStatusMap(prev => {
        const statuses = Object.values(prev);
        if (statuses.length > 0 && statuses.some(s => s === 'failed')) setRunResult('failed');
        else if (statuses.length > 0) setRunResult('success');
        return prev;
      });
    }
    setRunning(r);
  }, []);

  const handleStepVars = useCallback((si: number, sj: number, vars: Record<string, string>) => {
    setVarsMap(prev => ({ ...prev, [`${si}:${sj}`]: vars }));
  }, []);

  const startRun = useCallback(() => {
    if (!pipeline || running) return;
    setStatusMap({});
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
            onStepVars={handleStepVars}
          />
        </div>
      </div>
    </div>
  );
}
