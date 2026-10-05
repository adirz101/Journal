import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

// Transpiles sessionView.ts with the renderer modules it imports, so the test runs the renderer's own code.
async function load(t) {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const dir = mkdtempSync(resolve('.cache/tmp', 'view-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ['types', 'copy', 'sessionView']) {
    const source = readFileSync(new URL(`../src/ui/${name}.ts`, import.meta.url), 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    writeFileSync(join(dir, `${name}.mjs`), outputText.replace(/from '\.\/(types|copy)'/g, "from './$1.mjs'"));
  }
  return import(pathToFileURL(join(dir, 'sessionView.mjs')).href);
}

const receipt = (fields = {}) => ({ id: 'r', packet: 'x'.repeat(1946), query: '', items: Array.from({ length: 6 }, (_, i) => ({ id: `m${i}` })), excluded: [], state: 'submitted', estimatedTokens: 0, createdAt: '', ...fields });

test('statusLine summarises the delivery', async t => {
  const { statusLine } = await load(t);
  assert.deepEqual(statusLine(receipt()), { text: 'Agent got 6 notes · 1.9 KB', link: 'sent' });
  assert.deepEqual(statusLine(receipt({ items: [{ id: 'a' }] })), { text: 'Agent got 1 note · 1.9 KB', link: 'sent' });
  assert.deepEqual(statusLine(receipt({ items: [] })), { text: 'Agent got no notes', link: 'sent' });
  assert.deepEqual(statusLine(receipt({ state: 'uncertain' })), { text: 'Delivery uncertain · 6 notes · 1.9 KB', link: 'prepared' });
  assert.deepEqual(statusLine(receipt({ state: 'failed' })), { text: 'Nothing was sent', link: null });
  assert.deepEqual(statusLine(receipt({ state: 'prepared' })), { text: '', link: null });
  assert.deepEqual(statusLine(null), { text: '', link: null });
});

test('packetBytes counts UTF-8 bytes', async t => {
  const { packetBytes } = await load(t);
  assert.equal(packetBytes('abc'), 3); assert.equal(packetBytes('\u{1F600}'), 4); assert.equal(packetBytes('é'), 2); assert.equal(packetBytes(''), 0);
});

test('mergeEvents keeps each event once, for this session, oldest first', async t => {
  const { mergeEvents } = await load(t);
  const stored = [{ id: 1, sessionId: 's', at: '2026-10-04T10:00:01Z', kind: 'start', body: {} }, { id: 2, sessionId: 's', at: '2026-10-04T10:00:03Z', kind: 'file', body: { path: 'a' } }];
  const live = [
    { sessionId: 's', at: '2026-10-04T10:00:03Z', kind: 'file', body: { path: 'a' } }, // also stored
    { sessionId: 's', at: '2026-10-04T10:00:02Z', kind: 'prompt', body: {} },
    { sessionId: 'other', at: '2026-10-04T10:00:04Z', kind: 'file', body: { path: 'b' } },
    { id: 1, sessionId: 's', at: '2026-10-04T10:00:01Z', kind: 'start', body: {} },
  ];
  assert.deepEqual(mergeEvents(stored, live, 's').map(e => e.kind), ['start', 'prompt', 'file']);
  assert.deepEqual(mergeEvents([], [], 's'), []);
});

test('an index built once per fetch merges the same as the stored list', async t => {
  const { indexEvents, mergeEvents } = await load(t);
  const stored = [{ id: 1, sessionId: 's', at: '2026-10-04T10:00:01Z', kind: 'start', body: {} }, { id: 2, sessionId: 's', at: '2026-10-04T10:00:03Z', kind: 'file', body: { path: 'a' } }, { id: 2, sessionId: 's', at: '2026-10-04T10:00:03Z', kind: 'file', body: { path: 'a' } }];
  const index = indexEvents(stored, 's');
  assert.equal(index.events.length, 2); assert.equal(index.keys.size, 2);
  const live = [{ sessionId: 's', at: '2026-10-04T10:00:03Z', kind: 'file', body: { path: 'a' } }, { sessionId: 's', at: '2026-10-04T10:00:04Z', kind: 'turn-end', body: {} }, { sessionId: 's', at: '2026-10-04T10:00:04Z', kind: 'turn-end', body: {} }];
  assert.deepEqual(mergeEvents([], live, 's', index), mergeEvents(stored, live, 's'));
  assert.deepEqual(mergeEvents([], live, 's', index).map(e => e.kind), ['start', 'file', 'turn-end']);
  assert.equal(index.events.length, 2, 'merging never changes the cached index');
});

test('diffSummary counts what the session changed', async t => {
  const { diffSummary } = await load(t);
  assert.equal(diffSummary(null), null);
  assert.equal(diffSummary({ base: 'b', available: false, files: [] }), null);
  const file = (fields) => ({ path: 'p', from: null, additions: 1, deletions: 0, binary: false, untracked: false, preexisting: false, sensitive: false, ...fields });
  assert.deepEqual(diffSummary({ base: 'b', available: true, additions: 99, deletions: 99, files: [file({ additions: 3, deletions: 2 }), file({ untracked: true, additions: 5 }), file({ preexisting: true, additions: 40, deletions: 40 }), file({ binary: true, additions: null, deletions: null })] }),
    { additions: 8, deletions: 2, files: 3 });
  assert.deepEqual(diffSummary({ base: 'b', available: true, files: [] }), { additions: 0, deletions: 0, files: 0 });
});

test('activityVisible: Claude only', async t => {
  const { activityVisible } = await load(t);
  assert.deepEqual(['claude', 'codex', 'cursor'].map(provider => activityVisible({ provider })), [true, false, false]);
});

// Hooks plan 4.3: the timeline shows one entry per turn. Turn ends recorded by the runtime for
// a Cursor-style aborted + error pair (either order), a repeat and a late end collapse by turn key.
test('turn ends collapse to one entry per turn with the strongest outcome', async t => {
  const { mergeEvents, collapseTurns } = await load(t);
  const { TerminalManager } = await import('../src/core/terminal.mjs');
  const { JournalStore } = await import('../src/core/store.mjs');
  const { execFileSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  for (const order of [['aborted', 'error'], ['error', 'aborted']]) {
    const root = mkdtempSync(resolve(process.env.JOURNAL_TEST_TMP ?? tmpdir(), 'collapse-')); t.after(() => rmSync(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '-b', 'main', root], { stdio: 'pipe' });
    const store = new JournalStore(':memory:'); t.after(() => store.close()); const project = store.openProject(root);
    const chat = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const manager = new TerminalManager({ store, trackMs: 0, observationMs: 0, identify: () => null, table: () => null, makeObserver: () => ({ settingsFile: null, env: {} }),
      cursor: { find: async () => ({ path: '/bin/agent', cursor: true, supports: { resume: true, createChat: true, mode: true } }), createChat: async () => chat },
      spawn: () => ({ onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }) });
    t.after(() => { manager.disposed = true; });
    const live = []; manager.on('event', e => { if (e.type === 'timeline') live.push(e.event); });
    const { session } = await manager.start({ projectId: project.id, provider: 'cursor', task: 'x' });
    const send = fields => manager.ingest(session.id, { event: 'stop', nativeId: chat, cwd: root, ...fields });
    for (const status of order) send({ turn: 'g1', status });
    send({ turn: 'g1', status: 'aborted' });
    send({ turn: 'g2', status: 'completed' });
    // Stored and live copies merge to one entry per turn.
    const ends = mergeEvents(store.listEvents(session.id), live, session.id).filter(e => e.kind === 'turn-end');
    assert.deepEqual(ends.map(e => [e.body.turn, e.body.outcome]), [['g1', 'interrupted'], ['g2', 'completed']], order.join(','));
  }
  // A late end merges into its turn's entry; the entry is late only when every record is.
  const at = n => `2026-10-04T10:00:0${n}Z`;
  const collapsed = collapseTurns([{ at: at(1), kind: 'turn-end', body: { turn: 'a', outcome: 'completed' } }, { at: at(2), kind: 'turn-end', body: {} }, { at: at(3), kind: 'turn-end', body: {} },
    { at: at(4), kind: 'turn-end', body: { turn: 'a', outcome: 'error', late: true } }, { at: at(5), kind: 'turn-end', body: { turn: 'b', outcome: 'error', late: true } }]);
  assert.deepEqual(collapsed.map(e => e.body), [{ turn: 'a', outcome: 'error' }, {}, {}, { turn: 'b', outcome: 'error', late: true }]);
});
