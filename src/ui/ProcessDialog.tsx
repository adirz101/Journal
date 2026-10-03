import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { api } from './types';
import { terminalThemes, type Appearance } from './theme';

// A visible terminal for a one-off process Journal started at the user's
// request (installing or signing in to a CLI). Output is shown, never stored.
export function ProcessDialog({ id, title, command, appearance, onClose, onExit }: {
  id: string; title: string; command?: string; appearance: Appearance; onClose: () => void; onExit: (code: number | null) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null); const host = useRef<HTMLDivElement>(null);
  const [code, setCode] = useState<number | null | undefined>(undefined);
  const exitRef = useRef(onExit); exitRef.current = onExit; const terminalRef = useRef<Terminal | null>(null); const appearanceRef = useRef(appearance);
  // Theme changes restyle the terminal in place; they never restart it.
  useEffect(() => { appearanceRef.current = appearance; if (terminalRef.current) terminalRef.current.options.theme = terminalThemes[appearance]; }, [appearance]);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    const terminal = new Terminal({ fontSize: 12, lineHeight: 1.3, scrollback: 2000, convertEol: false, theme: terminalThemes[appearanceRef.current], fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace' });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host.current!); terminalRef.current = terminal;
    terminal.parser.registerOscHandler(52, () => true); // no clipboard writes from the process
    requestAnimationFrame(() => { fit.fit(); void api('processResize', { id, cols: terminal.cols, rows: terminal.rows }).catch(() => {}); terminal.focus(); });
    const input = terminal.onData(data => void api('processInput', { id, data }).catch(() => {}));
    // Subscribe first, then catch up from the snapshot; offsets drop duplicates.
    let written = -1; const queued: { data: string; offset: number }[] = [];
    const write = (data: string, offset: number) => { if (offset + data.length <= written) return; terminal.write(offset < written ? data.slice(written - offset) : data); written = offset + data.length; };
    let finished = false;
    const finish = (exit: number | null) => { if (finished) return; finished = true; setCode(exit); exitRef.current(exit); };
    const off = window.journal?.onEvent(event => {
      if (event.type === 'process-output' && event.id === id) { if (written < 0) queued.push(event); else write(event.data, event.offset); }
      if (event.type === 'process-exit' && event.id === id) finish(event.code);
    });
    void api<{ data: string; length: number; done: boolean; code: number | null }>('processSnapshot', { id }).then(snapshot => {
      terminal.write(snapshot.data); written = snapshot.length;
      for (const event of queued) write(event.data, event.offset);
      if (snapshot.done) finish(snapshot.code);
    }).catch(() => { written = 0; for (const event of queued) write(event.data, event.offset); });
    return () => { off?.(); input.dispose(); terminalRef.current = null; terminal.dispose(); };
  }, [id]);
  const running = code === undefined;
  return <dialog ref={dialog} className="knowledge-dialog process-dialog" aria-labelledby="process-title" onCancel={event => { if (running) event.preventDefault(); else onClose(); }}>
    <div className="dialog-heading"><div><span className="eyebrow">VISIBLE PROCESS</span><h2 id="process-title">{title}</h2></div></div>
    {command && <p className="muted">Running <code>{command}</code></p>}
    <div className="process-terminal" ref={host} />
    <p className="process-status" role="status">{running ? 'Running…' : code === 0 ? 'Finished (exit 0).' : `Finished with exit code ${code ?? 'unknown'}.`}</p>
    <div className="dialog-actions">
      {running ? <button onClick={() => void api('processStop', { id }).catch(() => {})}>Stop</button> : <button className="primary" onClick={onClose}>Done</button>}
    </div>
  </dialog>;
}
