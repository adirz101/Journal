import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { JournalStore, RECORD_DELIVERIES, RECORD_RECEIPT_DELIVERIES } from '../src/core/store.mjs';
import { ORIGIN_PROPOSALS_SQL } from '../src/core/insights.mjs';
import { removeLater } from './support/cleanup.mjs';

const SESSION_DATE = '2026-09-30T10:00:00.000Z';

function fixture(t) {
  const root = mkdtempSync(resolve(process.env.JOURNAL_TEST_TMP ?? tmpdir(), 'insights-'));
  const repo = resolve(root, 'repo'); mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-b', 'main');
  writeFileSync(resolve(repo, 'tests.md'), 'Integration tests require Docker.\nRun npm test.\n');
  git('add', 'tests.md'); git('-c', 'user.name=Fixture', '-c', 'user.email=test@example.test', 'commit', '-m', 'fixture');
  const path = resolve(root, 'journal.sqlite');
  const f = { root, repo, path, git, store: new JournalStore(path) };
  f.project = f.store.openProject(repo);
  t.after(() => { f.store.close(); removeLater(root); });
  f.note = (statement, extra = {}) => f.store.proposeMemory(f.project.id, { statement, category: 'lesson', scope: 'checkout', area: '', source: { kind: 'user', note: 'Fixture note' }, ...extra });
  f.approve = (statement, extra) => { const m = f.note(statement, extra); f.store.setMemoryStatus(m.id, 'active'); return m; };
  // A launch: persisted receipt, a session naming it, then the delivery state.
  f.deliver = ({ session = randomUUID(), provider = 'codex', nativeId = null, state = 'submitted', query = 'Docker', title = 'Fixture task' } = {}) => {
    const receipt = f.store.prepareContext(f.project.id, query);
    f.store.saveSession({ id: session, projectId: f.project.id, provider, nativeId, receiptId: receipt.id, title, createdAt: SESSION_DATE, status: 'exited' });
    if (state) f.store.updateReceiptState(receipt.id, state, session);
    return { receipt, session };
  };
  f.count = id => f.store.deliveryCounts(f.project.id, [id])[id];
  f.rows = () => f.store.db.prepare('SELECT * FROM deliveries ORDER BY receipt_id, memory_id').all();
  return f;
}

// Distinct conversations per note, straight from the receipts (not the deliveries table).
function onDemandCounts(db) {
  const seen = new Map();
  const rows = db.prepare(`SELECT r.id, r.body FROM receipts r WHERE json_extract(r.body,'$.state') IN ('submitted','uncertain')`).all();
  for (const row of rows) {
    const receipt = JSON.parse(row.body);
    const sessionRow = db.prepare(`SELECT body FROM sessions WHERE id=? OR json_extract(body,'$.receiptId')=? LIMIT 1`).get(receipt.sessionId ?? '', row.id);
    const session = sessionRow ? JSON.parse(sessionRow.body) : null;
    const key = session?.nativeId ? `${session.provider}:${session.nativeId}` : session ? `session:${session.id}` : `receipt:${row.id}`;
    for (const item of receipt.items ?? []) { if (!seen.has(item.id)) seen.set(item.id, new Set()); seen.get(item.id).add(key); }
  }
  return Object.fromEntries([...seen].map(([id, keys]) => [id, keys.size]));
}

test('migration v8 from a v7 database file backfills approvals and deliveries', t => {
  const f = fixture(t);
  const a = f.approve('Integration tests require Docker', { category: 'constraint', source: { kind: 'file', path: 'tests.md', startLine: 1, endLine: 1 } });
  const b = f.approve('Docker images build with buildx');
  f.note('Docker images build with buildx and a shared cache', { memoryId: b.id }); f.store.setMemoryStatus(b.id, 'active');
  const c = f.note('Docker compose is optional for unit tests');
  f.deliver({ nativeId: '11111111-1111-4111-8111-111111111111' });
  f.deliver({ state: 'uncertain' });
  const third = f.deliver({ provider: 'claude', nativeId: '33333333-3333-4333-8333-333333333333' }); f.store.updateReceiptState(third.receipt.id, 'uncertain', third.session);
  f.deliver({ state: 'failed' });
  f.deliver({ state: null });
  const legacy = randomUUID();
  f.store.db.prepare('INSERT INTO receipts(id,project_id,body) VALUES(?,?,?)').run(legacy, f.project.id, JSON.stringify({ id: legacy, projectId: f.project.id, state: 'prepared', items: [{ id: a.id, revision: 1 }], createdAt: SESSION_DATE }));
  f.store.close();

  const raw = new DatabaseSync(f.path);
  raw.exec(`DROP TABLE deliveries; DROP INDEX proposals_memory; DROP INDEX proposals_session;
    ALTER TABLE memories DROP COLUMN approved_at; ALTER TABLE memories DROP COLUMN approved_revision; PRAGMA user_version=7;`);
  raw.close();

  f.store = new JournalStore(f.path);
  const db = f.store.db;
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8);
  const expected = db.prepare(`SELECT count(*) AS n FROM receipts r, json_each(r.body,'$.items') WHERE json_extract(r.body,'$.state') IN ('submitted','uncertain')`).get().n;
  assert.equal(expected, 6); assert.equal(f.rows().length, expected);
  const onDemand = onDemandCounts(db);
  assert.deepEqual(f.store.deliveryCounts(f.project.id, [a.id, b.id, c.id]), { [a.id]: onDemand[a.id], [b.id]: onDemand[b.id], [c.id]: 0 });
  assert.equal(onDemand[a.id], 3);
  const approvals = f.store.listAudit().filter(row => row.action === 'memory-active');
  for (const note of [a, b]) {
    const last = approvals.filter(row => row.body.id === note.id).at(-1);
    assert.deepEqual({ ...db.prepare('SELECT approved_at, approved_revision FROM memories WHERE id=?').get(note.id) }, { approved_at: last.at, approved_revision: last.body.revision });
  }
  assert.equal(db.prepare('SELECT approved_revision FROM memories WHERE id=?').get(b.id).approved_revision, 2);
  assert.deepEqual({ ...db.prepare('SELECT approved_at, approved_revision FROM memories WHERE id=?').get(c.id) }, { approved_at: null, approved_revision: null });
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${ORIGIN_PROPOSALS_SQL}`).all(f.project.id, JSON.stringify([a.id])).map(row => row.detail).join('\n');
  assert.match(plan, /proposals_memory/);

  f.store.close(); f.store = new JournalStore(f.path);
  assert.equal(f.rows().length, expected, 'Reopening is a no-op');
  assert.equal(f.store.db.prepare('PRAGMA user_version').get().user_version, 8);
});

test('migration v8 tolerates a database whose version was lowered after the columns were added', t => {
  const f = fixture(t); f.approve('Docker runs the integration suite'); f.deliver();
  f.store.close();
  const raw = new DatabaseSync(f.path); raw.exec('PRAGMA user_version=7'); raw.close();
  f.store = new JournalStore(f.path);
  assert.equal(f.store.db.prepare('PRAGMA user_version').get().user_version, 8);
  assert.equal(f.rows().length, 1);
});

test('deliveries: previews and failed launches are not counted', t => {
  const f = fixture(t); const note = f.approve('Docker runs the integration suite');
  f.store.prepareContext(f.project.id, 'Docker', { persist: false });
  assert.equal(f.rows().length, 0);
  f.deliver({ state: 'failed' }); assert.equal(f.rows().length, 0);
  f.deliver({ state: null }); assert.equal(f.rows().length, 0);
  assert.equal(f.count(note.id), 0);
  const { receipt, session } = f.deliver();
  assert.equal(f.rows().length, 1); assert.equal(f.count(note.id), 1);
  const deliveredAt = f.store.getReceipt(receipt.id).updatedAt;
  f.store.updateReceiptState(receipt.id, 'uncertain', session);
  assert.equal(f.rows().length, 1); assert.equal(f.count(note.id), 1);
  const [row] = f.rows();
  assert.deepEqual([row.session_id, row.provider, row.revision, row.project_id], [session, 'codex', 1, f.project.id]);
  assert.equal(row.at, deliveredAt, 'The first delivery time is kept');
});

test('deliveries: recovering an interrupted launch records the delivery once', t => {
  const f = fixture(t); const note = f.approve('Docker runs the integration suite');
  const receipt = f.store.prepareContext(f.project.id, 'Docker');
  f.store.saveSession({ id: 'running', projectId: f.project.id, provider: 'claude', receiptId: receipt.id, createdAt: SESSION_DATE, status: 'running' });
  f.store.recoverSessions();
  assert.equal(f.store.getReceipt(receipt.id).state, 'uncertain');
  assert.equal(f.count(note.id), 1);
});

test('deliveries: a resume chain counts once', t => {
  const f = fixture(t); const note = f.approve('Docker runs the integration suite');
  const native = '22222222-2222-4222-8222-222222222222';
  f.deliver({ nativeId: native }); f.deliver({ nativeId: native });
  assert.equal(f.count(note.id), 1);
  f.deliver({ nativeId: '44444444-4444-4444-8444-444444444444' }); assert.equal(f.count(note.id), 2);
  f.deliver(); f.deliver(); assert.equal(f.count(note.id), 4, 'Sessions without native IDs count separately');
  const late = '55555555-5555-4555-8555-555555555555';
  f.deliver({ nativeId: late }); assert.equal(f.count(note.id), 5);
  const { session } = f.deliver();
  assert.equal(f.count(note.id), 6);
  f.store.saveSession({ ...f.store.getSession(session), nativeId: late });
  assert.equal(f.count(note.id), 5, 'A native ID learned after delivery joins its conversation');
});

test('deliveries: one note counts across its revisions', t => {
  const f = fixture(t); const note = f.approve('Docker runs the integration suite');
  f.deliver();
  f.note('Docker runs the integration suite and the smoke tests', { memoryId: note.id }); f.store.setMemoryStatus(note.id, 'active');
  f.deliver();
  assert.equal(f.count(note.id), 2);
  assert.deepEqual(f.rows().map(row => row.revision).sort(), [1, 2]);
});

test('memoryOrigins: every kind', t => {
  const f = fixture(t);
  const manual = f.approve('Docker runs the integration suite');
  const file = f.note('Integration tests need Docker', { source: { kind: 'file', path: 'tests.md', startLine: 1, endLine: 1 } });
  const head = f.git('rev-parse', 'HEAD').toString().trim();
  const draft = f.note('Status: fixture ready', { category: 'brief', scope: 'branch', source: { kind: 'git', base: null } });
  f.store.importBrain(f.project.id, JSON.stringify(exported(f)));
  const imported = f.store.listMemoryPage(f.project.id, { search: 'imported rule' }).items[0];
  const branchNote = f.approve('Feature flags live in flags.ts', { scope: 'branch' });
  const promoted = f.store.proposePromotion(branchNote.id);

  // A session note: "rule:" in the task → suggestion → Add for review → Remember.
  const { session } = f.deliver({ provider: 'claude', query: 'rule: Integration tests always need Docker running', title: 'Docker task' });
  const [proposal] = f.store.generateProposals(session);
  const fromSession = f.store.acceptProposal(proposal.id); f.store.setMemoryStatus(fromSession.id, 'active');

  const ids = [manual.id, file.id, draft.id, imported.id, promoted.id, fromSession.id];
  const origins = f.store.memoryOrigins(f.project.id, ids);
  assert.deepEqual(Object.keys(origins).sort(), [...ids].sort());
  assert.equal(origins[manual.id].kind, 'manual'); assert.equal(origins[manual.id].createdAt, manual.createdAt);
  assert.ok(origins[manual.id].approvedAt); assert.equal(origins[manual.id].approvedRevision, 1);
  assert.equal(origins[file.id].kind, 'manual'); assert.equal(origins[file.id].approvedAt, null);
  assert.deepEqual([origins[draft.id].kind, origins[draft.id].git], ['git', { base: null, head }]);
  assert.equal(origins[imported.id].kind, 'import');
  assert.deepEqual([origins[promoted.id].kind, origins[promoted.id].promotedFrom], ['promoted', { branch: 'main' }]);
  assert.deepEqual(origins[fromSession.id].session, { id: session, title: 'Docker task', provider: 'claude', date: '2026-09-30', state: 'present' });
  assert.equal(origins[fromSession.id].kind, 'session'); assert.ok(origins[fromSession.id].approvedAt);

  // A branch brief approved while a branch-status suggestion is open stays a Git draft.
  f.store.db.prepare('INSERT INTO proposals(id,project_id,fingerprint,body) VALUES(?,?,?,?)').run('status-1', f.project.id, 'status-fp',
    JSON.stringify({ id: 'status-1', projectId: f.project.id, kind: 'branch-status', branch: 'main', state: 'open', evidence: { sessionId: session }, createdAt: SESSION_DATE }));
  f.store.setMemoryStatus(draft.id, 'active');
  assert.equal(f.store.getProposal('status-1').memoryId, draft.id);
  assert.equal(f.store.memoryOrigins(f.project.id, [draft.id])[draft.id].kind, 'git');
});

function exported(f) {
  // A one-note export from a throwaway store, so the import has a valid checksum.
  const other = new JournalStore(':memory:'); const project = other.openProject(f.repo);
  const note = other.proposeMemory(project.id, { statement: 'An imported rule about caching', category: 'constraint', scope: 'checkout', area: '', source: { kind: 'user', note: 'Elsewhere' } });
  other.setMemoryStatus(note.id, 'active');
  try { return other.exportBrain(project.id).json; } finally { other.close(); }
}

function sessionNote(f, { provider = 'codex', title = 'Task with a secret title' } = {}) {
  const { session } = f.deliver({ provider, query: 'rule: Integration tests always need Docker running', title });
  const [proposal] = f.store.generateProposals(session);
  const note = f.store.acceptProposal(proposal.id); f.store.setMemoryStatus(note.id, 'active');
  return { session, note, proposal };
}

test('memoryOrigins: removed and purged sessions', t => {
  const f = fixture(t);
  const removed = sessionNote(f);
  f.store.removeSession(removed.session);
  assert.deepEqual(f.store.memoryOrigins(f.project.id, [removed.note.id])[removed.note.id].session, { id: null, title: null, provider: 'codex', date: '2026-09-30', state: 'removed' });
  f.store.purgeSession(removed.session);
  const purged = f.store.memoryOrigins(f.project.id, [removed.note.id])[removed.note.id];
  assert.equal(purged.kind, 'session');
  assert.deepEqual(purged.session, { id: null, title: null, provider: 'codex', date: '2026-09-30', state: 'purged' });
  assert.doesNotMatch(JSON.stringify(f.store.getProposal(removed.proposal.id)), /secret title/);

  // Rows purged before Phase 5 have neither field: parse the note.
  f.store.db.prepare(`UPDATE proposals SET body=json_remove(body,'$.evidence.provider','$.evidence.sessionDate')`).run();
  assert.deepEqual(f.store.memoryOrigins(f.project.id, [removed.note.id])[removed.note.id].session, { id: null, title: null, provider: 'codex', date: '2026-09-30', state: 'purged' });
  f.store.db.prepare(`UPDATE proposals SET body=json_set(body,'$.source.note','Stated as "rule:" in the task of a gemini session on 2026-01-02.') WHERE id=?`).run(removed.proposal.id);
  assert.deepEqual(f.store.memoryOrigins(f.project.id, [removed.note.id])[removed.note.id].session, { id: null, title: null, provider: null, date: '2026-01-02', state: 'purged' });

  // A test-command suggestion: the provider and date come from its statement.
  const receipt = f.store.prepareContext(f.project.id, 'Run the tests');
  f.store.saveSession({ id: 'tests', projectId: f.project.id, provider: 'claude', receiptId: receipt.id, branch: 'main', createdAt: SESSION_DATE, status: 'exited' });
  f.store.updateReceiptState(receipt.id, 'submitted', 'tests');
  f.store.appendEvent('tests', 'command-start', { toolUseId: 't1', test: true, command: 'npm test' });
  f.store.appendEvent('tests', 'command-end', { toolUseId: 't1', status: 'succeeded' });
  const command = f.store.generateProposals('tests').find(p => p.kind === 'test-command');
  const commandNote = f.store.acceptProposal(command.id);
  f.store.purgeSession('tests');
  f.store.db.prepare(`UPDATE proposals SET body=json_remove(body,'$.evidence.provider','$.evidence.sessionDate') WHERE id=?`).run(command.id);
  const origin = f.store.memoryOrigins(f.project.id, [commandNote.id])[commandNote.id];
  assert.equal(origin.kind, 'session'); assert.equal(origin.session.provider, 'claude'); assert.match(origin.session.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(origin.session.state, 'purged');
});

test('memoryOrigins: a revised note keeps its revision-1 origin', t => {
  const f = fixture(t); const { session, note } = sessionNote(f);
  f.note('Integration tests always need Docker running locally', { memoryId: note.id }); f.store.setMemoryStatus(note.id, 'active');
  f.note('Integration tests always need Docker running locally or in CI', { memoryId: note.id }); f.store.setMemoryStatus(note.id, 'active');
  const origin = f.store.memoryOrigins(f.project.id, [note.id])[note.id];
  assert.equal(origin.kind, 'session'); assert.equal(origin.session.id, session); assert.equal(origin.approvedRevision, 3);
});

test('memoryOrigins and deliveryCounts validate input and scope', t => {
  const f = fixture(t); const note = f.approve('Docker runs the integration suite');
  const otherRepo = resolve(f.root, 'other'); mkdirSync(otherRepo); execFileSync('git', ['init', '-q', '-b', 'main', otherRepo]);
  const other = f.store.openProject(otherRepo);
  const foreign = f.store.proposeMemory(other.id, { statement: 'Another project note', category: 'lesson', scope: 'checkout', area: '', source: { kind: 'user', note: 'x' } });
  const many = Array.from({ length: 201 }, (_, i) => `id-${i}`);
  for (const call of ['memoryOrigins', 'deliveryCounts']) {
    for (const bad of [many, [1], [], 'x', ['a', 'a'], ['x'.repeat(101)]]) assert.throws(() => f.store[call](f.project.id, bad), /Invalid note list/);
  }
  assert.throws(() => f.store.memoryOrigins('nope', [note.id]), /Unknown project/);
  assert.deepEqual(Object.keys(f.store.memoryOrigins(f.project.id, [note.id, foreign.id, 'unknown'])), [note.id]);
  assert.deepEqual(f.store.deliveryCounts(f.project.id, [note.id, foreign.id, 'unknown']), { [note.id]: 0, unknown: 0 });
});

test('memoryChecks: chunks and a changed file', t => {
  const f = fixture(t);
  const file = f.note('Integration tests need Docker', { source: { kind: 'file', path: 'tests.md', startLine: 1, endLine: 1 } });
  for (let i = 0; i < 59; i += 1) f.note(`Fixture lesson number ${i} about caching`);
  f.store.db.prepare(`UPDATE memories SET status='archived' WHERE id=?`).run(f.note('An archived lesson about queues').id);
  const first = f.store.memoryChecks(f.project.id, { offset: 0, limit: 50 });
  assert.deepEqual([first.offset, first.checked, first.total, first.stale], [0, 50, 60, []]);
  const second = f.store.memoryChecks(f.project.id, { offset: 50, limit: 50 });
  assert.deepEqual([second.checked, second.total], [10, 60]);
  writeFileSync(resolve(f.repo, 'tests.md'), 'Integration tests no longer need Docker.\nRun npm test.\n');
  const all = [...f.store.memoryChecks(f.project.id, {}).stale, ...f.store.memoryChecks(f.project.id, { offset: 50 }).stale];
  assert.deepEqual(all, [file.id]);
  assert.throws(() => f.store.memoryChecks(f.project.id, { limit: 51 }), /Invalid page/);
  assert.throws(() => f.store.memoryChecks(f.project.id, { offset: -1 }), /Invalid page/);
});

test('setMemoryStatus records the approval time', t => {
  const f = fixture(t); const note = f.note('Docker runs the integration suite');
  const read = () => ({ ...f.store.db.prepare('SELECT approved_at, approved_revision FROM memories WHERE id=?').get(note.id) });
  assert.deepEqual(read(), { approved_at: null, approved_revision: null });
  f.store.setMemoryStatus(note.id, 'active');
  const approved = read(); assert.match(approved.approved_at, /^\d{4}-/); assert.equal(approved.approved_revision, 1);
  f.store.setMemoryStatus(note.id, 'archived');
  assert.deepEqual(read(), approved);
  assert.equal(f.store.memoryOrigins(f.project.id, [note.id])[note.id].approvedAt, approved.approved_at);
});

test('deliveries: a launch records through the receipts primary key; the backfill stays unfiltered', t => {
  const f = fixture(t);
  const plan = (sql, ...args) => f.store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row => row.detail);
  const perLaunch = plan(RECORD_RECEIPT_DELIVERIES, 'receipt-id');
  assert.ok(perLaunch.some(detail => /^SEARCH r USING (?:INDEX sqlite_autoindex_receipts_1|PRIMARY KEY) \(id=\?\)/.test(detail)), perLaunch.join('\n'));
  assert.ok(!perLaunch.some(detail => /^SCAN r\b/.test(detail)), perLaunch.join('\n'));
  assert.ok(plan(RECORD_DELIVERIES).some(detail => /^SCAN r\b/.test(detail)));
  // And it still records exactly that launch.
  f.approve('Docker runs the integration suite');
  const other = f.deliver({ state: null }); const { receipt } = f.deliver();
  assert.deepEqual(f.rows().map(row => row.receipt_id), [receipt.id]);
  assert.equal(f.store.getReceipt(other.receipt.id).state, 'prepared');
});

test('deliveryCounts: a delivery without a provider still counts its conversation', t => {
  const f = fixture(t); const note = f.approve('Docker runs the integration suite');
  const insert = f.store.db.prepare('INSERT INTO deliveries(receipt_id, memory_id, revision, project_id, session_id, provider, native_id, at) VALUES(?,?,?,?,?,?,?,?)');
  insert.run('r1', note.id, 1, f.project.id, null, null, 'native-1', SESSION_DATE);
  insert.run('r2', note.id, 1, f.project.id, null, null, 'native-2', SESSION_DATE);
  insert.run('r3', note.id, 1, f.project.id, null, null, 'native-2', SESSION_DATE);
  assert.equal(f.count(note.id), 2);
});

test('memoryOrigins: a purged suggestion with a null provider reads the note text', t => {
  const f = fixture(t); const { session, note, proposal } = sessionNote(f);
  f.store.purgeSession(session);
  f.store.db.prepare(`UPDATE proposals SET body=json_set(body,'$.evidence.provider',json('null')) WHERE id=?`).run(proposal.id);
  assert.equal(f.store.memoryOrigins(f.project.id, [note.id])[note.id].session.provider, 'codex');
});

test('memoryOrigins: the earliest handled suggestion defines the origin; one without handledAt never wins', t => {
  const f = fixture(t); const { session, note, proposal } = sessionNote(f, { title: 'First task' });
  const body = { ...f.store.getProposal(proposal.id), id: 'late', fingerprint: 'late-fp', evidence: { ...f.store.getProposal(proposal.id).evidence, sessionId: 'another-session' } };
  delete body.handledAt;
  f.store.db.prepare('INSERT INTO proposals(id,project_id,fingerprint,body) VALUES(?,?,?,?)').run('late', f.project.id, 'late-fp', JSON.stringify(body));
  assert.equal(f.store.memoryOrigins(f.project.id, [note.id])[note.id].session.id, session);
  f.store.db.prepare(`UPDATE proposals SET body=json_set(body,'$.handledAt','') WHERE id='late'`).run();
  assert.equal(f.store.memoryOrigins(f.project.id, [note.id])[note.id].session.id, session);
});

test('listMemoryPage: categoryCounts ignores categories named like object properties', t => {
  const f = fixture(t); const note = f.approve('Docker runs the integration suite');
  f.store.db.prepare(`UPDATE revisions SET body=json_set(body,'$.category','toString') WHERE memory_id=?`).run(note.id);
  const { categoryCounts } = f.store.listMemoryPage(f.project.id, {});
  assert.deepEqual(Object.keys(categoryCounts), ['all', 'brief', 'decision', 'constraint', 'convention', 'lesson', 'issue']);
  assert.equal(categoryCounts.all, 1); assert.equal(categoryCounts.lesson, 0);
});
