import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { JournalStore } from '../src/core/store.mjs';
import { TerminalManager } from '../src/core/terminal.mjs';
import { generateTitle } from '../src/core/sessions.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sessions-')); const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]); writeFileSync(join(repo, 'README.md'), 'x\n');
  execFileSync('git', ['-C', repo, 'add', '.']); execFileSync('git', ['-C', repo, '-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'init']);
  const store = new JournalStore(join(root, 'j.sqlite')); const project = store.openProject(repo);
  const procs = []; const launches = [];
  const manager = new TerminalManager({ store, trackMs: 0, identify: () => null, table: () => null, spawn: (executable, argv) => {
    launches.push(argv); const proc = { onData() {}, onExit(f) { this.exit = f; }, write() {}, resize() {}, kill() {} }; procs.push(proc); return proc;
  } });
  t.after(() => { manager.disposed = true; try { store.close(); } catch {} rmSync(root, { recursive: true, force: true }); });
  return { root, repo, store, project, manager, procs, launches };
}

test('default titles are deterministic, cleaned and truncated at a word boundary', () => {
  assert.equal(generateTitle('  Fix the **login** bug\nmore detail'), 'Fix the login bug');
  assert.equal(generateTitle('Rule: Always use `npm test`'), 'Always use npm test');
  assert.equal(generateTitle('- [ ] list item task'), '[ ] list item task');
  assert.equal(generateTitle('Rename read_table to fetch_rows in TASK_1 and _private'), 'Rename read_table to fetch_rows in TASK_1 and _private');
  assert.equal(generateTitle('Use *careful* **bold** ~~old~~ text'), 'Use careful bold old text');
  assert.equal(generateTitle(''), 'Interactive session');
  const long = generateTitle('Refactor the payment retry logic so that every retry reuses the idempotency key and logs it');
  assert.ok(long.length <= 61 && long.endsWith('…') && !long.includes('  ')); assert.equal(long, generateTitle('Refactor the payment retry logic so that every retry reuses the idempotency key and logs it'));
  assert.equal(generateTitle('', { displayName: 'My fix', title: 'x' }), 'Resume · My fix');
});

test('rename, pin and archive are user-owned: runtime status saves never undo them', async t => {
  const f = fixture(t);
  const { session } = await f.manager.start({ projectId: f.project.id, provider: 'claude', task: 'Build the settings page' });
  assert.equal(session.title, 'Build the settings page');
  f.store.renameSession(session.id, 'Settings work'); f.store.setSessionPinned(session.id, true); f.store.archiveSession(session.id);
  f.manager.entry(session.id).session.status = 'waiting'; f.manager.persist(f.manager.entry(session.id).session); // a runtime status save
  const stored = f.store.getSession(session.id);
  assert.deepEqual([stored.displayName, stored.pinned, stored.archived, stored.status], ['Settings work', true, true, 'waiting']);
  assert.equal(stored.nativeId, session.nativeId, 'The native ID never changes');
  f.store.renameSession(session.id, null); assert.equal(f.store.getSession(session.id).displayName, null);
  assert.throws(() => f.store.renameSession(session.id, 'x'.repeat(200)), /session name/);
  assert.throws(() => f.store.updateSessionUser(session.id, { nativeId: 'other' }), /Invalid session field/);
});

test('pins order by pin sequence and survive reopening the store', async t => {
  const f = fixture(t);
  const ids = []; for (const task of ['one', 'two', 'three']) ids.push((await f.manager.start({ projectId: f.project.id, provider: 'codex', task })).session.id);
  f.store.setSessionPinned(ids[2], true); f.store.setSessionPinned(ids[0], true);
  f.store.close(); const reopened = new JournalStore(join(f.root, 'j.sqlite')); t.after(() => reopened.close());
  const pinned = reopened.listSessions(f.project.id).filter(s => s.pinned).sort((a, b) => a.pinSeq - b.pinSeq).map(s => s.id);
  assert.deepEqual(pinned, [ids[2], ids[0]]);
  reopened.setSessionPinned(ids[2], false); assert.equal(reopened.getSession(ids[2]).pinSeq, null);
});

test('removing hides a stopped session and its timeline, keeps receipts, and exact resume still works', async t => {
  const f = fixture(t);
  const first = await f.manager.start({ projectId: f.project.id, provider: 'claude', task: 'Original task' });
  assert.throws(() => f.store.removeSession(first.session.id), /Stop the session/);
  f.procs[0].exit({ exitCode: 0 });
  f.store.renameSession(first.session.id, 'Renamed'); f.store.setSessionPinned(first.session.id, true); f.store.archiveSession(first.session.id);
  const resumed = await f.manager.start({ projectId: f.project.id, provider: 'claude', resumeId: first.session.id });
  assert.deepEqual(f.launches[1].slice(0, 2), ['--resume', first.session.nativeId], 'Exact resume after rename, pin and archive');
  assert.equal(resumed.session.title, 'Resume · Renamed');
  f.procs[1].exit({ exitCode: 0 });
  f.store.removeSession(resumed.session.id);
  assert.equal(f.store.listSessions(f.project.id, true).some(s => s.id === resumed.session.id), false);
  assert.equal(f.store.listEvents(resumed.session.id).length, 0);
  assert.ok(f.store.getReceipt(resumed.receipt.id), 'Receipts are kept for resume history');
  assert.equal(f.store.latestNativeReceipt(f.project.id, 'claude', first.session.nativeId).id, resumed.receipt.id);
  await f.manager.start({ projectId: f.project.id, provider: 'claude', resumeId: first.session.id });
  assert.deepEqual(f.launches[2].slice(0, 2), ['--resume', first.session.nativeId]);
  assert.ok(existsSync(join(f.repo, 'README.md')));
});

test('migration v7 keeps existing sessions and gives them user fields', t => {
  const root = mkdtempSync(join(tmpdir(), 'mig7-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'r'); execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  const path = join(root, 'j.sqlite'); const store = new JournalStore(path); const project = store.openProject(repo);
  store.saveSession({ id: 'old', projectId: project.id, provider: 'codex', status: 'exited', nativeId: '55555555-5555-4555-8555-555555555555', nativeIdConfirmed: true, title: 'Old task', receiptId: 'r', createdAt: '2026-01-01T00:00:00Z' });
  store.close();
  const raw = new DatabaseSync(path); raw.exec('PRAGMA user_version=6'); raw.close();
  const migrated = new JournalStore(path); t.after(() => migrated.close());
  const session = migrated.getSession('old');
  assert.deepEqual([session.title, session.nativeId, session.displayName, session.pinned, session.archived, session.removed], ['Old task', '55555555-5555-4555-8555-555555555555', null, false, false, false]);
});

test('two connections (app and runtime) never undo each other: user fields and status survive interleaving', async t => {
  const f = fixture(t);
  const { session } = await f.manager.start({ projectId: f.project.id, provider: 'codex', task: 'Interleaving' });
  const runtimeView = { ...f.store.getSession(session.id) }; // the runtime's stale copy
  const app = new JournalStore(join(f.root, 'j.sqlite')); t.after(() => app.close());
  app.renameSession(session.id, 'Renamed by app'); app.archiveSession(session.id);
  f.store.saveSession({ ...runtimeView, status: 'exited', nativeId: '66666666-6666-4666-8666-666666666666', archived: false, displayName: 'stale' });
  let stored = app.getSession(session.id);
  assert.deepEqual([stored.displayName, stored.archived, stored.status, stored.nativeId], ['Renamed by app', true, 'exited', '66666666-6666-4666-8666-666666666666']);
  app.setSessionPinned(session.id, true); // a user write after the runtime's status write
  stored = f.store.getSession(session.id);
  assert.deepEqual([stored.status, stored.nativeId, stored.pinned], ['exited', '66666666-6666-4666-8666-666666666666', true], 'User writes never revert runtime state');
  app.removeSession(session.id);
  f.store.saveSession({ ...runtimeView, status: 'exited' }); // a late runtime save
  assert.equal(app.getSession(session.id).removed, true, 'A removed session never comes back');
  assert.equal(app.activeSessions().some(s => s.id === session.id), false);
  assert.deepEqual(app.generateProposals(session.id), [], 'Nothing is derived from a removed session');
});

test('removal refuses while leftover child processes are recorded', async t => {
  const f = fixture(t); const { session } = await f.manager.start({ projectId: f.project.id, provider: 'claude', task: 'x' });
  f.procs[0].exit({ exitCode: 0 });
  f.store.saveSession({ ...f.store.getSession(session.id), survivors: [{ pid: 4242, started: 'x', command: 'daemon' }] });
  assert.throws(() => f.store.removeSession(session.id), /leftover child processes/);
});

test('titles keep identifiers and whole characters, and never stack resume prefixes', () => {
  assert.equal(generateTitle('Fix __init__ and _private handling'), 'Fix __init__ and _private handling');
  assert.equal(generateTitle('---\n#\nReal first line'), 'Real first line');
  const emoji = generateTitle('😀'.repeat(70)); assert.ok(!emoji.includes('�') && [...emoji.replace('…', '')].length <= 60);
  const cjk = generateTitle('漢字'.repeat(40)); assert.equal([...cjk.replace('…', '')].length, 60);
  assert.equal(generateTitle('', { title: 'Resume · Resume · Build page' }), 'Resume · Build page');
});
