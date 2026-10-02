import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { buildAgentLaunch, captureCodexId, CODEX_RESUME_MARKER, UUID } from './agents.mjs';
import { descendants, isAlive, processIdentity, processTable, sameIdentity, signalVerified, survivors } from './process.mjs';
import { redact, text } from './validation.mjs';

export const MAX_SESSIONS = 4;
export const LIVE_STATES = ['starting', 'running', 'waiting', 'stopping'];
const isLive = status => LIVE_STATES.includes(status);
const TEST_COMMAND = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|node\s+--test|npx\s+(?:jest|vitest|playwright\s+test|mocha)|pytest|jest|vitest|go\s+test|cargo\s+test|playwright\s+test|mocha|rspec|dotnet\s+test|gradle\w*\s+test|mvn\s+test)\b/;
// Resolve the nearest existing ancestor so deleted or not-yet-created files
// still compare correctly against the canonical checkout root.
function canonical(path) {
  const rest = [];
  for (let current = path; ; current = dirname(current)) {
    try { return join(realpathSync(current), ...rest.reverse()); } catch { if (dirname(current) === current) return path; rest.push(basename(current)); }
  }
}
export const isTestCommand = command => TEST_COMMAND.test(command ?? '');

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

// Owns up to four native terminals. Every operation names a session ID, and
// only entries this manager spawned (and that have not exited) accept input or
// signals. Output stays in bounded memory; nothing raw is persisted.
export class TerminalManager extends EventEmitter {
  constructor({ store, spawn, makeSettings = () => null, runtimeId = randomUUID(), platform = process.platform,
    identify = processIdentity, table = processTable, verifiedSignal = signalVerified, alive = isAlive, stopGraceMs = 3000, trackMs = 5000 }) {
    super(); this.store = store; this.spawn = spawn; this.makeSettings = makeSettings; this.runtimeId = runtimeId; this.platform = platform;
    this.identify = identify; this.table = table; this.verifiedSignal = verifiedSignal; this.alive = alive; this.stopGraceMs = stopGraceMs;
    this.entries = new Map(); this.pending = 0; this.flushPending = false; this.disposed = false;
    this.tracker = trackMs ? setInterval(() => { void this.trackDescendants().catch(() => {}); void this.recheckOrphans().catch(() => {}); }, trackMs) : null; this.tracker?.unref?.();
  }
  entry(id) { return this.entries.get(id) ?? null; }
  liveEntries() { return [...this.entries.values()].filter(entry => !entry.exited); }
  list() { return [...this.entries.values()].map(entry => ({ ...entry.session })); }
  async start(request) {
    if (this.disposed) throw new Error('Journal is shutting down');
    if (this.liveEntries().length + this.pending >= MAX_SESSIONS) throw new Error(`Journal runs up to ${MAX_SESSIONS} sessions at once. Stop one before starting another.`);
    this.pending++;
    try { return await this.launch(request); } finally { this.pending--; }
  }
  async launch({ projectId, provider, task = '', resumeId, workspaceId = null, research = false, disabled = [] }) {
    if (provider !== 'claude' && provider !== 'codex') throw new Error('Unknown agent provider');
    if (typeof research !== 'boolean') throw new Error('Invalid research option');
    task = text(task, 'task', 4000, true);
    let prior = null;
    if (resumeId) {
      prior = await this.store.getSession(resumeId);
      if (prior.projectId !== projectId || prior.provider !== provider) throw new Error('Session belongs to another project or provider');
      // Native conversations are tied to their working directory: resume in place.
      workspaceId = prior.workspaceId ?? null; research = !!prior.research;
      if (!prior.nativeIdConfirmed || !UUID.test(prior.nativeId ?? '')) throw new Error('Confirm the exact native session ID before resuming');
      if (this.liveEntries().some(entry => entry.session.provider === provider && entry.session.nativeId === prior.nativeId)) throw new Error('This native conversation is already open in another session');
      // An orphan may still be writing to the same conversation outside Journal.
      const orphans = await this.store.activeSessions?.() ?? [];
      if (prior.status === 'orphaned' || orphans.some(other => other.status === 'orphaned' && other.provider === provider && other.nativeId === prior.nativeId)) throw new Error('This conversation may still be running in an orphaned process. End it before resuming.');
    }
    // The cwd is a registered worktree of this project (or its checkout), never another session's.
    const project = await (this.store.view ? this.store.view(projectId, workspaceId) : this.store.project(projectId));
    // Always reselect and revalidate here; a stale preview never authorizes delivery.
    const oldReceipt = prior ? await this.store.latestNativeReceipt(projectId, provider, prior.nativeId) : null;
    const receipt = await this.store.prepareContext(projectId, task || oldReceipt?.query || '', { workspaceId, disabled });
    const baseline = await this.store.checkoutBaseline?.(projectId, workspaceId) ?? null;
    const now = new Date().toISOString();
    const session = { id: randomUUID(), projectId, provider, nativeId: prior?.nativeId ?? (provider === 'claude' ? randomUUID() : null),
      nativeIdConfirmed: provider === 'claude' || !!prior, title: task.slice(0, 80) || (prior ? 'Resume session' : 'Interactive session'),
      status: 'starting', receiptId: receipt.id, resumedFrom: prior?.id ?? null, createdAt: now, lastActivityAt: now,
      branch: project.branch, head: project.head, cwd: project.root, workspaceId, research, baseline, runtimeId: this.runtimeId, activity: null, archived: false };
    let prompt = task;
    if (receipt.packet || (prior && (oldReceipt?.hadKnowledge || oldReceipt?.items.length))) {
      const withdrawn = oldReceipt?.items.filter(item => !receipt.items.some(current => current.revisionId === item.revisionId)) ?? [];
      const update = prior ? `Current Journal knowledge has been revalidated. Earlier context may remain. Only claims listed in the current packet by memory ID and revision are applicable; do not rely on any other earlier Journal claims. ${withdrawn.length ? `Previously delivered claims now excluded: ${withdrawn.map(item => `${item.id} r${item.revision}`).join(', ')}. ` : ''}${!receipt.items.length ? 'No prior Journal knowledge is currently applicable. ' : ''}No previous task is being repeated.\n` : '';
      prompt = `${update}${receipt.packet}${task ? `\nTask:\n${task}` : ''}`;
    }
    await this.store.saveSession(session);
    this.record(session.id, prior ? 'resume' : 'start', { provider, resumedFrom: prior?.id ?? null, branch: project.branch, head: project.head });
    let entry = null;
    try {
      if (this.disposed) throw new Error('Journal is shutting down');
      const settingsFile = provider === 'claude' ? this.makeSettings(session, project) : null;
      const launch = buildAgentLaunch({ provider, nativeId: session.nativeId, resume: !!prior, prompt, settingsFile, research });
      const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', JOURNAL_SESSION_ID: session.id };
      delete env.ELECTRON_RUN_AS_NODE;
      const proc = this.spawn(launch.executable, launch.argv, { cwd: project.root, env, name: 'xterm-256color', cols: 100, rows: 30 });
      entry = { session, proc, buffer: new OutputBuffer(), attached: false, sent: 0, acknowledged: 0, inflight: [], tail: '', exited: false,
        stopping: false, waiters: [], descendants: new Map(), identityAmbiguous: false, commands: new Map(), lastPersist: 0 };
      this.entries.set(session.id, entry);
      session.status = 'running'; session.pid = Number.isInteger(proc.pid) ? proc.pid : null;
      // Identity is read asynchronously, and again on first output once the CLI is running.
      session.identity = null; void this.refreshIdentity(entry);
      proc.onData(data => this.output(entry, data));
      proc.onExit(({ exitCode, signal }) => this.exited(entry, exitCode, signal));
      await this.store.saveSession(session);
      await this.store.updateReceiptState(receipt.id, 'submitted', session.id, prompt);
      this.record(session.id, 'context', { receiptId: receipt.id, claims: receipt.items.length, state: 'submitted' });
      this.emitStatus(session);
      return { session: { ...session }, receipt: await this.store.getReceipt(receipt.id) };
    } catch (error) {
      const spawned = !!entry;
      if (entry && !entry.exited) { try { entry.proc.kill(); } catch {} }
      this.entries.delete(session.id);
      session.status = 'failed'; session.endedAt = new Date().toISOString(); await this.store.saveSession(session);
      const current = await this.store.getReceipt(receipt.id);
      // Once the process started with the prompt, delivery may have happened.
      await this.store.updateReceiptState(receipt.id, current.state === 'prepared' && !spawned ? 'failed' : 'uncertain', session.id, prompt);
      this.record(session.id, 'error', { message: redact(error.message, 300) });
      this.emitStatus(session);
      throw new Error(`Could not start ${provider}. Check that its CLI is installed and available on PATH. ${error.message}`);
    }
  }
  async refreshIdentity(entry) {
    if (!entry.session.pid) return;
    const identity = await Promise.resolve(this.identify(entry.session.pid)).catch(() => null);
    if (identity && !entry.exited) { entry.session.identity = identity; this.persist(entry.session, true); }
  }
  output(entry, data) {
    if (this.disposed) return;
    const { session } = entry;
    if (!entry.sawOutput) { entry.sawOutput = true; void this.refreshIdentity(entry); }
    entry.buffer.append(data); entry.tail = (entry.tail + data).slice(-8192);
    session.lastActivityAt = new Date().toISOString();
    if (session.provider === 'codex' && !session.nativeIdConfirmed) {
      const captured = captureCodexId(entry.tail);
      // A newly printed incomplete/invalid banner revokes an earlier hint.
      // Do not clear hints merely because unrelated output evicted the banner.
      if (entry.tail.includes(CODEX_RESUME_MARKER) && session.nativeId !== captured) {
        session.nativeId = captured; this.persist(session, true); this.emitStatus(session);
      }
    }
    // Activity timestamps are metadata; persist them at most every five seconds.
    if (Date.now() - entry.lastPersist > 5000) this.persist(session);
    this.scheduleFlush();
  }
  exited(entry, exitCode, signal) {
    if (this.disposed || entry.exited) return;
    entry.exited = true; clearTimeout(entry.forceTimer); for (const resolve of entry.waiters.splice(0)) resolve();
    const { session } = entry;
    session.status = entry.stopping ? 'stopped' : 'exited'; session.exitCode = exitCode; session.signal = signal ?? null;
    session.endedAt = new Date().toISOString(); session.activity = null;
    const recorded = [...entry.descendants.values()];
    session.survivors = recorded.length ? null : [];
    this.persist(session, true); this.emitStatus(session); this.scheduleFlush();
    const event = survivors => this.record(session.id, entry.stopping ? 'stop' : 'exit', { exitCode, signal: signal ?? null, survivors });
    if (!recorded.length) { event(0); return; }
    // Leftover children: scanned after exit, always saved (dispose waits for it).
    entry.survivorScan = (async () => {
      const remaining = survivors(recorded, await Promise.resolve(this.table()).catch(() => null));
      session.survivors = remaining === null ? null : remaining.map(row => ({ pid: row.pid, started: row.started, command: redact(row.command, 120) }));
      event(session.survivors?.length ?? null);
      if (this.disposed) this.persist(session, true); else this.emitStatus(session);
    })().catch(() => {});
  }
  owned(id) {
    const entry = this.entries.get(id);
    if (!entry || entry.exited) throw new Error('Terminal is not active or owned by this session');
    return entry;
  }
  write(id, data) {
    if (typeof data !== 'string' || Buffer.byteLength(data) > 64 * 1024) throw new Error('Terminal input is too large');
    this.owned(id).proc.write(data);
  }
  resize(id, cols, rows) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 || cols > 500 || rows > 300) throw new Error('Invalid terminal size');
    const entry = this.owned(id); entry.proc.resize(cols, rows); entry.session.terminal = { cols, rows };
  }
  interrupt(id) { this.owned(id).proc.write('\x03'); this.record(id, 'interrupt', {}); }
  // Graceful first: SIGTERM to the PTY's process group (or ConPTY close on
  // Windows), then a forced kill only if it is still running after the grace
  // period. Signals stop once the exit callback fires, so a reused PID is
  // never targeted through this path.
  async stop(id) {
    const entry = this.owned(id); if (entry.stopping) return { ...entry.session };
    entry.stopping = true;
    // Last descendant sample before signals, bounded so stop stays prompt.
    await Promise.race([this.trackDescendants(entry).catch(() => {}), new Promise(r => setTimeout(r, 1000))]);
    if (entry.exited) return { ...entry.session };
    entry.session.status = 'stopping'; this.emitStatus(entry.session); this.persist(entry.session, true);
    const { pid } = entry.proc;
    const signal = name => {
      if (entry.exited) return;
      try {
        if (this.platform !== 'win32' && Number.isInteger(pid)) process.kill(-pid, name);
        // We still hold the live PTY handle; with no identity yet, kill through it.
        else if (name === 'SIGKILL' && Number.isInteger(pid) && entry.session.identity) void Promise.resolve(this.verifiedSignal(pid, entry.session.identity, 'SIGKILL', this.platform)).catch(() => {});
        else entry.proc.kill();
      } catch { try { entry.proc.kill(name); } catch { /* already gone */ } }
    };
    signal('SIGTERM');
    entry.forceTimer = setTimeout(() => signal('SIGKILL'), this.stopGraceMs); entry.forceTimer.unref?.();
    return { ...entry.session };
  }
  // Explicit user action after a stop reported surviving descendants.
  async terminateSurvivors(id) {
    const session = this.entries.get(id)?.session ?? await this.store.getSession(id);
    const results = [];
    for (const row of session.survivors ?? []) results.push({ pid: row.pid, ...await this.verifiedSignal(row.pid, { started: row.started }, 'SIGTERM', this.platform) });
    session.survivors = []; this.persist(session, true); this.record(id, 'cleanup', { results: results.map(r => ({ pid: r.pid, signalled: r.signalled })) });
    this.emitStatus(session);
    return results;
  }
  async trackDescendants(only) {
    const targets = only ? [only] : this.liveEntries();
    if (!targets.length || this.platform === 'win32') return;
    const table = await this.table(); if (!table) return;
    for (const entry of targets) {
      if (entry.exited || !Number.isInteger(entry.proc.pid)) continue;
      for (const row of descendants(table, entry.proc.pid) ?? []) {
        if (entry.descendants.size >= 200) break;
        entry.descendants.set(`${row.pid}:${row.started}`, row);
      }
    }
  }
  async confirmNativeId(id, nativeId) {
    if (!UUID.test(nativeId ?? '')) throw new Error('Enter the exact native session ID (UUID)');
    const session = await this.store.getSession(id);
    if (isLive(session.status) || session.status === 'orphaned') throw new Error('Stop this session before confirming its resume ID');
    session.nativeId = nativeId; session.nativeIdConfirmed = true;
    // Keep a retained in-memory copy in step so a later save cannot revert it.
    const entry = this.entries.get(id); if (entry) Object.assign(entry.session, { nativeId, nativeIdConfirmed: true });
    await this.store.saveSession(session); this.emitStatus(session); return session;
  }
  observe(id, nativeId, status, activity) {
    const entry = this.entries.get(id);
    if (!entry || entry.exited || !UUID.test(nativeId ?? '')) return;
    const { session } = entry;
    // Child sessions and native /clear can report another ID. Never graft it
    // onto a confirmed parent or silently restore confidence on a later hook.
    if (nativeId !== session.nativeId && !entry.identityAmbiguous) {
      entry.identityAmbiguous = true;
      this.emit('event', { type: 'error', sessionId: id, message: 'Native session identity changed. Stop the terminal and confirm its exact resume ID before resuming.' });
    }
    session.nativeIdConfirmed = !entry.identityAmbiguous;
    if (!entry.stopping && status) session.status = status;
    if (activity !== undefined) session.activity = activity;
    this.persist(session, true); this.emitStatus(session);
  }
  // Claude hook observations: lifecycle, Bash commands with exit status when
  // the CLI reports it, and file edits. Command text is redacted and bounded;
  // no tool output or prompt text is kept.
  ingest(id, event) {
    const entry = this.entries.get(id); if (!entry || entry.exited) return;
    const { session } = entry;
    session.lastActivityAt = new Date().toISOString();
    switch (event.event) {
      case 'SessionStart': this.observe(id, event.nativeId, 'running', 'idle'); break;
      case 'UserPromptSubmit': this.observe(id, event.nativeId, 'running', 'working'); this.record(id, 'prompt', {}); break;
      case 'PermissionRequest': this.observe(id, event.nativeId, 'waiting', 'permission'); this.record(id, 'permission', { tool: event.tool ?? null }); break;
      case 'Stop': this.observe(id, event.nativeId, 'running', 'idle'); this.record(id, 'turn-end', {}); break;
      case 'PreToolUse':
        if (session.status === 'waiting') this.observe(id, event.nativeId, 'running', 'working');
        if (event.tool === 'Bash' && event.toolUseId && entry.commands.size < 500) {
          const command = redact(event.command ?? '', 300);
          entry.commands.set(event.toolUseId, true);
          // Working directory relative to the session's workspace ('.' at its root).
          let cwd = null;
          if (typeof event.cwd === 'string') { const rel = relative(session.cwd, canonical(event.cwd)); cwd = !rel ? '.' : rel.startsWith('..') || isAbsolute(rel) ? null : rel.split(sep).join('/').slice(0, 200); }
          this.record(id, 'command-start', { toolUseId: event.toolUseId, command, cwd, background: !!event.background, test: isTestCommand(command) });
        }
        break;
      case 'PostToolUse': case 'PostToolUseFailure': {
        if (event.tool === 'Bash' && entry.commands.delete(event.toolUseId)) {
          // Exit 0 only when Claude reported completion of a foreground command.
          const status = event.interrupted ? 'interrupted' : event.background ? 'unknown' : event.event === 'PostToolUse' ? 'succeeded' : Number.isInteger(event.exit) ? 'failed' : 'unknown';
          this.record(id, 'command-end', { toolUseId: event.toolUseId, status, exitCode: status === 'succeeded' ? 0 : Number.isInteger(event.exit) ? event.exit : null, durationMs: Number.isFinite(event.durationMs) ? event.durationMs : null });
        } else if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(event.tool) && event.filePath && event.event === 'PostToolUse') {
          let absolute = isAbsolute(event.filePath) ? event.filePath : join(session.cwd, event.filePath);
          // Compare canonical paths (for example /var vs /private/var on macOS).
          absolute = canonical(absolute);
          const path = relative(session.cwd, absolute);
          if (path && !path.startsWith(`..${sep}`) && path !== '..') this.record(id, 'file', { path: path.split(sep).join('/').slice(0, 300), tool: event.tool });
        }
        break;
      }
      default: break;
    }
  }
  record(sessionId, kind, body) {
    const event = { sessionId, kind, at: new Date().toISOString(), body };
    try { Promise.resolve(this.store.appendEvent?.(sessionId, kind, body)).catch(() => {}); } catch { /* timeline is best effort */ }
    if (!this.disposed) this.emit('event', { type: 'timeline', event });
  }
  attach(id) {
    const entry = this.entries.get(id);
    if (!entry) return { chunks: [], gap: true, lastSequence: 0 };
    const snapshot = entry.buffer.since(0);
    entry.attached = true; entry.sent = snapshot.lastSequence; entry.acknowledged = snapshot.lastSequence; entry.inflight = [];
    return snapshot;
  }
  detach(id) { for (const entry of this.entries.values()) if (!id || entry.session.id === id) entry.attached = false; }
  acknowledge(id, sequence) {
    const entry = this.entries.get(id);
    if (!entry || !Number.isInteger(sequence) || sequence <= entry.acknowledged || sequence > entry.sent) return;
    entry.acknowledged = sequence; entry.inflight = entry.inflight.filter(item => item.sequence > sequence); this.scheduleFlush();
  }
  scheduleFlush() {
    if (this.flushPending) return; this.flushPending = true;
    setImmediate(() => { this.flushPending = false; this.flush(); });
  }
  flush() {
    // Per-session display credit: a flooding session cannot starve another.
    for (const entry of this.entries.values()) {
      if (!entry.attached) continue;
      let inflightBytes = entry.inflight.reduce((sum, item) => sum + item.bytes, 0);
      if (inflightBytes >= 64 * 1024) continue;
      const snapshot = entry.buffer.since(entry.sent);
      if (snapshot.gap) this.emit('event', { type: 'gap', sessionId: entry.session.id });
      for (const chunk of snapshot.chunks) {
        if (inflightBytes + chunk.bytes > 64 * 1024) break;
        entry.sent = chunk.sequence; entry.inflight.push({ sequence: chunk.sequence, bytes: chunk.bytes }); inflightBytes += chunk.bytes;
        this.emit('event', { type: 'output', sessionId: entry.session.id, sequence: chunk.sequence, data: chunk.data });
      }
    }
  }
  // Exited entries keep their bounded output for review until closed.
  release(id) {
    const entry = this.entries.get(id);
    if (entry && !entry.exited) throw new Error('Stop the session before closing it');
    this.entries.delete(id);
  }
  // Every state change bumps a version so the UI can ignore older snapshots.
  emitStatus(session) {
    session.version = (session.version ?? 0) + 1; this.persist(session);
    if (!this.disposed) this.emit('event', { type: 'status', session: { ...session } });
  }
  persist(session, force = false) {
    const entry = this.entries.get(session.id); if (entry) entry.lastPersist = Date.now();
    void force;
    try { Promise.resolve(this.store.saveSession({ ...session })).catch(error => { if (!this.disposed) this.emit('event', { type: 'error', message: `Session persistence failed: ${error.message}` }); }); }
    catch (error) { if (!this.disposed) this.emit('event', { type: 'error', message: `Session persistence failed: ${error.message}` }); }
  }
  // Called once when a runtime starts: sessions owned by a runtime that is no
  // longer running are interrupted, or orphaned when their verified process
  // is still alive. Prompts are never resent; delivery becomes uncertain.
  async recover() {
    const recovered = [];
    for (const session of await this.store.liveSessions()) {
      if (session.runtimeId === this.runtimeId) continue;
      // Verified: same PID and start time. A live PID whose identity
      // cannot be read stays orphaned but unverified: never reported as ended.
      const current = session.pid ? await this.identify(session.pid) : null;
      const verified = !!session.identity && sameIdentity(current, session.identity);
      const unverified = !verified && !!session.pid && this.alive(session.pid) && (!current || !session.identity);
      const orphaned = verified || unverified;
      const next = { ...session, status: orphaned ? 'orphaned' : 'interrupted', identityVerified: orphaned ? verified : undefined, activity: null, endedAt: orphaned ? null : new Date().toISOString(), recoveredAt: new Date().toISOString() };
      await this.store.saveSession(next);
      const receipt = await Promise.resolve().then(() => this.store.getReceipt(session.receiptId)).catch(() => null);
      if (receipt && ['prepared', 'submitted'].includes(receipt.state)) await this.store.updateReceiptState(receipt.id, 'uncertain', session.id);
      this.record(session.id, 'recovered', { status: next.status, previousStatus: session.status });
      recovered.push(next);
    }
    await this.recheckOrphans();
    return recovered;
  }
  // Orphans end on their own; once the process is gone the session becomes
  // interrupted (and resumable) instead of staying blocked forever.
  async recheckOrphans() {
    for (const session of await this.store.activeSessions?.() ?? []) {
      if (session.status !== 'orphaned') continue;
      const running = session.identityVerified === false ? this.alive(session.pid) : sameIdentity(await this.identify(session.pid), session.identity);
      if (running) continue;
      const next = { ...session, status: 'interrupted', endedAt: new Date().toISOString() };
      await this.store.saveSession(next); this.record(session.id, 'recovered', { status: 'interrupted', previousStatus: 'orphaned' }); this.emitStatus(next);
    }
  }
  // An orphan keeps running without a terminal. Ending it is explicit and
  // requires the recorded process identity to match.
  async terminateOrphan(id, { waitMs = 3000 } = {}) {
    const session = await this.store.getSession(id);
    if (session.status !== 'orphaned') throw new Error('Only an orphaned session can be terminated this way');
    if (session.identityVerified === false || !session.identity) throw new Error('Journal cannot verify that this process is the original agent, so it will not signal it. End it outside Journal if needed.');
    let result;
    if (this.platform !== 'win32' && sameIdentity(await this.identify(session.pid), session.identity)) {
      // The PTY child led its own session and process group; end the group.
      try { process.kill(-session.pid, 'SIGTERM'); result = { signalled: true }; }
      catch { result = await this.verifiedSignal(session.pid, session.identity, 'SIGTERM', this.platform); }
    } else result = await this.verifiedSignal(session.pid, session.identity, 'SIGTERM', this.platform);
    // Record an end only after confirming the process is gone.
    const deadline = Date.now() + waitMs; let gone = false;
    while (result.signalled && Date.now() < deadline) { if (!sameIdentity(await this.identify(session.pid), session.identity)) { gone = true; break; } await new Promise(r => setTimeout(r, 100)); }
    const next = gone ? { ...session, status: 'stopped', endedAt: new Date().toISOString() } : session;
    if (gone) await this.store.saveSession(next);
    this.record(id, 'cleanup', { signalled: result.signalled, exited: gone, reason: result.reason ?? null });
    this.emitStatus(next); return { ...result, exited: gone };
  }
  async dispose({ stopSessions = true, timeoutMs = 5000 } = {}) {
    if (this.disposed) return; clearInterval(this.tracker);
    const live = this.liveEntries();
    if (stopSessions && live.length) {
      const exits = live.map(entry => new Promise(resolve => {
        if (entry.exited) return resolve();
        entry.waiters.push(resolve); setTimeout(resolve, timeoutMs).unref?.();
      }));
      for (const entry of live) { try { void this.stop(entry.session.id).catch(() => {}); } catch { /* already gone */ } }
      await Promise.all(exits);
      await Promise.all(live.map(entry => entry.survivorScan).filter(Boolean));
    }
    this.disposed = true; this.detach();
    for (const entry of this.liveEntries()) {
      try {
        await this.store.saveSession({ ...entry.session, status: 'interrupted', endedAt: new Date().toISOString() });
        const receipt = await this.store.getReceipt(entry.session.receiptId);
        if (['prepared', 'submitted'].includes(receipt.state)) await this.store.updateReceiptState(receipt.id, 'uncertain', entry.session.id);
      } finally { try { entry.proc.kill(); } catch {} }
    }
  }
}
