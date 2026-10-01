import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { JournalStore } from '../src/core/store.mjs';
import { aliasesFor, areaMatches, identifierParts, possibleConflict, queryTerms } from '../src/core/retrieval.mjs';
import { checkoutBaseline, sessionChanges, fileDiff } from '../src/core/changes.mjs';

function fixture(t) {
  const root = mkdtempSync(join(process.env.JOURNAL_TEST_TMP ?? tmpdir(), 'retrieval-'));
  const repo = join(root, 'repo'); mkdirSync(join(repo, 'src/payments'), { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'src/payments/retry.mjs'), 'export const retry = 1;\n');
  writeFileSync(join(repo, 'README.md'), 'Fixture\n');
  git('add', '.'); git('-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'init');
  const path = join(root, 'journal.sqlite'); const store = new JournalStore(path); const project = store.openProject(repo);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const approve = (statement, extra = {}) => { const m = store.proposeMemory(project.id, { statement, category: 'constraint', scope: 'checkout', area: '', source: { kind: 'user', note: 'Fixture rule' }, ...extra }); store.setMemoryStatus(m.id, 'active'); return m; };
  return { root, repo, git, store, project, approve, path };
}

test('identifiers and paths are split into searchable aliases', () => {
  assert.deepEqual(identifierParts('readTable jsonStore.mjs HTTPServer snake_case'), ['read', 'table', 'json', 'store', 'mjs', 'http', 'server', 'snake', 'case']);
  assert.match(aliasesFor({ statement: 'Use readTable from src/storage/jsonStore.mjs', area: 'src/storage', source: { kind: 'file', path: 'src/storage/jsonStore.mjs' } }), /read table.*json store|json.*store/);
  assert.deepEqual(queryTerms('Fix the payment retries in createRefund'), ['payment', 'retries', 'createrefund', 'create', 'refund']);
});

test('task words that never name a path still find stemmed, identifier and area matches', t => {
  const f = fixture(t);
  const retry = f.approve('Payment retries must reuse the idempotency key.', { area: 'src/payments' });
  const table = f.approve('Persist rows with readTable/writeTable from src/storage/jsonStore.mjs.');
  const ids = query => f.store.prepareContext(f.project.id, query).items.map(item => item.id);
  assert.deepEqual(ids('retrying a failed payment'), [retry.id], 'stemming plus area segment');
  assert.ok(ids('where do we write a table').includes(table.id), 'identifier alias');
  assert.ok(ids('json store cleanup').includes(table.id), 'filename alias');
  assert.deepEqual(ids('marketing copy'), []);
  assert.ok(areaMatches('src/payments', 'touch src/payments/retry.mjs'));
  assert.ok(!areaMatches('src/payments', 'update the shipping page'));
  assert.ok(!areaMatches('src/lib', 'library code'), 'generic segments never match on their own');
});

test('duplicate claims are delivered once and the duplicate is disclosed', t => {
  const f = fixture(t);
  const first = f.approve('Integration tests require Docker running locally.');
  const copy = f.approve('Integration tests require docker running locally!');
  const receipt = f.store.prepareContext(f.project.id, 'docker integration tests');
    assert.equal(receipt.items.length, 1);
  assert.ok(receipt.excluded.some(x => x.reason === 'duplicate' && [first.id, copy.id].includes(x.id)));
});

test('possible conflicts are flagged for review and warned about at delivery', t => {
  const f = fixture(t);
  const always = f.approve('Always run database migrations on startup.');
  const candidate = f.store.proposeMemory(f.project.id, { statement: 'Never run database migrations on startup; run them manually.', category: 'decision', scope: 'checkout', area: '', source: { kind: 'user', note: 'Ops decision' } });
  assert.deepEqual(candidate.conflicts.map(c => c.id), [always.id]);
  assert.equal(f.store.getMemory(candidate.id).status, 'candidate', 'Flags never block or auto-reject');
  f.store.setMemoryStatus(candidate.id, 'active');
  const receipt = f.store.prepareContext(f.project.id, 'database migrations startup');
  assert.equal(receipt.items.length, 2); assert.ok(receipt.warnings.some(w => /may conflict/.test(w)));
  assert.ok(possibleConflict('Retry at most 3 times.', 'Retry at most 5 times.'));
  assert.ok(!possibleConflict('Retry at most 3 times.', 'Cache images for one hour.'));
  const three = f.approve('Retry payment calls at most 3 times.'); const five = f.approve('Retry payment calls at most 5 times.');
  const packet = f.store.prepareContext(f.project.id, 'payment retry calls');
  assert.ok([three.id, five.id].every(id => packet.items.some(i => i.id === id)), 'Different numbers are not duplicates');
});

test('knowledge pages are bounded, filterable and searchable', t => {
  const f = fixture(t);
  for (let i = 0; i < 7; i++) f.approve(`Rule ${i} about area${i} configuration value ${i * 13}`);
  f.store.proposeMemory(f.project.id, { statement: 'Pending rule for review', category: 'lesson', scope: 'checkout', area: '', source: { kind: 'user', note: 'x' } });
  const first = f.store.listMemoryPage(f.project.id, { limit: 3 });
  assert.equal(first.items.length, 3); assert.equal(first.total, 8); assert.equal(first.counts.candidate, 1);
  const second = f.store.listMemoryPage(f.project.id, { offset: 3, limit: 3 });
  assert.equal(new Set([...first.items, ...second.items].map(i => i.id)).size, 6);
  assert.equal(f.store.listMemoryPage(f.project.id, { filter: 'review' }).total, 1);
  assert.equal(f.store.listMemoryPage(f.project.id, { search: 'area4' }).total, 1);
  assert.throws(() => f.store.listMemoryPage(f.project.id, { limit: 1000 }), /page/);
});

test('a version 1 database migrates in place and keeps knowledge searchable', t => {
  const root = mkdtempSync(join(tmpdir(), 'migrate-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'); mkdirSync(repo); execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  const path = join(root, 'old.sqlite'); const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY, root TEXT UNIQUE NOT NULL, body TEXT NOT NULL);
    CREATE TABLE memories(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, current_revision TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE revisions(id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, number INTEGER NOT NULL, body TEXT NOT NULL, UNIQUE(memory_id,number));
    CREATE VIRTUAL TABLE memory_fts USING fts5(revision_id UNINDEXED, statement, tokenize='unicode61');
    CREATE TABLE receipts(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE sessions(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, body TEXT NOT NULL); PRAGMA user_version=1;`);
  old.close();
  const store = new JournalStore(path); const project = store.openProject(repo);
  // Reopen the old file as v1, insert a memory with the old schema, then migrate again from scratch.
  store.close(); const raw = new DatabaseSync(path);
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 3);
  raw.close();
  const reopened = new JournalStore(path); t.after(() => reopened.close());
  const memory = reopened.proposeMemory(project.id, { statement: 'Payments retry with backoff', category: 'lesson', scope: 'checkout', area: '', source: { kind: 'user', note: 'x' } });
  reopened.setMemoryStatus(memory.id, 'active');
  assert.equal(reopened.prepareContext(project.id, 'payment retrying').items[0]?.id, memory.id);
  reopened.appendEvent('s1', 'start', {}); assert.throws(() => reopened.appendEvent('s1', 'made-up', {}), /event kind/);
});

test('session changes compare with the starting commit and label pre-existing edits', t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'README.md'), 'Fixture edited before the session\n');
  const project = f.store.project(f.project.id);
  const session = { head: project.head, baseline: checkoutBaseline(project) };
  assert.deepEqual(session.baseline.dirty, ['README.md']);
  writeFileSync(join(f.repo, 'src/payments/retry.mjs'), 'export const retry = 2;\nexport const extra = true;\n');
  writeFileSync(join(f.repo, 'NEW.md'), 'one\ntwo\n'); writeFileSync(join(f.repo, '.env'), 'SECRET=1\n');
  f.git('add', 'src'); f.git('-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'agent commit');
  const changes = sessionChanges(f.store.project(f.project.id), session);
  const byPath = Object.fromEntries(changes.files.map(file => [file.path, file]));
  assert.equal(changes.commitsSince, 1); assert.equal(changes.headMoved, true);
  assert.deepEqual([byPath['src/payments/retry.mjs'].additions, byPath['src/payments/retry.mjs'].deletions], [2, 1]);
  assert.equal(byPath['README.md'].preexisting, true); assert.equal(byPath['NEW.md'].untracked, true); assert.equal(byPath['NEW.md'].additions, 2);
  assert.equal(byPath['.env'].sensitive, true);
  assert.equal(fileDiff(f.store.project(f.project.id), session, '.env').hidden, true);
  assert.match(fileDiff(f.store.project(f.project.id), session, 'src/payments/retry.mjs').text, /\+export const extra = true;/);
  assert.match(fileDiff(f.store.project(f.project.id), session, 'NEW.md').text, /^\+one/);
  assert.throws(() => fileDiff(f.store.project(f.project.id), session, '../outside'), /relative path/);
  assert.equal(sessionChanges(f.store.project(f.project.id), { head: 'f'.repeat(40) }).available, false);
});
