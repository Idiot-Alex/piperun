import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface Props {
  command: string;
  onClose: () => void;
}

export default function SandboxModal({ command, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Terminal + WS lifecycle
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

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
      cursorBlink: true,
      convertEol: true,
      scrollback: 3000,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(el);

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/sandbox`);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      ws.send(JSON.stringify({ cmd: command, cols: term.cols, rows: term.rows }));
    };

    // Forward terminal keystrokes to bash stdin
    const inputDisposable = term.onData(data => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    ws.onmessage = (e: MessageEvent) => {
      const data =
        typeof e.data === 'string'
          ? e.data
          : new TextDecoder().decode(e.data as ArrayBuffer);
      term.write(data);
    };

    return () => {
      ro.disconnect();
      inputDisposable.dispose();
      ws.close();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally runs once on mount; command is captured at render time

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-3xl bg-[#1e1e1e] rounded-t-xl sm:rounded-xl shadow-2xl flex flex-col overflow-hidden"
        style={{ height: '52vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-white/10 flex-shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-emerald-400 font-semibold uppercase tracking-widest">沙箱试运行</span>
            <span className="text-[11px] text-white/30 font-mono truncate max-w-xs">
              {command.split('\n')[0].slice(0, 60)}{command.split('\n').length > 1 || command.length > 60 ? ' …' : ''}
            </span>
          </div>
          <button
            className="text-white/40 hover:text-white/80 text-base leading-none px-1"
            onClick={onClose}
            title="关闭 (Esc)"
          >
            ✕
          </button>
        </div>
        {/* Terminal */}
        <div ref={containerRef} className="flex-1 overflow-hidden" style={{ padding: '8px 4px 4px 8px' }} />
      </div>
    </div>
  );
}
