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
import type { RunResult, StepStatus } from '../types';
import { getToken } from '../api';
import { parseReplayMarkers, stripProtocolMarkers } from '../terminalProtocol';

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
  onRunResult?: (result: RunResult) => void;
  onStepVars?: (si: number, sj: number, vars: Record<string, string>) => void;
}

const XTerm = forwardRef<XTermHandle, Props>(function XTerm(
  { onStepStatus, onRunningChange, onRunResult, onStepVars },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const wsGenerationRef = useRef(0);
  const outputBufferRef = useRef<string>('');
  // Max raw bytes kept in memory for replay (~10 MB)
  const OUTPUT_BUFFER_LIMIT = 10 * 1024 * 1024;

  // Keep callbacks fresh without re-creating imperative handle
  const onStepStatusRef = useRef(onStepStatus);
  const onRunningChangeRef = useRef(onRunningChange);
  const onRunResultRef = useRef(onRunResult);
  const onStepVarsRef = useRef(onStepVars);
  useLayoutEffect(() => {
    onStepStatusRef.current = onStepStatus;
    onRunningChangeRef.current = onRunningChange;
    onRunResultRef.current = onRunResult;
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
    // Defer initial fit until the browser has finished layout so the container
    // has real pixel dimensions. Calling fit() synchronously right after open()
    // can hit xterm's internal dimension guard and throw.
    const rafId = requestAnimationFrame(() => {
      if (fitAddonRef.current) fitAddonRef.current.fit();
    });

    termRef.current = term;
    fitAddonRef.current = fit;

    const ro = new ResizeObserver(() => {
      // Guard: terminal may have been disposed before this callback fires
      if (fitAddonRef.current && termRef.current) fitAddonRef.current.fit();
    });
    ro.observe(containerRef.current);

    return () => {
      cancelAnimationFrame(rafId);
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
      const generation = wsGenerationRef.current + 1;
      wsGenerationRef.current = generation;
      term.write('\x1b[2J\x1b[H');
      outputBufferRef.current = '';

      onRunningChangeRef.current(true);

      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const token = getToken();
      const ws = new WebSocket(`${proto}//${location.host}/pty?pipeline=${pipelineId}`);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        if (token) ws.send(JSON.stringify({ type: 'auth', token }));
        if (fitAddonRef.current && termRef.current) {
          ws.send(`\x1b[RESIZE:${termRef.current.cols};${termRef.current.rows}]`);
        }
      };

      // Buffer for cross-frame marker reassembly.
      // WebSocket frames can split a \x01MARKER\x01 sequence across two frames,
      // causing the partial bytes to render as visible garbage in the terminal.
      // We hold back anything from the last unpaired \x01 until the next frame.
      let partial = '';

      const processChunk = (toProcess: string) => {
        if (!toProcess || !termRef.current) return;

        // outputBufferRef stores the RAW (pre-strip) content so that replay()
        // can recover step statuses from the same data that the server log holds.
        // Cap at OUTPUT_BUFFER_LIMIT: keep the most recent half when exceeded.
        const next = outputBufferRef.current + toProcess;
        outputBufferRef.current = next.length > OUTPUT_BUFFER_LIMIT
          ? next.slice(-(OUTPUT_BUFFER_LIMIT / 2))
          : next;

        const out = toProcess
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
          })
          .replace(/\x01RUN_END:(success|failed|timeout|stopped)\x01\r?\n?/g, (_, result: RunResult) => {
            onRunResultRef.current?.(result);
            return '';
          });

        if (out) termRef.current.write(out);
        termRef.current.scrollToBottom();
      };

      ws.onmessage = (e: MessageEvent) => {
        if (!termRef.current) return;
        const raw =
          typeof e.data === 'string'
            ? e.data
            : new TextDecoder().decode(e.data as ArrayBuffer);

        const combined = partial + raw;

        // Each complete marker is wrapped by exactly two \x01 bytes.
        // If the total count is odd, the last \x01 is an unclosed opener
        // (the frame was cut mid-marker). Hold that suffix back until the
        // next frame arrives so regexes always see complete markers.
        const sohCount = (combined.match(/\x01/g) ?? []).length;
        if (sohCount % 2 === 1) {
          const lastSoh = combined.lastIndexOf('\x01');
          processChunk(combined.slice(0, lastSoh));
          partial = combined.slice(lastSoh);
        } else {
          processChunk(combined);
          partial = '';
        }
      };

      ws.onclose = () => {
        if (wsGenerationRef.current !== generation) return;
        // Flush any buffered partial (e.g. connection dropped mid-marker).
        // Complete any truncated marker by appending a closing \x01 so the regex
        // can fire (e.g. a STEP_END whose closing byte was never delivered).
        if (partial) {
          processChunk(partial + '\x01');
          partial = '';
        }
        wsRef.current = null;
        onRunningChangeRef.current(false);
      };

      ws.onerror = () => {
        if (wsGenerationRef.current !== generation) return;
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
      wsGenerationRef.current += 1;
      onRunResultRef.current?.('stopped');
      wsRef.current?.close();
      wsRef.current = null;
      onRunningChangeRef.current(false);
    },
    getBuffer() {
      return outputBufferRef.current;
    },
    replay(data: string) {
      const term = termRef.current;
      if (!term) return;

      parseReplayMarkers(data, {
        onStepStatus: (...args) => onStepStatusRef.current(...args),
        onStepVars: (...args) => onStepVarsRef.current?.(...args),
        onRunResult: result => onRunResultRef.current?.(result),
      });

      const stripped = stripProtocolMarkers(data);
      term.write('\x1b[2J\x1b[H');
      term.write(stripped);
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
