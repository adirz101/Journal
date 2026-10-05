// Visible one-off processes (installing a provider's CLI, signing in to it): a
// pseudo-terminal whose output streams to a Journal dialog and whose input
// comes only from that dialog. Nothing is written to disk, so a sign-in flow's
// output (URLs, codes) is never stored.

const PROVIDERS = ['claude', 'codex', 'cursor']; const KINDS = ['install', 'login'];

export class ProcessRunner {
  constructor(send, spawn) { this.send = send; this.spawn = spawn; this.processes = new Map(); this.sequence = 0; }
  // One run per provider and kind: Codex can sign in while Cursor installs, and a
  // second click on the same row is refused.
  async start(slot, { file, args, env, cwd }) {
    const { provider, kind } = slot ?? {};
    if (!PROVIDERS.includes(provider) || !KINDS.includes(kind)) throw new Error('Invalid process');
    // The slot is taken before anything is awaited, so a double click starts one process.
    if ([...this.processes.values()].some(entry => entry.provider === provider && entry.kind === kind && !entry.done)) throw new Error('This is already running');
    const id = `process-${++this.sequence}`;
    // A bounded in-memory copy lets a dialog that opens a moment later catch up.
    const entry = { id, provider, kind, proc: null, done: false, code: null, output: '', length: 0 };
    this.processes.set(id, entry);
    let proc;
    try { proc = await this.spawn(file, args, { name: 'xterm-256color', cols: 100, rows: 24, cwd, env }); }
    catch (error) { this.processes.delete(id); throw error; }
    entry.proc = proc;
    proc.onData(data => { const offset = entry.length; entry.length += data.length; entry.output = (entry.output + data).slice(-65536); this.send({ type: 'process-output', id, data, offset }); });
    proc.onExit(({ exitCode }) => { entry.done = true; entry.code = exitCode; this.send({ type: 'process-exit', id, provider, kind, code: exitCode }); setTimeout(() => this.processes.delete(id), 60000).unref?.(); });
    return { id };
  }
  snapshot(id) { const entry = this.processes.get(id); if (!entry) throw new Error('Unknown process'); return { data: entry.output, length: entry.length, done: entry.done, code: entry.code }; }
  owned(id) { const entry = this.processes.get(id); if (!entry?.proc || entry.done) throw new Error('This process has finished'); return entry; }
  write(id, data) { if (typeof data !== 'string' || data.length > 4096) throw new Error('Invalid input'); this.owned(id).proc.write(data); }
  resize(id, cols, rows) { if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 || cols > 500 || rows > 300) return; this.owned(id).proc.resize(cols, rows); }
  running() { return [...this.processes.values()].filter(entry => !entry.done).map(({ provider, kind }) => ({ provider, kind })); }
  // The whole process group on macOS and Linux (an installer pipeline has children).
  kill(entry) {
    if (!entry?.proc || entry.done) return;
    if (process.platform !== 'win32' && Number.isInteger(entry.proc.pid)) { try { process.kill(-entry.proc.pid, 'SIGTERM'); return; } catch { /* fall back to the leader */ } }
    try { entry.proc.kill(); } catch { /* exited */ }
  }
  stop(id) { this.kill(this.processes.get(id)); }
  stopAll() { for (const entry of this.processes.values()) this.kill(entry); }
}
