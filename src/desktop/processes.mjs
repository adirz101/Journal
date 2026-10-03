// Visible one-off processes (installing the Cursor CLI, signing in to it): a
// pseudo-terminal whose output streams to a Journal dialog and whose input
// comes only from that dialog. Nothing is written to disk, so a sign-in flow's
// output (URLs, codes) is never stored.

export class ProcessRunner {
  constructor(send, spawn) { this.send = send; this.spawn = spawn; this.processes = new Map(); this.sequence = 0; }
  async start(kind, { file, args, env, cwd }) {
    if ([...this.processes.values()].some(entry => entry.kind === kind && !entry.done)) throw new Error('This is already running');
    const id = `process-${++this.sequence}`;
    const proc = await this.spawn(file, args, { name: 'xterm-256color', cols: 100, rows: 24, cwd, env });
    // A bounded in-memory copy lets a dialog that opens a moment later catch up.
    const entry = { id, kind, proc, done: false, code: null, output: '', length: 0 };
    this.processes.set(id, entry);
    proc.onData(data => { const offset = entry.length; entry.length += data.length; entry.output = (entry.output + data).slice(-65536); this.send({ type: 'process-output', id, data, offset }); });
    proc.onExit(({ exitCode }) => { entry.done = true; entry.code = exitCode; this.send({ type: 'process-exit', id, kind, code: exitCode }); setTimeout(() => this.processes.delete(id), 60000).unref?.(); });
    return { id };
  }
  snapshot(id) { const entry = this.processes.get(id); if (!entry) throw new Error('Unknown process'); return { data: entry.output, length: entry.length, done: entry.done, code: entry.code }; }
  owned(id) { const entry = this.processes.get(id); if (!entry || entry.done) throw new Error('This process has finished'); return entry; }
  write(id, data) { if (typeof data !== 'string' || data.length > 4096) throw new Error('Invalid input'); this.owned(id).proc.write(data); }
  resize(id, cols, rows) { if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 || cols > 500 || rows > 300) return; this.owned(id).proc.resize(cols, rows); }
  stop(id) { const entry = this.processes.get(id); if (entry && !entry.done) entry.proc.kill(); }
  stopAll() { for (const entry of this.processes.values()) if (!entry.done) { try { entry.proc.kill(); } catch { /* exited */ } } }
}
