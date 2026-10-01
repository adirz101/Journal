import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api, type OutputSnapshot, type TerminalEvent } from './types';
import { terminalThemes, type Appearance } from './theme';

export function TerminalPane({ sessionId, live, appearance, onError }: { sessionId: string; live: boolean; appearance: Appearance; onError: (message: string) => void }) {
  const host = useRef<HTMLDivElement>(null); const liveRef = useRef(live); const errorRef = useRef(onError);
  const terminalRef = useRef<Terminal | null>(null); const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;
  liveRef.current = live; errorRef.current = onError;
  useEffect(() => {
    if (!host.current) return;
    let disposed = false; let attached = false; let acceptInput = false; let last = 0; const queued: TerminalEvent[] = [];
    const terminal = new Terminal({ cursorBlink: false, fontSize: 13, lineHeight: 1.35, scrollback: 4000,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      theme: terminalThemes[appearanceRef.current] });
    terminalRef.current = terminal;
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host.current);
    terminal.parser.registerOscHandler(52, () => true); // Never accept terminal-originated clipboard writes.
    terminal.parser.registerOscHandler(8, () => true); // No automatic links to external applications.
    const failed = (error: unknown) => { if (!disposed) errorRef.current(String(error instanceof Error ? error.message : error)); };
    function handle(event: TerminalEvent) {
      if (disposed || event.type === 'status' || event.type === 'error' || event.sessionId !== sessionId) return;
      if (!attached) { queued.push(event); return; }
      if (event.type === 'gap') { terminal.write('\r\n\x1b[33m[Output skipped while display was behind]\x1b[0m\r\n'); return; }
      if (event.sequence <= last) return;
      last = event.sequence;
      terminal.write(event.data, () => { if (!disposed) void api('acknowledge', { id: sessionId, sequence: event.sequence }).catch(failed); });
    }
    const removeListener = window.journal?.onEvent(handle);
    void api<OutputSnapshot>('attach', { id: sessionId }).then(snapshot => {
      if (disposed) return;
      last = snapshot.lastSequence;
      const prefix = snapshot.gap ? '\x1b[33m[Earlier terminal output is unavailable; input has not been replayed]\x1b[0m\r\n' : '';
      // Historical device queries may make xterm emit replies. Keep PTY input
      // disabled until the snapshot has finished parsing, not just been queued.
      terminal.write(prefix + snapshot.chunks.map(chunk => chunk.data).join(''), () => {
        if (disposed) return;
        attached = true; acceptInput = true; for (const event of queued) handle(event); queued.length = 0;
        terminal.focus();
      });
    }).catch(failed);
    const input = terminal.onData(data => { if (acceptInput && liveRef.current) void api('write', { id: sessionId, data }).catch(failed); });
    let resizeFrame = 0;
    const resize = () => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        if (disposed) return; fit.fit();
        if (liveRef.current && terminal.cols > 1 && terminal.rows > 1) void api('resize', { id: sessionId, cols: terminal.cols, rows: terminal.rows }).catch(failed);
      });
    };
    const observer = new ResizeObserver(resize); observer.observe(host.current); resize();
    return () => { disposed = true; cancelAnimationFrame(resizeFrame); observer.disconnect(); removeListener?.(); input.dispose(); terminalRef.current = null; terminal.dispose(); };
  }, [sessionId]);
  useEffect(() => { if (terminalRef.current) terminalRef.current.options.theme = terminalThemes[appearance]; }, [appearance]);
  return <div ref={host} className="terminal-surface" aria-label="Agent terminal" />;
}
