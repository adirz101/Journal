import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { buildAgentLaunch, captureCodexId, CODEX_RESUME_MARKER, PROVIDER_NAMES, PROVIDERS, UUID } from './agents.mjs';
import { captureCursorId, createChat, CURSOR_RESUME_MARKER, findCursor } from './cursor.mjs';
import { descendants, isAlive, processIdentity, processTable, resolveExecutable, sameIdentity, signalVerified, survivors, testProviderAllowed } from './process.mjs';
import { redact, text } from './validation.mjs';
import { generateTitle } from './sessions.mjs';
import { referenceEvent } from './references.mjs';
import { realPath } from './paths.mjs';
import { REPO_ENV } from './git-env.mjs';
import { agentTerminalEnv, APPEARANCES, QueryResponder, themeReport } from './terminal-queries.mjs';
import { ADAPTERS } from '../runtime/adapters/index.mjs';
import { SlotPool } from '../runtime/capacity.mjs';

export const IDLE_SETTLE_MS = 750;
export const ECHO_MS = 300;          // output this soon after input or resize is not "activity"
export const QUIET_MS = 10_000;      // output after this much quiet is a resume edge
export const ACTIVITY_THROTTLE_MS = 5_000;
export const LIVE_STATES = ['starting', 'running', 'waiting', 'stopping'];
// Observation (docs/superpowers/plans/2026-10-05-codex-cursor-hooks.md, 4.4). Definitions:
// - pending: the launch registered hooks and no event has been applied yet.
// - live: an applied parent event arrived (first event, or any event after loss). Only a live
//   observer lets the UI present a current state.
// - unobserved: the hooks will not report, by positive evidence only: the launch registered
//   nothing (provider not supported, gate failed), or a clearly submitted first prompt got
//   terminal output but no event within UNOBSERVED_GRACE_MS. Later gates (version, trust,
//   plugin refused) report through observationUnavailable().
// - lost: the hooks did report, then the observer reported a failure (file cap, unreadable
//   file) or a provider gate reported it unavailable. Never from silence.
// Silence never changes the observation: a long tool run or an unanswered approval can be
// silent for a long time. It only ages confidence: lastObserved keeps the last applied fact
// and its time, and the UI says when Working has not been confirmed recently
// (src/ui/sessionState.ts). A pending approval is cleared only by an event or an answer.
export const OBSERVATIONS = ['pending', 'live', 'unobserved', 'lost'];
export const UNOBSERVED_GRACE_MS = 20_000;
export const OBSERVATION_CHECK_MS = 5_000;
// lastObserved is sent with a status at most this old, so the window can age it accurately.
const OBSERVED_REFRESH_MS = 60_000;
// Turns (4.3): settled turn keys and applied event signatures kept per session.
const MAX_SETTLED_TURNS = 256; const MAX_SIGNATURES = 512; const MAX_CHILDREN = 100;
// One outcome per turn: the strongest wins, whatever the order. A turn replaced by a
// newer one before it reported an end is 'superseded' (weaker than any reported outcome).
const PRECEDENCE = { superseded: 0, completed: 1, error: 2, interrupted: 3 };
const stronger = (a, b) => (PRECEDENCE[b] ?? -1) > (PRECEDENCE[a] ?? -1) ? b : a;
// What an approval request asks, to recognise the same request while it is still open.
const requestKey = event => [event.tool ?? '', event.command ?? '', event.filePath ?? ''].join('\u0000');
const bounded = (collection, limit) => { while (collection.size > limit) collection.delete(collection.keys().next().value); };
// Exited sessions whose output stays in memory for review (BUG-8). Each live
// session also has its own bounded buffer. Output is never written to disk.
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
  SLOTS_FULL: 'SLOTS_FULL',                 // legacy client compatibility
  SHUTTING_DOWN: 'SHUTTING_DOWN',
  PROVIDER_MISSING: 'PROVIDER_MISSING',     // CLI not found before the start; spawn ENOENT
  PROVIDER_UNSUPPORTED: 'PROVIDER_UNSUPPORTED', // Cursor lacks resume/createChat/mode
  ID_UNCONFIRMED: 'ID_UNCONFIRMED',         // resume without a confirmed native ID
  CONVERSATION_OPEN: 'CONVERSATION_OPEN',   // same native conversation already live
  ORPHAN_RUNNING: 'ORPHAN_RUNNING',         // resume blocked by an orphan
  START_FAILED: 'START_FAILED',             // other launch failure (wrapped)
  NOT_LIVE: 'NOT_LIVE',                     // owned(): terminal not active
});
const CODES = new Set(Object.values(ERROR_CODES));
// The lifecycle states in which an isolated session's copy takes a new or continued session.
const OPEN_ENVIRONMENT = ['ready', 'running', 'waiting', 'completed', 'conflict', 'integrated'];
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

// The production resolver: a Claude or Codex CLI on PATH (PATHEXT on Windows), or null.
export const providerResolver = (env = process.env, platform = process.platform) => name => resolveExecutable(name, env, platform);

// Owns native terminals requested by the user. Every operation names a session ID, and
// only entries this manager spawned (and that have not exited) accept input or
// signals. Output stays in bounded memory; nothing raw is persisted.
export class TerminalManager extends EventEmitter {
  constructor({ store, spawn, makeObserver = () => null, runtimeId = randomUUID(), platform = process.platform, appVersion = null,
    identify = processIdentity, table = processTable, verifiedSignal = signalVerified, alive = isAlive, stopGraceMs = 3000, trackMs = 5000,
    cursor = { find: () => findCursor(process.env), createChat: (path, cwd) => createChat(path, cwd, process.env) },
    // Where a Claude or Codex CLI is now (PATH, PATHEXT on Windows), or null; checked before any
    // start. The runtime passes providerResolver(); unit tests with an injected spawn pass their own
    // or none (then the spawn alone decides, as before).
    resolveProvider = null, env = process.env, unobservedGraceMs = UNOBSERVED_GRACE_MS, observationMs = OBSERVATION_CHECK_MS, adapters = ADAPTERS, prepareTools = () => null }) {
    super(); this.cursor = cursor; this.resolveProvider = resolveProvider; this.env = env; this.store = store; this.spawn = spawn; this.makeObserver = makeObserver; this.runtimeId = runtimeId; this.platform = platform;
    this.unobservedGraceMs = unobservedGraceMs; this.adapters = adapters; this.prepareTools = prepareTools;
    this.identify = identify; this.table = table; this.verifiedSignal = verifiedSignal; this.alive = alive; this.stopGraceMs = stopGraceMs;
    // Journal's light or dark appearance: main sends it with each start and on every switch.
    this.appearance = 'dark'; this.appVersion = appVersion;
    // Slots are reserved synchronously at start so concurrent starts never share one.
    this.entries = new Map(); this.slots = new SlotPool(() => this.liveEntries().map(entry => entry.session.slot)); this.flushPending = false; this.disposed = false; this.settling = new Set();
    this.tracker = trackMs ? setInterval(() => { void this.trackDescendants().catch(() => {}); void this.recheckOrphans().catch(() => {}); }, trackMs) : null; this.tracker?.unref?.();
    this.observationTimer = observationMs ? setInterval(() => this.checkObservation(), observationMs) : null; this.observationTimer?.unref?.();
  }
  entry(id) { return this.entries.get(id) ?? null; }
  adapter(provider) { return Object.hasOwn(this.adapters, provider) ? this.adapters[provider] : null; }
  liveEntries() { return [...this.entries.values()].filter(entry => !entry.exited); }
  list() { return [...this.entries.values()].map(entry => ({ ...entry.session })); }
  // The lowest slot not held by a live session of this runtime or a start in progress.
  // Orphans hold no slot; their identity checks still prevent unsafe resumes.
  freeSlot() {
    return this.slots.free();
  }
  async start(request) {
    if (this.disposed) throw fail(ERROR_CODES.SHUTTING_DOWN, 'Journal is shutting down');
    // Live sessions and starts in progress (reserved) each hold one slot; a start
    // whose process already runs is in both sets but counts once.
    const lease = this.slots.reserve('manual');
    return this.startReserved(request, lease);
  }
  async startReserved(request, lease) {
    const slot = this.slots.validate(lease);
    try {
      if (this.disposed) throw fail(ERROR_CODES.SHUTTING_DOWN, 'Journal is shutting down');
      return await this.launch({ ...request, slot });
    } finally { this.slots.release(lease); }
  }
  async launch({ projectId, provider, task = '', resumeId, workspaceId = null, research = false, plan = false, disabled = [], references = [], slot = null, cliVersion = null, hooksEnabled = null, appearance, model = null, orchestration = null }) {
    if (!PROVIDERS.includes(provider)) throw new Error('Unknown agent provider');
    if (APPEARANCES.includes(appearance)) this.setAppearance(appearance);
    if (typeof research !== 'boolean' || typeof plan !== 'boolean') throw new Error('Invalid mode option');
    if (plan && provider === 'codex') throw new Error('Codex has no plan mode; use Read-only instead');
    if (research) plan = false;
    task = text(task, 'task', 4000, true);
    let prior = null;
    if (resumeId) {
      prior = await this.store.getSession(resumeId);
      if (prior.runId && (orchestration?.runId !== prior.runId || orchestration?.attemptId !== prior.attemptId && prior.role === 'worker')) throw fail('MANAGED_SESSION', 'Continue this conversation through its team so its task and capacity remain tracked');
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
    // An isolated session's copy takes work only before its result is applied, set aside or cleaned up.
    if (project.isolated && (!OPEN_ENVIRONMENT.includes(project.isolated.lifecycle) || (project.isolated.lifecycle === 'integrated' && !prior))) throw fail(ERROR_CODES.START_FAILED, `This isolated session is ${String(project.isolated.lifecycle).replace('_', ' ')}; its copy no longer takes new work through a new conversation. Continue its exact conversation instead.`);
    // Cursor: the genuine CLI (found again now, never assumed), with the modes this build documents.
    let cursor = null;
    if (provider === 'cursor') {
      cursor = await this.cursor.find();
      if (!cursor?.path || !cursor.cursor) throw fail(ERROR_CODES.PROVIDER_MISSING, 'Cursor CLI is not installed. Choose Install… on the Cursor card in New session, then start again.');
      if (!cursor.supports?.resume || !cursor.supports?.createChat) throw fail(ERROR_CODES.PROVIDER_UNSUPPORTED, 'This Cursor CLI version cannot open a chat by its exact ID. Update it with "agent update".');
      if ((research || plan) && !cursor.supports?.mode) throw fail(ERROR_CODES.PROVIDER_UNSUPPORTED, `This Cursor CLI version has no ${research ? 'Ask' : 'Plan'} mode. Update it with "agent update", or start without ${research ? 'Read-only' : 'Plan'}.`);
    }
    // Claude and Codex: the CLI must be found now, before any context is prepared or any receipt
    // is written, so a missing CLI is PROVIDER_MISSING with nothing sent (not an exit after a
    // submitted prompt). The launch itself still names the provider as before.
    const executablePath = provider === 'cursor' ? cursor.path : this.resolveProvider ? this.resolveProvider(provider) : provider;
    if (!executablePath) throw fail(ERROR_CODES.PROVIDER_MISSING, `${PROVIDER_NAMES[provider]} is not installed or not on PATH. Install it, then start again.`);
    // A headless test run never launches a provider CLI outside its fixture folder (process.mjs).
    if (executablePath !== provider && !testProviderAllowed(executablePath, this.env)) throw fail(ERROR_CODES.PROVIDER_MISSING, `${PROVIDER_NAMES[provider]} is outside the test provider folder; it is treated as not installed.`);
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
    const session = { id: randomUUID(), projectId, provider, model: model ?? prior?.model ?? null, nativeId,
      ...(orchestration ? { journalToolsAllowed: orchestration.journalToolsAllowed === true, role: orchestration.role, runId: orchestration.runId, taskId: orchestration.taskId ?? null, attemptId: orchestration.attemptId ?? null } : {}),
      launchId: orchestration?.launchId ?? randomUUID(), inputOwner: 'automation', inputGeneration: 0,
      nativeIdConfirmed: provider === 'claude' || !!prior || (provider === 'cursor' && !!nativeId), title: orchestration?.title ? text(orchestration.title, 'title', 200) : generateTitle(task, prior),
      status: 'starting', receiptId: receipt.id, resumedFrom: prior?.id ?? null, createdAt: now, lastActivityAt: now,
      // An additional-folder session runs in that folder with its own Git identity (if any).
      branch: project.cwd ? project.cwdBranch ?? null : project.branch, head: project.cwd ? project.cwdHead ?? null : project.head, cwd, workspaceId, research, plan, baseline, runtimeId: this.runtimeId, activity: null,
      ...(project.isolated ? { environmentId: project.isolated.id } : {}),
      slot, nativeIdSource, identityMismatch: false, lastOutputAt: null, pending: null,
      // What Journal observes of this launch (OBSERVATIONS); lastObserved: the last applied fact, as past evidence.
      observation: 'pending', lastObserved: null, children: 0,
      // The CLI version main detected for this launch (a resume records the version at resume time).
      cliVersion: typeof cliVersion === 'string' ? cliVersion.slice(0, 64) : null };
    let prompt = task;
    if (receipt.packet || (prior && (oldReceipt?.hadKnowledge || oldReceipt?.items.length))) {
      const withdrawn = oldReceipt?.items.filter(item => !receipt.items.some(current => current.revisionId === item.revisionId)) ?? [];
      const update = prior ? `Current Journal knowledge has been revalidated. Earlier context may remain. Only claims listed in the current packet by memory ID and revision are applicable; do not rely on any other earlier Journal claims. ${withdrawn.length ? `Previously delivered claims now excluded: ${withdrawn.map(item => `${item.id} r${item.revision}`).join(', ')}. ` : ''}${!receipt.items.length ? 'No prior Journal knowledge is currently applicable. ' : ''}No previous task is being repeated.\n` : '';
      prompt = `${update}${receipt.packet}${task ? `\nTask:\n${task}` : ''}`;
    }
    // Checked again right before the session counts as live: an Apply, Abandon or cleanup may have
    // finished while the launch was being prepared (once saved, those wait for the session).
    if (project.isolated) { const current = await this.store.getEnvironment(project.isolated.id); if (!OPEN_ENVIRONMENT.includes(current.state) || current.base !== project.isolated.base || (current.state === 'integrated' && !prior)) throw fail(ERROR_CODES.START_FAILED, 'This copy changed during launch preparation and no longer takes new work from this request. Refresh and continue its exact conversation.'); }
    await this.store.saveSession(session);
    this.record(session.id, prior ? 'resume' : 'start', { provider, resumedFrom: prior?.id ?? null, branch: project.branch, head: project.head });
    let entry = null;
    try {
      if (this.disposed) throw fail(ERROR_CODES.SHUTTING_DOWN, 'Journal is shutting down');
      // The provider's adapter registers this launch's hooks (Claude: --settings); null when it is not observed.
      // Codex: what the desktop's detection read (`codex features list`). Cursor: whether this CLI's own
      // help lists --plugin-dir (an older Cursor would refuse the flag, so nothing is registered then).
      const observing = provider === 'cursor' ? cursor?.supports?.pluginDir === true : typeof hooksEnabled === 'boolean' ? hooksEnabled : null;
      const observer = this.makeObserver(session, project, { hooksEnabled: observing });
      if (!observer) session.observation = 'unobserved';
      // What this launch's hooks can report (Cursor without level 2: no turn end; never approvals).
      session.observes = observer?.observes ?? null;
      const tools = session.role ? await this.prepareTools(session) : null;
      const launch = buildAgentLaunch({ provider, model: session.model, nativeId: session.nativeId, resume: !!prior, prompt, settingsFile: observer?.settingsFile ?? null, hookArgs: observer?.args ?? [], research, plan, executable: cursor?.path, tools: tools?.config });
      // The agent's terminal is Journal's, not the one Journal was started from: TERM_PROGRAM names
      // Journal, and COLORFGBG (read by Claude Code in theme Auto and by Cursor) is Journal's appearance.
      // The hook launcher reads the observer's target and token from here (the command is the same for every launch).
      // An inherited observer (Journal started from a Journal session's agent) is never passed on:
      // only an observed launch gets a target and token, its own.
      // An isolated session: its port block, temp and log folders and identity (development isolation,
      // not a sandbox; agents may ignore the variables).
      const isolation = project.isolated && this.store.environmentLaunch ? await this.store.environmentLaunch(project.isolated.id) : {};
      const env = { ...agentTerminalEnv(process.env, { appearance: this.appearance, version: this.appVersion }), ...isolation, JOURNAL_SESSION_ID: session.id };
      delete env.ELECTRON_RUN_AS_NODE; delete env.JOURNAL_APP_VERSION; delete env.JOURNAL_HOOK_TARGET; delete env.JOURNAL_HOOK_TOKEN;
      for (const name of ['JOURNAL_RUN_ID', 'JOURNAL_TASK_ID', 'JOURNAL_ATTEMPT_ID', 'JOURNAL_TOOL_ID', 'JOURNAL_TOOL_TOKEN', 'JOURNAL_TOOL_SOCKET', 'JOURNAL_CONTINUATION_ENABLED', 'JOURNAL_CONTINUATION_ID', 'JOURNAL_CONTINUATION_TOKEN', 'JOURNAL_CONTINUATION_SOCKET']) delete env[name];
      Object.assign(env, observer?.env ?? {});
      Object.assign(env, tools?.env ?? {});
      // The agent works in session.cwd: Git variables that point at another repository are not passed on (git-env.mjs).
      for (const name of Object.keys(env)) if (REPO_ENV.has(name.toUpperCase())) delete env[name];
      const proc = this.spawn(launch.executable, launch.argv, { cwd: session.cwd, env, name: 'xterm-256color', ...PTY_SIZE });
      entry = { session, proc, buffer: new OutputBuffer(), attached: 0, sent: 0, acknowledged: 0, inflight: [], tail: '', exited: false,
        stopping: false, waiters: [], descendants: new Map(), identityAmbiguous: false, commands: new Map(), tools: new Map(), pending: [], answered: false, lastPersist: 0,
        lastInputAt: 0, lastResizeAt: 0, lastActivityEmit: 0, activityTimer: null, size: { cols: PTY_SIZE.cols, rows: PTY_SIZE.rows }, queries: new QueryResponder(),
        // Turns and observation: the current turn key, settled keys with their outcome, applied event
        // signatures, child IDs seen, when lastObserved was last sent and when a prompt was first submitted.
        currentTurn: null, settled: new Map(), signatures: new Set(), childIds: new Set(), observedSentAt: 0,
        promptAt: prompt ? Date.now() : 0, typedText: false,
        launchId: session.launchId, observationGeneration: 0, inputGeneration: 0, inputOwner: 'automation', boundary: null };
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
      throw Object.assign(fail(['ENOMEM', 'EAGAIN', 'EMFILE'].includes(error.code) ? error.code : code, `Could not start ${provider}. Check that its CLI is installed and available on PATH. ${error.message}`), { noProcess: !spawned });
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
    // Colour queries are answered here at once (src/core/terminal-queries.mjs). Not typed input: lastInputAt stays.
    const reply = entry.queries.feed(data, { appearance: this.appearance, attached: entry.attached > 0 });
    if (reply && !entry.exited) { try { entry.proc.write(reply); } catch { /* the PTY is closing */ } }
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
  boundaryReason(entry, operation) {
    const { session } = entry;
    if (entry.exited || entry.stopping || !['running', 'waiting'].includes(session.status)) return 'NOT_RUNNING';
    if (entry.pending.length || session.status === 'waiting' || session.activity === 'permission') return 'PENDING_APPROVAL';
    if (entry.inputOwner !== 'automation') return entry.inputOwner === 'human' ? 'HUMAN_INPUT' : 'INPUT_UNCERTAIN';
    // No production adapter declares these contracts until native validation. Quiet time is
    // only a debounce; it proves neither an empty input buffer nor absence of background writers.
    if (this.adapter(session.provider)?.boundaries?.[operation] !== true) return 'BOUNDARY_UNVERIFIED';
    if (session.observation !== 'live') return 'OBSERVATION_LOST';
    if (entry.tools.size || entry.commands.size || session.activity !== 'idle' || Date.now() - (entry.activitySince ?? 0) < IDLE_SETTLE_MS) return 'NOT_IDLE';
    return null;
  }
  qualifyBoundary(id, operation) {
    if (!['capture', 'delivery', 'apply', 'mutate'].includes(operation)) throw new Error('Unknown boundary operation');
    const entry = this.owned(id); const reason = this.boundaryReason(entry, operation);
    if (reason) return { eligible: false, reason };
    const boundary = { eligible: true, reservationId: randomUUID(), operation, sessionId: id, launchId: entry.launchId,
      turnId: entry.currentTurn, observationGeneration: entry.observationGeneration, inputGeneration: entry.inputGeneration };
    entry.boundary = boundary;
    return { ...boundary };
  }
  validateBoundary(boundary) {
    const entry = this.entries.get(boundary?.sessionId);
    if (!entry || !entry.boundary || entry.boundary.reservationId !== boundary.reservationId ||
      ['operation', 'launchId', 'turnId', 'observationGeneration', 'inputGeneration'].some(key => entry.boundary[key] !== boundary[key]) ||
      entry.launchId !== boundary.launchId || entry.observationGeneration !== boundary.observationGeneration || entry.inputGeneration !== boundary.inputGeneration) return { eligible: false, reason: 'BOUNDARY_CHANGED' };
    const reason = this.boundaryReason(entry, boundary.operation);
    return reason ? { eligible: false, reason } : { eligible: true };
  }
  claimInput(entry, owner = 'human') {
    entry.inputOwner = owner; entry.inputGeneration++; entry.boundary = null;
    entry.session.inputOwner = owner; entry.session.inputGeneration = entry.inputGeneration;
    this.persist(entry.session, true);
  }
  stageAutomatic(boundary, text) {
    if (!this.validateBoundary(boundary).eligible) throw fail('BOUNDARY_CHANGED', 'The automatic input boundary changed');
    const entry = this.owned(boundary.sessionId); const transport = this.adapter(entry.session.provider)?.delivery;
    if (!transport?.stage || !transport?.submit) throw fail('BOUNDARY_UNVERIFIED', 'This adapter has no validated delivery transport');
    // Set before the first possible side effect, including a partially throwing PTY write.
    entry.stagedInput = true;
    transport.stage(entry, text);
  }
  submitAutomatic(boundary) {
    if (!this.validateBoundary(boundary).eligible) throw fail('BOUNDARY_CHANGED', 'The automatic input boundary changed');
    const entry = this.owned(boundary.sessionId);
    this.adapter(entry.session.provider).delivery.submit(entry);
    entry.stagedInput = false;
    entry.boundary = null;
  }
  uncertainInput(id) { const entry = this.entries.get(id); if (entry) { this.claimInput(entry, 'uncertain'); this.emitStatus(entry.session); } }
  resumeAutomatic(id) {
    const entry = this.owned(id); const adapter = this.adapter(entry.session.provider);
    if (entry.pending.length || adapter?.delivery?.handoff?.(entry) !== true) throw fail('HANDOFF_UNVERIFIED', 'This provider cannot yet prove that its input is empty. Use the addressed inbox.');
    entry.stagedInput = false; this.claimInput(entry, 'automation'); this.emitStatus(entry.session);
    return { inputOwner: entry.inputOwner };
  }
  write(id, data) {
    if (typeof data !== 'string' || Buffer.byteLength(data) > 64 * 1024) throw new Error('Terminal input is too large');
    const entry = this.owned(id);
    // Revoke before writing: a throwing or partial write cannot leave automation owning a draft.
    this.claimInput(entry);
    // Claude's prompt answer keys: a digit selects, Enter confirms, Esc or Ctrl+C dismisses (deny with feedback ends with Enter).
    // Pasted text never counts. The only open prompt settles at once; with several, the next tool event settles one.
    const dismiss = data === '\x1b' || data === '\x03';
    const extra = this.adapter(entry.session.provider)?.answerKeys;
    if (entry.pending.length && !data.startsWith('\x1b[200~') && (data.includes('\r') || dismiss || /^[1-9]$/.test(data) || (extra && extra.test(data)))) entry.answered = true;
    entry.proc.write(data); entry.lastInputAt = Date.now();
    if (printable(data)) { entry.typedThisTurn = true; entry.typedText = true; }
    // A prompt is clearly submitted when Enter follows typed text (not inside a paste).
    const submitted = entry.typedText && data.includes('\r') && !data.startsWith('\x1b[200~') && !entry.pending.length;
    if (submitted) { entry.typedText = false; entry.promptAt ||= entry.lastInputAt; }
    const { session } = entry;
    // A provider without a turn-start event (Cursor): a prompt submitted at Your turn starts a turn no
    // hook announces, so the state becomes unknown until the next event, never a stale Your turn.
    if (submitted && session.status === 'running' && session.activity === 'idle' && this.adapter(session.provider)?.turnStarts === false) {
      session.activity = null; this.persist(session, true); this.emitStatus(session);
    }
    if (entry.answered && entry.pending.length === 1 && session.status === 'waiting') {
      // Esc or Ctrl+C rejects the tool and interrupts the turn, which no hook reports: Claude is back at its input box.
      // Claude: Esc or Ctrl+C is back at its input box. Other providers report what follows (Codex: Interrupt).
      entry.pending = []; entry.answered = false; this.syncPending(entry); this.observe(id, session.nativeId, 'running', dismiss && session.provider === 'claude' ? 'idle' : 'working');
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
    // Typed only where Journal can see both the agent's turns and its approval prompts: Claude, and
    // Codex with its hooks live. Cursor's approval waits are not observable, so it is copied instead.
    const sees = session.provider === 'claude' ? session.observes?.approvals !== false : !!(session.observes?.turns && session.observes?.approvals);
    const reason = !sees ? `Journal cannot see when ${PROVIDER_NAMES[session.provider]} is ready for input`
      : session.activity === 'permission' || session.status === 'waiting' ? 'The agent is waiting for a permission answer'
      : session.status !== 'running' || entry.stopping ? 'The agent is not ready for input'
      // Without a live observer the last state may be out of date.
      : session.observation !== 'live' ? 'Journal does not know yet whether the agent is ready for input'
      : session.activity === 'working' ? 'The agent is working and could ask for permission at any moment'
      // A permission prompt can appear just before its hook is observed, so
      // only a turn that has been idle for a moment counts as ready.
      : session.activity !== 'idle' || Date.now() - (entry.activitySince ?? 0) < IDLE_SETTLE_MS ? 'Journal does not know yet whether the agent is ready for input' : null;
    if (reason) return { inserted: false, reason };
    this.claimInput(entry);
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
    if (!Array.isArray(session.survivors)) throw Object.assign(new Error('The previous process tree is unknown; inspect it before reusing this folder'), { code: 'WRITERS_UNKNOWN' });
    const recorded = [...session.survivors]; const results = [];
    for (const row of recorded) results.push({ pid: row.pid, ...await this.verifiedSignal(row.pid, { started: row.started }, 'SIGTERM', this.platform) });
    // Sending SIGTERM is not proof of exit. Preserve blockers when a signal fails,
    // a child ignores it, or the process table cannot be read. Only observed absence
    // may release the environment's writer guard.
    let remaining = recorded; let verified = false; const deadline = Date.now() + 1000;
    do {
      const current = survivors(recorded, await Promise.resolve(this.table()).catch(() => null));
      if (current === null) break;
      remaining = current; verified = true;
      if (!remaining.length || Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (true);
    session.survivors = remaining;
    await this.store.saveSession({ ...session });
    this.record(id, 'cleanup', { results: results.map(r => ({ pid: r.pid, signalled: r.signalled })), remaining: remaining.length, verified });
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
      const tracked = [...entry.descendants.values()].map(row => ({ pid: row.pid, started: row.started, command: redact(row.command, 120) }));
      if (JSON.stringify(entry.session.processTracking?.descendants) !== JSON.stringify(tracked)) { entry.session.processTracking = { descendants: tracked }; this.persist(entry.session); }
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
    if (!entry || entry.exited || !this.bindIdentity(entry, nativeId)) return;
    const { session } = entry;
    if (!entry.stopping && status) session.status = status;
    if (activity !== undefined) { if (activity !== session.activity) { entry.activitySince = Date.now(); entry.typedThisTurn = false; } session.activity = activity; }
    this.persist(session, true); this.emitStatus(session);
  }
  // A parent event's native ID against the session's (4.8). A launch without one binds the
  // first parent ID when its adapter allows it (Codex); an exit-banner hint gives way to it.
  // Any other ID is a mismatch: child sessions and native /clear can report another ID, which
  // is never grafted onto a known parent nor silently forgiven by a later matching hook.
  // False when the ID is not a UUID (the event then changes no state). Children never get here.
  bindIdentity(entry, nativeId) {
    if (!UUID.test(nativeId ?? '')) return false;
    const { session } = entry;
    const bindable = !entry.identityAmbiguous && this.adapter(session.provider)?.bindsIdentity
      && (!session.nativeId || (session.nativeIdSource === 'exit-banner' && !session.nativeIdConfirmed));
    if (bindable && session.nativeId !== nativeId) { session.nativeId = nativeId; session.nativeIdSource = 'hook'; }
    if (nativeId !== session.nativeId && !entry.identityAmbiguous) {
      entry.identityAmbiguous = true; session.identityMismatch = true;
      this.emit('event', { type: 'error', sessionId: session.id, code: IDENTITY_CHANGED, message: 'Native session identity changed. Stop the terminal and confirm its conversation ID before continuing.' });
    }
    // The preassigned ID is now seen in Claude's own hook.
    if (nativeId === session.nativeId && !entry.identityAmbiguous && session.nativeIdSource === 'preassigned') session.nativeIdSource = 'preassigned-observed';
    if (nativeId === session.nativeId && !entry.identityAmbiguous && session.nativeIdSource === 'exit-banner') session.nativeIdSource = 'hook';
    session.nativeIdConfirmed = !entry.identityAmbiguous;
    return true;
  }
  // Open approval prompts end when their own tool (or the last in-flight tool of its kind)
  // completes, or when the user answers: one answer settles the oldest prompt. A sibling or
  // subagent event alone must not hide a prompt. `known` is undefined for a tool that is starting.
  settlePermissions(id, nativeId, toolUseId, known, event = null) {
    const entry = this.entries.get(id); if (!entry) return;
    const before = entry.pending[0];
    if (known !== undefined) {
      const open = entry.pending.filter(p => !this.permissionResolvedBy(entry, p, toolUseId, known, event));
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
  // A relative file is resolved against the hook's working directory (base) when known.
  relativePath(session, file, base) {
    if (typeof file !== 'string' || !file) return null;
    // Compare canonical paths (for example /var vs /private/var on macOS).
    const path = relative(session.cwd, canonical(isAbsolute(file) ? file : join(typeof base === 'string' && isAbsolute(base) ? base : session.cwd, file)));
    if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) return null;
    return path.split(sep).join('/').slice(0, 300);
  }
  // After Esc or Ctrl+C set Your turn, a tool that starts or completes shows the turn went on.
  // Not after Stop: it clears entry.tools, so only tools of the current turn count.
  restoreWorking(id, entry, nativeId) {
    if (entry.session.status === 'running' && entry.session.activity === 'idle') this.observe(id, nativeId, 'running', 'working');
  }
  // A tool finished (already removed from entry.tools): was it the one that asked?
  permissionResolvedBy(entry, pending, toolUseId, known, event = null) {
    if (pending.toolUseId && known) return pending.toolUseId === toolUseId;
    if (pending.toolUseId === toolUseId && toolUseId) return true;
    // Without tool starts (Codex), only the asking tool's own end settles it: the same tool and
    // command or path. A sibling tool finishing in parallel never does.
    if (this.adapter(entry.session.provider)?.toolStarts === false) return !!event && !!pending.request && pending.request === requestKey(event);
    return ![...entry.tools.values()].some(tool => tool.tool === pending.tool);
  }
  // Hook observations, normalized by the session's provider adapter: lifecycle, Bash
  // commands with exit status when the CLI reports it, and file edits. Command text is
  // redacted and bounded; no tool output or prompt text is kept. An event the adapter
  // cannot classify is dropped; a child's event only updates the child count; turn rules
  // (turnVerdict) keep an old or repeated event from changing the current state.
  ingest(id, raw) {
    const entry = this.entries.get(id); if (!entry) return;
    const event = this.adapter(entry.session.provider)?.normalize(raw); if (!event) return;
    entry.observationGeneration++; entry.boundary = null;
    if (entry.exited) { this.drained(entry, event); return; }
    // Shut down with the process still running: its state was saved as interrupted and stays so.
    if (this.disposed) return;
    const { session } = entry; const now = Date.now();
    session.lastActivityAt = new Date(now).toISOString();
    if (event.child) { this.child(entry, event); return; }
    const verdict = this.turnVerdict(entry, event);
    if (verdict === 'ignore') return;
    // A turn end that arrived late (an older turn) or that strengthens the current turn's
    // outcome is recorded for the timeline, which shows one entry per turn; state is unchanged.
    if (verdict === 'late' || verdict === 'revised') {
      this.record(id, 'turn-end', { turn: event.turn, outcome: event.outcome, ...(verdict === 'late' ? { late: true } : {}) });
      if (verdict === 'revised') session.lastObserved = { fact: `turn-${event.outcome}`, at: session.lastActivityAt };
      return;
    }
    const wasLive = session.observation === 'live'; const version = session.version; const lastSent = entry.observedSentAt ?? 0;
    session.observation = 'live';
    session.lastObserved = { fact: event.kind === 'turn-end' ? `turn-${event.outcome}` : event.kind, at: session.lastActivityAt };
    // A new turn ends whatever the previous one left open; its first event, unless it is the
    // turn's start, end or an approval request, shows the new turn is working.
    if (verdict === 'new-turn') {
      entry.pending = []; entry.answered = false; entry.tools.clear(); this.syncPending(entry);
      if (event.kind === 'tool-end' || event.kind === 'tool-start') this.observe(id, event.nativeId, 'running', 'working');
    }
    this.apply(id, entry, event);
    if (event.kind === 'turn-end' && event.hookInvocationId) entry.lastStopInvocation = { id: event.hookInvocationId, turnId: entry.currentTurn };
    if (session.version !== version) entry.observedSentAt = now;
    // Becoming live, or a last fact the window has not had for a while, is sent on its own.
    else if (!wasLive || now - lastSent >= OBSERVED_REFRESH_MS) { entry.observedSentAt = now; this.emitStatus(session); }
  }
  apply(id, entry, event) {
    const { session } = entry;
    // Codex and Cursor check every parent event's ID; Claude, as before, when its state changes.
    if (this.adapter(session.provider)?.strictIdentity) this.bindIdentity(entry, event.nativeId);
    switch (event.kind) {
      case 'session-start': entry.pending = []; entry.answered = false; entry.tools.clear(); this.syncPending(entry); this.observe(id, event.nativeId, 'running', 'idle'); break;
      case 'turn-start':
        // Claude has no native turn key. Bind reports to an observed parent prompt,
        // never to startup, terminal input, a tool call, or an invented capture boundary.
        if (!event.turn && this.adapter(session.provider)?.localTurnIds === true) {
          entry.currentTurn = UUID.test(event.nativeId ?? '') && event.nativeId === session.nativeId &&
            !entry.identityAmbiguous ? randomUUID() : null;
          // Even a rejected identity must revoke the old reporting fence.
          this.emitStatus(session);
        }
        entry.pending = []; entry.answered = false; entry.tools.clear(); this.syncPending(entry);
        this.observe(id, event.nativeId, 'running', 'working'); this.record(id, 'prompt', {}); break;
      // In-turn evidence (Cursor's response event): the turn goes on.
      case 'turn-progress': if (session.status === 'running' && session.activity !== 'working') this.observe(id, event.nativeId, 'running', 'working'); break;
      case 'permission-wait': {
        // The request may not carry a tool id: match it to the in-flight tool that asked, if exactly one fits.
        const candidates = [...entry.tools].filter(([, tool]) => !tool.asked && tool.tool === event.tool
          && (!event.command || tool.command === event.command) && (!event.filePath || tool.filePath === event.filePath));
        const toolUseId = event.toolUseId ?? (candidates.length === 1 ? candidates[0][0] : null);
        if (toolUseId && entry.tools.has(toolUseId)) entry.tools.get(toolUseId).asked = true;
        // What the prompt asks: from the request, else from the in-flight tool that asked ('' counts as missing).
        const matched = toolUseId ? entry.tools.get(toolUseId) : null;
        const rawCommand = event.command || matched?.command || null;
        const rawPath = event.filePath || matched?.filePath || null;
        const detail = { tool: event.tool ?? null, command: rawCommand ? redact(rawCommand, 300) : null, path: rawPath ? this.relativePath(session, rawPath, event.filePath ? event.cwd : matched?.cwd) : null,
          at: new Date().toISOString(), ...(!event.command && !event.filePath && matched ? { inferred: true } : {}) };
        entry.pending.push({ toolUseId, tool: event.tool ?? null, detail, request: requestKey(event) }); if (entry.pending.length > 100) entry.pending.shift(); entry.answered = false;
        this.syncPending(entry);
        this.observe(id, event.nativeId, 'waiting', 'permission');
        this.record(id, 'permission', { tool: detail.tool, command: detail.command, path: detail.path, toolUseId }); break;
      }
      case 'turn-end':
        entry.pending = []; entry.answered = false; entry.tools.clear(); this.syncPending(entry); this.observe(id, event.nativeId, 'running', 'idle');
        this.record(id, 'turn-end', event.turn ? { turn: event.turn, outcome: event.outcome } : {}); break;
      case 'tool-start':
        if (event.toolUseId && entry.tools.size < 500) entry.tools.set(event.toolUseId, { tool: event.tool, command: event.command ?? null, filePath: event.filePath ?? null, cwd: event.cwd });
        this.settlePermissions(id, event.nativeId, event.toolUseId);
        this.restoreWorking(id, entry, event.nativeId);
        if (event.tool === 'Bash' && event.toolUseId && entry.commands.size < 500) {
          const command = redact(event.command ?? '', 300);
          entry.commands.set(event.toolUseId, true);
          this.record(id, 'command-start', { toolUseId: event.toolUseId, command, cwd: this.commandCwd(session, event.cwd), background: !!event.background, test: isTestCommand(command), ...(event.description ? { description: event.description } : {}) });
        }
        break;
      case 'tool-end': {
        // The tool ran, so any permission prompt for it was answered, even if no further tool-start arrives.
        const tool = entry.tools.get(event.toolUseId); const known = entry.tools.delete(event.toolUseId);
        this.settlePermissions(id, event.nativeId, event.toolUseId, known, event);
        // A rejected (asked) or interrupted tool failing is the end of the turn, not new work.
        if (known && !(event.failed && (event.interrupted || tool.asked))) this.restoreWorking(id, entry, event.nativeId);
        if (event.tool === 'Bash' && entry.commands.delete(event.toolUseId)) {
          // Exit 0 only when Claude reported completion of a foreground command.
          const status = event.interrupted ? 'interrupted' : event.background ? 'unknown' : !event.failed ? 'succeeded' : Number.isInteger(event.exit) ? 'failed' : 'unknown';
          this.record(id, 'command-end', { toolUseId: event.toolUseId, status, exitCode: status === 'succeeded' ? 0 : Number.isInteger(event.exit) ? event.exit : null, durationMs: Number.isFinite(event.durationMs) ? event.durationMs : null });
        } else if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(event.tool) && event.filePath && !event.failed) {
          const path = this.relativePath(session, event.filePath, event.cwd);
          if (path) this.record(id, 'file', { path, tool: event.tool });
        } else this.recordStoryTool(id, entry, event);
        break;
      }
      // The agent reported its own end; the process exit follows and decides the status.
      case 'session-end': this.persist(session, true); break;
      default: break;
    }
  }
  // Turn identity (4.3), for providers whose events carry a turn key (Claude's do not:
  // its events always apply). Returns:
  //   'apply' or 'new-turn' (the event starts the key's turn and settles an open older one);
  //   'late': a turn end for a turn that is not the current one (recorded, no state change);
  //   'revised': a stronger outcome for the current, already settled turn (recorded only);
  //   'ignore': a duplicate, a weaker or equal outcome, or a tool, permission or turn start
  //   event for a settled turn (a delayed turn start never reopens it).
  turnVerdict(entry, event) {
    const key = event.turn;
    if (!key) return 'apply';
    const settle = (turn, outcome) => { entry.settled.set(turn, outcome); bounded(entry.settled, MAX_SETTLED_TURNS); };
    if (entry.settled.has(key)) {
      if (event.kind !== 'turn-end') return 'ignore';
      const before = entry.settled.get(key); const after = stronger(before, event.outcome);
      if (after === before) return 'ignore';
      settle(key, after); event.outcome = after;
      return key === entry.currentTurn ? 'revised' : 'late';
    }
    // The current turn has already applied an event: a delayed or repeated start of it changes
    // nothing (it must not clear an open approval or end an approval wait).
    if (event.kind === 'turn-start' && key === entry.currentTurn) return 'ignore';
    // Duplicates. With a tool id: the same event, turn, tool, request and status already applied.
    // Without one, a repeat is indistinguishable from a new request, so only an approval request
    // identical to one still open and unanswered counts; tool ends without an id always apply
    // (two identical commands or edits in a row are two events, and applying one twice changes nothing).
    const signature = [event.event, key, event.toolUseId ?? '', event.tool ?? '', event.command ?? '', event.filePath ?? '', event.outcome ?? ''].join('\u0000');
    if (event.toolUseId && entry.signatures.has(signature)) return 'ignore';
    if (event.kind === 'permission-wait' && !event.toolUseId && !entry.answered && entry.pending.some(open => open.request === requestKey(event))) return 'ignore';
    const open = entry.currentTurn && !entry.settled.has(entry.currentTurn);
    let verdict = 'apply';
    if (key !== entry.currentTurn) {
      // An older turn's end while a newer turn runs: recorded, never finishes the newer one.
      if (event.kind === 'turn-end' && open) { settle(key, event.outcome); return 'late'; }
      if (open) settle(entry.currentTurn, 'superseded');
      entry.currentTurn = key; verdict = 'new-turn';
    }
    if (event.toolUseId) { entry.signatures.add(signature); bounded(entry.signatures, MAX_SIGNATURES); }
    if (event.kind === 'turn-end') settle(key, event.outcome);
    return verdict;
  }
  // Working directory relative to the session's workspace ('.' at its root), or null outside it.
  commandCwd(session, cwd) {
    if (typeof cwd !== 'string') return null;
    const rel = relative(session.cwd, canonical(cwd));
    return !rel ? '.' : rel.startsWith('..') || isAbsolute(rel) ? null : rel.split(sep).join('/').slice(0, 200);
  }
  // The Story's evidence from a finished tool that is not Claude's Bash or file tools
  // (src/core/story): Codex and Cursor commands (they report a command only when it ends),
  // Codex apply_patch and Cursor file edits, plan updates, and other tools by name. Bounded per session.
  recordStoryTool(id, entry, event) {
    const { session } = entry; entry.storyEvents = (entry.storyEvents ?? 0) + 1;
    if (entry.storyEvents > 5000) return;
    const adapter = this.adapter(session.provider);
    // A command reported once, at its end: Codex PostToolUse (with its exit code), Cursor afterShellExecution.
    const shell = session.provider === 'cursor' ? event.event === 'afterShellExecution' : adapter?.toolStarts === false && typeof event.command === 'string';
    if (shell && typeof event.command === 'string' && event.command) {
      const command = redact(event.command, 300); const toolUseId = event.toolUseId ?? `${session.provider}-${randomUUID()}`;
      const status = event.interrupted ? 'interrupted' : Number.isInteger(event.exit) ? event.exit === 0 ? 'succeeded' : 'failed' : event.failed ? 'failed' : 'unknown';
      this.record(id, 'command-start', { toolUseId, command, cwd: this.commandCwd(session, event.cwd), background: false, test: isTestCommand(command) });
      this.record(id, 'command-end', { toolUseId, status, exitCode: status === 'succeeded' ? 0 : Number.isInteger(event.exit) ? event.exit : null, durationMs: Number.isFinite(event.durationMs) ? event.durationMs : null });
      return;
    }
    if (session.provider === 'cursor' && (event.event === 'postToolUse' || event.event === 'postToolUseFailure') && /shell|terminal|edit|write|delete/i.test(event.tool ?? '')) return;
    if (event.failed) return;
    if (Array.isArray(event.patchFiles)) {
      for (const file of event.patchFiles) { const path = this.relativePath(session, file?.path, event.cwd); if (path) this.record(id, 'file', { path, tool: 'apply_patch', op: file.op === 'add' ? 'add' : file.op === 'delete' ? 'delete' : 'update' }); }
      return;
    }
    if (event.event === 'afterFileEdit' && event.filePath) { const path = this.relativePath(session, event.filePath, event.cwd); if (path) this.record(id, 'file', { path, tool: 'Edit' }); return; }
    if (event.plan) { const items = this.planSnapshot(entry, event.plan); if (items) this.record(id, 'plan', { items }); return; }
    if (!event.tool || event.tool === 'Bash' || /^(?:TodoWrite|TaskCreate|TaskUpdate|TaskList|TaskGet)$/.test(event.tool)) return;
    const path = event.readPath ? this.relativePath(session, event.readPath, event.cwd) : null;
    this.record(id, 'tool', { tool: event.tool, ...(path ? { path } : {}), ...(event.description ? { description: event.description } : {}) });
  }
  // The plan as a whole after one update: TodoWrite replaces it; TaskCreate adds an item and
  // TaskUpdate changes one. null when the update names nothing known.
  planSnapshot(entry, plan) {
    entry.plan ??= new Map();
    // The hook bounded these; the runtime keeps only the known fields again (a line is untrusted input).
    const id = value => typeof value === 'string' && value ? value.slice(0, 160) : null;
    const title = value => typeof value === 'string' && value.trim() ? redact(value.trim(), 120) : null;
    const status = value => ['pending', 'in_progress', 'completed'].includes(value) ? value : null;
    if (plan.kind === 'todos' && Array.isArray(plan.items)) {
      entry.plan = new Map(plan.items.slice(0, 50).map(item => ({ id: id(item?.id), title: title(item?.title), status: status(item?.status) })).filter(item => item.id && item.title && item.status).map(item => [item.id, item]));
    } else if (plan.kind === 'create' && title(plan.title)) { const itemId = id(plan.id) ?? String(entry.plan.size + 1); if (entry.plan.size < 50) entry.plan.set(itemId, { id: itemId, title: title(plan.title), status: 'pending' }); }
    else if (plan.kind === 'update' && entry.plan.has(plan.id)) {
      if (plan.status === 'deleted') entry.plan.delete(plan.id);
      else { const item = entry.plan.get(plan.id); entry.plan.set(plan.id, { ...item, ...(status(plan.status) ? { status: plan.status } : {}), ...(title(plan.title) ? { title: title(plan.title) } : {}) }); }
    } else return null;
    // A timeline event holds at most 4000 characters (store.appendEvent): the plan's first items that fit.
    const items = [...entry.plan.values()];
    while (items.length && JSON.stringify({ items }).length > 3800) items.pop();
    return items;
  }
  // A child's (sub-agent's) event: a bounded count of the children seen, nothing else. It
  // never binds or replaces the parent's identity, starts or ends the parent's turn or
  // clears its approval prompt, and does not make the parent's observation live.
  child(entry, event) {
    if (!event.childId || entry.childIds.has(event.childId) || entry.childIds.size >= MAX_CHILDREN) return;
    entry.childIds.add(event.childId); entry.session.children = entry.childIds.size; this.emitStatus(entry.session);
  }
  // Events read after the process exited (the observer's drain, 4.7): this launch's only, and
  // only for identity (a native ID first reported at the end) and the agent's own clean end
  // (lastObserved 'session-end'). The final turn outcome is not recorded: a turn end read after
  // the exit changes nothing. Never reopens the session or changes its status.
  drained(entry, event) {
    if (event.child) return;
    const { session } = entry;
    const before = JSON.stringify([session.nativeId, session.nativeIdSource, session.nativeIdConfirmed, session.identityMismatch, session.lastObserved]);
    this.bindIdentity(entry, event.nativeId);
    if (event.kind === 'session-end') session.lastObserved = { fact: 'session-end', at: new Date().toISOString() };
    if (JSON.stringify([session.nativeId, session.nativeIdSource, session.nativeIdConfirmed, session.identityMismatch, session.lastObserved]) === before) return;
    this.persist(session, true); if (!this.disposed) this.emitStatus(session);
  }
  // Positive evidence that the hooks do not (or no longer) report: the observer failed (its
  // file reached the size cap or cannot be read), or a provider gate reported it. Before any
  // event the session is unobserved; after one it is lost. The next applied event makes it live.
  observationUnavailable(id) {
    const entry = this.entries.get(id); if (!entry || entry.exited) return;
    const { observation } = entry.session;
    if (observation === 'live') this.setObservation(entry, 'lost');
    else if (observation === 'pending') this.setObservation(entry, 'unobserved');
  }
  observerLost(id, message) { this.observationUnavailable(id); this.record(id, 'error', { message }); }
  setObservation(entry, observation) {
    if (entry.session.observation === observation) return;
    entry.session.observation = observation; this.persist(entry.session, true); this.emitStatus(entry.session);
  }
  // Periodic (observationMs) and callable with a time in tests: pending -> unobserved when a
  // clearly submitted first prompt produced output but no event within the grace period. This
  // is the only timed rule; a live observer is never downgraded by silence (see OBSERVATIONS).
  checkObservation(now = Date.now()) {
    if (this.disposed) return;
    for (const entry of this.liveEntries()) {
      const { session } = entry; const output = session.lastOutputAt ? Date.parse(session.lastOutputAt) : 0;
      if (session.observation === 'pending' && entry.promptAt && now - entry.promptAt >= this.unobservedGraceMs && output >= entry.promptAt) this.setObservation(entry, 'unobserved');
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
    // A count: two panes may show one session, and closing one must not detach the other.
    entry.attached++; entry.sent = snapshot.lastSequence; entry.acknowledged = snapshot.lastSequence; entry.inflight = [];
    // colors: this runtime answers colour queries, so the window must not answer them too.
    return { ...snapshot, colors: true };
  }
  // Journal switched between light and dark. Later colour answers and launches use it,
  // and each live CLI that enabled theme reports (mode 2031) is told, so it can ask again.
  setAppearance(appearance) {
    if (!APPEARANCES.includes(appearance)) throw new Error('Invalid appearance');
    if (appearance === this.appearance) return { reported: 0 };
    this.appearance = appearance; let reported = 0;
    for (const entry of this.liveEntries()) {
      if (!entry.queries.themeReports) continue;
      try { entry.proc.write(themeReport(appearance)); reported++; } catch { /* the PTY is closing */ }
    }
    return { reported };
  }
  detach(id) {
    // Without an ID (a reload, or the renderer gone) every pane is gone.
    for (const entry of this.entries.values()) if (!id) entry.attached = 0; else if (entry.session.id === id) entry.attached = Math.max(0, entry.attached - 1);
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
    const entry = this.entries.get(session.id);
    if (entry) { session.turnId = entry.currentTurn; session.observationGeneration = entry.observationGeneration; }
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
      const recoveredSurvivors = orphaned ? null : await this.recoveredSurvivors(session);
      const next = { ...session, survivors: recoveredSurvivors, status: orphaned ? 'orphaned' : 'interrupted', identityVerified: orphaned ? verified : undefined, activity: null, slot: null, pending: null, endedAt: orphaned ? null : new Date().toISOString(), recoveredAt: new Date().toISOString() };
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
  async recoveredSurvivors(session) {
    const table = await Promise.resolve(this.table()).catch(() => null);
    if (!table || !Array.isArray(session.processTracking?.descendants)) return null;
    const tracked = survivors(session.processTracking.descendants, table) ?? [];
    const grouped = Number.isInteger(session.pid) ? descendants(table, session.pid) ?? [] : [];
    return [...new Map([...tracked, ...grouped].map(row => [`${row.pid}:${row.started}`, { pid: row.pid, started: row.started, command: redact(row.command, 120) }])).values()];
  }
  async recheckOrphans() {
    for (const session of await this.store.activeSessions?.() ?? []) {
      if (session.status !== 'orphaned') continue;
      const running = session.identityVerified === false ? this.alive(session.pid) : sameIdentity(await this.identify(session.pid), session.identity);
      if (running) continue;
      const next = { ...session, survivors: await this.recoveredSurvivors(session), status: 'interrupted', endedAt: new Date().toISOString() };
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
    if (this.disposed) return; clearInterval(this.tracker); clearInterval(this.observationTimer);
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
