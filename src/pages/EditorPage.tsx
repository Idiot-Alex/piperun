import { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams, useBlocker } from 'react-router-dom';
import { api } from '../api';
import type { Pipeline, Stage, Step, Selection, EnvVar } from '../types';
import StageFlow from '../components/StageFlow';
import ShellEditor from '../components/ShellEditor';
import SandboxModal from '../components/SandboxModal';

const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);

const emptyPipeline = (): Pipeline => ({
  id: '',
  name: '',
  description: '',
  env: [],
  stages: [],
});

export default function EditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isNew = !id;

  const [pipeline, setPipeline] = useState<Pipeline | null>(isNew ? emptyPipeline() : null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [sandboxCmd, setSandboxCmd] = useState<string | null>(null);
  const savedRef = useRef(false);
  const initialSnapshotRef = useRef<string>('');
  const saveRef = useRef<() => Promise<void>>();

  const isDirty = () =>
    !savedRef.current &&
    pipeline !== null &&
    JSON.stringify(pipeline) !== initialSnapshotRef.current;

  // Block navigation when there are unsaved changes
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    isDirty() && currentLocation.pathname !== nextLocation.pathname
  );

  useEffect(() => {
    if (!isNew && id) {
      api.getPipeline(id).then(p => {
        setPipeline(p);
        initialSnapshotRef.current = JSON.stringify(p);
      }).catch(console.error);
    } else {
      initialSnapshotRef.current = JSON.stringify(emptyPipeline());
    }
  }, [id, isNew]);

  // Cmd+S / Ctrl+S shortcut — must be before any early return
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        void saveRef.current?.();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  if (!pipeline) {
    return (
      <div className="flex justify-center items-center min-h-screen">
        <span className="loading loading-spinner loading-lg text-primary"></span>
      </div>
    );
  }

  const p = pipeline;

  const update = (updater: (prev: Pipeline) => Pipeline) =>
    setPipeline(prev => (prev ? updater(prev) : prev));

  // ── Stage operations ────────────────────────────────────────────────────────
  const addStage = () => {
    const si = p.stages.length;
    update(prev => ({ ...prev, stages: [...prev.stages, { id: uid(), name: '', steps: [] }] }));
    setSelection({ type: 'stage', si });
  };

  const deleteStage = (si: number) => {
    update(prev => ({ ...prev, stages: prev.stages.filter((_, i) => i !== si) }));
    setSelection(null);
  };

  const moveStage = (si: number, dir: -1 | 1) => {
    const ni = si + dir;
    if (ni < 0 || ni >= p.stages.length) return;
    update(prev => {
      const stages = [...prev.stages];
      [stages[si], stages[ni]] = [stages[ni], stages[si]];
      return { ...prev, stages };
    });
    setSelection({ type: 'stage', si: ni });
  };

  const updateStage = (si: number, patch: Partial<Stage>) =>
    update(prev => ({
      ...prev,
      stages: prev.stages.map((s, i) => (i === si ? { ...s, ...patch } : s)),
    }));

  // ── Step operations ─────────────────────────────────────────────────────────
  const addStep = (si: number) => {
    const sj = p.stages[si].steps.length;
    update(prev => ({
      ...prev,
      stages: prev.stages.map((s, i) =>
        i === si
          ? { ...s, steps: [...s.steps, { id: uid(), name: '', command: '', continueOnError: false }] }
          : s,
      ),
    }));
    setSelection({ type: 'step', si, sj });
  };

  const deleteStep = (si: number, sj: number) => {
    update(prev => ({
      ...prev,
      stages: prev.stages.map((s, i) =>
        i === si ? { ...s, steps: s.steps.filter((_, j) => j !== sj) } : s,
      ),
    }));
    setSelection({ type: 'stage', si });
  };

  const moveStep = (si: number, sj: number, dir: -1 | 1) => {
    const nj = sj + dir;
    if (nj < 0 || nj >= p.stages[si].steps.length) return;
    update(prev => ({
      ...prev,
      stages: prev.stages.map((s, i) => {
        if (i !== si) return s;
        const steps = [...s.steps];
        [steps[sj], steps[nj]] = [steps[nj], steps[sj]];
        return { ...s, steps };
      }),
    }));
    setSelection({ type: 'step', si, sj: nj });
  };

  const updateStep = (si: number, sj: number, patch: Partial<Step>) =>
    update(prev => ({
      ...prev,
      stages: prev.stages.map((s, i) =>
        i === si
          ? { ...s, steps: s.steps.map((st, j) => (j === sj ? { ...st, ...patch } : st)) }
          : s,
      ),
    }));

  const reorderStage = (from: number, to: number) => {
    if (from === to) return;
    update(prev => {
      const stages = [...prev.stages];
      const [item] = stages.splice(from, 1);
      stages.splice(to, 0, item);
      return { ...prev, stages };
    });
    setSelection({ type: 'stage', si: to });
  };

  const reorderStep = (si: number, from: number, to: number) => {
    if (from === to) return;
    update(prev => ({
      ...prev,
      stages: prev.stages.map((s, i) => {
        if (i !== si) return s;
        const steps = [...s.steps];
        const [item] = steps.splice(from, 1);
        steps.splice(to, 0, item);
        return { ...s, steps };
      }),
    }));
    setSelection({ type: 'step', si, sj: to });
  };

  const save = async () => {
    if (!p.name.trim()) {
      setNameError(true);
      return;
    }
    setNameError(false);
    setSaveError(null);
    setSaving(true);
    try {
      if (isNew) await api.createPipeline(p);
      else await api.updatePipeline(p.id, p);
      savedRef.current = true;
      navigate('/');
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  saveRef.current = save;

  // ── Right panel ─────────────────────────────────────────────────────────────
  const renderDetail = () => {
    // No selection → show pipeline meta fields
    if (!selection) {
      return (
        <div className="p-8 max-w-xl">
          <p className="text-xs font-semibold text-base-content/30 uppercase tracking-widest mb-6">流水线信息</p>
          <div className="space-y-5">
            <div className="form-control gap-1.5">
              <label className="label py-0">
                <span className="label-text font-medium">名称 <span className="text-error">*</span></span>
              </label>
              <input
                type="text"
                className={`input input-bordered ${nameError ? 'input-error' : ''}`}
                placeholder="例如：后端部署流程"
                value={p.name}
                onChange={e => {
                  setPipeline(prev => prev ? { ...prev, name: e.target.value } : prev);
                  setNameError(false);
                }}
                autoFocus
              />
              {nameError && <p className="text-xs text-error mt-0.5">名称不能为空</p>}
            </div>
            <div className="form-control gap-1.5">
              <label className="label py-0">
                <span className="label-text font-medium">描述 <span className="text-base-content/30 font-normal">（可选）</span></span>
              </label>
              <textarea
                className="textarea textarea-bordered leading-relaxed"
                placeholder="简要描述该流水线的用途..."
                rows={3}
                value={p.description}
                onChange={e => setPipeline(prev => prev ? { ...prev, description: e.target.value } : prev)}
              />
            </div>
            {p.stages.length === 0 && (
              <div className="pt-2">
                <p className="text-sm text-base-content/40 mb-3">点击左侧「+ 阶段」开始构建流程</p>
                <button className="btn btn-primary btn-sm" onClick={addStage}>+ 添加第一个阶段</button>
              </div>
            )}

            {/* Env vars editor */}
            <div className="pt-2 border-t border-base-200">
              <div className="flex items-center justify-between mb-2">
                <span className="label-text font-medium">环境变量</span>
                <button
                  className="btn btn-ghost btn-xs gap-1"
                  onClick={() => setPipeline(prev => prev ? { ...prev, env: [...(prev.env ?? []), { key: '', value: '' }] } : prev)}
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                  添加
                </button>
              </div>
              {(p.env ?? []).length === 0 ? (
                <p className="text-xs text-base-content/35">执行时自动 export，所有步骤可直接使用 $KEY</p>
              ) : (
                <div className="space-y-1.5">
                  {(p.env ?? []).map((ev: EnvVar, i: number) => (
                    <div key={i} className="flex gap-1.5 items-center">
                      <input
                        type="text"
                        className="input input-bordered input-xs font-mono w-32 flex-shrink-0"
                        placeholder="KEY"
                        value={ev.key}
                        onChange={e => setPipeline(prev => {
                          if (!prev) return prev;
                          const env = [...prev.env];
                          env[i] = { ...env[i], key: e.target.value.replace(/[^A-Za-z0-9_]/g, '').toUpperCase() };
                          return { ...prev, env };
                        })}
                      />
                      <span className="text-base-content/30 text-xs">=</span>
                      <input
                        type="text"
                        className="input input-bordered input-xs font-mono flex-1 min-w-0"
                        placeholder="value"
                        value={ev.value}
                        onChange={e => setPipeline(prev => {
                          if (!prev) return prev;
                          const env = [...prev.env];
                          env[i] = { ...env[i], value: e.target.value };
                          return { ...prev, env };
                        })}
                      />
                      <button
                        className="btn btn-ghost btn-xs text-error/60 hover:text-error px-1"
                        onClick={() => setPipeline(prev => {
                          if (!prev) return prev;
                          const env = prev.env.filter((_, j) => j !== i);
                          return { ...prev, env };
                        })}
                      >✕</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      );
    }

    if (selection.type === 'stage') {
      const stage = p.stages[selection.si];
      if (!stage) return null;
      return (
        <div className="p-8 max-w-xl">
          <div className="flex items-center gap-2 mb-6">
            <div className="w-6 h-6 rounded-full bg-primary text-primary-content flex items-center justify-center text-xs font-bold flex-shrink-0">
              {selection.si + 1}
            </div>
            <span className="text-xs font-semibold text-base-content/30 uppercase tracking-widest">
              阶段 {selection.si + 1} / {p.stages.length}
            </span>
          </div>
          <div className="form-control gap-1.5">
            <label className="label py-0">
              <span className="label-text font-medium">阶段名称</span>
            </label>
            <input
              type="text"
              className="input input-bordered"
              placeholder="例如：构建 / 测试 / 部署"
              value={stage.name}
              onChange={e => updateStage(selection.si, { name: e.target.value })}
              autoFocus
            />
          </div>
          <p className="text-xs text-base-content/35 leading-relaxed mt-4">
            阶段是流程中的一个大节点，包含若干操作步骤。多个阶段按顺序执行，某阶段失败后续阶段不会运行。
          </p>
          <div className="mt-6 pt-4 border-t border-base-200">
            <button className="btn btn-ghost btn-sm gap-1.5" onClick={() => addStep(selection.si)}>
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
              在此阶段添加步骤
            </button>
          </div>
        </div>
      );
    }

    if (selection.type === 'step' && selection.sj !== undefined) {
      const stage = p.stages[selection.si];
      const step = stage?.steps[selection.sj];
      if (!step) return null;
      return (
        <div className="p-8 max-w-2xl flex flex-col gap-5 h-full">
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="text-xs font-semibold text-base-content/30 uppercase tracking-widest">
              {p.stages[selection.si]?.name || `阶段 ${selection.si + 1}`} › 步骤 {selection.sj + 1} / {stage.steps.length}
            </span>
          </div>

          <div className="form-control gap-1.5 flex-shrink-0">
            <label className="label py-0">
              <span className="label-text font-medium">步骤名称</span>
            </label>
            <input
              type="text"
              className="input input-bordered input-sm"
              placeholder="例如：安装依赖 / 编译代码 / 重启服务"
              value={step.name}
              onChange={e => updateStep(selection.si, selection.sj!, { name: e.target.value })}
              autoFocus
            />
          </div>

          <div className="form-control gap-1.5 flex-1 flex flex-col min-h-0">
            <label className="label py-0 flex-shrink-0">
              <span className="label-text font-medium">Shell 命令</span>
              <span className="label-text-alt text-base-content/30 text-[11px]">支持多行，可使用 export 传递变量</span>
              <button
                type="button"
                className="btn btn-ghost btn-xs gap-1 text-base-content/50 hover:text-success"
                onClick={() => setSandboxCmd(step.command)}
                disabled={!step.command.trim()}
                title="在沙箱中试运行此步骤命令"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                试运行
              </button>
            </label>
            <ShellEditor
              value={step.command}
              onChange={val => updateStep(selection.si, selection.sj!, { command: val })}
              placeholder={'# 示例\nnpm install\nnpm run build'}
            />
          </div>

          <div className="form-control flex-shrink-0">
            <label className="label cursor-pointer justify-start gap-3 py-0">
              <input
                type="checkbox"
                className="checkbox checkbox-sm checkbox-warning"
                checked={step.continueOnError}
                onChange={e =>
                  updateStep(selection.si, selection.sj!, { continueOnError: e.target.checked })
                }
              />
              <div>
                <span className="label-text">失败后继续</span>
                <p className="text-xs text-base-content/35 mt-0.5">此步骤出错时跳过并继续后续步骤（适合非关键操作）</p>
              </div>
            </label>
          </div>

          <div className="form-control flex-shrink-0">
            <label className="label py-0 pb-1">
              <span className="label-text font-medium">超时限制（秒）</span>
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                className="input input-bordered input-sm w-28"
                min={0}
                max={86400}
                placeholder="不限制"
                value={step.timeout ?? ''}
                onChange={e => {
                  const v = e.target.value === '' ? undefined : Math.max(0, Math.floor(Number(e.target.value)));
                  updateStep(selection.si, selection.sj!, { timeout: v });
                }}
              />
              <span className="text-xs text-base-content/40">0 或空 = 不限制</span>
            </div>
            <p className="text-xs text-base-content/35 mt-1">超时后步骤以退出码 143 终止</p>
          </div>
        </div>
      );
    }

    return null;
  };

  return (
    <div className="flex flex-col h-screen bg-base-100">
      {/* Sandbox modal */}
      {sandboxCmd !== null && (
        <SandboxModal key={sandboxCmd} command={sandboxCmd} onClose={() => setSandboxCmd(null)} />
      )}

      {/* Leave confirmation dialog */}
      {blocker.state === 'blocked' && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-base-100 rounded-xl p-6 shadow-xl max-w-sm w-full mx-4 space-y-4">
            <h3 className="font-semibold text-base">离开页面？</h3>
            <p className="text-sm text-base-content/60">当前修改尚未保存，离开后将丢失。</p>
            <div className="flex justify-end gap-2">
              <button className="btn btn-ghost btn-sm" onClick={() => blocker.reset()}>继续编辑</button>
              <button className="btn btn-error btn-sm" onClick={() => blocker.proceed()}>放弃修改</button>
            </div>
          </div>
        </div>
      )}
      {/* Navbar */}
      <div className="navbar bg-base-200 border-b border-base-300 px-4 flex-shrink-0 min-h-12">
        <div className="flex-1 gap-2 min-w-0">
          <button className="btn btn-ghost btn-sm gap-1 flex-shrink-0" onClick={() => navigate('/')}>
            ← 返回
          </button>
          <span className="divider divider-horizontal mx-0 flex-shrink-0"></span>
          <div className="min-w-0">
            <span className="text-xs text-base-content/40">{isNew ? '新建流水线' : '编辑流水线'}</span>
            {p.name && (
              <span className="text-sm font-medium text-base-content/70 ml-1.5 truncate">{p.name}</span>
            )}
          </div>
        </div>
        <div className="flex-none flex items-center gap-2">
          {isDirty() && (
            <span className="text-xs text-base-content/40 hidden sm:inline">未保存</span>
          )}
          <button className="btn btn-primary btn-sm gap-1.5" onClick={() => void save()} disabled={saving} title="保存 (⌘S)">
            {saving
              ? <span className="loading loading-spinner loading-xs"></span>
              : <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" /></svg>
            }
            保存
            <kbd className="kbd kbd-xs opacity-50 hidden sm:inline">⌘S</kbd>
          </button>
        </div>
      </div>

      {/* Save error banner */}
      {saveError && (
        <div className="flex items-center gap-3 px-4 py-2 bg-error/10 border-b border-error/30 text-error text-sm flex-shrink-0">
          <span className="flex-1">{saveError}</span>
          <button className="btn btn-ghost btn-xs" onClick={() => setSaveError(null)}>✕</button>
        </div>
      )}

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar: stage/step tree */}
        <div className="w-72 flex-shrink-0 border-r border-base-300 bg-base-200 flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-base-300 flex-shrink-0">
            <span className="text-xs font-semibold text-base-content/40 uppercase tracking-wide">
              阶段 ({p.stages.length})
            </span>
            <button className="btn btn-ghost btn-xs" onClick={addStage}>
              + 阶段
            </button>
          </div>

          {p.stages.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-base-content/25 text-sm px-6 text-center gap-3">
              <span className="text-3xl">⟳</span>
              <p>点击「+ 阶段」创建第一个阶段</p>
            </div>
          ) : (
            <div className="overflow-y-auto flex-1 p-3">
              <StageFlow
                stages={p.stages}
                selection={selection}
                onSelectStage={si => setSelection({ type: 'stage', si })}
                onSelectStep={(si, sj) => setSelection({ type: 'step', si, sj })}
                onAddStep={addStep}
                onDeleteStage={deleteStage}
                onDeleteStep={deleteStep}
                onMoveStage={moveStage}
                onMoveStep={moveStep}
                onReorderStage={reorderStage}
                onReorderStep={reorderStep}
              />
            </div>
          )}
        </div>

        {/* Right: detail panel */}
        <div className="flex-1 overflow-y-auto">{renderDetail()}</div>
      </div>
    </div>
  );
}
