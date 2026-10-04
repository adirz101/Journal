import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { JournalStore } from '../src/core/store.mjs';
import { restore } from '../scripts/data-restore.mjs';
import { createHash } from 'node:crypto';
import { removeLater } from './support/cleanup.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'maint-')); const repo = join(root, 'repo'); mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]); writeFileSync(join(repo, 'README.md'), 'Fixture readme line\n');
  execFileSync('git', ['-C', repo, 'add', '.']); execFileSync('git', ['-C', repo, '-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'init']);
  const data = join(root, 'data'); mkdirSync(data);
  const store = new JournalStore(join(data, 'journal.sqlite')); const project = store.openProject(repo);
  t.after(() => { try { store.close(); } catch {} removeLater(root); });
  const approve = (statement, extra = {}) => { const m = store.proposeMemory(project.id, { statement, category: 'constraint', scope: 'checkout', area: '', source: { kind: 'user', note: 'Team rule' }, ...extra }); store.setMemoryStatus(m.id, 'active'); return m; };
  return { root, repo, data, store, project, approve };
}

test('an online backup passes an integrity check and restores without deleting the current data', async t => {
  const f = fixture(t); f.approve('Deploy only from tagged commits.');
  const target = join(f.root, 'backup.sqlite');
  const result = await f.store.backup(target);
  assert.equal(result.integrity, 'ok'); assert.ok(result.bytes > 0);
  await assert.rejects(f.store.backup('relative.sqlite'), /absolute/);
  f.approve('A later rule that the restore removes.');
  writeFileSync(join(f.data, 'runtime.lock'), JSON.stringify({ pid: process.pid }));
  assert.throws(() => restore(target, f.data), /Quit Journal/);
  writeFileSync(join(f.data, 'runtime.lock'), JSON.stringify({ pid: 999999 }));
  f.store.close();
  const restored = restore(target, f.data, { alive: () => false });
  assert.ok(existsSync(restored.previous), 'The previous database is kept');
  const reopened = new JournalStore(join(f.data, 'journal.sqlite')); t.after(() => reopened.close());
  assert.deepEqual(reopened.listMemories(f.project.id).map(m => m.statement), ['Deploy only from tagged commits.']);
  writeFileSync(join(f.root, 'broken.sqlite'), 'not a database');
  assert.throws(() => restore(join(f.root, 'broken.sqlite'), f.data, { alive: () => false }));
});

test('a full disk produces a clear error and keeps earlier data', t => {
  const f = fixture(t); const kept = f.approve('Rule that must survive the full disk.');
  const pages = f.store.db.prepare('PRAGMA page_count').get().page_count;
  f.store.db.exec(`PRAGMA max_page_count=${pages}`);
  assert.throws(() => { for (let i = 0; i < 200; i++) f.approve(`Filler rule ${i} ${'x'.repeat(1500)}`); }, /full/i);
  assert.equal(f.store.getMemory(kept.id).status, 'active');
  const info = f.store.storageInfo(); assert.ok(info.database > 0); assert.equal(typeof info.tables.memories, 'number');
});

test('Brain export is versioned, checksummed and redacted; import quarantines claims as candidates', async t => {
  const f = fixture(t);
  f.approve('Payments use idempotency keys on retries.', { environment: 'production only' });
  const fileClaim = f.store.proposeMemory(f.project.id, { statement: 'The README names the fixture.', category: 'convention', scope: 'checkout', area: 'docs', source: { kind: 'file', path: 'README.md', startLine: 1, endLine: 1 } });
  f.store.setMemoryStatus(fileClaim.id, 'active');
  const { json, markdown } = f.store.exportBrain(f.project.id);
  assert.equal(json.format, 'journal-brain'); assert.equal(json.memories.length, 2); assert.match(markdown, /Payments use idempotency keys/);
  assert.ok(!JSON.stringify(json).includes('sessions'), 'No session or terminal data');
  const other = fixture(t); const raw = JSON.stringify(json);
  const result = other.store.importBrain(other.project.id, raw);
  assert.equal(result.imported, 2);
  const imported = other.store.listMemories(other.project.id);
  assert.ok(imported.every(m => m.status === 'candidate' && m.source.kind === 'import'), 'Imported claims are never trusted automatically');
  assert.match(imported.find(m => m.area === 'docs').source.note, /README\.md:1/);
  assert.equal(other.store.prepareContext(other.project.id, 'payments retries').items.length, 0);
  assert.equal(other.store.importBrain(other.project.id, raw).skipped.filter(s => s.reason === 'duplicate').length, 2, 'Re-importing is idempotent');
  const tampered = JSON.parse(raw); tampered.memories[0].revisions[0].statement = 'changed';
  assert.throws(() => other.store.importBrain(other.project.id, JSON.stringify(tampered)), /Checksum/);
  assert.throws(() => other.store.importBrain(other.project.id, 'x'.repeat(5 * 1024 * 1024 + 1)), /5 MiB/);
  assert.throws(() => other.store.importBrain(other.project.id, '{"format":"other"}'), /Not a Journal/);
});

test('malicious imports cannot traverse paths, smuggle secrets or invalid scopes', t => {
  const f = fixture(t);
  const memories = [
    { id: 'a', status: 'active', revisions: [{ revision: 1, statement: 'Escape area', category: 'lesson', scope: 'checkout', area: '../../etc', source: { kind: 'user', note: 'x' } }] },
    { id: 'b', status: 'active', revisions: [{ revision: 1, statement: 'Use password=hunter22 everywhere', category: 'lesson', scope: 'checkout', area: '', source: { kind: 'user', note: 'x' } }] },
    { id: 'c', status: 'active', revisions: [{ revision: 1, statement: 'Bad scope', category: 'lesson', scope: 'global', area: '', source: { kind: 'user', note: 'x' } }] },
    { id: 'd', status: 'active', revisions: [{ revision: 1, statement: 'Valid imported lesson about caching layers', category: 'lesson', scope: 'branch', branch: 'feature/elsewhere', area: '', source: { kind: 'file', path: '../../secret', startLine: 1 } }] },
  ];
  const document = { format: 'journal-brain', version: 1, project: { name: 'other' }, memories, checksum: createHash('sha256').update(JSON.stringify(memories)).digest('hex') };
  const result = f.store.importBrain(f.project.id, JSON.stringify(document));
  assert.equal(result.imported, 1); assert.equal(result.skipped.length, 3);
  const [memory] = f.store.listMemories(f.project.id);
  assert.equal(memory.scope, 'checkout', 'Another repository\'s branch name is not matched automatically');
  assert.equal(memory.source.kind, 'import'); assert.ok(!existsSync(join(f.repo, '..', '..', 'secret')));
});

test('purge removes one ended session; retention trims old timelines but keeps knowledge', t => {
  const f = fixture(t); const kept = f.approve('Knowledge is never pruned by retention.');
  const receipt = f.store.prepareContext(f.project.id, '');
  const old = { id: 'old', projectId: f.project.id, provider: 'claude', status: 'stopped', receiptId: receipt.id, createdAt: '2020-01-01T00:00:00.000Z', endedAt: '2020-01-01T01:00:00.000Z' };
  f.store.saveSession(old); f.store.appendEvent('old', 'start', {}); f.store.appendEvent('old', 'stop', {});
  f.store.saveSession({ ...old, id: 'live', status: 'running', endedAt: null }); f.store.appendEvent('live', 'start', {});
  assert.deepEqual(f.store.applyRetention({ eventDays: 90 }), { eventsDeleted: 2 });
  assert.equal(f.store.listEvents('live').length, 1); assert.equal(f.store.getSession('old').id, 'old');
  assert.throws(() => f.store.purgeSession('live'), /Stop the session/);
  f.store.purgeSession('old');
  assert.throws(() => f.store.getSession('old'), /Unknown session/); assert.throws(() => f.store.getReceipt(receipt.id), /Unknown receipt/);
  assert.equal(f.store.getMemory(kept.id).status, 'active');
  assert.ok(f.store.listAudit().some(a => a.action === 'session-purged'));
});

test('review fixes: export approved only, purge keeps shared resume history, restore validates the file', async t => {
  const f = fixture(t); f.approve('Approved rule about caching.');
  f.store.proposeMemory(f.project.id, { statement: 'Unreviewed candidate about queues.', category: 'lesson', scope: 'checkout', area: '', source: { kind: 'user', note: 'x' } });
  assert.equal(f.store.exportBrain(f.project.id).json.memories.length, 1);
  const receipt = f.store.prepareContext(f.project.id, '');
  const base = { projectId: f.project.id, provider: 'claude', nativeId: '44444444-4444-4444-8444-444444444444', status: 'stopped', receiptId: receipt.id, createdAt: '' };
  f.store.saveSession({ ...base, id: 'a' }); f.store.saveSession({ ...base, id: 'b', resumedFrom: 'a' });
  assert.throws(() => f.store.purgeSession('b'), /so you can still continue it/);
  const { DatabaseSync } = await import('node:sqlite');
  const other = join(f.root, 'other.sqlite'); const db = new DatabaseSync(other); db.exec('CREATE TABLE x(a)'); db.close();
  assert.throws(() => restore(other, f.data, { alive: () => false }), /not a Journal backup/);
  const newer = join(f.root, 'newer.sqlite'); await f.store.backup(newer); const n = new DatabaseSync(newer); n.exec('PRAGMA user_version=99'); n.close();
  assert.throws(() => restore(newer, f.data, { alive: () => false }), /newer Journal/);
  (await import('node:fs')).symlinkSync('host-12345', join(f.data, 'SingletonLock')); // dangling, as Chromium creates it
  const good = join(f.root, 'good.sqlite'); await f.store.backup(good);
  assert.throws(() => restore(good, f.data, { alive: () => false }), /appears to be open/);
});
