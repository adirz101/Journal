import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { ERROR_CODES, IDENTITY_CHANGED } from '../src/core/terminal.mjs';
import { settledError } from '../src/desktop/ipc-error.mjs';

// Transpiles sessionState.ts with the two renderer modules it imports into one
// temporary directory, so the test runs the renderer's own code.
async function load(t) {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const dir = mkdtempSync(resolve('.cache/tmp', 'state-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ['types', 'copy', 'sessionState']) {
    const source = readFileSync(new URL(`../src/ui/${name}.ts`, import.meta.url), 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    writeFileSync(join(dir, `${name}.mjs`), outputText.replace(/from '\.\/(types|copy)'/g, "from './$1.mjs'"));
  }
  return { ...await import(pathToFileURL(join(dir, 'sessionState.mjs')).href), types: await import(pathToFileURL(join(dir, 'types.mjs')).href) };
}

const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const ago = ms => new Date(NOW - ms).toISOString();
let serial = 0;
const session = (fields = {}) => ({ id: `s${++serial}`, projectId: 'p', provider: 'claude', nativeId: null, nativeIdConfirmed: false, title: 'Task', status: 'running', receiptId: 'r', createdAt: ago(60_000), ...fields });

const PROVIDERS = ['claude', 'codex', 'cursor'];
const STATUSES = ['starting', 'running', 'waiting', 'stopping', 'stopped', 'exited', 'failed', 'interrupted', 'orphaned'];
const ACTIVITIES = ['idle', 'working', 'permission', null];
const LIVE = new Set(['starting', 'running', 'waiting', 'stopping']);
// undefined: a session from a runtime before observation states (Claude shows its state as then).
const OBSERVATIONS = [undefined, 'pending', 'live', 'unobserved', 'lost'];
const current = ({ provider, observation }) => provider === 'claude' && (observation === 'live' || observation === undefined);

// The state table of the Phase 2 plan (board B8), written out independently, with the
// observation rule of the hooks plan (4.4): a current state only while the observer is live.
function expected({ provider, status, activity, exitCode, observation }, connected) {
  if (LIVE.has(status) && !connected) return { word: 'Disconnected', tone: 'muted', limited: false };
  if (current({ provider, observation }) && status === 'waiting') return { word: 'Needs approval', tone: 'attention', limited: false };
  // An unknown activity (no hook has said what the agent is doing) is never presented as current.
  if (current({ provider, observation }) && status === 'running' && activity) return activity === 'idle' ? { word: 'Your turn', tone: 'active', limited: false } : { word: 'Working', tone: 'active', limited: false };
  if (status === 'running' || status === 'waiting') return { word: 'Running', tone: 'active', limited: true };
  const rest = {
    starting: { word: 'Starting', tone: 'neutral' }, stopping: { word: 'Stopping', tone: 'neutral' },
    exited: exitCode ? { word: `Exited ${exitCode}`, tone: 'error' } : { word: 'Exited 0', tone: 'neutral' },
    failed: { word: 'Failed to start', tone: 'error' }, stopped: { word: 'Stopped', tone: 'muted' },
    interrupted: { word: 'Interrupted', tone: 'muted' }, orphaned: { word: 'Still running outside Journal', tone: 'attention' },
  };
  return { ...rest[status], limited: false };
}

test('stateFor follows the state table for every provider, status, activity, observation and connection', async t => {
  const { stateFor } = await load(t);
  let cases = 0;
  for (const provider of PROVIDERS) for (const status of STATUSES) for (const activity of ACTIVITIES) for (const observation of OBSERVATIONS) for (const connected of [true, false]) for (const exitCode of status === 'exited' ? [0, null, 2] : [undefined]) {
    const input = session({ provider, status, activity, exitCode, observation, lastOutputAt: ago(1000) });
    const state = stateFor(input, NOW, connected);
    const label = `${provider} ${status} ${activity} ${observation} ${connected ? 'connected' : 'disconnected'} ${exitCode}`;
    assert.deepEqual({ word: state.word, tone: state.tone, limited: state.limited }, expected(input, connected), label);
    // An orphan is "still running outside Journal" for every provider; nothing else of Codex or Cursor asks for attention.
    if (provider !== 'claude' && status !== 'orphaned') assert.notEqual(state.tone, 'attention', `${label}: Codex and Cursor never need approval`);
    if (current(input) && (status !== 'running' || activity)) assert.equal(state.limited, false, `${label}: a live Claude observer gives full status`);
    // Without a live observer a state is never presented as current.
    if (!current(input)) assert.ok(!['Working', 'Your turn', 'Needs approval'].includes(state.word), `${label}: no current state without a live observer`);
    cases++;
  }
  assert.ok(cases >= 3 * 9 * 4 * 5 * 2, `${cases} cases`);
});

test('without a live observer: output time or how long the state is unknown, then the last observed fact', async t => {
  const { stateFor, limitedDetail } = await load(t);
  const fact = (name, ms) => ({ fact: name, at: ago(ms) });
  // Pending before any hook: the limited model, as for Codex today.
  assert.deepEqual(stateFor(session({ observation: 'pending', lastOutputAt: ago(2000) }), NOW, true), { word: 'Running', tone: 'active', detail: 'output just now', limited: true });
  // Unobserved: the same, never Working.
  assert.equal(stateFor(session({ observation: 'unobserved', activity: 'working', lastOutputAt: ago(5 * 60_000) }), NOW, true).detail, 'quiet 5m');
  // Working that went stale is unknown since its last fact, and never becomes Your turn.
  for (const activity of ['working', 'idle']) {
    const lost = stateFor(session({ observation: 'lost', activity, lastOutputAt: ago(16 * 60_000), lastObserved: fact('turn-start', 16 * 60_000) }), NOW, true);
    assert.deepEqual(lost, { word: 'Running', tone: 'active', detail: 'state unknown for 16m · last seen: prompt sent, 16m ago', limited: true }, activity);
  }
  // A lost waiting session is not presented as Needs approval either.
  assert.equal(stateFor(session({ status: 'waiting', observation: 'lost', lastObserved: fact('permission-wait', 90_000) }), NOW, true).detail, 'state unknown for 1m · last seen: approval asked, 1m ago');
  assert.equal(limitedDetail(session({ observation: 'unobserved', lastOutputAt: ago(1000), lastObserved: fact('turn-completed', 30_000) }), NOW), 'output just now · last seen: turn finished, <1m ago');
  assert.equal(limitedDetail(session({ observation: 'lost', lastObserved: { fact: 'tool-end', at: 'not a time' }, lastOutputAt: null }), NOW), 'no output yet');
  // Live but silent (a long tool run or approval wait): confidence ages, the state is kept and never declared finished.
  const quiet = stateFor(session({ observation: 'live', activity: 'working', lastObserved: fact('tool-start', 20 * 60_000) }), NOW, true);
  assert.deepEqual(quiet, { word: 'Working', tone: 'active', detail: 'no hook activity for 20m', limited: false });
  assert.equal(stateFor(session({ observation: 'live', activity: 'working', lastObserved: fact('tool-start', 4 * 60_000) }), NOW, true).detail, null);
  const asking = stateFor(session({ status: 'waiting', observation: 'live', activity: 'permission', lastObserved: fact('permission-wait', 3 * 3600_000), pending: { tool: 'Bash', command: 'npm publish', path: null, at: ago(3 * 3600_000) } }), NOW, true);
  assert.deepEqual(asking, { word: 'Needs approval', tone: 'attention', detail: 'npm publish', limited: false });
  // Live again: the current state returns.
  assert.equal(stateFor(session({ observation: 'live', activity: 'idle', lastObserved: fact('turn-completed', 1000) }), NOW, true).word, 'Your turn');
});

test('details: disconnected says the state is unknown; Codex and Cursor show output time', async t => {
  const { stateFor } = await load(t);
  assert.equal(stateFor(session({ status: 'running' }), NOW, false).detail, 'state unknown');
  assert.equal(stateFor(session({ provider: 'codex', lastOutputAt: ago(2000) }), NOW, true).detail, 'output just now');
  assert.equal(stateFor(session({ provider: 'cursor', status: 'waiting', lastOutputAt: ago(5 * 60_000) }), NOW, true).detail, 'quiet 5m');
  assert.equal(stateFor(session({ provider: 'codex', lastOutputAt: null }), NOW, true).detail, 'no output yet');
  assert.equal(stateFor(session({ activity: 'working' }), NOW, true).detail, null);
  assert.equal(stateFor(session({ status: 'stopped' }), NOW, true).detail, null);
});

test('outputDetail boundaries', async t => {
  const { outputDetail, OUTPUT_FRESH_MS } = await load(t);
  assert.equal(OUTPUT_FRESH_MS, 10_000);
  assert.equal(outputDetail(null, NOW), 'no output yet');
  assert.equal(outputDetail(undefined, NOW), 'no output yet');
  assert.equal(outputDetail(ago(0), NOW), 'output just now');
  assert.equal(outputDetail(ago(9_900), NOW), 'output just now');
  assert.equal(outputDetail(ago(10_000), NOW), 'quiet <1m');
  assert.equal(outputDetail(ago(59_000), NOW), 'quiet <1m');
  assert.equal(outputDetail(ago(60_000), NOW), 'quiet 1m');
  assert.equal(outputDetail(ago(59 * 60_000), NOW), 'quiet 59m');
  assert.equal(outputDetail(ago(2 * 3600_000), NOW), 'quiet 2h');
  // A clock slightly behind the runtime's still reads as fresh output.
  assert.equal(outputDetail(ago(-3000), NOW), 'output just now');
});

test('Needs approval detail prefers command, then path, then tool', async t => {
  const { stateFor } = await load(t);
  const detail = pending => stateFor(session({ status: 'waiting', activity: 'permission', pending }), NOW, true).detail;
  const at = ago(0);
  assert.equal(detail({ tool: 'Bash', command: 'npm publish', path: 'src/a.ts', at }), 'npm publish');
  assert.equal(detail({ tool: 'Write', command: null, path: 'src/a.ts', at }), 'src/a.ts');
  assert.equal(detail({ tool: 'WebFetch', command: null, path: null, at }), 'WebFetch');
  assert.equal(detail({ tool: null, command: null, path: null, at }), null);
  assert.equal(detail(null), null);
  assert.equal(detail(undefined), null);
});

test('needsYou: blocked Claude, failed, orphaned and leftover processes; not Codex waiting, archived when ended, or removed', async t => {
  const { needsYou } = await load(t);
  assert.equal(needsYou(session({ status: 'waiting' })), true);
  assert.equal(needsYou(session({ status: 'failed' })), true);
  assert.equal(needsYou(session({ status: 'orphaned' })), true);
  assert.equal(needsYou(session({ status: 'stopped', survivors: [{ pid: 1, started: 'x', command: 'node' }] })), true);
  assert.equal(needsYou(session({ provider: 'codex', status: 'waiting' })), false);
  assert.equal(needsYou(session({ provider: 'cursor', status: 'waiting' })), false);
  // A live session needs the user even if archived (the badge counts it too); archive hides only ended ones.
  assert.equal(needsYou(session({ status: 'waiting', archived: true })), true);
  assert.equal(needsYou(session({ status: 'failed', archived: true })), false);
  assert.equal(needsYou(session({ status: 'stopped', archived: true, survivors: [{ pid: 1, started: 'x', command: 'node' }] })), false);
  assert.equal(needsYou(session({ status: 'failed', removed: true })), false);
  assert.equal(needsYou(session({ status: 'running', activity: 'idle' })), false);
  assert.equal(needsYou(session({ status: 'stopped', survivors: [] })), false);
});

test('slotOrder: by slot, then orphans and unslotted live sessions newest first; pins do not reorder', async t => {
  const { slotOrder, slotTarget } = await load(t);
  const three = session({ slot: 3, createdAt: ago(1000) });
  const one = session({ slot: 1, createdAt: ago(9000) });
  const two = session({ slot: 2, pinned: true, pinSeq: 1, createdAt: ago(5000) });
  const orphanOld = session({ status: 'orphaned', slot: null, createdAt: ago(80_000) });
  const orphanNew = session({ status: 'orphaned', slot: null, createdAt: ago(70_000) });
  const unslotted = session({ status: 'running', createdAt: ago(75_000) });
  const stopped = session({ status: 'stopped', slot: null });
  const removed = session({ status: 'running', slot: 4, removed: true });
  // A stored copy can keep a slot from before it ended; only live sessions hold one.
  const ended = session({ status: 'exited', slot: 4 });
  const ids = list => list.map(s => s.id);
  assert.deepEqual(ids(slotOrder([three, orphanOld, one, stopped, removed, ended, orphanNew, unslotted, two])), ids([one, two, three, orphanNew, unslotted, orphanOld]));
  assert.deepEqual(ids(slotOrder([three, one, orphanOld])), ids([one, three, orphanOld]));
  const all = [three, one, two, orphanNew, unslotted, removed, ended];
  assert.equal(slotTarget(all, 1), one); assert.equal(slotTarget(all, 2), two); assert.equal(slotTarget(all, 3), three);
  assert.equal(slotTarget(all, 4), null, 'removed and ended sessions hold no slot, and slot keys never reach unslotted rows');
});

test('nextNeedsYou cycles in slot order and wraps', async t => {
  const { nextNeedsYou } = await load(t);
  const s1 = session({ slot: 1, status: 'waiting' }); const s2 = session({ slot: 2, activity: 'idle' }); const s4 = session({ slot: 4, status: 'waiting' });
  const all = [s4, s2, s1];
  assert.equal(nextNeedsYou(all, s1.id), s4);
  assert.equal(nextNeedsYou(all, s4.id), s1);
  assert.equal(nextNeedsYou(all, null), s1);
  assert.equal(nextNeedsYou(all, s2.id), s4);
  assert.equal(nextNeedsYou(all, 'not-listed'), s1);
  // Failed sessions follow the slotted rows, newest first.
  const failedOld = session({ status: 'failed', slot: null, createdAt: ago(90_000) }); const failedNew = session({ status: 'failed', slot: null, createdAt: ago(10_000) });
  const more = [...all, failedOld, failedNew];
  assert.equal(nextNeedsYou(more, s4.id), failedNew);
  assert.equal(nextNeedsYou(more, failedNew.id), failedOld);
  assert.equal(nextNeedsYou(more, failedOld.id), s1);
  // The only match, or none: nothing to jump to.
  assert.equal(nextNeedsYou([s1, s2], s1.id), null);
  assert.equal(nextNeedsYou([s2], s2.id), null);
  assert.equal(nextNeedsYou([], null), null);
  assert.equal(nextNeedsYou([s1, s2], s2.id), s1);
});

test('resumable needs an ended session with a confirmed native ID', async t => {
  const { resumable } = await load(t);
  assert.equal(resumable(session({ status: 'stopped', nativeId: 'n', nativeIdConfirmed: true })), true);
  assert.equal(resumable(session({ status: 'stopped', nativeId: 'n', nativeIdConfirmed: false })), false);
  assert.equal(resumable(session({ status: 'running', nativeId: 'n', nativeIdConfirmed: true })), false);
  assert.equal(resumable(session({ status: 'orphaned', nativeId: 'n', nativeIdConfirmed: true })), false);
});

test('the renderer branches only on the runtime error codes; any other code is no code', async t => {
  const { types } = await load(t);
  assert.deepEqual([...types.ERROR_CODES].sort(), Object.values(ERROR_CODES).sort());
  // The identity-changed error event carries its own code, shared by name.
  assert.equal(types.IDENTITY_CHANGED, IDENTITY_CHANGED);
  const coded = code => Object.assign(new Error('x'), { code });
  assert.equal(types.errorCode(coded('SLOTS_FULL')), 'SLOTS_FULL');
  for (const other of ['ENOENT', 42, { code: 'SLOTS_FULL' }, undefined, null, 'slots_full']) assert.equal(types.errorCode(coded(other)), null, String(other));
  assert.equal(types.errorCode('SLOTS_FULL'), null);
  assert.equal(types.errorCode({ code: 'SLOTS_FULL' }), null);
});

test('a failed desktop request carries only a bounded string code', () => {
  const coded = code => Object.assign(new Error('nope'), { code });
  assert.deepEqual(settledError(coded('SLOTS_FULL')), { ok: false, error: 'nope', code: 'SLOTS_FULL' });
  assert.deepEqual(settledError(coded('X'.repeat(100))), { ok: false, error: 'nope', code: 'X'.repeat(40) });
  for (const code of [42, { nested: 'SLOTS_FULL' }, null, undefined, ['SLOTS_FULL']]) assert.deepEqual(settledError(coded(code)), { ok: false, error: 'nope' }, String(code));
  assert.deepEqual(settledError('plain'), { ok: false, error: 'Operation failed' });
  assert.deepEqual(settledError(null), { ok: false, error: 'Operation failed' });
});

test('Codex and Cursor states follow what their live hooks report (plan 4.4, Phase 4)', async t => {
  const { stateFor, needsYou, outputOnly } = await load(t);
  const both = { turns: true, approvals: true };
  const codex = fields => session({ provider: 'codex', observation: 'live', observes: both, lastObserved: { fact: 'turn-start', at: ago(1000) }, ...fields });
  assert.equal(stateFor(codex({ status: 'running', activity: 'working' }), NOW, true).word, 'Working');
  assert.equal(stateFor(codex({ status: 'running', activity: 'idle' }), NOW, true).word, 'Your turn');
  const waiting = codex({ status: 'waiting', activity: 'permission', pending: { tool: 'Bash', command: 'rm x' } });
  assert.deepEqual([stateFor(waiting, NOW, true).word, stateFor(waiting, NOW, true).detail, needsYou(waiting)], ['Needs approval', 'rm x', true]);
  // Not live (no hooks yet, untrusted, lost): the limited model, never a current state.
  for (const observation of ['pending', 'unobserved', 'lost']) {
    const s = codex({ observation, status: 'waiting', activity: 'permission' });
    assert.equal(stateFor(s, NOW, true).limited, true, observation); assert.equal(needsYou(s), false, observation); assert.equal(outputOnly(s), true);
  }
  // No capabilities reported (an older runtime): limited.
  assert.equal(stateFor(codex({ observes: undefined, status: 'running', activity: 'idle' }), NOW, true).limited, true);
  // Cursor level 1: live tool events, but no turn end: never Working or Your turn, the last fact shown instead.
  const level1 = session({ provider: 'cursor', observation: 'live', observes: { turns: false, approvals: false }, status: 'running', activity: 'working', lastObserved: { fact: 'tool-end', at: ago(120_000) } });
  const shown = stateFor(level1, NOW, true);
  assert.equal(shown.limited, true); assert.match(shown.detail, /2m/);
  assert.equal(outputOnly(level1), true);
  // Cursor level 2: turn end reported; approvals never (a waiting status is not shown as an approval).
  const level2 = fields => session({ provider: 'cursor', observation: 'live', observes: { turns: true, approvals: false }, ...fields });
  assert.equal(stateFor(level2({ status: 'running', activity: 'idle' }), NOW, true).word, 'Your turn');
  const cursorWaiting = stateFor(level2({ status: 'waiting', activity: 'permission' }), NOW, true);
  assert.notEqual(cursorWaiting.word, 'Needs approval'); assert.equal(cursorWaiting.limited, true);
  assert.equal(needsYou(level2({ status: 'waiting', activity: 'permission' })), false);
  // Claude keeps reporting both, with or without the field.
  assert.equal(stateFor(session({ observation: 'live', status: 'waiting', activity: 'permission' }), NOW, true).word, 'Needs approval');
});
