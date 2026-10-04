import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import { api, type OutputSnapshot, type TerminalEvent } from './types';
import { MONO_FONT, monoFontFamily, terminalThemes, type Appearance } from './theme';

// What a wrap-up can ask of an ended session's terminal (Phase 6): its last lines as text.
export interface TerminalHandle { copyText(maxLines?: number): string }

// onUnavailable: the runtime has no buffer for this session (released or from an earlier
// run): attach answers with no chunks, a gap and sequence 0. focusOnAttach: false for a
// read-only preview that must not take the keyboard (journal:focus-terminal without a
// session ID skips it, as it skips a terminal that is not rendered). onReady: the replay
// is on screen, so copyText has something to read.
export function TerminalPane({ sessionId, live, appearance, onError, onUnavailable, onReady, handleRef, focusOnAttach = true }: { sessionId: string; live: boolean; appearance: Appearance; onError: (message: string) => void;
  onUnavailable?: () => void; onReady?: () => void; handleRef?: Ref<TerminalHandle>; focusOnAttach?: boolean }) {
  const host = useRef<HTMLDivElement>(null); const liveRef = useRef(live); const errorRef = useRef(onError);
  const unavailableRef = useRef(onUnavailable); unavailableRef.current = onUnavailable; const focusRef = useRef(focusOnAttach); focusRef.current = focusOnAttach;
  const readyRef = useRef(onReady); readyRef.current = onReady;
  // The last lines of the buffer, read on request; nothing is stored.
  useImperativeHandle(handleRef, () => ({
    copyText(maxLines = 500) {
      const buffer = terminalRef.current?.buffer.active; if (!buffer) return '';
      const lines: string[] = [];
      for (let index = Math.max(0, buffer.length - maxLines); index < buffer.length; index++) lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
      while (lines.length && !lines.at(-1)) lines.pop();
      return lines.join('\n');
    },
  }), []);
  const terminalRef = useRef<Terminal | null>(null); const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;
  liveRef.current = live; errorRef.current = onError;
  useEffect(() => {
    if (!host.current) return;
    let disposed = false; let attached = false; let acceptInput = false; let last = 0; const queued: TerminalEvent[] = [];
    // A late bundled font switches the family, so xterm re-measures and the terminal refits.
    const font = monoFontFamily(document.fonts, () => { if (disposed) return; terminal.options.fontFamily = MONO_FONT; resize(); });
    // Bounded scrollback per visible terminal; the runtime keeps 256 KiB per session.
    const terminal = new Terminal({ cursorBlink: false, fontSize: 13, lineHeight: 1.35, scrollback: 4000, allowProposedApi: true,
      fontFamily: font.family, fontWeight: 400, fontWeightBold: 600,
      theme: terminalThemes[appearanceRef.current] });
    terminalRef.current = terminal;
    const fit = new FitAddon(); terminal.loadAddon(fit);
    // Unicode 11 widths keep CJK and emoji aligned with what CLIs assume.
    terminal.loadAddon(new Unicode11Addon()); terminal.unicode.activeVersion = '11';
    terminal.open(host.current);
    terminal.parser.registerOscHandler(52, () => true); // Never accept terminal-originated clipboard writes.
    terminal.parser.registerOscHandler(8, () => true); // No automatic links to external applications.
    const failed = (error: unknown) => { if (!disposed) errorRef.current(String(error instanceof Error ? error.message : error)); };
    function handle(event: TerminalEvent) {
      if (disposed) return;
      // A restarted runtime keeps its own buffer: attach again and repaint.
      if (event.type === 'runtime') { if (event.state === 'connected') { attached = false; acceptInput = false; queued.length = 0; terminal.reset(); attach(); } return; }
      if ((event.type !== 'output' && event.type !== 'gap') || event.sessionId !== sessionId) return;
      if (!attached) { queued.push(event); return; }
      if (event.type === 'gap') { terminal.write('\r\n\x1b[33m[Output skipped while display was behind]\x1b[0m\r\n'); return; }
      if (event.sequence <= last) return;
      last = event.sequence;
      terminal.write(event.data, () => { if (!disposed) void api('acknowledge', { id: sessionId, sequence: event.sequence }).catch(failed); });
    }
    const removeListener = window.journal?.onEvent(handle);
    const attach = () => void api<OutputSnapshot>('attach', { id: sessionId }).then(snapshot => {
      if (disposed) return;
      if (unavailableRef.current && !snapshot.chunks.length && snapshot.gap && snapshot.lastSequence === 0) { unavailableRef.current(); return; }
      last = snapshot.lastSequence;
      const prefix = snapshot.gap ? '\x1b[33m[Earlier terminal output is unavailable; input has not been replayed]\x1b[0m\r\n' : '';
      // Historical device queries may make xterm emit replies. Keep PTY input
      // disabled until the snapshot has finished parsing, not just been queued.
      terminal.write(prefix + snapshot.chunks.map(chunk => chunk.data).join(''), () => {
        if (disposed) return;
        attached = true; acceptInput = true; for (const event of queued) handle(event); queued.length = 0;
        readyRef.current?.();
        if (focusRef.current) terminal.focus();
      });
    }).catch(failed);
    attach();
    const input = terminal.onData(data => { if (acceptInput && liveRef.current) void api('write', { id: sessionId, data }).catch(failed); });
    // No session ID: whichever terminal is shown (an overlay returning focus).
    // A read-only preview takes focus only when asked for by its session ID; a hidden one never.
    const focus = (event: Event) => {
      const target = (event as CustomEvent).detail;
      if (target === undefined ? !focusRef.current : target !== sessionId) return;
      if (!host.current?.isConnected || !host.current.getClientRects().length) return;
      terminal.focus();
    };
    window.addEventListener('journal:focus-terminal', focus);
    // Only a changed size is sent: the runtime treats output right after a resize
    // as a repaint, not agent output, so layout changes that keep the size must not count.
    let resizeFrame = 0; let sent = '';
    const resize = () => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        if (disposed) return; fit.fit();
        const size = `${terminal.cols}x${terminal.rows}`;
        if (liveRef.current && terminal.cols > 1 && terminal.rows > 1 && size !== sent) { sent = size; void api('resize', { id: sessionId, cols: terminal.cols, rows: terminal.rows }).catch(failed); }
      });
    };
    const observer = new ResizeObserver(resize); observer.observe(host.current); resize();
    const unfocus = () => window.removeEventListener('journal:focus-terminal', focus);
    return () => { unfocus(); font.stop(); disposed = true; void api('detach', { id: sessionId }).catch(() => {}); cancelAnimationFrame(resizeFrame); observer.disconnect(); removeListener?.(); input.dispose(); terminalRef.current = null; terminal.dispose(); };
  }, [sessionId]);
  useEffect(() => { if (terminalRef.current) terminalRef.current.options.theme = terminalThemes[appearance]; }, [appearance]);
  return <div ref={host} className="terminal-surface" role="group" aria-label="Agent terminal" />;
}
