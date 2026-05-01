import {
  useEffect,
  useRef,
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
} from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { StepStatus } from '../types';

export interface XTermHandle {
  start: (pipelineId: string) => void;
  stop: () => void;
  clear: () => void;
  getBuffer: () => string;
  replay: (data: string) => void;
}

interface Props {
  onStepStatus: (si: number, sj: number, status: StepStatus, durationMs?: number) => void;
  onRunningChange: (running: boolean) => void;
  onStepVars?: (si: number, sj: number, vars: Record<string, string>) => void;
}

const XTerm = forwardRef<XTermHandle, Props>(function XTerm(
  { onStepStatus, onRunningChange, onStepVars },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const outputBufferRef = useRef<string>('');

  // Keep callbacks fresh without re-creating imperative handle
  const onStepStatusRef = useRef(onStepStatus);
  const onRunningChangeRef = useRef(onRunningChange);
  const onStepVarsRef = useRef(onStepVars);
  useLayoutEffect(() => {
    onStepStatusRef.current = onStepStatus;
    onRunningChangeRef.current = onRunningChange;
    onStepVarsRef.current = onStepVars;
  });

  // Init terminal once on mount
  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
        selectionBackground: '#264f78',
      },
      fontFamily: '"JetBrains Mono", "Cascadia Code", "Fira Code", monospace',
      fontSize: 13,
      lineHeight: 1.45,
      cursorBlink: false,
      convertEol: true,
      scrollback: 5000,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    termRef.current = term;
    fitAddonRef.current = fit;

    const ro = new ResizeObserver(() => fitAddonRef.current?.fit());
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      wsRef.current?.close();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  useImperativeHandle(ref, () => ({
    start(pipelineId: string) {
      const term = termRef.current;
      if (!term) return;

      wsRef.current?.close();
      term.write('\x1b[2J\x1b[H');
      outputBufferRef.current = '';

      onRunningChangeRef.current(true);

      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/pty?pipeline=${pipelineId}`);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        if (fitAddonRef.current && termRef.current) {
          ws.send(`\x1b[RESIZE:${termRef.current.cols};${termRef.current.rows}]`);
        }
      };

      ws.onmessage = (e: MessageEvent) => {
        if (!termRef.current) return;
        const chunk =
          typeof e.data === 'string'
            ? e.data
            : new TextDecoder().decode(e.data as ArrayBuffer);

        const out = chunk
          .replace(/\x01STEP_START:(\d+):(\d+)\x01\r?\n?/g, (_, si, sj) => {
            onStepStatusRef.current(+si, +sj, 'running');
            return '';
          })
          .replace(/\x01STEP_END:(\d+):(\d+):(\d+)(?::(\d+))?\x01\r?\n?/g, (_, si, sj, c, dt) => {
            onStepStatusRef.current(+si, +sj, +c === 0 ? 'done' : 'failed', dt !== undefined ? +dt : undefined);
            return '';
          })
          .replace(/\x01STEP_VARS:(\d+):(\d+):([^\x01]*)\x01\r?\n?/g, (_, si, sj, jsonStr) => {
            try {
              const vars = JSON.parse(jsonStr) as Record<string, string>;
              if (Object.keys(vars).length > 0) onStepVarsRef.current?.(+si, +sj, vars);
            } catch { /* ignore malformed */ }
            return '';
          });
        if (out) {
          termRef.current.write(out);
          outputBufferRef.current += out;
        }
        termRef.current.scrollToBottom();
      };

      ws.onclose = () => {
        wsRef.current = null;
        onRunningChangeRef.current(false);
      };

      ws.onerror = () => {
        wsRef.current = null;
        onRunningChangeRef.current(false);
      };
    },

    clear() {
      termRef.current?.clear();
      termRef.current?.write('\x1b[2J\x1b[H');
      outputBufferRef.current = '';
    },
    stop() {
      wsRef.current?.close();
    },
    getBuffer() {
      return outputBufferRef.current;
    },
    replay(data: string) {
      const term = termRef.current;
      if (!term) return;
      term.write('\x1b[2J\x1b[H');
      term.write(data);
      term.scrollToBottom();
    },
  }));

  return (
    <div className="w-full h-full" style={{ background: '#1e1e1e', padding: '12px', boxSizing: 'border-box' }}>
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
});

export default XTerm;
