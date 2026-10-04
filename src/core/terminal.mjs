import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { buildAgentLaunch, captureCodexId, CODEX_RESUME_MARKER, PROVIDER_NAMES, PROVIDERS, UUID } from './agents.mjs';
import { captureCursorId, createChat, CURSOR_RESUME_MARKER, findCursor } from './cursor.mjs';
import { descendants, isAlive, processIdentity, processTable, sameIdentity, signalVerified, survivors } from './process.mjs';
import { redact, text } from './validation.mjs';
import { generateTitle } from './sessions.mjs';
import { referenceEvent } from './references.mjs';
import { realPath } from './paths.mjs';

export const MAX_SESSIONS = 4;
export const IDLE_SETTLE_MS = 750;
export const ECHO_MS = 300;          // output this soon after input or resize is not "activity"
export const QUIET_MS = 10_000;      // output after this much quiet is a resume edge
export const ACTIVITY_THROTTLE_MS = 5_000;
export const LIVE_STATES = ['starting', 'running', 'waiting', 'stopping'];
// Exited sessions whose output stays in memory for review (BUG-8): with four live
// sessions, at most 12 × 256 KiB ≈ 3 MiB. Output is never written to disk.
export const RETAINED_EXITED = 8;
const MAX_SNAPSHOT_PATHS = 200;
// The end snapshot (D11): totals and the paths this session changed, taken once.
export function summarizeChanges(changes, at = new Date().toISOString()) {
  const files = Array.isArray(changes?.files) ? changes.files : [];
  const changed = files.filter(file => !file.preexisting);
  return { available: !!changes?.available, additions: changes?.available ? changes.additions ?? 0 : 0, deletions: changes?.available ? changes.deletions ?? 0 : 0,
    files: files.length, preexisting: files.filter(file => file.preexisting).length,
    paths: changed.slice(0, MAX_SNAPSHOT_PATHS).map(({ path, from }) => ({ path, from: from ?? null })),
    truncated: !!changes?.truncated || changed.length > MAX_SNAPSHOT_PATHS, at, ...(changes?.reason ? { reason: String(changes.reason).slice(0, 300) } : {}) };
}
const PTY_SIZE = Object.freeze({ cols: 100, rows: 30 }); // until the terminal reports its own
const isLive = status => LIVE_STATES.includes(status);
// Machine-readable reasons for refused or failed operations. Messages stay
// human-readable; the renderer branches on `code`.
export const ERROR_CODES = Object.freeze({
  SLOTS_FULL: 'SLOTS_FULL',                 // start: 4 live (or pending) sessions
  SHUTTING_DOWN: 'SHUTTING_DOWN',
  PROVIDER_MISSING: 'PROVIDER_MISSING',     // Cursor CLI not found; spawn ENOENT
  PROVIDER_UNSUPPORTED: 'PROVIDER_UNSUPPORTED', // Cursor lacks resume/createChat/mode
  ID_UNCONFIRMED: 'ID_UNCONFIRMED',         // resume without a confirmed native ID
  CONVERSATION_OPEN: 'CONVERSATION_OPEN',   // same native conversation already live
  ORPHAN_RUNNING: 'ORPHAN_RUNNING',         // resume blocked by an orphan
  START_FAILED: 'START_FAILED',             // other launch failure (wrapped)
  NOT_LIVE: 'NOT_LIVE',                     // owned(): terminal not active
});
const CODES = new Set(Object.values(ERROR_CODES));
// The code of the error event sent when a hook reports another native session ID
// (src/ui/types.ts shares it by name).
export const IDENTITY_CHANGED = 'IDENTITY_CHANGED';
const fail = (code, message) => Object.assign(new Error(message), { code });
const TEST_COMMAND = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|node\s+--test|npx\s+(?:jest|vitest|playwright\s+test|mocha)|pytest|jest|vitest|go\s+test|cargo\s+test|playwright\s+test|mocha|rspec|dotnet\s+test|gradle\w*\s+test|mvn\s+test)\b/;
// Resolve the nearest existing ancestor so deleted or not-yet-created files
// still compare correctly against the canonical checkout root.
function canonical(path) {
  const rest = [];
  for (let current = path; ; current = dirname(current)) {
    try { return join(realPath(current), ...rest.reverse()); } catch { if (dirname(current) === current) return path; rest.push(basename(current)); }
  }
}
export const isTestCommand = command => TEST_COMMAND.test(command ?? '');
// Terminal input that types text (not only keys such as arrows, Esc, Enter or Ctrl+C).
const KEY_SEQUENCES = /\x1b(?:\[200~|\[201~|\[[0-9;?]*[ -\/]*[@-~]|O.|.)?/g;
const printable = data => /[^\x00-\x1f\x7f]/.test(data.replace(KEY_SEQUENCES, ''));

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
    identify = processIdentity, table = processTable, verifiedSignal = signalVerified, alive = isAlive, stopGraceMs = 3000, trackMs = 5000,
    cursor = { find: () => findCursor(process.env), createChat: (path, cwd) => createChat(path, cwd, process.env) } }) {
    super(); this.cursor = cursor; this.store = store; this.spawn = spawn; this.makeSettings = makeSettings; this.runtimeId = runtimeId; this.platform = platform;
    this.identify = identify; this.table = table; this.verifiedSignal = verifiedSignal; this.alive = alive; this.stopGraceMs = stopGraceMs;
    // Slots 1-4 are reserved synchronously at start so concurrent starts never share one.
    this.entries = new Map(); this.reservedSlots = new Set(); this.flushPending = false; this.disposed = false; this.settling = new Set();
    this.tracker = trackMs ? setInterval(() => { void this.trackDescendants().catch(() => {}); void this.recheckOrphans().catch(() => {}); }, trackMs) : null; this.tracker?.unref?.();
  }
  entry(id) { return this.entries.get(id) ?? null; }
  liveEntries() { return [...this.entries.values()].filter(entry => !entry.exited); }
  list() { return [...this.entries.values()].map(entry => ({ ...entry.session })); }
  // The lowest slot not held by a live session of this runtime or a start in progress.
  // Orphans hold no slot: they do not count toward MAX_SESSIONS.
  freeSlot() {
    const used = new Set([...this.reservedSlots, ...this.liveEntries().map(entry => entry.session.slot)]);
    for (let slot = 1; slot <= MAX_SESSIONS; slot++) if (!used.has(slot)) return slot;
    return null;
  }
  async start(request) {
    if (this.disposed) throw fail(ERROR_CODES.SHUTTING_DOWN, 'Journal is shutting down');
    // Live sessions and starts in progress (reserved) each hold one slot; a start
    // whose process already runs is in both sets but counts once.
    const slot = this.freeSlot();
    if (!slot) throw fail(ERROR_CODES.SLOTS_FULL, `Journal runs up to ${MAX_SESSIONS} sessions at once. Stop one before starting another.`);
    this.reservedSlots.add(slot);
    try { return await this.launch({ ...request, slot }); } finally { this.reservedSlots.delete(slot); }
  }
  async launch({ projectId, provider, task = '', resumeId, workspaceId = null, research = false, plan = false, disabled = [], references = [], slot = null, cliVersion = null }) {
    if (!PROVIDERS.includes(provider)) throw new Error('Unknown agent provider');
    if (typeof research !== 'boolean' || typeof plan !== 'boolean') throw new Error('Invalid mode option');
    if (plan && provider === 'codex') throw new Error('Codex has no plan mode; use Read-only instead');
    if (research) plan = false;
    task = text(task, 'task', 4000, true);
    let prior = null;
    if (resumeId) {
      prior = await this.store.getSession(resumeId);
      if (prior.projectId !== projectId || prior.provider !== provider) throw new Error('Session belongs to another project or provider');
      // Native conversations are tied to their working directory: resume in place.
      workspaceId = prior.workspaceId ?? null; research = !!prior.research; plan = !research && !!prior.plan;
      if (!prior.nativeIdConfirmed || !UUID.test(prior.nativeId ?? '')) throw fail(ERROR_CODES.ID_UNCONFIRMED, 'Confirm the conversation ID before continuing');
      if (this.liveEntries().some(entry => entry.session.provider === provider && entry.session.nativeId === prior.nativeId)) throw fail(ERROR_CODES.CONVERSATION_OPEN, 'This native conversation is already open in another session');
      // An orphan may still be writing to the same conversation outside Journal.
      const orphans = await this.store.activeSessions?.() ?? [];
      if (prior.status === 'orphaned' || orphans.some(other => other.status === 'orphaned' && other.provider === provider && other.nativeId === prior.nativeId)) throw fail(ERROR_CODES.ORPHAN_RUNNING, 'This conversation may still be running in an orphaned process. End it before resuming.');
    }
    // The cwd is a registered worktree of this project (or its checkout), never another session's.
    const project = await (this.store.view ? this.store.view(projectId, workspaceId) : this.store.project(projectId));
    // Cursor: the genuine CLI (found again now, never assumed), with the modes this build documents.
    let cursor = null;
    if (provider === 'cursor') {
      cursor = await this.cursor.find();
      if (!cursor?.path || !cursor.cursor) throw fail(ERROR_CODES.PROVIDER_MISSING, 'Cursor CLI is not installed. Choose Install… on the Cursor card in New session, then start again.');
      if (!cursor.supports?.resume || !cursor.supports?.createChat) throw fail(ERROR_CODES.PROVIDER_UNSUPPORTED, 'This Cursor CLI version cannot open a chat by its exact ID. Update it with "agent update".');
      if ((research || plan) && !cursor.supports?.mode) throw fail(ERROR_CODES.PROVIDER_UNSUPPORTED, `This Cursor CLI version has no ${research ? 'Ask' : 'Plan'} mode. Update it with "agent update", or start without ${research ? 'Read-only' : 'Plan'}.`);
    }
    // Always reselect and revalidate here; a stale preview never authorizes delivery.
    const oldReceipt = prior ? await this.store.latestNativeReceipt(projectId, provider, prior.nativeId) : null;
    const receipt = await this.store.prepareContext(projectId, task || oldReceipt?.query || '', { workspaceId, disabled, references: prior ? [] : references });
    const baseline = await this.store.checkoutBaseline?.(projectId, workspaceId) ?? null;
    const now = new Date().toISOString();
    const cwd = project.cwd ?? project.root;
    // Exact identity at launch: Claude takes a preassigned ID; Cursor's chat is created
    // first in the same folder (documented create-chat). Codex is confirmed after exit.
    const nativeId = prior?.nativeId ?? (provider === 'claude' ? randomUUID() : provider === 'cursor' ? await this.cursor.createChat(cursor.path, cwd) : null);
    // Where the native ID came from: a resume keeps the prior session's source.
    const nativeIdSource = prior ? prior.nativeIdSource ?? null : provider === 'claude' ? 'preassigned' : provider === 'cursor' && nativeId ? 'create-chat' : null;
    const session = { id: randomUUID(), projectId, provider, nativeId,
      nativeIdConfirmed: provider === 'claude' || !!prior || (provider === 'cursor' && !!nativeId), title: generateTitle(task, prior),
      status: 'starting', receiptId: receipt.id, resumedFrom: prior?.id ?? null, createdAt: now, lastActivityAt: now,
      // An additional-folder session runs in that folder with its own Git identity (if any).
      branch: project.cwd ? project.cwdBranch ?? null : project.branch, head: project.cwd ? project.cwdHead ?? null : project.head, cwd, workspaceId, research, plan, baseline, runtimeId: this.runtimeId, activity: null,
      slot, nativeIdSource, identityMismatch: false, lastOutputAt: null, pending: null,
      // The CLI version main detected for this launch (a resume records the version at resume time).
      cliVersion: typeof cliVersion === 'string' ? cliVersion.slice(0, 64) : null };
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
      if (this.disposed) throw fail(ERROR_CODES.SHUTTING_DOWN, 'Journal is shutting down');
      const settingsFile = provider === 'claude' ? this.makeSettings(session, project) : null;
      const launch = buildAgentLaunch({ provider, nativeId: session.nativeId, resume: !!prior, prompt, settingsFile, research, plan, executable: cursor?.path });
      const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', JOURNAL_SESSION_ID: session.id };
      delete env.ELECTRON_RUN_AS_NODE;
      const proc = this.spawn(launch.executable, launch.argv, { cwd: session.cwd, env, name: 'xterm-256color', ...PTY_SIZE });
      entry = { session, proc, buffer: new OutputBuffer(), attached: false, sent: 0, acknowledged: 0, inflight: [], tail: '', exited: false,
        stopping: false, waiters: [], descendants: new Map(), identityAmbiguous: false, commands: new Map(), tools: new Map(), pending: [], answered: false, lastPersist: 0,
        lastInputAt: 0, lastResizeAt: 0, lastActivityEmit: 0, activityTimer: null, size: { cols: PTY_SIZE.cols, rows: PTY_SIZE.rows } };
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
      session.status = 'failed'; session.slot = null; session.endedAt = new Date().toISOString(); await this.store.saveSession(session);
      const current = await this.store.getReceipt(receipt.id);
      // Once the process started with the prompt, delivery may have happened.
      await this.store.updateReceiptState(receipt.id, current.state === 'prepared' && !spawned ? 'failed' : 'uncertain', session.id, prompt);
      this.record(session.id, 'error', { message: redact(error.message, 300) });
      this.emitStatus(session);
      // ENOENT means a missing executable only when spawning failed; later it is some other file.
      const code = CODES.has(error.code) ? error.code : error.code === 'ENOENT' && !spawned ? ERROR_CODES.PROVIDER_MISSING : ERROR_CODES.START_FAILED;
      if (code === ERROR_CODES.SHUTTING_DOWN) throw fail(code, error.message);
      throw fail(code, `Could not start ${provider}. Check that its CLI is installed and available on PATH. ${error.message}`);
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
    const now = Date.now();
    // Echo of typed input and full-screen repaints after a resize are not agent output.
    if (now - Math.max(entry.lastInputAt, entry.lastResizeAt) >= ECHO_MS) this.noteOutput(entry, now);
    // Whether the CLI enabled bracketed paste (DECSET 2004), for inserted references.
    const on = entry.tail.lastIndexOf('\x1b[?2004h'); const off = entry.tail.lastIndexOf('\x1b[?2004l');
    if (on >= 0 || off >= 0) entry.bracketedPaste = on > off;
    session.lastActivityAt = new Date().toISOString();
    if ((session.provider === 'codex' || session.provider === 'cursor') && !session.nativeIdConfirmed) {
      const [marker, capture] = session.provider === 'codex' ? [CODEX_RESUME_MARKER, captureCodexId] : [CURSOR_RESUME_MARKER, captureCursorId];
      const captured = capture(entry.tail);
      // A newly printed incomplete/invalid banner revokes an earlier hint.
      // Do not clear hints merely because unrelated output evicted the banner.
      if (entry.tail.includes(marker) && session.nativeId !== captured) {
        session.nativeId = captured; session.nativeIdSource = captured ? 'exit-banner' : null; this.persist(session, true); this.emitStatus(session);
      }
    }
    // Activity timestamps are metadata; persist them at most every five seconds.
    if (Date.now() - entry.lastPersist > 5000) this.persist(session);
    this.scheduleFlush();
  }
  // Only the time of output is kept, never its content. Codex and Cursor have no
  // state hooks, so they report output: at once after a quiet period, then at
  // most one trailing event per throttle window carrying the latest time.
  noteOutput(entry, now) {
    const { session } = entry;
    const previous = session.lastOutputAt ? Date.parse(session.lastOutputAt) : -Infinity;
    session.lastOutputAt = new Date(now).toISOString();
    if (session.provider !== 'codex' && session.provider !== 'cursor') return;
    const emit = () => { if (!this.disposed && !entry.exited) this.emit('event', { type: 'activity', sessionId: session.id, lastOutputAt: session.lastOutputAt }); };
    if (now - previous >= QUIET_MS) {
      clearTimeout(entry.activityTimer); entry.activityTimer = null;
      entry.lastActivityEmit = now; emit(); return;
    }
    if (entry.activityTimer) return;
    entry.activityTimer = setTimeout(() => { entry.activityTimer = null; entry.lastActivityEmit = Date.now(); emit(); },
      Math.max(0, entry.lastActivityEmit + ACTIVITY_THROTTLE_MS - now));
    entry.activityTimer.unref?.();
  }
  exited(entry, exitCode, signal) {
    if (this.disposed || entry.exited) return;
    entry.exited = true; entry.tools.clear(); entry.commands.clear(); entry.pending = []; entry.answered = false; this.syncPending(entry); clearTimeout(entry.forceTimer); clearTimeout(entry.activityTimer); entry.activityTimer = null; for (const resolve of entry.waiters.splice(0)) resolve();
    const { session } = entry;
    session.status = entry.stopping ? 'stopped' : 'exited'; session.exitCode = exitCode; session.signal = signal ?? null;
    session.endedAt = new Date().toISOString(); session.activity = null; session.slot = null;
    const recorded = [...entry.descendants.values()];
    session.survivors = recorded.length ? null : [];
    this.persist(session, true); this.emitStatus(session); this.scheduleFlush();
    // The end snapshot: changes in the checkout since the start, counted once now (Git runs
    // in the storage worker). It lives on entry.session, so every later save carries it.
    entry.snapshotPending = true;
    entry.changeSnapshot = (async () => {
      const at = new Date().toISOString();
      try { session.changeStats = summarizeChanges(await this.store.sessionChanges(session.id), at); }
      catch (error) { session.changeStats = summarizeChanges({ available: false, reason: error?.message ?? 'Changes could not be counted' }, at); }
      this.persist(session, true); if (!this.disposed) this.emitStatus(session);
    })().catch(() => {}).finally(() => { entry.snapshotPending = false; this.settling.delete(entry.changeSnapshot); if (!this.disposed) this.trimExited(); });
    this.settling.add(entry.changeSnapshot);
    const event = survivors => this.record(session.id, entry.stopping ? 'stop' : 'exit', { exitCode, signal: signal ?? null, survivors });
    if (!recorded.length) { event(0); this.trimExited(); return; }
    // Leftover children: scanned after exit, always saved (dispose waits for it).
    entry.scanPending = true;
    entry.survivorScan = (async () => {
      const remaining = survivors(recorded, await Promise.resolve(this.table()).catch(() => null));
      session.survivors = remaining === null ? null : remaining.map(row => ({ pid: row.pid, started: row.started, command: redact(row.command, 120) }));
      event(session.survivors?.length ?? null);
      if (this.disposed) this.persist(session, true); else this.emitStatus(session);
    })().catch(() => {}).finally(() => { entry.scanPending = false; this.settling.delete(entry.survivorScan); if (!this.disposed) this.trimExited(); });
    this.settling.add(entry.survivorScan);
    this.trimExited();
  }
  // Keeps at most RETAINED_EXITED exited buffers, dropping the oldest first. One being
  // viewed (attached) or still being scanned or counted is kept; it is trimmed when it is
  // detached or its scan and count finish (or on a later exit).
  trimExited() {
    const exited = [...this.entries.values()].filter(entry => entry.exited)
      .sort((a, b) => String(a.session.endedAt ?? '').localeCompare(String(b.session.endedAt ?? '')));
    let excess = exited.length - RETAINED_EXITED;
    for (const entry of exited) {
      if (excess <= 0) break;
      if (entry.attached || entry.scanPending || entry.snapshotPending) continue;
      this.entries.delete(entry.session.id); excess--;
    }
  }
  owned(id) {
    const entry = this.entries.get(id);
    if (!entry || entry.exited) throw fail(ERROR_CODES.NOT_LIVE, 'Terminal is not active or owned by this session');
    return entry;
  }
  write(id, data) {
    if (typeof data !== 'string' || Buffer.byteLength(data) > 64 * 1024) throw new Error('Terminal input is too large');
    const entry = this.owned(id);
    // Claude's prompt answer keys: a digit selects, Enter confirms, Esc or Ctrl+C dismisses (deny with feedback ends with Enter).
    // Pasted text never counts. The only open prompt settles at once; with several, the next tool event settles one.
    const dismiss = data === '\x1b' || data === '\x03';
    if (entry.pending.length && !data.startsWith('\x1b[200~') && (data.includes('\r') || dismiss || /^[1-9]$/.test(data))) entry.answered = true;
    entry.proc.write(data); entry.lastInputAt = Date.now();
    if (printable(data)) entry.typedThisTurn = true;
    const { session } = entry;
    if (entry.answered && entry.pending.length === 1 && session.status === 'waiting') {
      // Esc or Ctrl+C rejects the tool and interrupts the turn, which no hook reports: Claude is back at its input box.
      entry.pending = []; entry.answered = false; this.syncPending(entry); this.observe(id, session.nativeId, 'running', dismiss ? 'idle' : 'working');
    } else if (dismiss && !entry.pending.length && session.provider === 'claude' && session.status === 'running' && session.activity === 'working' && !entry.typedThisTurn) {
      // "esc to interrupt": Stop does not fire on a user interrupt. A later tool event corrects this if the turn went on.
      // Not after typing during the turn: the key may only close an autocomplete menu or leave vim insert mode.
      this.observe(id, session.nativeId, 'running', 'idle');
    }
  }
  // Types a file reference into the agent's input without submitting it, only
  // when Claude's hooks report it idle at its prompt (never while working or
  // during a permission request), so pasted text cannot answer a prompt.
  // Otherwise the caller copies the reference for the user to paste.
  paste(id, text, reference = {}) {
    const entry = this.owned(id); const { session } = entry;
    if (typeof text !== 'string' || !text || text.length > 2048 || /[\x00-\x1f\x7f]/.test(text)) throw new Error('This reference cannot be typed into the terminal');
    const reason = session.provider !== 'claude' ? `Journal cannot see when ${PROVIDER_NAMES[session.provider]} is ready for input`
      : session.activity === 'permission' || session.status === 'waiting' ? 'The agent is waiting for a permission answer'
      : session.status !== 'running' || entry.stopping ? 'The agent is not ready for input'
      : session.activity === 'working' ? 'The agent is working and could ask for permission at any moment'
      // A permission prompt can appear just before its hook is observed, so
      // only a turn that has been idle for a moment counts as ready.
      : session.activity !== 'idle' || Date.now() - (entry.activitySince ?? 0) < IDLE_SETTLE_MS ? 'Journal does not know yet whether the agent is ready for input' : null;
    if (reason) return { inserted: false, reason };
    entry.proc.write(entry.bracketedPaste ? `\x1b[200~${text} \x1b[201~` : `${text} `); entry.lastInputAt = Date.now();
    this.record(id, 'reference', referenceEvent(reference, 'inserted'));
    return { inserted: true };
  }
  resize(id, cols, rows) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 || cols > 500 || rows > 300) throw new Error('Invalid terminal size');
    const entry = this.owned(id); entry.session.terminal = { cols, rows };
    // The same size changes nothing (no repaint), so it opens no echo window either.
    if (entry.size.cols === cols && entry.size.rows === rows) return;
    entry.proc.resize(cols, rows); entry.size = { cols, rows }; entry.lastResizeAt = Date.now();
  }
  // Goes through write() so Ctrl+C counts as answering an open permission prompt.
  interrupt(id) { this.write(id, '\x03'); this.record(id, 'interrupt', {}); }
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
    if (isLive(session.status) || session.status === 'orphaned') throw new Error('Stop this session before confirming its conversation ID');
    const confirmed = { nativeId, nativeIdConfirmed: true, nativeIdSource: 'user', identityMismatch: false };
    Object.assign(session, confirmed);
    // Keep a retained in-memory copy in step so a later save cannot revert it.
    const entry = this.entries.get(id); if (entry) Object.assign(entry.session, confirmed);
    await this.store.saveSession(session); this.emitStatus(session); return session;
  }
  observe(id, nativeId, status, activity) {
    const entry = this.entries.get(id);
    if (!entry || entry.exited || !UUID.test(nativeId ?? '')) return;
    const { session } = entry;
    // Child sessions and native /clear can report another ID. Never graft it
    // onto a confirmed parent or silently restore confidence on a later hook.
    if (nativeId !== session.nativeId && !entry.identityAmbiguous) {
      entry.identityAmbiguous = true; session.identityMismatch = true;
      this.emit('event', { type: 'error', sessionId: id, code: IDENTITY_CHANGED, message: 'Native session identity changed. Stop the terminal and confirm its conversation ID before continuing.' });
    }
    // The preassigned ID is now seen in Claude's own hook.
    if (nativeId === session.nativeId && !entry.identityAmbiguous && session.nativeIdSource === 'preassigned') session.nativeIdSource = 'preassigned-observed';
    session.nativeIdConfirmed = !entry.identityAmbiguous;
    if (!entry.stopping && status) session.status = status;
    if (activity !== undefined) { if (activity !== session.activity) { entry.activitySince = Date.now(); entry.typedThisTurn = false; } session.activity = activity; }
    this.persist(session, true); this.emitStatus(session);
  }
  // Open approval prompts end when their own tool (or the last in-flight tool of its kind)
  // completes, or when the user answers: one answer settles the oldest prompt. A sibling or
  // subagent event alone must not hide a prompt. `known` is undefined for a tool that is starting.
  settlePermissions(id, nativeId, toolUseId, known) {
    const entry = this.entries.get(id); if (!entry) return;
    const before = entry.pending[0];
    if (known !== undefined) {
      const open = entry.pending.filter(p => !this.permissionResolvedBy(entry, p, toolUseId, known));
      // The answer belonged to the prompt this tool resolved.
      if (open.length < entry.pending.length) { entry.pending = open; entry.answered = false; }
    }
    if (entry.answered && entry.pending.length) { entry.pending.shift(); entry.answered = false; }
    this.syncPending(entry);
    if (entry.session.status === 'waiting' && !entry.pending.length) this.observe(id, nativeId, 'running', 'working');
    // Still waiting, now on the next prompt: report its detail.
    else if (entry.session.status === 'waiting' && entry.pending[0] !== before) this.emitStatus(entry.session);
  }
  // The banner shows the oldest open prompt, the one the next answer settles.
  syncPending(entry) { entry.session.pending = entry.pending[0]?.detail ?? null; }
  // Workspace-relative, '/'-separated and bounded; null outside the workspace.
  relativePath(session, file) {
    if (typeof file !== 'string' || !file) return null;
    // Compare canonical paths (for example /var vs /private/var on macOS).
    const path = relative(session.cwd, canonical(isAbsolute(file) ? file : join(session.cwd, file)));
    if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) return null;
    return path.split(sep).join('/').slice(0, 300);
  }
  // After Esc or Ctrl+C set Your turn, a tool that starts or completes shows the turn went on.
  // Not after Stop: it clears entry.tools, so only tools of the current turn count.
  restoreWorking(id, entry, nativeId) {
    if (entry.session.status === 'running' && entry.session.activity === 'idle') this.observe(id, nativeId, 'running', 'working');
  }
  // A tool finished (already removed from entry.tools): was it the one that asked?
  permissionResolvedBy(entry, pending, toolUseId, known) {
    if (pending.toolUseId && known) return pending.toolUseId === toolUseId;
    if (pending.toolUseId === toolUseId && toolUseId) return true;
    return ![...entry.tools.values()].some(tool => tool.tool === pending.tool);
  }
  // Claude hook observations: lifecycle, Bash commands with exit status when
  // the CLI reports it, and file edits. Command text is redacted and bounded;
  // no tool output or prompt text is kept.
  ingest(id, event) {
    const entry = this.entries.get(id); if (!entry || entry.exited) return;
    const { session } = entry;
    session.lastActivityAt = new Date().toISOString();
    switch (event.event) {
      case 'SessionStart': entry.pending = []; entry.answered = false; entry.tools.clear(); this.syncPending(entry); this.observe(id, event.nativeId, 'running', 'idle'); break;
      case 'UserPromptSubmit': entry.pending = []; entry.answered = false; entry.tools.clear(); this.syncPending(entry); this.observe(id, event.nativeId, 'running', 'working'); this.record(id, 'prompt', {}); break;
      case 'PermissionRequest': {
        // The request may not carry a tool id: match it to the in-flight tool that asked, if exactly one fits.
        const candidates = [...entry.tools].filter(([, tool]) => !tool.asked && tool.tool === event.tool
          && (!event.command || tool.command === event.command) && (!event.filePath || tool.filePath === event.filePath));
        const toolUseId = event.toolUseId ?? (candidates.length === 1 ? candidates[0][0] : null);
        if (toolUseId && entry.tools.has(toolUseId)) entry.tools.get(toolUseId).asked = true;
        // What the prompt asks: from the request, else from the in-flight tool that asked ('' counts as missing).
        const matched = toolUseId ? entry.tools.get(toolUseId) : null;
        const rawCommand = event.command || matched?.command || null;
        const rawPath = event.filePath || matched?.filePath || null;
        const detail = { tool: event.tool ?? null, command: rawCommand ? redact(rawCommand, 300) : null, path: rawPath ? this.relativePath(session, rawPath) : null,
          at: new Date().toISOString(), ...(!event.command && !event.filePath && matched ? { inferred: true } : {}) };
        entry.pending.push({ toolUseId, tool: event.tool ?? null, detail }); if (entry.pending.length > 100) entry.pending.shift(); entry.answered = false;
        this.syncPending(entry);
        this.observe(id, event.nativeId, 'waiting', 'permission');
        this.record(id, 'permission', { tool: detail.tool, command: detail.command, path: detail.path, toolUseId }); break;
      }
      case 'Stop': entry.pending = []; entry.answered = false; entry.tools.clear(); this.syncPending(entry); this.observe(id, event.nativeId, 'running', 'idle'); this.record(id, 'turn-end', {}); break;
      case 'PreToolUse':
        if (event.toolUseId && entry.tools.size < 500) entry.tools.set(event.toolUseId, { tool: event.tool, command: event.command ?? null, filePath: event.filePath ?? null });
        this.settlePermissions(id, event.nativeId, event.toolUseId);
        this.restoreWorking(id, entry, event.nativeId);
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
        // The tool ran, so any permission prompt for it was answered, even if no further PreToolUse arrives.
        const tool = entry.tools.get(event.toolUseId); const known = entry.tools.delete(event.toolUseId);
        this.settlePermissions(id, event.nativeId, event.toolUseId, known);
        // A rejected (asked) or interrupted tool failing is the end of the turn, not new work.
        if (known && !(event.event === 'PostToolUseFailure' && (event.interrupted || tool.asked))) this.restoreWorking(id, entry, event.nativeId);
        if (event.tool === 'Bash' && entry.commands.delete(event.toolUseId)) {
          // Exit 0 only when Claude reported completion of a foreground command.
          const status = event.interrupted ? 'interrupted' : event.background ? 'unknown' : event.event === 'PostToolUse' ? 'succeeded' : Number.isInteger(event.exit) ? 'failed' : 'unknown';
          this.record(id, 'command-end', { toolUseId: event.toolUseId, status, exitCode: status === 'succeeded' ? 0 : Number.isInteger(event.exit) ? event.exit : null, durationMs: Number.isFinite(event.durationMs) ? event.durationMs : null });
        } else if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(event.tool) && event.filePath && event.event === 'PostToolUse') {
          const path = this.relativePath(session, event.filePath);
          if (path) this.record(id, 'file', { path, tool: event.tool });
        }
        break;
      }
      default: break;
    }
  }
  record(sessionId, kind, body) {
    const event = { sessionId, kind, at: new Date().toISOString(), body };
    try { Promise.resolve(this.store.appendEvent?.(sessionId, kind, body, event.at)).catch(() => {}); } catch { /* timeline is best effort */ }
    if (!this.disposed) this.emit('event', { type: 'timeline', event });
  }
  attach(id) {
    const entry = this.entries.get(id);
    if (!entry) return { chunks: [], gap: true, lastSequence: 0 };
    const snapshot = entry.buffer.since(0);
    entry.attached = true; entry.sent = snapshot.lastSequence; entry.acknowledged = snapshot.lastSequence; entry.inflight = [];
    return snapshot;
  }
  detach(id) {
    for (const entry of this.entries.values()) if (!id || entry.session.id === id) entry.attached = false;
    if (!this.disposed) this.trimExited();
  }
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
      const next = { ...session, status: orphaned ? 'orphaned' : 'interrupted', identityVerified: orphaned ? verified : undefined, activity: null, slot: null, pending: null, endedAt: orphaned ? null : new Date().toISOString(), recoveredAt: new Date().toISOString() };
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
    }
    // Leftover-process scans and end snapshots still running are saved before the runtime closes.
    // (Tracked apart from entries, so a released buffer's pending save is awaited too.)
    await Promise.all([...this.settling]);
    this.disposed = true; this.detach();
    for (const entry of this.entries.values()) { clearTimeout(entry.activityTimer); entry.activityTimer = null; }
    for (const entry of this.liveEntries()) {
      try {
        await this.store.saveSession({ ...entry.session, status: 'interrupted', slot: null, pending: null, endedAt: new Date().toISOString() });
        const receipt = await this.store.getReceipt(entry.session.receiptId);
        if (['prepared', 'submitted'].includes(receipt.state)) await this.store.updateReceiptState(receipt.id, 'uncertain', entry.session.id);
      } finally { try { entry.proc.kill(); } catch {} }
    }
  }
}
