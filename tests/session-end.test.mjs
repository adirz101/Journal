import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { JournalStore } from '../src/core/store.mjs';
import { summarizeChanges, TerminalManager } from '../src/core/terminal.mjs';
import { parseHunks, selectHunks, shiftedRange, movedRange } from '../src/core/hunks.mjs';
import { removeLater } from './support/cleanup.mjs';

// Phase 6 Group A: the end snapshot, sessionSummary, suggestions of a conversation,
// one-step Remember (D1), the out-of-date catch and "Still true".

const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const lines = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n';

function fixture(t) {
  const root = mkdtempSync(resolve(process.env.JOURNAL_TEST_TMP ?? tmpdir(), 'session-end-'));
  const repo = join(root, 'repo'); mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
  const commit = message => { git('add', '-A'); git('-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', message); };
  git('init', '-q', '-b', 'main');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'a.txt'), 'a\n'); writeFileSync(join(repo, 'b.txt'), 'b\n');
  writeFileSync(join(repo, 'src', 'a.js'), lines('line', 12)); writeFileSync(join(repo, 'src', 'other.js'), lines('other', 5));
  commit('init');
  const store = new JournalStore(join(root, 'journal.sqlite')); const project = store.openProject(repo);
  t.after(() => { store.close(); removeLater(root); });
  // A stored session as the runtime leaves it, with the baseline taken at its start.
  const session = (task = '', extra = {}) => {
    const workspaceId = extra.workspaceId ?? null; const view = store.view(project.id, workspaceId);
    const receipt = store.prepareContext(project.id, task, { workspaceId });
    const s = { id: `s-${Math.random().toString(16).slice(2)}`, projectId: project.id, provider: 'claude', nativeId: null, nativeIdConfirmed: true, status: 'exited', exitCode: 0,
      receiptId: receipt.id, createdAt: new Date(Date.now() - 60_000).toISOString(), endedAt: new Date().toISOString(), head: view.head, branch: view.branch,
      baseline: store.checkoutBaseline(project.id, workspaceId), survivors: [], ...extra };
    store.saveSession(s); return s;
  };
  // What the runtime does at exit.
  const end = s => { const saved = store.getSession(s.id); store.saveSession({ ...saved, changeStats: summarizeChanges(store.sessionChanges(s.id)) }); return store.getSession(s.id); };
  const note = (path, startLine, endLine, extra = {}) => {
    const memory = store.proposeMemory(project.id, { statement: `Lines ${startLine}-${endLine} of ${path} hold the retry policy`, category: 'convention', scope: 'checkout', area: '',
      source: { kind: 'file', path, startLine, endLine }, ...extra });
    return store.setMemoryStatus(memory.id, 'active');
  };
  const testCommand = (s, id = 'a', command = 'npm test') => {
    store.appendEvent(s.id, 'command-start', { toolUseId: id, command, test: true });
    store.appendEvent(s.id, 'command-end', { toolUseId: id, status: 'succeeded', exitCode: 0 });
  };
  const counts = () => Object.fromEntries(['memories', 'revisions', 'memory_fts', 'audit'].map(table => [table, store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]));
  return { root, repo, git, commit, store, project, session, end, note, testCommand, counts };
}

// A TerminalManager over the fixture's store with fake PTYs.
function terminals(f) {
  const procs = [];
  const manager = new TerminalManager({ store: f.store, trackMs: 0, identify: () => null, table: () => null, spawn: () => {
    const proc = { callbacks: {}, onData(fn) { this.callbacks.data = fn; }, onExit(fn) { this.callbacks.exit = fn; }, write() {}, resize() {}, kill() {} };
    procs.push(proc); return proc;
  } });
  return { manager, procs };
}

// ----- A1: the end snapshot -----

test('the end snapshot is kept when the checkout changes later', async t => {
  const f = fixture(t); const { manager, procs } = terminals(f);
  const { session } = await manager.start({ projectId: f.project.id, provider: 'claude', task: 'Write a.txt' });
  appendFileSync(join(f.repo, 'a.txt'), 'one\ntwo\nthree\n');
  procs[0].callbacks.exit({ exitCode: 0 }); await manager.entry(session.id).changeSnapshot;
  const stats = f.store.getSession(session.id).changeStats;
  assert.equal(stats.additions, 3); assert.equal(stats.files, 1); assert.deepEqual(stats.paths, [{ path: 'a.txt', from: null }]);
  appendFileSync(join(f.repo, 'a.txt'), lines('more', 5));
  assert.equal(f.store.sessionSummary(session.id).changes.additions, 3);
  assert.equal(f.store.sessionChanges(session.id).additions, 8);
  await manager.dispose();
});

test('files changed before the start are counted but not listed', async t => {
  const f = fixture(t); const { manager, procs } = terminals(f);
  appendFileSync(join(f.repo, 'b.txt'), 'dirty\n');
  const { session } = await manager.start({ projectId: f.project.id, provider: 'claude', task: '' });
  appendFileSync(join(f.repo, 'a.txt'), 'one\n');
  procs[0].callbacks.exit({ exitCode: 0 }); await manager.entry(session.id).changeSnapshot;
  const stats = f.store.getSession(session.id).changeStats;
  assert.equal(stats.preexisting, 1); assert.equal(stats.files, 2);
  assert.deepEqual(stats.paths.map(p => p.path), ['a.txt']);
  await manager.dispose();
});

// ----- A3: sessionSummary -----

test('sessionSummary counts Claude test commands and hides them for Codex', t => {
  const f = fixture(t); const s = f.session('');
  const command = (id, text, status) => { f.store.appendEvent(s.id, 'command-start', { toolUseId: id, command: text, test: true }); if (status) f.store.appendEvent(s.id, 'command-end', { toolUseId: id, status }); };
  command('a', 'npm test', 'succeeded'); command('b', 'npm test', 'succeeded'); command('c', `node --test ${'x'.repeat(100)}`, 'failed');
  command('d', 'npx vitest run', null); command('e', 'go test ./...', 'interrupted');
  f.store.appendEvent(s.id, 'command-start', { toolUseId: 'f', command: 'ls', test: false });
  const summary = f.store.sessionSummary(s.id);
  assert.deepEqual({ ...summary.tests, commands: null }, { passed: 2, failed: 1, unknown: 2, commands: null });
  assert.equal(summary.tests.commands.length, 3); assert.equal(summary.tests.commands[0], 'npm test');
  assert.ok(summary.tests.commands.every(c => c.length <= 60));
  assert.equal(summary.durationMs, Date.parse(s.endedAt) - Date.parse(s.createdAt));
  assert.equal(summary.changes, null, 'no snapshot was taken');
  assert.equal(summary.status, 'exited'); assert.equal(summary.exitCode, 0); assert.equal(summary.signal, null);
  const codex = f.session('', { provider: 'codex' }); f.store.appendEvent(codex.id, 'command-start', { toolUseId: 'a', command: 'npm test', test: true });
  assert.equal(f.store.sessionSummary(codex.id).tests, null);
  assert.equal(f.store.sessionSummary(f.session('', { provider: 'cursor' }).id).tests, null);
  assert.equal(f.store.sessionSummary(f.session('', { endedAt: null }).id).durationMs, null);
});

test('sessionSummary identity states', async t => {
  const f = fixture(t); const id = 'c7d2a1e0-0000-4000-8000-0000000081af';
  const observed = f.session('', { nativeId: id, nativeIdConfirmed: true, nativeIdSource: 'preassigned-observed' });
  assert.deepEqual(f.store.sessionSummary(observed.id).identity, { nativeId: id, confirmed: true, source: 'preassigned-observed', mismatch: false });
  const codex = f.session('', { provider: 'codex', nativeId: id, nativeIdConfirmed: false, nativeIdSource: 'exit-banner' });
  assert.deepEqual(f.store.sessionSummary(codex.id).identity, { nativeId: id, confirmed: false, source: 'exit-banner', mismatch: false });
  const mismatch = f.session('', { nativeId: id, nativeIdConfirmed: false, nativeIdSource: 'preassigned', identityMismatch: true });
  assert.deepEqual(f.store.sessionSummary(mismatch.id).identity, { nativeId: id, confirmed: false, source: 'preassigned', mismatch: true });
  const { manager } = terminals(f); await manager.confirmNativeId(mismatch.id, id);
  assert.deepEqual(f.store.sessionSummary(mismatch.id).identity, { nativeId: id, confirmed: true, source: 'user', mismatch: false });
  assert.deepEqual(f.store.sessionSummary(f.session('', { provider: 'codex', nativeIdConfirmed: false }).id).identity, { nativeId: null, confirmed: false, source: null, mismatch: false });
  await manager.dispose();
});

// ----- A4: suggestions of a conversation and one-step Remember -----

test('listProposals filters by session and its resume chain', t => {
  const f = fixture(t);
  const a = f.session('Start.\nRule: Release tags must be signed by CI.');
  const b = f.session('Continue.\nRule: Payment webhooks retry three times before failing.', { resumedFrom: a.id });
  const other = f.session('Elsewhere.\nRule: Database migrations always run inside a transaction.');
  for (const s of [a, b, other]) f.store.generateProposals(s.id);
  const listed = f.store.listProposals(f.project.id, 'open', { sessionId: b.id });
  assert.deepEqual(listed.map(p => [p.statement, p.earlier]).sort(), [['Payment webhooks retry three times before failing.', false], ['Release tags must be signed by CI.', true]]);
  assert.ok(listed.every(p => Array.isArray(p.conflicts)));
  assert.deepEqual(f.store.listProposals(f.project.id, 'open', { sessionId: a.id }).map(p => p.earlier), [false], 'an earlier session does not see later ones');
  assert.equal(f.store.listProposals(f.project.id).length, 3, 'unchanged without a session');
  assert.equal(f.store.sessionSummary(b.id).suggestions, 2);
  const foreignRoot = mkdtempSync(join(f.root, 'foreign-')); execFileSync('git', ['init', '-q', '-b', 'main', foreignRoot]);
  const foreign = f.store.openProject(foreignRoot);
  assert.throws(() => f.store.listProposals(foreign.id, 'open', { sessionId: b.id }), /another project/);
});

test('rememberProposals remembers three at once', t => {
  const f = fixture(t);
  const s = f.session('Do it.\nRule: Release tags must be signed by CI.\nDecision: Payment webhooks retry three times before failing.\nLesson: Database migrations always run inside a transaction.');
  const ids = f.store.generateProposals(s.id).map(p => p.id); assert.equal(ids.length, 3);
  const before = f.store.listAudit(1000).length;
  const notes = f.store.rememberProposals(ids, { via: 'wrap-up' });
  assert.equal(notes.length, 3); assert.ok(notes.every(note => note.status === 'active'));
  for (const [index, id] of ids.entries()) {
    const proposal = f.store.getProposal(id);
    assert.equal(proposal.state, 'accepted'); assert.equal(proposal.memoryId, notes[index].id); assert.ok(proposal.handledAt);
    assert.ok(f.store.db.prepare('SELECT approved_at FROM memories WHERE id=?').get(notes[index].id).approved_at);
  }
  const audits = f.store.listAudit(1000).slice(before);
  assert.deepEqual(audits.filter(a => a.action === 'proposal-accepted').map(a => [a.body.id, a.body.via, a.body.kind]), ids.map(id => [id, 'wrap-up', 'rule']));
  assert.deepEqual(audits.filter(a => a.action === 'memory-active').map(a => a.body.via), ['wrap-up', 'wrap-up', 'wrap-up']);
  assert.equal(f.store.prepareContext(f.project.id, 'release tags').items[0]?.id, notes[0].id, 'remembered notes reach new sessions');
  assert.equal(f.store.sessionSummary(s.id).suggestions, 0);
});

test('one bad suggestion leaves the batch unchanged', t => {
  const f = fixture(t);
  const s = f.session('Do it.\nRule: Release tags must be signed by CI.\nDecision: Payment webhooks retry three times before failing.\nLesson: Database migrations always run inside a transaction.');
  const [one, two, three] = f.store.generateProposals(s.id).map(p => p.id);
  f.store.dismissProposal(three);
  const before = f.counts();
  assert.throws(() => f.store.rememberProposals([one, two, three], { via: 'wrap-up' }), /already handled/);
  assert.deepEqual(f.counts(), before);
  assert.deepEqual([one, two].map(id => f.store.getProposal(id).state), ['open', 'open']);
});

test('rememberProposals refuses six, duplicates, a branch update and a conflict', t => {
  const f = fixture(t);
  const ids = f.store.generateProposals(f.session('x\nRule: Release tags must be signed by CI.').id).map(p => p.id);
  const before = f.counts();
  assert.throws(() => f.store.rememberProposals([...ids, 'b', 'c', 'd', 'e', 'f'], { via: 'wrap-up' }), /Choose 1 to 5 suggestions/);
  assert.throws(() => f.store.rememberProposals([], { via: 'wrap-up' }), /Choose 1 to 5 suggestions/);
  assert.throws(() => f.store.rememberProposals([ids[0], ids[0]], { via: 'wrap-up' }), /Choose 1 to 5 suggestions/);
  assert.throws(() => f.store.rememberProposals(ids, { via: 'renderer' }), /Invalid remember path/);
  assert.throws(() => f.store.rememberProposals(ids, {}), /Invalid remember path/);
  // Two suggestions that say the same thing.
  const twins = f.store.generateProposals(f.session('x\nRule: Payment webhooks retry three times before failing.\nRule: Payment webhook retries three times before failing.').id).map(p => p.id);
  assert.equal(twins.length, 2);
  assert.throws(() => f.store.rememberProposals(twins, { via: 'wrap-up' }), /repeats another suggestion/);
  // A branch update keeps its own draft helper.
  const s = f.session('', { head: f.store.project(f.project.id).head });
  writeFileSync(join(f.repo, 'c.txt'), 'c\n'); f.commit('work');
  const status = f.store.generateProposals(s.id).find(p => p.kind === 'branch-status');
  assert.throws(() => f.store.rememberProposals([ids[0], status.id], { via: 'wrap-up' }), /Where this branch stands/);
  // A suggestion that may contradict a remembered note goes to Memory for review.
  f.store.rememberProposals([ids[0]], { via: 'wrap-up' });
  const opposite = f.store.generateProposals(f.session('x\nRule: Release tags must not be signed by CI.').id).map(p => p.id);
  assert.ok(f.store.listProposals(f.project.id, 'open', { sessionId: f.store.getProposal(opposite[0]).evidence.sessionId })[0].conflicts.length);
  const mid = f.counts();
  assert.throws(() => f.store.rememberProposals([twins[0], opposite[0]], { via: 'wrap-up' }), /^Error: "Release tags must not be signed by CI\." may conflict with a remembered note\. Review it in Memory\.$/);
  assert.deepEqual(f.counts(), mid); assert.equal(f.store.getProposal(twins[0]).state, 'open');
  assert.ok(before.memories < mid.memories);
});

test('a worktree branch suggestion is remembered in that worktree\'s view', t => {
  const f = fixture(t);
  const ws = f.store.createWorkspace(f.project.id, { branch: 'feature/x', base: 'main' }, join(f.root, 'worktrees'));
  const s = f.session('', { workspaceId: ws.id }); f.testCommand(s);
  const proposal = f.store.generateProposals(s.id).find(p => p.kind === 'test-command');
  assert.equal(proposal.branch, 'feature/x');
  const [note] = f.store.rememberProposals([proposal.id], { via: 'wrap-up' });
  assert.equal(note.status, 'active'); assert.equal(note.branch, 'feature/x'); assert.equal(f.store.project(f.project.id).branch, 'main');
  const s2 = f.session('', { workspaceId: ws.id }); f.testCommand(s2, 'b', 'cargo test --workspace integration');
  const later = f.store.generateProposals(s2.id).find(p => p.kind === 'test-command');
  f.store.removeWorkspace(ws.id);
  assert.throws(() => f.store.rememberProposals([later.id], { via: 'wrap-up' }), { message: 'This note belongs to branch feature/x; check out that branch to remember it' });
  assert.equal(f.store.getProposal(later.id).state, 'open');
});

test('setMemoryStatus approves a worktree-branch candidate in the worktree\'s view', t => {
  const f = fixture(t);
  const ws = f.store.createWorkspace(f.project.id, { branch: 'feature/x', base: 'main' }, join(f.root, 'worktrees'));
  const s = f.session('', { workspaceId: ws.id }); f.testCommand(s);
  const candidate = f.store.acceptProposal(f.store.generateProposals(s.id).find(p => p.kind === 'test-command').id);
  const before = f.store.listAudit(1000).length;
  assert.equal(f.store.setMemoryStatus(candidate.id, 'active').status, 'active');
  const audit = f.store.listAudit(1000).slice(before).find(a => a.action === 'memory-active');
  assert.equal(audit.body.via, undefined, 'the two-step path has no via');
});

test('setMemoryStatus still refuses when no copy has the branch', t => {
  const f = fixture(t); f.git('branch', 'feature/y');
  const s = f.session('', { branch: 'feature/y' }); f.testCommand(s);
  f.store.db.prepare(`UPDATE sessions SET body=json_set(body,'$.branch','feature/y') WHERE id=?`).run(s.id);
  const memory = f.store.proposeMemory(f.project.id, { statement: 'Feature y tests need the flag service', category: 'constraint', scope: 'branch', area: '', source: { kind: 'user', note: 'n' } }, { branch: 'feature/y' });
  assert.throws(() => f.store.setMemoryStatus(memory.id, 'active'), { message: 'This note belongs to branch feature/y; check out that branch to remember it' });
});

// ----- A5: the out-of-date catch -----

test('staleNotesForSession flags a note on a file the session changed', t => {
  const f = fixture(t);
  const target = f.note('src/a.js', 3, 5); const untouched = f.note('src/other.js', 1, 2);
  const s = f.session('');
  const text = readFileSync(join(f.repo, 'src', 'a.js'), 'utf8').replace('line 4\n', 'line four\n'); writeFileSync(join(f.repo, 'src', 'a.js'), text);
  f.end(s);
  const caught = f.store.staleNotesForSession(s.id);
  assert.equal(caught.available, true); assert.equal(caught.truncated, false);
  assert.deepEqual(caught.notes.map(n => n.note.id), [target.id]);
  const [item] = caught.notes;
  assert.equal(item.path, 'src/a.js'); assert.equal(item.renamedTo, null); assert.equal(item.before, null); assert.equal(item.after, null);
  const changed = item.hunks[0].lines.filter(line => line.kind !== ' ');
  assert.deepEqual(changed, [{ kind: '-', old: 4, new: null, text: 'line 4' }, { kind: '+', old: null, new: 4, text: 'line four' }]);
  assert.deepEqual(item.reaffirm, { allowed: true, reason: null }); assert.equal(item.workspaceId, null);
  assert.equal(item.suggestedRange, null);
  assert.ok(!caught.notes.some(n => n.note.id === untouched.id));
});

test('a rename\'s old path is caught', t => {
  const f = fixture(t); const target = f.note('src/a.js', 1, 2);
  const s = f.session(''); f.git('mv', 'src/a.js', 'src/b.js'); f.end(s);
  const [item] = f.store.staleNotesForSession(s.id).notes;
  assert.equal(item.note.id, target.id); assert.equal(item.renamedTo, 'src/b.js');
  assert.deepEqual(item.reaffirm, { allowed: false, reason: 'file-missing' }); assert.equal(item.hunks, null);
});

test('an additional folder\'s notes map through its path prefix', t => {
  const f = fixture(t);
  const outer = join(f.root, 'outer'); mkdirSync(join(outer, 'docs', 'guide'), { recursive: true });
  const og = (...args) => execFileSync('git', ['-C', outer, ...args], { stdio: 'pipe' });
  og('init', '-q', '-b', 'main'); writeFileSync(join(outer, 'docs', 'guide', 'retry.md'), lines('guide', 6));
  og('add', '-A'); og('-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'init');
  const folder = f.store.addProjectRoot(f.project.id, join(outer, 'docs')).roots.at(-1);
  const memory = f.store.proposeMemory(f.project.id, { statement: 'The retry guide documents three attempts', category: 'convention', scope: 'checkout', area: '',
    source: { kind: 'file', rootId: folder.id, path: 'guide/retry.md', startLine: 2, endLine: 3 } });
  f.store.setMemoryStatus(memory.id, 'active');
  const checkoutNote = f.note('src/a.js', 1, 2);
  const s = f.session('', { workspaceId: `root:${folder.id}`, head: null, branch: 'main' });
  writeFileSync(join(outer, 'docs', 'guide', 'retry.md'), lines('guide', 6).replace('guide 2', 'guide two'));
  writeFileSync(join(f.repo, 'src', 'a.js'), 'changed\n');
  f.end(s);
  assert.deepEqual(f.store.getSession(s.id).changeStats.paths.map(p => p.path), ['docs/guide/retry.md']);
  const caught = f.store.staleNotesForSession(s.id);
  assert.deepEqual(caught.notes.map(n => [n.note.id, n.path]), [[memory.id, 'guide/retry.md']]);
  assert.ok(caught.notes[0].hunks[0].lines.some(line => line.kind === '-' && line.old === 2));
  assert.ok(!caught.notes.some(n => n.note.id === checkoutNote.id), 'the folder session did not change the checkout');
});

test('hunks outside the note\'s lines are left out', t => {
  const f = fixture(t); const target = f.note('src/a.js', 6, 7);
  const s = f.session('');
  writeFileSync(join(f.repo, 'src', 'a.js'), lines('line', 12).replace('line 1\n', 'line one\n').replace('line 12\n', 'line twelve\n')); f.end(s);
  const [item] = f.store.staleNotesForSession(s.id).notes;
  assert.equal(item.note.id, target.id); assert.deepEqual(item.hunks, []);
  // Unit: an insertion just above the range counts, one further up does not.
  const diff = '@@ -3,3 +3,4 @@\n line 3\n line 4\n+inserted\n line 5\n@@ -9,2 +10,2 @@\n-line 9\n+line nine\n line 10\n';
  const hunks = parseHunks(diff);
  assert.deepEqual(hunks[0].lines.map(l => [l.kind, l.old, l.new]), [[' ', 3, 3], [' ', 4, 4], ['+', null, 5], [' ', 5, 6]]);
  assert.equal(selectHunks(hunks, 5, 6).hunks.length, 1, 'an insertion just above the range counts');
  assert.equal(selectHunks(hunks, 6, 7).hunks.length, 0);
  assert.deepEqual(selectHunks(hunks, 9, 9).hunks[0].lines.filter(l => l.kind === '-').map(l => l.old), [9]);
  assert.deepEqual(shiftedRange(hunks, 6, 8, 20), { startLine: 7, endLine: 9 });
  assert.equal(shiftedRange(hunks, 2, 3, 20), null);
  assert.deepEqual(movedRange('b\nc', ['a', 'x', 'b', 'c'], 2), { found: 1, range: { startLine: 3, endLine: 4 } });
  assert.deepEqual(movedRange('b', ['b', 'b'], 1), { found: 2, range: null });
});

test('an insertion just above the range counts', t => {
  const f = fixture(t); f.note('src/a.js', 5, 6);
  const s = f.session('');
  writeFileSync(join(f.repo, 'src', 'a.js'), lines('line', 12).replace('line 4\n', 'line 4\nnew line\n')); f.end(s);
  const [item] = f.store.staleNotesForSession(s.id).notes;
  assert.equal(item.hunks.length, 1); assert.ok(item.hunks[0].lines.some(line => line.kind === '+' && line.text === 'new line'));
  assert.deepEqual(item.suggestedRange, { startLine: 6, endLine: 7 });
});

test('a note saved from uncommitted content uses the excerpt fallback', t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'src', 'a.js'), lines('draft', 12));
  const target = f.note('src/a.js', 2, 3);
  const s = f.session('');
  writeFileSync(join(f.repo, 'src', 'a.js'), lines('draft', 12).replace('draft 2\n', 'final 2\n')); f.end(s);
  assert.deepEqual(f.store.getSession(s.id).changeStats.paths, [], 'a.js was already changed at the start');
  assert.deepEqual(f.store.staleNotesForSession(s.id).notes, [], 'files changed before the start are left out');
  // A session that starts clean and then edits it.
  writeFileSync(join(f.repo, 'src', 'a.js'), lines('line', 12)); // back to the committed content: a clean start
  const s3 = f.session(''); writeFileSync(join(f.repo, 'src', 'a.js'), lines('line', 12).replace('line 3\n', 'line three\n')); f.end(s3);
  const [item] = f.store.staleNotesForSession(s3.id).notes;
  assert.equal(item.note.id, target.id); assert.equal(item.hunks, null);
  assert.deepEqual(item.before, { startLine: 2, lines: ['draft 2', 'draft 3'] });
  assert.deepEqual(item.after, { startLine: 2, lines: ['line 2', 'line three'] });
});

test('a moved excerpt suggests its new range', t => {
  const f = fixture(t); f.note('src/a.js', 3, 5);
  const s = f.session(''); writeFileSync(join(f.repo, 'src', 'a.js'), lines('header', 10) + lines('line', 12)); f.end(s);
  const [item] = f.store.staleNotesForSession(s.id).notes;
  assert.deepEqual(item.suggestedRange, { startLine: 13, endLine: 15 });
});

test('an all-branches note in a worktree session cannot be reaffirmed there', t => {
  const f = fixture(t);
  const ws = f.store.createWorkspace(f.project.id, { branch: 'feature/x', base: 'main' }, join(f.root, 'worktrees'));
  const target = f.note('src/a.js', 1, 2);
  const s = f.session('', { workspaceId: ws.id });
  writeFileSync(join(ws.path, 'src', 'a.js'), 'rewritten\n'); f.end(s);
  const [item] = f.store.staleNotesForSession(s.id).notes;
  assert.equal(item.note.id, target.id); assert.deepEqual(item.reaffirm, { allowed: false, reason: 'separate-copy' }); assert.equal(item.workspaceId, null);
  assert.throws(() => f.store.reaffirmMemory(target.id, { workspaceId: ws.id }), /Check this note from the main checkout/);
  assert.throws(() => f.store.reaffirmMemory(target.id, {}), /unchanged; there is nothing to check/, 'the main checkout still matches');
});

test('the catch is capped at 20 notes', t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'src', 'big.js'), lines('row', 30)); f.commit('big');
  for (let i = 1; i <= 21; i++) f.note('src/big.js', i, i, { statement: `Row ${i} of big.js is the ${i}th retry setting` });
  const s = f.session(''); writeFileSync(join(f.repo, 'src', 'big.js'), lines('changed', 30)); f.end(s);
  const caught = f.store.staleNotesForSession(s.id);
  assert.equal(caught.notes.length, 20); assert.equal(caught.truncated, true);
});

test('without a snapshot the catch uses live changes; a removed workspace is unavailable', t => {
  const f = fixture(t); const target = f.note('src/a.js', 1, 1);
  const s = f.session(''); writeFileSync(join(f.repo, 'src', 'a.js'), 'x\n');
  assert.deepEqual(f.store.staleNotesForSession(s.id).notes.map(n => n.note.id), [target.id]);
  const ws = f.store.createWorkspace(f.project.id, { branch: 'feature/z', base: 'main' }, join(f.root, 'worktrees'));
  const gone = f.session('', { workspaceId: ws.id }); f.store.removeWorkspace(ws.id);
  assert.deepEqual(f.store.staleNotesForSession(gone.id), { available: false, notes: [], truncated: false });
});

// ----- A6: Still true -----

test('reaffirmMemory adds revision n+1 and remembers it', t => {
  const f = fixture(t); const target = f.note('src/a.js', 3, 5, { environment: 'with Docker running' });
  f.store.setPinned(target.id, true);
  writeFileSync(join(f.repo, 'src', 'a.js'), lines('line', 12).replace('line 4\n', 'line four\n'));
  const before = f.store.getMemory(target.id); const auditBefore = f.store.listAudit(1000).length;
  const result = f.store.reaffirmMemory(target.id, { expectedHash: sha(join(f.repo, 'src', 'a.js')) });
  assert.equal(result.revision, before.revision + 1); assert.equal(result.status, 'active'); assert.equal(result.pinned, true);
  assert.notEqual(result.source.contentHash, before.source.contentHash); assert.equal(result.source.excerpt, 'line 3\nline four\nline 5');
  assert.equal(result.statement, before.statement); assert.equal(result.environment, 'with Docker running');
  const history = f.store.memoryHistory(target.id);
  assert.equal(history.length, before.revision + 1);
  assert.equal(history.find(r => r.revision === before.revision).source.contentHash, before.source.contentHash, 'revision n is intact');
  const audit = f.store.listAudit(1000).slice(auditBefore).filter(a => a.action === 'memory-active');
  assert.deepEqual(audit.map(a => [a.body.via, a.body.revision]), [['reaffirm', before.revision + 1]]);
  assert.equal(f.store.validation(f.store.project(f.project.id), f.store.getMemory(target.id)), 'current');
});

test('reaffirmMemory refuses a current note, another branch and the wrong copy', t => {
  const f = fixture(t); const current = f.note('src/a.js', 1, 2);
  assert.throws(() => f.store.reaffirmMemory(current.id, {}), /unchanged; there is nothing to check/);
  const user = f.store.proposeMemory(f.project.id, { statement: 'Retries use exponential backoff', category: 'convention', scope: 'checkout', area: '', source: { kind: 'user', note: 'n' } });
  assert.throws(() => f.store.reaffirmMemory(user.id, {}), /Only a remembered note based on a file/);
  const ws = f.store.createWorkspace(f.project.id, { branch: 'feature/x', base: 'main' }, join(f.root, 'worktrees'));
  // A branch note on feature/x, remembered in its worktree, then changed there.
  const s = f.session('', { workspaceId: ws.id }); void s;
  const branchNote = f.store.proposeMemory(f.project.id, { statement: 'Feature x keeps its retry table in a.js', category: 'convention', scope: 'branch', area: '',
    source: { kind: 'file', path: 'src/a.js', startLine: 1, endLine: 2 } }, { branch: 'feature/x', view: f.store.view(f.project.id, ws.id) });
  f.store.setMemoryStatus(branchNote.id, 'active');
  writeFileSync(join(ws.path, 'src', 'a.js'), 'changed in the worktree\nsecond\n');
  assert.throws(() => f.store.reaffirmMemory(branchNote.id, { workspaceId: null }), /belongs to branch feature\/x; check out that branch to remember it/);
  assert.throws(() => f.store.reaffirmMemory(branchNote.id, { workspaceId: 'root:x' }), /main checkout/);
  assert.equal(f.store.reaffirmMemory(branchNote.id, { workspaceId: ws.id, expectedHash: sha(join(ws.path, 'src', 'a.js')) }).revision, 2);
  writeFileSync(join(f.repo, 'src', 'a.js'), 'changed in main\n');
  assert.throws(() => f.store.reaffirmMemory(current.id, { workspaceId: ws.id }), /Check this note from the main checkout/);
  assert.equal(f.store.getMemory(current.id).revision, 1);
});

test('reaffirmMemory takes a new line range', t => {
  const f = fixture(t); const target = f.note('src/a.js', 3, 5);
  writeFileSync(join(f.repo, 'src', 'a.js'), lines('header', 10) + lines('line', 40));
  assert.throws(() => f.store.reaffirmMemory(target.id, { startLine: 11, endLine: 41, expectedHash: sha(join(f.repo, 'src', 'a.js')) }), /Select 1–30 existing source lines/);
  assert.equal(f.store.getMemory(target.id).revision, 1);
  const moved = f.store.reaffirmMemory(target.id, { startLine: 13, endLine: 15, expectedHash: sha(join(f.repo, 'src', 'a.js')) });
  assert.equal(moved.source.startLine, 13); assert.equal(moved.source.excerpt, 'line 3\nline 4\nline 5');
});

test('writeMemory refuses a note that changed after it was checked', t => {
  const f = fixture(t); const target = f.note('src/a.js', 1, 2);
  const input = { memoryId: target.id, statement: target.statement, category: target.category, scope: 'checkout', area: '', source: { kind: 'file', path: 'src/a.js', startLine: 1, endLine: 2 } };
  const { item, expected } = f.store.prepareMemory(f.project.id, input);
  f.store.proposeMemory(f.project.id, input);
  const before = f.counts();
  assert.throws(() => f.store.transaction(() => f.store.writeMemory(item, expected)), /changed while you were checking it/);
  assert.deepEqual(f.counts(), before);
});

// ----- Review fixes: windowing, reviewed content, deadlines -----

test('selectHunks windows on the note\'s lines and says when it cut', () => {
  // 100 lines inserted right above a note on old lines 5-6.
  const added = Array.from({ length: 100 }, (_, i) => `+added ${i + 1}`).join('\n');
  const diff = `@@ -2,3 +2,103 @@\n line 2\n line 3\n line 4\n${added}\n line 5\n line 6\n line 7\n`;
  const { hunks, truncated } = selectHunks(parseHunks(diff), 5, 6);
  assert.equal(truncated, true);
  assert.equal(hunks.length, 1); assert.ok(hunks[0].lines.length <= 40);
  const olds = hunks[0].lines.filter(line => line.kind === ' ').map(line => line.old);
  assert.ok(olds.includes(5) && olds.includes(6), 'the note\'s own lines are shown');
  assert.ok(hunks[0].lines.some(line => line.kind === '+' && line.text === 'added 100'), 'the insertion next to them is shown');
  // A small hunk is shown whole.
  const small = selectHunks(parseHunks('@@ -3,3 +3,3 @@\n line 3\n-line 4\n+line four\n line 5\n'), 4, 4);
  assert.equal(small.truncated, false); assert.equal(small.hunks[0].lines.length, 4);
  // More than three matching hunks, and an overlong line, are cut.
  const many = Array.from({ length: 4 }, (_, i) => `@@ -${i * 10 + 1},1 +${i * 10 + 1},1 @@\n-old ${i}\n+new ${i}`).join('\n');
  const four = selectHunks(parseHunks(many), 1, 40);
  assert.equal(four.hunks.length, 3); assert.equal(four.truncated, true);
  const long = selectHunks(parseHunks(`@@ -1,1 +1,1 @@\n-${'x'.repeat(400)}\n+y\n`), 1, 1);
  assert.equal(long.truncated, true); assert.equal(long.hunks[0].lines[0].text.length, 300);
});

test('a big insertion above a note is flagged truncated in the catch', t => {
  const f = fixture(t); const target = f.note('src/a.js', 5, 6);
  const s = f.session('');
  writeFileSync(join(f.repo, 'src', 'a.js'), lines('line', 12).replace('line 4\n', `line 4\n${lines('inserted', 100)}`)); f.end(s);
  const [item] = f.store.staleNotesForSession(s.id).notes;
  assert.equal(item.note.id, target.id); assert.equal(item.truncated, true);
  assert.ok(item.hunks[0].lines.some(line => line.kind === ' ' && line.old === 5));
  const small = fixture(t); small.note('src/a.js', 3, 3);
  const s2 = small.session(''); writeFileSync(join(small.repo, 'src', 'a.js'), lines('line', 12).replace('line 3\n', 'line three\n')); small.end(s2);
  assert.equal(small.store.staleNotesForSession(s2.id).notes[0].truncated, false);
});

test('hunks keep blank context lines and drop carriage returns', t => {
  assert.deepEqual(parseHunks('@@ -1,2 +1,2 @@\n-old\r\n+new\r\n \r\n').flatMap(h => h.lines.map(l => l.text)), ['old', 'new', '']);
  const f = fixture(t);
  writeFileSync(join(f.repo, 'src', 'gap.js'), 'one\n\ntwo\nthree\n'); f.commit('gap');
  f.git('config', 'diff.suppressBlankEmpty', 'true');
  const target = f.note('src/gap.js', 3, 4);
  const s = f.session(''); writeFileSync(join(f.repo, 'src', 'gap.js'), 'one\n\ntwo\nTHREE\n'); f.end(s);
  const [item] = f.store.staleNotesForSession(s.id).notes;
  assert.equal(item.note.id, target.id);
  assert.deepEqual(item.hunks[0].lines.map(l => [l.kind, l.old, l.text]), [[' ', 1, 'one'], [' ', 2, ''], [' ', 3, 'two'], ['-', 4, 'three'], ['+', null, 'THREE']]);
});

test('Still true saves only the content that was shown', t => {
  const f = fixture(t); const target = f.note('src/a.js', 3, 5);
  const s = f.session('');
  writeFileSync(join(f.repo, 'src', 'a.js'), lines('line', 12).replace('line 4\n', 'line four\n')); f.end(s);
  const [item] = f.store.staleNotesForSession(s.id).notes;
  assert.equal(item.contentHash, sha(join(f.repo, 'src', 'a.js')));
  assert.deepEqual(item.shownRange, { startLine: 1, endLine: 7 }, 'new-side lines of the hunk on screen');
  // The agent (or the user) edits the file again after the catch was shown.
  writeFileSync(join(f.repo, 'src', 'a.js'), lines('line', 12).replace('line 4\n', 'line FOUR\n'));
  const before = f.counts();
  assert.throws(() => f.store.reaffirmMemory(target.id, { expectedHash: item.contentHash }), { message: 'The file changed again; check it once more.' });
  assert.throws(() => f.store.reaffirmMemory(target.id, {}), /check the change/i, 'a hash is required');
  assert.deepEqual(f.counts(), before); assert.equal(f.store.getMemory(target.id).revision, 1);
  const again = f.store.staleNotesForSession(s.id).notes[0];
  assert.equal(f.store.reaffirmMemory(target.id, { expectedHash: again.contentHash }).source.excerpt, 'line 3\nline FOUR\nline 5');
});

test('Still true on a replacement does not archive the note it replaced again', t => {
  const f = fixture(t); const old = f.note('src/other.js', 1, 2, { statement: 'Other.js opens with the legacy retry header' });
  const replacement = f.store.proposeMemory(f.project.id, { statement: 'Other.js opens with the new retry header', category: 'convention', scope: 'checkout', area: '',
    source: { kind: 'file', path: 'src/a.js', startLine: 1, endLine: 2 }, supersedes: old.id });
  f.store.setMemoryStatus(replacement.id, 'active');
  assert.equal(f.store.getMemory(old.id).status, 'archived');
  // The user brings the older note back later (restored outside this flow).
  f.store.db.prepare(`UPDATE memories SET status='active' WHERE id=?`).run(old.id);
  writeFileSync(join(f.repo, 'src', 'a.js'), lines('line', 12).replace('line 1\n', 'line one\n'));
  const auditBefore = f.store.listAudit(1000).length;
  const result = f.store.reaffirmMemory(replacement.id, { expectedHash: sha(join(f.repo, 'src', 'a.js')) });
  assert.equal(result.revision, 2); assert.deepEqual(result.supersedes, { id: old.id, revision: old.revision }, 'the record of what it replaced is kept');
  assert.equal(f.store.getMemory(old.id).status, 'active', 'reaffirming is not a second replacement');
  const audit = f.store.listAudit(1000).slice(auditBefore).find(a => a.action === 'memory-active');
  assert.equal(audit.body.supersedes, null);
});

test('a failure inside the remember transaction rolls the whole batch back', t => {
  const f = fixture(t);
  const s = f.session('Do it.\nRule: Release tags must be signed by CI.\nDecision: Payment webhooks retry three times before failing.');
  const ids = f.store.generateProposals(s.id).map(p => p.id);
  const original = f.store.writeMemory; let calls = 0;
  // The second item's note gains a revision after it was checked: writeMemory's revision check fails mid-batch.
  f.store.writeMemory = function (item, expected) { return original.call(this, item, ++calls === 2 ? 'a-revision-written-meanwhile' : expected); };
  t.after(() => { f.store.writeMemory = original; });
  const before = f.counts(); const auditBefore = f.store.listAudit(1000).length;
  assert.throws(() => f.store.rememberProposals(ids, { via: 'wrap-up' }), /changed while you were checking it/);
  assert.equal(calls, 2, 'the first item was written before the failure');
  assert.deepEqual(f.counts(), before);
  assert.equal(f.store.listAudit(1000).length, auditBefore);
  assert.deepEqual(ids.map(id => f.store.getProposal(id).state), ['open', 'open']);
  assert.equal(f.store.db.prepare(`SELECT count(*) AS n FROM memories WHERE status='active'`).get().n, 0);
});

test('approveMemory refuses a note whose revision moved on', t => {
  const f = fixture(t);
  const input = { statement: 'Retries use exponential backoff', category: 'convention', scope: 'checkout', area: '', source: { kind: 'user', note: 'n' } };
  const first = f.store.proposeMemory(f.project.id, input);
  const checked = f.store.getMemory(first.id);
  f.store.proposeMemory(f.project.id, { ...input, memoryId: first.id, statement: 'Retries use linear backoff' });
  const before = f.counts();
  assert.throws(() => f.store.transaction(() => f.store.approveMemory(checked)), /changed while you were checking it/);
  assert.deepEqual(f.counts(), before);
  const now = f.store.getMemory(first.id);
  assert.equal(now.status, 'candidate'); assert.equal(f.store.db.prepare('SELECT approved_at FROM memories WHERE id=?').get(first.id).approved_at, null);
});

test('rememberProposals checks conflicts again inside the lock and within the batch', t => {
  const f = fixture(t);
  const [signed] = f.store.generateProposals(f.session('x\nRule: Release tags must be signed by CI.').id).map(p => p.id);
  // A contradicting note is remembered after the batch was checked, before it is written.
  const original = f.store.transaction;
  f.store.transaction = function (fn) {
    f.store.transaction = original;
    const other = f.store.proposeMemory(f.project.id, { statement: 'Release tags must not be signed by CI.', category: 'convention', scope: 'checkout', area: '', source: { kind: 'user', note: 'n' } });
    f.store.setMemoryStatus(other.id, 'active');
    return original.call(this, fn);
  };
  t.after(() => { f.store.transaction = original; });
  assert.throws(() => f.store.rememberProposals([signed], { via: 'wrap-up' }), /may conflict with a remembered note/);
  assert.equal(f.store.getProposal(signed).state, 'open');
  // Two suggestions in one batch that contradict each other.
  const g = fixture(t);
  const pair = g.store.generateProposals(g.session('x\nRule: Payment webhooks must retry before failing.\nDecision: Payment webhooks must not retry before failing.').id).map(p => p.id);
  assert.equal(pair.length, 2);
  const before = g.counts();
  assert.throws(() => g.store.rememberProposals(pair, { via: 'wrap-up' }), /may contradict another suggestion; remember only one of them/);
  assert.deepEqual(g.counts(), before);
});

test('the catch stops at its deadline when Git is slow', { skip: process.platform === 'win32' && 'a shell-script git stand-in' }, t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'src', 'big.js'), lines('row', 10)); f.commit('big');
  for (let i = 1; i <= 5; i++) f.note('src/big.js', i, i, { statement: `Row ${i} of big.js is the ${i}th retry setting` });
  const s = f.session(''); writeFileSync(join(f.repo, 'src', 'big.js'), lines('changed', 10)); f.end(s);
  assert.equal(f.store.staleNotesForSession(s.id).notes.length, 5, 'all five with a fast Git');
  // A Git that takes 200 ms per call.
  const bin = join(f.root, 'slow-bin'); mkdirSync(bin);
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nsleep 0.2\nexec "${real}" "$@"\n`, { mode: 0o755 });
  const path = process.env.PATH; process.env.PATH = `${bin}:${path}`; t.after(() => { process.env.PATH = path; });
  const started = Date.now();
  const caught = f.store.staleNotesForSession(s.id, { deadlineMs: 300 });
  assert.equal(caught.available, true); assert.equal(caught.truncated, true);
  assert.ok(caught.notes.length < 5, `stopped early (${caught.notes.length} notes)`);
  assert.ok(Date.now() - started < 3000);
});

test('sessionSummary reports changes unavailable without a baseline', t => {
  const f = fixture(t);
  const s = f.session('', { baseline: null });
  writeFileSync(join(f.repo, 'a.txt'), 'changed\n'); const ended = f.end(s);
  assert.equal(ended.changeStats.available, true, 'the runtime still counted against HEAD');
  const { changes } = f.store.sessionSummary(s.id);
  assert.equal(changes.available, false); assert.equal(changes.files, 0); assert.deepEqual(changes.paths, []);
  assert.match(changes.reason, /start/);
  assert.equal(f.store.sessionSummary(f.session('', { baseline: undefined }).id).changes.available, false, 'also with no snapshot');
});
