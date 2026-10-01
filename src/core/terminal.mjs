import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { buildAgentLaunch, captureCodexId, CODEX_RESUME_MARKER, UUID } from './agents.mjs';
import { text } from './validation.mjs';

export class OutputBuffer {
  constructor(limit = 256 * 1024) { this.limit = limit; this.bytes = 0; this.chunks = []; this.sequence = 0; }
  append(data) {
    // Code-point iteration keeps UTF-16 pairs intact; chunks also bound IPC messages.
    let part = ''; let size = 0;
    const flush = () => {
      if (!part) return;
      this.chunks.push({ sequence: ++this.sequence, data: part, bytes: size }); this.bytes += size;
      while (this.bytes > this.limit && this.chunks.length) this.bytes -= this.chunks.shift().bytes;
      part = ''; size = 0;
    };
    const chunkLimit = Math.min(this.limit, 8192);
    for (const char of data) {
      const bytes = Buffer.byteLength(char);
      if (size + bytes > chunkLimit) flush();
      part += char; size += bytes;
    }
    flush();
  }
  since(sequence) {
    return { gap: sequence < (this.chunks[0]?.sequence ?? this.sequence + 1) - 1,
      chunks: this.chunks.filter(chunk => chunk.sequence > sequence), lastSequence: this.sequence };
  }
}

export class TerminalManager extends EventEmitter {
  constructor({ store, spawn, makeSettings = () => null }) {
    super(); this.store = store; this.spawn = spawn; this.makeSettings = makeSettings;
    this.active = null; this.last = null; this.flushPending = false; this.starting = false; this.disposed = false;
  }
  async start(request) {
    if (this.active || this.starting) throw new Error('Stop the active terminal before starting another session');
    if (this.disposed) throw new Error('Journal is shutting down');
    this.starting = true;
    try { return await this.launch(request); } finally { this.starting = false; }
  }
  async launch({ projectId, provider, task = '', resumeId }) {
    const project = await this.store.project(projectId);
    task = text(task, 'task', 4000, true);
    let prior = null;
    if (resumeId) {
      prior = await this.store.getSession(resumeId);
      if (prior.projectId !== projectId || prior.provider !== provider) throw new Error('Session belongs to another project or provider');
      if (!prior.nativeIdConfirmed || !UUID.test(prior.nativeId ?? '')) throw new Error('Confirm the exact native session ID before resuming');
    }
    // Always reselect and revalidate here; a stale preview never authorizes delivery.
    const oldReceipt = prior ? await this.store.latestNativeReceipt(projectId, provider, prior.nativeId) : null;
    const receipt = await this.store.prepareContext(projectId, task || oldReceipt?.query || '');
    const session = { id: randomUUID(), projectId, provider, nativeId: prior?.nativeId ?? (provider === 'claude' ? randomUUID() : null),
      nativeIdConfirmed: provider === 'claude' || !!prior, title: task.slice(0, 80) || (prior ? 'Resume session' : 'Interactive session'),
      status: 'starting', receiptId: receipt.id, resumedFrom: prior?.id ?? null, createdAt: new Date().toISOString() };
    let prompt = task;
    if (receipt.packet || (prior && (oldReceipt?.hadKnowledge || oldReceipt?.items.length))) {
      const withdrawn = oldReceipt?.items.filter(item => !receipt.items.some(current => current.revisionId === item.revisionId)) ?? [];
      const update = prior ? `Current Journal knowledge has been revalidated. Earlier context may remain. Only claims listed in the current packet by memory ID and revision are applicable; do not rely on any other earlier Journal claims. ${withdrawn.length ? `Previously delivered claims now excluded: ${withdrawn.map(item => `${item.id} r${item.revision}`).join(', ')}. ` : ''}${!receipt.items.length ? 'No prior Journal knowledge is currently applicable. ' : ''}No previous task is being repeated.\n` : '';
      prompt = `${update}${receipt.packet}${task ? `\nTask:\n${task}` : ''}`;
    }
    await this.store.saveSession(session);
    try {
      if (this.disposed) throw new Error('Journal is shutting down');
      const settingsFile = provider === 'claude' ? this.makeSettings(session, project) : null;
      const launch = buildAgentLaunch({ provider, nativeId: session.nativeId, resume: !!prior, prompt, settingsFile });
      const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', JOURNAL_SESSION_ID: session.id };
      delete env.ELECTRON_RUN_AS_NODE;
      const proc = this.spawn(launch.executable, launch.argv, { cwd: project.root, env, name: 'xterm-256color', cols: 100, rows: 30 });
      const buffer = new OutputBuffer();
      session.status = 'running';
      const active = { session, proc, buffer, attached: false, sent: 0, acknowledged: 0, inflight: [], tail: '' };
      this.active = active; this.last = active;
      proc.onData(data => {
        if (this.disposed) return;
        buffer.append(data); active.tail = (active.tail + data).slice(-8192);
        if (provider === 'codex' && !session.nativeIdConfirmed) {
          const captured = captureCodexId(active.tail);
          // A newly printed incomplete/invalid banner revokes an earlier hint.
          // Do not clear hints merely because unrelated output evicted the banner.
          if (active.tail.includes(CODEX_RESUME_MARKER) && session.nativeId !== captured) {
            session.nativeId = captured;
            this.persistSession(session); this.emit('event', { type: 'status', session: { ...session } });
          }
        }
        this.scheduleFlush();
      });
      proc.onExit(({ exitCode, signal }) => {
        if (this.disposed) return;
        session.status = 'exited'; session.exitCode = exitCode; session.signal = signal; session.endedAt = new Date().toISOString();
        this.persistSession(session); if (this.active === active) this.active = null;
        this.emit('event', { type: 'status', session: { ...session } }); this.scheduleFlush();
      });
      await this.store.saveSession(session);
      await this.store.updateReceiptState(receipt.id, 'submitted', session.id, prompt);
      this.emit('event', { type: 'status', session: { ...session } });
      return { session, receipt: await this.store.getReceipt(receipt.id) };
    } catch (error) {
      if (this.active?.session.id === session.id) { try { this.active.proc.kill(); } catch {} this.active = null; }
      session.status = 'failed'; await this.store.saveSession(session);
      const current = await this.store.getReceipt(receipt.id);
      await this.store.updateReceiptState(receipt.id, current.state === 'prepared' ? 'failed' : 'uncertain', session.id, prompt);
      throw new Error(`Could not start ${provider}. Check that its CLI is installed and available on PATH. ${error.message}`);
    }
  }
  owned(id) {
    if (!this.active || this.active.session.id !== id) throw new Error('Terminal is not active or owned by this session');
    return this.active;
  }
  write(id, data) {
    if (typeof data !== 'string' || Buffer.byteLength(data) > 64 * 1024) throw new Error('Terminal input is too large');
    this.owned(id).proc.write(data);
  }
  resize(id, cols, rows) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 || cols > 500 || rows > 300) throw new Error('Invalid terminal size');
    this.owned(id).proc.resize(cols, rows);
  }
  interrupt(id) { this.owned(id).proc.write('\x03'); }
  stop(id) { this.owned(id).proc.kill(); }
  async confirmNativeId(id, nativeId) {
    if (!UUID.test(nativeId ?? '')) throw new Error('Enter the exact native session ID (UUID)');
    const session = await this.store.getSession(id);
    if (['starting', 'running', 'waiting'].includes(session.status)) throw new Error('Stop this session before confirming its resume ID');
    session.nativeId = nativeId; session.nativeIdConfirmed = true;
    await this.store.saveSession(session); return session;
  }
  observe(id, nativeId, status) {
    if (!this.active || this.active.session.id !== id || !UUID.test(nativeId)) return;
    const session = this.active.session;
    // Child sessions and native /clear can report another ID. Never graft it
    // onto a confirmed parent or silently restore confidence on a later hook.
    if (nativeId !== session.nativeId && !this.active.identityAmbiguous) {
      this.active.identityAmbiguous = true;
      this.emit('event', { type: 'error', message: 'Native session identity changed. Stop the terminal and confirm its exact resume ID before resuming.' });
    }
    session.nativeIdConfirmed = !this.active.identityAmbiguous; session.status = status;
    this.persistSession(session); this.emit('event', { type: 'status', session: { ...session } });
  }
  attach(id) {
    const active = this.active?.session.id === id ? this.active : this.last?.session.id === id ? this.last : null;
    if (!active) return { chunks: [], gap: true, lastSequence: 0 };
    const snapshot = active.buffer.since(0);
    active.attached = true; active.sent = snapshot.lastSequence; active.acknowledged = snapshot.lastSequence; active.inflight = [];
    return snapshot;
  }
  detach() { if (this.last) this.last.attached = false; }
  acknowledge(id, sequence) {
    const active = this.last;
    if (!active || active.session.id !== id || !Number.isInteger(sequence) || sequence <= active.acknowledged || sequence > active.sent) return;
    active.acknowledged = sequence; active.inflight = active.inflight.filter(item => item.sequence > sequence); this.scheduleFlush();
  }
  scheduleFlush() {
    if (this.flushPending) return; this.flushPending = true;
    setImmediate(() => { this.flushPending = false; this.flush(); });
  }
  flush() {
    const active = this.last; if (!active?.attached) return;
    let inflightBytes = active.inflight.reduce((sum, item) => sum + item.bytes, 0);
    if (inflightBytes >= 64 * 1024) return;
    const snapshot = active.buffer.since(active.sent);
    if (snapshot.gap) this.emit('event', { type: 'gap', sessionId: active.session.id });
    for (const chunk of snapshot.chunks) {
      if (inflightBytes + chunk.bytes > 64 * 1024) break;
      active.sent = chunk.sequence; active.inflight.push({ sequence: chunk.sequence, bytes: chunk.bytes }); inflightBytes += chunk.bytes;
      this.emit('event', { type: 'output', sessionId: active.session.id, sequence: chunk.sequence, data: chunk.data });
    }
  }
  persistSession(session) {
    try { Promise.resolve(this.store.saveSession({ ...session })).catch(error => { if (!this.disposed) this.emit('event', { type: 'error', message: `Session persistence failed: ${error.message}` }); }); }
    catch (error) { if (!this.disposed) this.emit('event', { type: 'error', message: `Session persistence failed: ${error.message}` }); }
  }
  async dispose() {
    if (this.disposed) return; this.disposed = true; this.detach();
    const active = this.active; this.active = null;
    if (!active) return;
    try {
      await this.store.saveSession({ ...active.session, status: 'interrupted', endedAt: new Date().toISOString() });
      const receipt = await this.store.getReceipt(active.session.receiptId);
      if (['prepared', 'submitted'].includes(receipt.state)) await this.store.updateReceiptState(receipt.id, 'uncertain', active.session.id);
    } finally { try { active.proc.kill(); } catch {} }
  }
}
