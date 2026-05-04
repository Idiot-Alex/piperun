import type { Pipeline } from './types';

export function validatePipelineYaml(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'YAML 顶层必须是对象';
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== 'string' || !obj.name.trim()) return '缺少必填字段 name（字符串）';
  if (obj.env !== undefined && !Array.isArray(obj.env)) return 'env 必须是数组';
  const env = (Array.isArray(obj.env) ? obj.env : []) as unknown[];
  for (let i = 0; i < env.length; i++) {
    const item = env[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) return `环境变量 ${i + 1} 格式错误（必须是对象）`;
    const ev = item as Record<string, unknown>;
    if (typeof ev.key !== 'string' || !ev.key.trim()) return `环境变量 ${i + 1} 缺少 key（字符串）`;
    if (ev.value !== undefined && typeof ev.value !== 'string') return `环境变量 ${i + 1} 的 value 必须是字符串`;
  }
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
      if (st.retries !== undefined && (typeof st.retries !== 'number' || st.retries < 0 || st.retries > 10)) return `阶段 ${si + 1} 步骤 ${sj + 1} 的 retries 必须是 0-10 的整数`;
    }
  }
  return null;
}

export function pipelineToYamlData(p: Pipeline) {
  return {
    name: p.name,
    description: p.description || undefined,
    env: p.env?.length ? p.env.map(ev => ({
      key: ev.key,
      value: ev.value,
    })) : undefined,
    stages: p.stages.map(s => ({
      name: s.name,
      steps: s.steps.map(st => ({
        name: st.name,
        command: st.command || undefined,
        continueOnError: st.continueOnError || undefined,
        timeout: st.timeout ? st.timeout : undefined,
        retries: st.retries ? st.retries : undefined,
      })),
    })),
  };
}
