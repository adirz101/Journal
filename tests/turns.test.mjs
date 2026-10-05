import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { JournalStore } from '../src/core/store.mjs';
import { IDENTITY_CHANGED, IDLE_SETTLE_MS, TerminalManager } from '../src/core/terminal.mjs';
import { ADAPTERS } from '../src/runtime/adapters/index.mjs';
import { KINDS } from '../src/runtime/adapters/common.mjs';
import { removeLater } from './support/cleanup.mjs';

// Turn identity, deduplication, children and observation (plan 4.3, 4.4, 4.7, 4.8), on the
// TerminalManager with fake PTYs and fixture hook lines: Codex and Cursor payload shapes as
// documented and observed in the plan, never a provider CLI.
const CODEX_ID = '01a0f661-908b-7193-8520-6ac6f3b44aeb';
const CURSOR_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function setup(t, options = {}) {
  const root = mkdtempSync(resolve(process.env.JOURNAL_TEST_TMP ?? tmpdir(), 'turns-'));
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'pipe' });
  const store = new JournalStore(':memory:'); const project = store.openProject(root); const procs = [];
  const manager = new TerminalManager({ store, trackMs: 0, observationMs: 0, identify: () => null, table: () => null,
    // An observed launch (Codex and Cursor register in Phases 2 and 3; here a fixture registration).
    makeObserver: () => ({ settingsFile: null, env: { JOURNAL_HOOK_TARGET: 'target', JOURNAL_HOOK_TOKEN: 'token' } }),
    cursor: { find: async () => ({ path: '/bin/agent', cursor: true, supports: { resume: true, createChat: true, mode: true } }), createChat: async () => CURSOR_ID },
    spawn: () => { const proc = { callbacks: {}, inputs: [], onData(fn) { this.callbacks.data = fn; }, onExit(fn) { this.callbacks.exit = fn; }, write(d) { this.inputs.push(d); }, resize() {}, kill() {} }; procs.push(proc); return proc; },
    ...options });
  t.after(() => { manager.disposed = true; store.close(); removeLater(root); });
  const errors = []; manager.on('event', e => { if (e.type === 'error') errors.push(e); });
  const start = async (provider, extra = {}) => {
    const { session } = await manager.start({ projectId: project.id, provider, task: 'x', ...extra });
    const proc = procs.at(-1);
    const send = (event, fields = {}) => manager.ingest(session.id, { event, cwd: root, ...(provider === 'codex' ? { nativeId: CODEX_ID } : provider === 'cursor' ? { nativeId: CURSOR_ID } : { nativeId: session.nativeId }), ...fields });
    const live = () => manager.entry(session.id).session;
    const state = () => `${live().status}/${live().activity}`;
    const kinds = kind => store.listEvents(session.id).filter(e => e.kind === kind);
    return { session, proc, send, live, state, kinds, entry: () => manager.entry(session.id) };
  };
  return { root, store, project, manager, procs, start, errors };
}

test('adapters: every normalized kind is in the shared vocabulary; Claude keeps its mapping', () => {
  const claude = ADAPTERS.claude;
  const mapped = Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure']
    .map(event => { const n = claude.normalize({ event, nativeId: 'n' }); return [event, [n.kind, n.turn, n.child, n.outcome, n.failed]]; }));
  assert.deepEqual(mapped, {
    SessionStart: ['session-start', null, false, null, false], UserPromptSubmit: ['turn-start', null, false, null, false],
    PermissionRequest: ['permission-wait', null, false, null, false], Stop: ['turn-end', null, false, 'completed', false],
    PreToolUse: ['tool-start', null, false, null, false], PostToolUse: ['tool-end', null, false, null, false], PostToolUseFailure: ['tool-end', null, false, null, true],
  });
  assert.deepEqual(claude.events, ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
  // Claude's lines keep every field its ingest reads, and nothing turns them into children or turns.
  const line = { event: 'PostToolUseFailure', nativeId: 'n', cwd: '/w', tool: 'Bash', toolUseId: 't', command: 'ls', background: false, exit: 3, interrupted: true, durationMs: 5 };
  const n = claude.normalize(line);
  for (const key of ['nativeId', 'cwd', 'tool', 'toolUseId', 'command', 'background', 'exit', 'interrupted', 'durationMs']) assert.equal(n[key], line[key], key);
  assert.equal(claude.normalize({ event: 'Notification' }), null);
  for (const adapter of Object.values(ADAPTERS)) for (const event of adapter.events) {
    const n = adapter.normalize({ event, nativeId: 'n', status: 'completed', turn: 'k' });
    assert.ok(n && KINDS.includes(n.kind), `${adapter.provider} ${event}`);
  }
  // No permission step is ever registered.
  assert.ok(!ADAPTERS.codex.events.includes('PreToolUse'));
  assert.ok(!ADAPTERS.cursor.events.some(event => /^before|^preToolUse$|^subagentStart$/.test(event)));
  assert.deepEqual(Object.fromEntries(Object.values(ADAPTERS).map(a => [a.provider, a.response])), { claude: '', codex: '', cursor: '{}' });
});

test('Codex: the first parent event binds the native ID; a later different ID is a mismatch', async t => {
  const f = setup(t); const c = await f.start('codex');
  assert.equal(c.session.nativeId, null); assert.equal(c.session.observation, 'pending');
  c.send('SessionStart', { source: 'startup' });
  assert.deepEqual([c.live().nativeId, c.live().nativeIdConfirmed, c.live().nativeIdSource, c.live().observation], [CODEX_ID, true, 'hook', 'live']);
  c.send('UserPromptSubmit', { turn: 't1', nativeId: OTHER_ID });
  assert.deepEqual(f.errors.map(e => e.code), [IDENTITY_CHANGED]);
  assert.equal(c.live().nativeId, CODEX_ID, 'Never replaced'); assert.equal(c.live().nativeIdConfirmed, false);
});

test('duplicates are applied once', async t => {
  const f = setup(t); const c = await f.start('codex');
  c.send('UserPromptSubmit', { turn: 't1' }); c.send('UserPromptSubmit', { turn: 't1' });
  assert.equal(c.kinds('prompt').length, 1);
  c.send('PermissionRequest', { turn: 't1', tool: 'Bash', command: 'npm publish' }); c.send('PermissionRequest', { turn: 't1', tool: 'Bash', command: 'npm publish' });
  assert.equal(c.kinds('permission').length, 1); assert.equal(c.entry().pending.length, 1);
  // Codex's PostToolUse carries the tool's input (natively observed): the command matches the request.
  c.send('PostToolUse', { turn: 't1', tool: 'Bash', toolUseId: 'b1', command: 'npm publish' });
  assert.equal(c.state(), 'running/working');
  // A second approval in the same turn is a new request, not a duplicate.
  c.send('PermissionRequest', { turn: 't1', tool: 'Bash', command: 'npm publish' });
  assert.equal(c.state(), 'waiting/permission'); assert.equal(c.kinds('permission').length, 2);
  c.send('PostToolUse', { turn: 't1', tool: 'Bash', toolUseId: 'b2', command: 'npm publish' });
  c.send('PermissionRequest', { turn: 't1', tool: 'Bash', command: 'npm publish' }); c.send('PostToolUse', { turn: 't1', tool: 'Bash', toolUseId: 'b2', command: 'npm publish' });
  assert.equal(c.state(), 'waiting/permission', 'The same tool completion applied twice cannot clear a later prompt');
  c.send('Stop', { turn: 't1' }); c.send('Stop', { turn: 't1' });
  assert.equal(c.kinds('turn-end').length, 1);
});

test('a delayed turn start of the current turn never clears an open approval wait', async t => {
  const f = setup(t); const c = await f.start('codex');
  c.send('PermissionRequest', { turn: 't1', tool: 'Bash', command: 'rm x' });
  assert.equal(c.state(), 'waiting/permission');
  c.send('UserPromptSubmit', { turn: 't1' });
  assert.equal(c.state(), 'waiting/permission'); assert.equal(c.live().pending.command, 'rm x');
  // Also after other events of the turn.
  c.send('PostToolUse', { turn: 't1', tool: 'Bash', toolUseId: 'b1' }); c.send('UserPromptSubmit', { turn: 't1' });
  assert.equal(c.kinds('prompt').length, 0, 'The turn started without a prompt event; a late one changes nothing');
});

test('a repeated request after an answer is a new request; tool ends without an id all apply', async t => {
  const f = setup(t); const c = await f.start('codex');
  c.send('UserPromptSubmit', { turn: 't1' });
  c.send('PermissionRequest', { turn: 't1', tool: 'Bash', command: 'rm x' });
  f.manager.write(c.session.id, '1');
  assert.equal(c.state(), 'running/working');
  c.send('PermissionRequest', { turn: 't1', tool: 'Bash', command: 'rm x' });
  assert.equal(c.state(), 'waiting/permission', 'The same command asked again is waiting again');
  // An identical request while one is still open and unanswered is the same request.
  c.send('PermissionRequest', { turn: 't1', tool: 'Bash', command: 'rm x' });
  assert.equal(c.entry().pending.length, 1);
  // A different request in the same turn is not a duplicate.
  c.send('PermissionRequest', { turn: 't1', tool: 'Bash', command: 'rm y' });
  assert.equal(c.entry().pending.length, 2);
  // Cursor: two identical shell commands and two edits in a row (no tool id) are both applied.
  const g = await f.start('cursor'); g.send('afterAgentResponse', { turn: 'g1' });
  const verdict = line => f.manager.turnVerdict(g.entry(), ADAPTERS.cursor.normalize({ nativeId: CURSOR_ID, turn: 'g1', ...line }));
  for (const line of [{ event: 'afterShellExecution', command: 'npm test' }, { event: 'afterFileEdit', filePath: 'a.ts' }]) assert.deepEqual([verdict(line), verdict(line)], ['apply', 'apply'], line.event);
  // With a tool id, the same completion is applied once.
  const once = { event: 'postToolUse', tool: 'Shell', toolUseId: 'x1' };
  assert.deepEqual([verdict(once), verdict(once)], ['apply', 'ignore']);
});

test('a turn end without a turn key is dropped (Codex and Cursor)', async t => {
  const f = setup(t); const c = await f.start('codex');
  c.send('UserPromptSubmit', { turn: 't1' }); c.send('Stop'); c.send('Interrupt');
  assert.equal(c.state(), 'running/working'); assert.equal(c.kinds('turn-end').length, 0);
  const g = await f.start('cursor');
  g.send('afterAgentResponse', { turn: 'g1' }); g.send('stop', { status: 'completed' });
  assert.equal(g.state(), 'running/working');
});

test('an inherited observer is never passed on; an observed launch gets fresh values', async t => {
  const saved = { target: process.env.JOURNAL_HOOK_TARGET, token: process.env.JOURNAL_HOOK_TOKEN };
  process.env.JOURNAL_HOOK_TARGET = '/parent/events.jsonl'; process.env.JOURNAL_HOOK_TOKEN = 'parent-token';
  try {
    const launches = []; const spawn = (executable, argv, options) => { launches.push(options.env); return { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }; };
    const plain = setup(t, { makeObserver: () => null, spawn }); await plain.start('codex');
    assert.equal(launches[0].JOURNAL_HOOK_TARGET, undefined); assert.equal(launches[0].JOURNAL_HOOK_TOKEN, undefined);
    const observed = setup(t, { spawn }); await observed.start('claude');
    assert.deepEqual([launches[1].JOURNAL_HOOK_TARGET, launches[1].JOURNAL_HOOK_TOKEN], ['target', 'token']);
  } finally {
    if (saved.target === undefined) delete process.env.JOURNAL_HOOK_TARGET; else process.env.JOURNAL_HOOK_TARGET = saved.target;
    if (saved.token === undefined) delete process.env.JOURNAL_HOOK_TOKEN; else process.env.JOURNAL_HOOK_TOKEN = saved.token;
  }
});

test('a late Stop for an older turn never finishes the newer one', async t => {
  const f = setup(t); const c = await f.start('codex');
  c.send('UserPromptSubmit', { turn: 't1' });
  c.send('UserPromptSubmit', { turn: 't2' });
  c.send('Stop', { turn: 't1' });
  assert.equal(c.state(), 'running/working');
  assert.deepEqual(c.kinds('turn-end').map(e => e.body), [{ turn: 't1', outcome: 'completed', late: true }], 'Recorded for audit');
  assert.equal(c.live().lastObserved.fact, 'turn-start', 'A late event is not the last observed fact');
  c.send('Stop', { turn: 't2' });
  assert.equal(c.state(), 'running/idle');
  // An older turn's end, never seen start, while a newer turn runs: the same.
  c.send('UserPromptSubmit', { turn: 't4' }); c.send('Stop', { turn: 't3' });
  assert.equal(c.state(), 'running/working');
});

test('Cursor: aborted and error for one generation give one interruption, in either order', async t => {
  for (const order of [['aborted', 'error'], ['error', 'aborted']]) {
    const f = setup(t); const c = await f.start('cursor');
    c.send('afterAgentResponse', { turn: 'g1' });
    assert.equal(c.state(), 'running/working');
    for (const status of order) c.send('stop', { turn: 'g1', status });
    assert.equal(c.state(), 'running/idle', order.join(','));
    assert.equal(c.entry().settled.get('g1'), 'interrupted', order.join(','));
    assert.equal(c.live().lastObserved.fact, 'turn-interrupted', order.join(','));
    // Records: the first outcome, then (only when stronger) the merged one; the timeline collapses them by turn.
    const outcomes = c.kinds('turn-end').map(e => e.body.outcome);
    assert.deepEqual(outcomes, order[0] === 'aborted' ? ['interrupted'] : ['error', 'interrupted'], order.join(','));
    c.send('stop', { turn: 'g1', status: 'completed' });
    assert.equal(c.kinds('turn-end').length, outcomes.length, 'A weaker outcome changes nothing');
  }
});

test('delayed and out-of-order events: a settled turn is never reopened or changed', async t => {
  const f = setup(t); const c = await f.start('codex');
  c.send('UserPromptSubmit', { turn: 't1' }); c.send('Stop', { turn: 't1' });
  assert.equal(c.state(), 'running/idle');
  c.send('PostToolUse', { turn: 't1', tool: 'Bash', toolUseId: 'late' });
  c.send('PermissionRequest', { turn: 't1', tool: 'Bash', command: 'rm -rf /' });
  c.send('UserPromptSubmit', { turn: 't1' });
  assert.equal(c.state(), 'running/idle');
  assert.equal(c.kinds('permission').length, 0); assert.equal(c.kinds('prompt').length, 1);
  // A turn whose first event is its end (Cursor level 2: stop only) is shown finished, never Working.
  const g = await f.start('cursor'); const states = [];
  f.manager.on('event', e => { if (e.type === 'status' && e.session.id === g.session.id) states.push(e.session.activity); });
  g.send('stop', { turn: 'g7', status: 'completed' });
  assert.equal(g.state(), 'running/idle'); assert.ok(!states.includes('working'));
  // A tool event of a new turn makes that turn current (Working); the old one is superseded.
  c.send('PostToolUse', { turn: 't2', tool: 'Bash', toolUseId: 'b' });
  assert.equal(c.state(), 'running/working');
  c.send('UserPromptSubmit', { turn: 't3' }); c.send('Stop', { turn: 't2' });
  assert.equal(c.state(), 'running/working', 't2 was superseded by t3');
});

test('Codex Interrupt ends its turn without a Stop', async t => {
  const f = setup(t); const c = await f.start('codex');
  c.send('UserPromptSubmit', { turn: 't1' });
  c.send('PermissionRequest', { turn: 't1', tool: 'Bash' });
  c.send('Interrupt', { turn: 't1' });
  assert.equal(c.state(), 'running/idle'); assert.equal(c.live().pending, null);
  assert.deepEqual(c.kinds('turn-end').map(e => e.body), [{ turn: 't1', outcome: 'interrupted' }]);
  c.send('Stop', { turn: 't1' });
  assert.equal(c.kinds('turn-end').length, 1, 'A completion after an interruption is weaker');
});

test('children never bind identity, finish the parent turn or clear its approval; they are counted', async t => {
  const f = setup(t); const c = await f.start('codex');
  c.send('SubagentStart', { turn: 't1', agentId: 'a1' });
  assert.equal(c.live().nativeId, null, 'A child never binds the parent ID');
  c.send('UserPromptSubmit', { turn: 't1' });
  c.send('PermissionRequest', { turn: 't1', tool: 'Bash', command: 'deploy' });
  c.send('PostToolUse', { turn: 't1', tool: 'Bash', toolUseId: 'c1', agentId: 'a1' });
  c.send('Stop', { turn: 't1', agentId: 'a1' });
  c.send('SubagentStop', { turn: 't1', agentId: 'a1' }); c.send('SubagentStart', { turn: 't1', agentId: 'a2' });
  assert.equal(c.state(), 'waiting/permission'); assert.equal(c.live().pending.command, 'deploy');
  assert.equal(c.kinds('turn-end').length, 0);
  assert.equal(c.live().children, 2);
  assert.equal(f.errors.length, 0);
  // Cursor: a child's own conversation ID is not an identity change.
  const g = await f.start('cursor');
  g.send('afterAgentResponse', { turn: 'g1' });
  g.send('postToolUse', { turn: 'g1', nativeId: OTHER_ID, parentNativeId: CURSOR_ID, tool: 'Shell' });
  g.send('subagentStop', { turn: 'g1', nativeId: OTHER_ID, parentNativeId: CURSOR_ID });
  assert.equal(f.errors.length, 0); assert.equal(g.live().nativeId, CURSOR_ID); assert.equal(g.live().children, 1);
  assert.equal(g.state(), 'running/working');
});

test('events that cannot be classified are dropped', async t => {
  const f = setup(t); const c = await f.start('codex');
  c.send('UserPromptSubmit', { turn: 't1', nativeId: null });
  c.send('Notification', { turn: 't1' });
  c.send('PreToolUse', { turn: 't1' });
  assert.equal(c.live().observation, 'pending'); assert.equal(c.kinds('prompt').length, 0); assert.equal(c.live().nativeId, null);
  const g = await f.start('cursor');
  g.send('stop', { turn: 'g1' }); g.send('stop', { turn: 'g1', status: 'weird' });
  assert.equal(g.live().observation, 'pending'); assert.equal(g.kinds('turn-end').length, 0);
});

test('Claude has no turn key: repeated events still apply as before', async t => {
  const f = setup(t); const c = await f.start('claude');
  c.send('UserPromptSubmit'); c.send('Stop'); c.send('UserPromptSubmit'); c.send('Stop');
  assert.equal(c.kinds('turn-end').length, 2); assert.deepEqual(c.kinds('turn-end').map(e => e.body), [{}, {}]);
  assert.equal(c.state(), 'running/idle'); assert.equal(c.live().observation, 'live');
});

// ----- Observation (4.4) -----
test('pending becomes unobserved after a submitted prompt, output and the grace period; never Working', async t => {
  const f = setup(t, { unobservedGraceMs: 1000 }); const c = await f.start('codex', { task: '' });
  const now = Date.now();
  f.manager.checkObservation(now + 5000);
  assert.equal(c.live().observation, 'pending', 'No prompt was submitted yet');
  f.manager.write(c.session.id, 'hello'); f.manager.write(c.session.id, '\r');
  f.manager.checkObservation(Date.now() + 5000);
  assert.equal(c.live().observation, 'pending', 'No output since the prompt');
  c.live().lastOutputAt = new Date().toISOString();
  f.manager.checkObservation(Date.now() + 500);
  assert.equal(c.live().observation, 'pending', 'Still within the grace period');
  f.manager.checkObservation(Date.now() + 1500);
  assert.equal(c.live().observation, 'unobserved'); assert.equal(f.store.getSession(c.session.id).observation, 'unobserved');
  assert.equal(c.live().activity, null);
  // A pasted line with Enter is not a submitted prompt.
  const d = await f.start('codex', { task: '' });
  f.manager.write(d.session.id, '\x1b[200~text\r\x1b[201~'); d.live().lastOutputAt = new Date().toISOString();
  f.manager.checkObservation(Date.now() + 5000);
  assert.equal(d.live().observation, 'pending');
  // An unobserved session that starts reporting is live.
  c.send('SessionStart'); assert.equal(c.live().observation, 'live');
});

test('a launch prompt counts as submitted; a launch without a registration is unobserved at once', async t => {
  const f = setup(t, { unobservedGraceMs: 1000 }); const c = await f.start('claude');
  c.live().lastOutputAt = new Date(Date.now() + 1).toISOString();
  f.manager.checkObservation(Date.now() + 2000);
  assert.equal(c.live().observation, 'unobserved');
  const g = setup(t, { makeObserver: () => null }); const plain = await g.start('codex');
  assert.equal(plain.session.observation, 'unobserved');
});

// Liveness (4.4): silence alone never marks observation lost; it only ages confidence.
test('a long silent tool keeps the observer live, the state Working and the last fact', async t => {
  const f = setup(t); const c = await f.start('codex');
  c.send('UserPromptSubmit', { turn: 't1' });
  const fact = c.live().lastObserved;
  // No hook, no output for far longer than any window.
  for (const later of [60_000, 30 * 60_000, 24 * 3600_000]) f.manager.checkObservation(Date.now() + later);
  assert.equal(c.live().observation, 'live'); assert.equal(c.state(), 'running/working');
  assert.deepEqual(c.live().lastObserved, fact);
});

test('a long approval wait keeps Needs approval and its request; silence never clears or downgrades it', async t => {
  const f = setup(t); const c = await f.start('codex');
  c.send('UserPromptSubmit', { turn: 't1' });
  c.send('PermissionRequest', { turn: 't1', tool: 'Bash', command: 'npm publish' });
  for (const later of [60_000, 30 * 60_000, 24 * 3600_000]) f.manager.checkObservation(Date.now() + later);
  assert.equal(c.state(), 'waiting/permission'); assert.equal(c.live().observation, 'live');
  assert.equal(c.live().pending.command, 'npm publish'); assert.equal(c.entry().pending.length, 1);
  assert.equal(f.store.getSession(c.session.id).pending.command, 'npm publish');
});

test('positive evidence makes observation unavailable: lost after live, unobserved before; an event recovers it', async t => {
  const f = setup(t); const c = await f.start('codex');
  f.manager.observationUnavailable(c.session.id);
  assert.equal(c.live().observation, 'unobserved', 'Before any event (a gate, trust or plugin refusal)');
  c.send('UserPromptSubmit', { turn: 't1' });
  assert.equal(c.live().observation, 'live', 'An applied event recovers it');
  f.manager.observationUnavailable(c.session.id);
  assert.equal(c.live().observation, 'lost'); assert.equal(c.state(), 'running/working', 'The state is kept, only no longer presented as current');
  c.send('PostToolUse', { turn: 't1', tool: 'Bash', toolUseId: 'b' });
  assert.equal(c.live().observation, 'live');
  // A child's event alone does not make it live again.
  f.manager.observationUnavailable(c.session.id); c.send('SubagentStop', { turn: 't1', agentId: 'z' });
  assert.equal(c.live().observation, 'lost');
});

test('lastObserved reaches the window at least once a minute while events arrive', async t => {
  const f = setup(t); const c = await f.start('codex'); const sent = [];
  f.manager.on('event', e => { if (e.type === 'status' && e.session.id === c.session.id) sent.push(e.session.lastObserved?.at); });
  c.send('UserPromptSubmit', { turn: 't1' });
  const before = sent.length; c.send('PostToolUse', { turn: 't1', tool: 'Read', toolUseId: 'r1' });
  assert.equal(sent.length, before, 'Not on every event');
  c.entry().observedSentAt -= 61_000; c.send('PostToolUse', { turn: 't1', tool: 'Read', toolUseId: 'r2' });
  assert.equal(sent.length, before + 1);
});

test('observer loss makes a live session lost; the next event recovers it', async t => {
  const f = setup(t); const c = await f.start('claude');
  c.send('UserPromptSubmit');
  f.manager.observerLost(c.session.id, 'Activity observation stopped: the hook event file reached its size limit.');
  assert.equal(c.live().observation, 'lost'); assert.equal(c.kinds('error').length, 1);
  assert.equal(c.state(), 'running/working');
  // Typing Esc while the state is unknown changes activity but the session stays unknown.
  f.manager.write(c.session.id, '\x1b');
  assert.equal(c.live().observation, 'lost');
  c.send('Stop');
  assert.equal(c.live().observation, 'live'); assert.equal(c.state(), 'running/idle');
  assert.equal((await f.manager.paste(c.session.id, 'src/a.ts')).inserted, false, 'Paste waits for the idle state to settle');
  f.manager.observerLost(c.session.id, 'x');
  c.entry().activitySince = 0;
  assert.match(f.manager.paste(c.session.id, 'src/a.ts').reason, /does not know yet/, 'Never typed while the observer is lost');
});

// ----- After exit (4.7) -----
test('events read after exit record only identity and the clean end; the session stays ended', async t => {
  const f = setup(t); const c = await f.start('codex');
  c.send('UserPromptSubmit', { turn: 't1', nativeId: null });
  c.proc.callbacks.exit({ exitCode: 0 });
  assert.equal(c.live().status, 'exited');
  c.send('SubagentStop', { turn: 't1', agentId: 'a', nativeId: OTHER_ID });
  assert.equal(c.live().nativeId, null, 'A child never binds, even after exit');
  c.send('UserPromptSubmit', { turn: 't2' }); c.send('PermissionRequest', { turn: 't2', tool: 'Bash' });
  c.send('SessionEnd');
  const stored = f.store.getSession(c.session.id);
  assert.deepEqual([stored.status, stored.activity, stored.pending, stored.nativeId, stored.nativeIdConfirmed, stored.nativeIdSource], ['exited', null, null, CODEX_ID, true, 'hook']);
  assert.equal(stored.lastObserved.fact, 'session-end');
  assert.equal(c.kinds('prompt').length, 0); assert.equal(c.kinds('permission').length, 0);
  // Claude: a final hook confirms the preassigned ID and nothing else.
  const k = await f.start('claude'); k.proc.callbacks.exit({ exitCode: 0 });
  k.send('Stop'); k.send('UserPromptSubmit');
  const claude = f.store.getSession(k.session.id);
  assert.deepEqual([claude.status, claude.activity, claude.nativeIdSource], ['exited', null, 'preassigned-observed']);
  assert.equal(k.kinds('turn-end').length, 0);
});

// Review fixes (5 October 2026): identity fallback, parallel approvals, answer keys, the turn no hook announces.
test('Cursor without a pre-created chat binds its ID from the first parent event, with no false identity change', async t => {
  const { start, errors } = setup(t, { cursor: { find: async () => ({ path: '/bin/agent', cursor: true, supports: { resume: true, createChat: true, mode: true } }), createChat: async () => null } });
  const s = await start('cursor');
  assert.equal(s.session.nativeId, null);
  s.send('postToolUse', { turn: 'g1', tool: 'Shell' });
  assert.deepEqual([s.live().nativeId, s.live().nativeIdConfirmed, s.live().identityMismatch ?? false], [CURSOR_ID, true, false]);
  assert.equal(errors.length, 0);
  // A different conversation later is a change, never a silent rebind.
  s.send('postToolUse', { turn: 'g2', tool: 'Shell', nativeId: OTHER_ID });
  assert.ok(errors.some(e => e.code === IDENTITY_CHANGED));
});

test('Codex: a sibling tool finishing never clears another tool\'s open approval; its own end does', async t => {
  const { start } = setup(t); const s = await start('codex');
  s.send('UserPromptSubmit', { turn: 't1' });
  s.send('PermissionRequest', { turn: 't1', tool: 'Bash', command: 'rm x' });
  assert.equal(s.state(), 'waiting/permission');
  s.send('PostToolUse', { turn: 't1', tool: 'Bash', command: 'ls' });
  assert.equal(s.state(), 'waiting/permission', 'A parallel tool ended; the approval is still open');
  assert.equal(s.live().pending?.command, 'rm x');
  s.send('PostToolUse', { turn: 't1', tool: 'Bash', command: 'rm x' });
  assert.equal(s.state(), 'running/working', 'The asking tool ran, so its approval was answered');
});

test('Codex: a letter key answers its approval prompt; typing during a turn never does', async t => {
  const { start, manager } = setup(t); const s = await start('codex');
  s.send('UserPromptSubmit', { turn: 't1' });
  manager.write(s.session.id, 'y');
  assert.equal(s.state(), 'running/working', 'No prompt open: a letter is just typing');
  s.send('PermissionRequest', { turn: 't1', tool: 'Bash', command: 'npm install' });
  manager.write(s.session.id, 'y');
  assert.equal(s.state(), 'running/working', 'Answered: the long approved command runs');
  assert.equal(s.live().pending ?? null, null);
  // A paste is never an answer.
  s.send('PermissionRequest', { turn: 't1', tool: 'Bash', command: 'rm x' });
  manager.write(s.session.id, '\x1b[200~y\x1b[201~');
  assert.equal(s.state(), 'waiting/permission');
});

test('Cursor (no turn-start event): a prompt sent at Your turn makes the state unknown until the next event', async t => {
  const { start, manager } = setup(t); const s = await start('cursor');
  s.send('postToolUse', { turn: 'g1', tool: 'Shell' });
  s.send('stop', { turn: 'g1', status: 'completed' });
  assert.equal(s.state(), 'running/idle');
  manager.write(s.session.id, 'do more'); manager.write(s.session.id, '\r');
  assert.equal(s.live().activity, null, 'Not a stale Your turn');
  s.send('postToolUse', { turn: 'g2', tool: 'Shell' });
  assert.equal(s.state(), 'running/working');
  // Claude and Codex announce their turns: their state is left to their hooks.
  const c = await start('codex'); c.send('Stop', { turn: 't0' }); c.send('UserPromptSubmit', { turn: 't0b' }); c.send('Stop', { turn: 't0b' });
  manager.write(c.session.id, 'next'); manager.write(c.session.id, '\r');
  assert.equal(c.state(), 'running/idle', 'UserPromptSubmit will report it');
});

// ----- File references typed into the prompt (drag and drop, Reference in Session) -----
test('a reference is typed into Codex only when its hooks report turns and approvals; Cursor is always copied', async t => {
  const observes = { codex: { turns: true, approvals: true }, cursor: { turns: true, approvals: false } };
  const f = setup(t, { makeObserver: session => ({ settingsFile: null, observes: observes[session.provider] ?? null, env: { JOURNAL_HOOK_TARGET: 'target', JOURNAL_HOOK_TOKEN: 'token' } }) });
  const settle = () => new Promise(r => setTimeout(r, IDLE_SETTLE_MS + 50));
  const c = await f.start('codex');
  c.send('SessionStart', { source: 'startup' }); await settle();
  assert.deepEqual(f.manager.paste(c.session.id, "'src/my file.ts'", { kind: 'file', path: 'src/my file.ts' }), { inserted: true });
  assert.ok(!c.proc.inputs.at(-1).includes('\r'), 'Never submitted');
  assert.match(c.proc.inputs.at(-1), /'src\/my file\.ts' $/);
  c.send('UserPromptSubmit', { turn: 't1' });
  assert.match(f.manager.paste(c.session.id, 'src/a.ts').reason, /working/);
  c.send('PermissionRequest', { turn: 't1', tool: 'Bash' });
  assert.match(f.manager.paste(c.session.id, 'src/a.ts').reason, /permission/);
  // Codex launched without Journal's hooks: Journal cannot see its approval prompts.
  observes.codex = null;
  const blind = await f.start('codex');
  assert.match(f.manager.paste(blind.session.id, 'src/a.ts').reason, /cannot see when Codex/);
  const cursor = await f.start('cursor');
  cursor.send('sessionStart'); await settle();
  assert.match(f.manager.paste(cursor.session.id, 'src/a.ts').reason, /cannot see when Cursor/);
  assert.ok(!cursor.proc.inputs.some(input => input.includes('src/a.ts')));
});

// ----- The Story's evidence (src/core/story): what each adapter extracts and the runtime records -----
test('Story evidence: Claude descriptions, reads, sub-agents and plans; never content', () => {
  const claude = ADAPTERS.claude; const cwd = '/w';
  const bash = claude.extract({ hook_event_name: 'PreToolUse', session_id: 'n', cwd, tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'npm test', description: '  Run   the test suite ' } });
  assert.equal(bash.description, 'Run the test suite');
  const read = claude.extract({ hook_event_name: 'PostToolUse', session_id: 'n', cwd, tool_name: 'Read', tool_use_id: 't2', tool_input: { file_path: '/w/src/a.ts' }, tool_response: { file: { content: 'SECRET CONTENT' } } });
  assert.equal(read.readPath, 'src/a.ts'); assert.ok(!JSON.stringify(read).includes('SECRET'), 'Tool output never leaves the hook');
  const agent = claude.extract({ hook_event_name: 'PostToolUse', session_id: 'n', cwd, tool_name: 'Agent', tool_use_id: 't3', tool_input: { description: 'Review the diff', prompt: 'LONG PROMPT' } });
  assert.equal(agent.description, 'Review the diff'); assert.ok(!JSON.stringify(agent).includes('LONG PROMPT'));
  const todos = claude.extract({ hook_event_name: 'PostToolUse', session_id: 'n', cwd, tool_name: 'TodoWrite', tool_use_id: 't4',
    tool_input: { todos: [{ content: 'Investigate issue', status: 'completed', activeForm: 'Investigating' }, { content: 'Implement fix', status: 'in_progress' }, { content: 'bad', status: 'weird' }] } });
  assert.deepEqual(todos.plan, { kind: 'todos', items: [{ id: '1', title: 'Investigate issue', status: 'completed' }, { id: '2', title: 'Implement fix', status: 'in_progress' }] });
  const created = claude.extract({ hook_event_name: 'PostToolUse', session_id: 'n', cwd, tool_name: 'TaskCreate', tool_use_id: 't5', tool_input: { subject: 'Run tests', description: 'long' }, tool_response: { task: { id: '3' } } });
  assert.deepEqual(created.plan, { kind: 'create', title: 'Run tests', id: '3' });
  const updated = claude.extract({ hook_event_name: 'PostToolUse', session_id: 'n', cwd, tool_name: 'TaskUpdate', tool_use_id: 't6', tool_input: { taskId: '3', status: 'in_progress' } });
  assert.deepEqual(updated.plan, { kind: 'update', id: '3', status: 'in_progress', title: null });
  // Secrets in a description are redacted like commands.
  assert.match(claude.extract({ hook_event_name: 'PreToolUse', session_id: 'n', cwd, tool_name: 'Bash', tool_use_id: 't7', tool_input: { command: 'x', description: 'use token=ghp_abcdefghijklmnopqrstuvwxyz0123456789' } }).description, /\[redacted\]/);
});

test('Story evidence: Codex apply_patch keeps only its header paths', () => {
  const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-const SECRET = 1;\n+const SECRET = 2;\n*** Add File: src/new.ts\n+export {};\n*** Delete File: old.ts\n*** End Patch';
  const line = ADAPTERS.codex.extract({ hook_event_name: 'PostToolUse', session_id: CODEX_ID, turn_id: 't1', cwd: '/w', tool_name: 'apply_patch', tool_use_id: 'p1', tool_input: { input: patch } });
  assert.deepEqual(line.patchFiles, [{ path: 'src/a.ts', op: 'update' }, { path: 'src/new.ts', op: 'add' }, { path: 'old.ts', op: 'delete' }]);
  assert.ok(!JSON.stringify(line).includes('SECRET'), 'The patch content never leaves the hook');
});

test('Story evidence: Codex commands with their exit, apply_patch files; plans from Claude snapshots', async t => {
  const f = setup(t, { makeObserver: session => ({ settingsFile: null, observes: { turns: true, approvals: true }, env: { JOURNAL_HOOK_TARGET: 'x', JOURNAL_HOOK_TOKEN: 'y' }, ...(session ? {} : {}) }) });
  const c = await f.start('codex');
  c.send('UserPromptSubmit', { turn: 't1' });
  c.send('PostToolUse', { turn: 't1', tool: 'shell', toolUseId: 's1', command: 'npm test', exit: 1 });
  c.send('PostToolUse', { turn: 't1', tool: 'shell', toolUseId: 's2', command: 'npm test', exit: 0 });
  c.send('PostToolUse', { turn: 't1', tool: 'apply_patch', toolUseId: 'p1', patchFiles: [{ path: 'src/a.ts', op: 'update' }, { path: 'src/new.ts', op: 'add' }] });
  const starts = c.kinds('command-start'); const ends = c.kinds('command-end');
  assert.deepEqual(starts.map(e => [e.body.command, e.body.test]), [['npm test', true], ['npm test', true]]);
  assert.deepEqual(ends.map(e => [e.body.status, e.body.exitCode]), [['failed', 1], ['succeeded', 0]]);
  assert.deepEqual(c.kinds('file').map(e => [e.body.path, e.body.op]), [['src/a.ts', 'update'], ['src/new.ts', 'add']]);
  // Claude: TaskCreate and TaskUpdate become whole-plan snapshots; Read and Agent are tools by name.
  const cl = await f.start('claude');
  cl.send('SessionStart');
  cl.send('PostToolUse', { tool: 'TaskCreate', toolUseId: 'a', plan: { kind: 'create', title: 'Investigate', id: '1' } });
  cl.send('PostToolUse', { tool: 'TaskCreate', toolUseId: 'b', plan: { kind: 'create', title: 'Fix', id: null } });
  cl.send('PostToolUse', { tool: 'TaskUpdate', toolUseId: 'c', plan: { kind: 'update', id: '1', status: 'in_progress', title: null } });
  cl.send('PostToolUse', { tool: 'TaskUpdate', toolUseId: 'd', plan: { kind: 'update', id: 'missing', status: 'completed', title: null } });
  cl.send('PostToolUse', { tool: 'Read', toolUseId: 'e', readPath: 'src/a.ts' });
  cl.send('PostToolUse', { tool: 'Agent', toolUseId: 'g', description: 'Review the diff' });
  cl.send('PostToolUse', { tool: 'AskUserQuestion', toolUseId: 'h' });
  assert.deepEqual(cl.kinds('plan').map(e => e.body.items.map(i => `${i.title}:${i.status}`)), [['Investigate:pending'], ['Investigate:pending', 'Fix:pending'], ['Investigate:in_progress', 'Fix:pending']]);
  assert.deepEqual(cl.kinds('tool').map(e => e.body), [{ tool: 'Read', path: 'src/a.ts' }, { tool: 'Agent', description: 'Review the diff' }, { tool: 'AskUserQuestion' }]);
  assert.equal(cl.kinds('command-start').length, 0, 'A Claude Bash end without its start records nothing new');
});

test('Story evidence: Cursor commands once (afterShellExecution, exit unknown), edits from afterFileEdit', async t => {
  const f = setup(t); const c = await f.start('cursor');
  c.send('sessionStart', {});
  c.send('postToolUse', { tool: 'Shell', toolUseId: 'u1', command: 'npm test', turn: 'g1' });
  c.send('afterShellExecution', { command: 'npm test', turn: 'g1', durationMs: 900 });
  c.send('afterFileEdit', { filePath: 'src/a.ts', turn: 'g1' });
  c.send('postToolUse', { tool: 'Edit', toolUseId: 'u2', turn: 'g1' });
  c.send('postToolUse', { tool: 'Read', toolUseId: 'u3', turn: 'g1' });
  assert.deepEqual(c.kinds('command-start').map(e => e.body.command), ['npm test'], 'One record per command');
  assert.deepEqual(c.kinds('command-end').map(e => [e.body.status, e.body.exitCode, e.body.durationMs]), [['unknown', null, 900]]);
  assert.deepEqual(c.kinds('file').map(e => e.body.path), ['src/a.ts']);
  assert.deepEqual(c.kinds('tool').map(e => e.body.tool), ['Read']);
});
