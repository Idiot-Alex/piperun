import { useRef, useState } from 'react';
import type { Stage, Selection } from '../types';

interface Props {
  stages: Stage[];
  selection: Selection | null;
  onSelectStage: (si: number) => void;
  onSelectStep: (si: number, sj: number) => void;
  onAddStep: (si: number) => void;
  onDeleteStage: (si: number) => void;
  onDeleteStep: (si: number, sj: number) => void;
  onMoveStage: (si: number, dir: -1 | 1) => void;
  onMoveStep: (si: number, sj: number, dir: -1 | 1) => void;
  onReorderStage?: (from: number, to: number) => void;
  onReorderStep?: (si: number, from: number, to: number) => void;
}

type DragSrc =
  | { type: 'stage'; si: number }
  | { type: 'step'; si: number; sj: number };

type DragOver =
  | { type: 'stage'; si: number }
  | { type: 'step'; si: number; sj: number }
  | null;

export default function StageFlow({
  stages, selection,
  onSelectStage, onSelectStep, onAddStep,
  onDeleteStage, onDeleteStep, onMoveStage, onMoveStep,
  onReorderStage, onReorderStep,
}: Props) {
  const dragSrc = useRef<DragSrc | null>(null);
  const [dragOver, setDragOver] = useState<DragOver>(null);

  const isDragOverStage = (si: number) =>
    dragOver?.type === 'stage' && dragOver.si === si;

  const isDragOverStep = (si: number, sj: number) =>
    dragOver?.type === 'step' && dragOver.si === si && dragOver.sj === sj;

  return (
    <div className="space-y-2">
      {stages.map((stage, si) => {
        const isStageSelected = selection?.type === 'stage' && selection.si === si;
        return (
          <div key={stage.id}>
            {si > 0 && (
              <div className="text-center text-base-content/20 text-xs py-1 select-none">↓</div>
            )}
            <div
              className={`rounded-xl border transition-colors overflow-hidden
                ${isStageSelected ? 'border-primary/60 bg-base-100' : 'border-base-300 bg-base-100'}
                ${isDragOverStage(si) ? 'ring-2 ring-primary/40 border-primary/40' : ''}`}
              onDragOver={e => {
                if (dragSrc.current?.type !== 'stage') return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setDragOver({ type: 'stage', si });
              }}
              onDragLeave={e => {
                if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
                  setDragOver(null);
                }
              }}
              onDrop={e => {
                e.preventDefault();
                setDragOver(null);
                const src = dragSrc.current;
                if (!src || src.type !== 'stage' || src.si === si) return;
                onReorderStage?.(src.si, si);
                dragSrc.current = null;
              }}
            >
              {/* Stage header */}
              <div
                draggable
                onDragStart={e => {
                  dragSrc.current = { type: 'stage', si };
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', `stage:${si}`);
                }}
                onDragEnd={() => { dragSrc.current = null; setDragOver(null); }}
                className={`flex items-center gap-2 px-3 py-2.5 cursor-pointer transition-colors group/stage
                  ${isStageSelected ? 'bg-primary/10' : 'hover:bg-base-200'}`}
                onClick={() => onSelectStage(si)}
              >
                {/* Drag handle */}
                <span
                  className="text-base-content/20 hover:text-base-content/50 cursor-grab active:cursor-grabbing select-none text-sm flex-shrink-0"
                  title="拖拽排序"
                  onClick={e => e.stopPropagation()}
                >⠿</span>
                <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0
                  ${isStageSelected ? 'bg-primary text-primary-content' : 'bg-base-300 text-base-content/60'}`}>
                  {si + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <div className={`text-sm font-medium truncate
                    ${isStageSelected ? 'text-primary' : 'text-base-content/80'}`}>
                    {stage.name || '(未命名阶段)'}
                  </div>
                  <div className="text-[11px] text-base-content/40">{stage.steps.length} 个步骤</div>
                </div>
                <div className="flex gap-0.5 opacity-0 group-hover/stage:opacity-100 transition-opacity flex-shrink-0">
                  {si > 0 && (
                    <button
                      className="btn btn-ghost btn-xs px-1.5 h-6 min-h-6"
                      onClick={e => { e.stopPropagation(); onMoveStage(si, -1); }}
                    >↑</button>
                  )}
                  {si < stages.length - 1 && (
                    <button
                      className="btn btn-ghost btn-xs px-1.5 h-6 min-h-6"
                      onClick={e => { e.stopPropagation(); onMoveStage(si, 1); }}
                    >↓</button>
                  )}
                  <button
                    className="btn btn-ghost btn-xs px-1.5 h-6 min-h-6 text-error hover:bg-error/10"
                    onClick={e => {
                      e.stopPropagation();
                      if (stage.steps.length > 0 && !confirm(`删除「${stage.name || '未命名阶段'}」及其 ${stage.steps.length} 个步骤？`)) return;
                      onDeleteStage(si);
                    }}
                  >✕</button>
                </div>
              </div>

              {/* Steps */}
              <div className="px-3 pb-2 space-y-0.5 border-t border-base-300/50">
                {stage.steps.map((step, sj) => {
                  const isStepSelected =
                    selection?.type === 'step' && selection.si === si && selection.sj === sj;
                  return (
                    <div
                      key={step.id}
                      draggable
                      onDragStart={e => {
                        dragSrc.current = { type: 'step', si, sj };
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', `step:${si}:${sj}`);
                        e.stopPropagation();
                      }}
                      onDragEnd={() => { dragSrc.current = null; setDragOver(null); }}
                      onDragOver={e => {
                        const src = dragSrc.current;
                        if (!src || src.type !== 'step' || src.si !== si) return;
                        e.preventDefault();
                        e.stopPropagation();
                        e.dataTransfer.dropEffect = 'move';
                        setDragOver({ type: 'step', si, sj });
                      }}
                      onDragLeave={() => setDragOver(null)}
                      onDrop={e => {
                        e.preventDefault();
                        e.stopPropagation();
                        setDragOver(null);
                        const src = dragSrc.current;
                        if (!src || src.type !== 'step' || src.si !== si || src.sj === sj) return;
                        onReorderStep?.(si, src.sj, sj);
                        dragSrc.current = null;
                      }}
                      className={`flex items-center gap-2 pl-2 pr-2 py-1.5 rounded-lg cursor-pointer transition-colors group/step mt-1
                        ${isStepSelected ? 'bg-primary/10 text-primary' : 'hover:bg-base-200 text-base-content/50'}
                        ${isDragOverStep(si, sj) ? 'ring-1 ring-primary/40' : ''}`}
                      onClick={e => { e.stopPropagation(); onSelectStep(si, sj); }}
                    >
                      {/* Step drag handle */}
                      <span
                        className="text-base-content/20 hover:text-base-content/50 cursor-grab active:cursor-grabbing select-none text-xs flex-shrink-0"
                        onClick={e => e.stopPropagation()}
                      >⠿</span>
                      <span className={`text-xs flex-shrink-0 ${isStepSelected ? 'text-primary' : 'text-base-content/30'}`}>
                        •
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs truncate">
                          {step.name || '(未命名步骤)'}
                        </div>
                        {step.command ? (
                          <div className="text-[10px] font-mono text-base-content/25 truncate mt-0.5">
                            {step.command.split('\n')[0].slice(0, 32)}
                          </div>
                        ) : (
                          <div className="text-[10px] text-warning/70 mt-0.5">命令为空</div>
                        )}
                      </div>
                      <div className="flex gap-0.5 opacity-0 group-hover/step:opacity-100 transition-opacity flex-shrink-0">
                        {sj > 0 && (
                          <button
                            className="btn btn-ghost btn-xs px-1 h-5 min-h-5 text-xs"
                            onClick={e => { e.stopPropagation(); onMoveStep(si, sj, -1); }}
                          >↑</button>
                        )}
                        {sj < stage.steps.length - 1 && (
                          <button
                            className="btn btn-ghost btn-xs px-1 h-5 min-h-5 text-xs"
                            onClick={e => { e.stopPropagation(); onMoveStep(si, sj, 1); }}
                          >↓</button>
                        )}
                        <button
                          className="btn btn-ghost btn-xs px-1 h-5 min-h-5 text-error hover:bg-error/10 text-xs"
                          onClick={e => { e.stopPropagation(); onDeleteStep(si, sj); }}
                        >✕</button>
                      </div>
                    </div>
                  );
                })}
                <button
                  className="w-full text-left text-[11px] text-base-content/25 hover:text-base-content/50 pl-6 py-1.5 transition-colors"
                  onClick={() => onAddStep(si)}
                >
                  + 步骤
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

