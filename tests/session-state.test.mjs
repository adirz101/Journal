import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { ERROR_CODES } from '../src/core/terminal.mjs';

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

// The state table of the Phase 2 plan (board B8), written out independently.
function expected({ provider, status, activity, exitCode }, connected) {
  if (LIVE.has(status) && !connected) return { word: 'Disconnected', tone: 'muted', limited: false };
  if (provider === 'claude' && status === 'waiting') return { word: 'Needs approval', tone: 'attention', limited: false };
  if (provider === 'claude' && status === 'running') return activity === 'idle' ? { word: 'Your turn', tone: 'active', limited: false } : { word: 'Working', tone: 'active', limited: false };
  if (provider !== 'claude' && (status === 'running' || status === 'waiting')) return { word: 'Running', tone: 'active', limited: true };
  const rest = {
    starting: { word: 'Starting', tone: 'neutral' }, stopping: { word: 'Stopping', tone: 'neutral' },
    exited: exitCode ? { word: `Exited ${exitCode}`, tone: 'error' } : { word: 'Exited 0', tone: 'neutral' },
    failed: { word: 'Failed to start', tone: 'error' }, stopped: { word: 'Stopped', tone: 'muted' },
    interrupted: { word: 'Interrupted', tone: 'muted' }, orphaned: { word: 'Still running outside Journal', tone: 'attention' },
  };
  return { ...rest[status], limited: false };
}

test('stateFor follows the state table for every provider, status, activity and connection', async t => {
  const { stateFor } = await load(t);
  let cases = 0;
  for (const provider of PROVIDERS) for (const status of STATUSES) for (const activity of ACTIVITIES) for (const connected of [true, false]) for (const exitCode of status === 'exited' ? [0, null, 2] : [undefined]) {
    const input = session({ provider, status, activity, exitCode, lastOutputAt: ago(1000) });
    const state = stateFor(input, NOW, connected);
    const label = `${provider} ${status} ${activity} ${connected ? 'connected' : 'disconnected'} ${exitCode}`;
    assert.deepEqual({ word: state.word, tone: state.tone, limited: state.limited }, expected(input, connected), label);
    // An orphan is "still running outside Journal" for every provider; nothing else of Codex or Cursor asks for attention.
    if (provider !== 'claude' && status !== 'orphaned') assert.notEqual(state.tone, 'attention', `${label}: Codex and Cursor never need approval`);
    if (provider === 'claude') assert.equal(state.limited, false, `${label}: Claude has full status`);
    cases++;
  }
  assert.ok(cases >= 3 * 9 * 4 * 2, `${cases} cases`);
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

test('needsYou: blocked Claude, failed, orphaned and leftover processes; not Codex waiting, archived or removed', async t => {
  const { needsYou } = await load(t);
  assert.equal(needsYou(session({ status: 'waiting' })), true);
  assert.equal(needsYou(session({ status: 'failed' })), true);
  assert.equal(needsYou(session({ status: 'orphaned' })), true);
  assert.equal(needsYou(session({ status: 'stopped', survivors: [{ pid: 1, started: 'x', command: 'node' }] })), true);
  assert.equal(needsYou(session({ provider: 'codex', status: 'waiting' })), false);
  assert.equal(needsYou(session({ provider: 'cursor', status: 'waiting' })), false);
  assert.equal(needsYou(session({ status: 'waiting', archived: true })), false);
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
  const coded = code => Object.assign(new Error('x'), { code });
  assert.equal(types.errorCode(coded('SLOTS_FULL')), 'SLOTS_FULL');
  for (const other of ['ENOENT', 42, { code: 'SLOTS_FULL' }, undefined, null, 'slots_full']) assert.equal(types.errorCode(coded(other)), null, String(other));
  assert.equal(types.errorCode('SLOTS_FULL'), null);
  assert.equal(types.errorCode({ code: 'SLOTS_FULL' }), null);
});
