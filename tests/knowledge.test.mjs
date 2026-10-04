import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { removeLater } from './support/cleanup.mjs';
const { JournalStore } = await import('../src/core/store.mjs').catch(() => ({}));

function fixture(t) {
  const root = mkdtempSync(resolve(process.env.JOURNAL_TEST_TMP ?? tmpdir(), 'journal-'));
  const repo = resolve(root, 'checkout with spaces'); mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-b', 'main');
  writeFileSync(resolve(repo, 'tests.md'), 'Integration tests require Docker.\nRun npm test.\n');
  git('add', 'tests.md'); git('-c', 'user.name=Fixture', '-c', 'user.email=test@example.test', 'commit', '-m', 'fixture');
  const path = resolve(root, 'journal.sqlite');
  const store = new JournalStore(path); const project = store.openProject(repo);
  t.after(() => { store.close(); removeLater(root); });
  const propose = (extra = {}) => store.proposeMemory(project.id, {
    statement: 'Integration tests require Docker', category: 'constraint', scope: 'branch', area: '',
    source: { kind: 'file', path: 'tests.md', startLine: 1, endLine: 1 }, ...extra,
  });
  return { root, repo, path, store, project, propose, git };
}

test('knowledge store exists', () => assert.equal(typeof JournalStore, 'function'));
test('only manually admitted knowledge is retrieved, with exact sources and receipt', t => {
  const f = fixture(t); const memory = f.propose();
  assert.equal(f.store.prepareContext(f.project.id, 'Docker').items.length, 0);
  f.store.setMemoryStatus(memory.id, 'active');
  const receipt = f.store.prepareContext(f.project.id, 'Docker');
  assert.equal(receipt.items.length, 1); assert.match(receipt.packet, /tests\.md/);
  assert.equal(receipt.items[0].revisionId, memory.revisionId);
  assert.equal(receipt.state, 'prepared');
  assert.ok(receipt.items[0].source.contentHash); assert.equal(receipt.items[0].source.excerpt, 'Integration tests require Docker.');
});
test('incidental English grammar words cannot inject unrelated approved knowledge', t => {
  const f = fixture(t);
  const memory = f.propose({ statement: 'The native terminal requires Electron', source: { kind: 'user', note: 'Explicit fixture development policy' } });
  f.store.setMemoryStatus(memory.id, 'active');
  assert.equal(f.store.prepareContext(f.project.id, 'Translate THE marketing landing page').items.length, 0);
  assert.equal(f.store.prepareContext(f.project.id, 'the and for').items.length, 0);
  assert.equal(f.store.prepareContext(f.project.id, 'Update the Electron setup').items[0]?.id, memory.id);
  assert.equal(f.store.prepareContext(f.project.id, 'a an and are as at be by for from in is it of on or Electron').items[0]?.id, memory.id);
});
test('an approved project brief orients empty and unrelated tasks before task-specific knowledge', t => {
  const f = fixture(t);
  const brief = f.propose({ category: 'brief', scope: 'checkout', statement: 'Purpose: fixture project. Status: integration foundation ready. Next: validate Docker setup.', source: { kind: 'user', note: 'Reviewed fixture project status' } });
  assert.equal(f.store.prepareContext(f.project.id, '').items.length, 0, 'Candidates are never orientation');
  f.store.setMemoryStatus(brief.id, 'active');
  for (const query of ['', 'Translate marketing']) assert.deepEqual(f.store.prepareContext(f.project.id, query).items.map(x => x.id), [brief.id]);
  const rule = f.propose(); f.store.setMemoryStatus(rule.id, 'active');
  const receipt = f.store.prepareContext(f.project.id, 'Docker');
  assert.deepEqual(receipt.items.map(x => x.id), [brief.id, rule.id]);
  assert.match(receipt.packet, /Project brief/); assert.match(receipt.packet, /checkout with spaces/); assert.match(receipt.packet, /branch main/);
  f.git('switch', '-c', 'feature'); assert.equal(f.store.prepareContext(f.project.id, '').items[0]?.id, brief.id);
});
test('project briefs retain source freshness, branch boundaries and explicit revision admission', t => {
  const f = fixture(t); const brief = f.propose({ category: 'brief', statement: 'Status: integration tests require Docker.' });
  f.store.setMemoryStatus(brief.id, 'active'); const original = f.store.prepareContext(f.project.id, '');
  f.git('switch', '-c', 'feature'); assert.equal(f.store.prepareContext(f.project.id, '').items.length, 0);
  f.git('switch', 'main'); writeFileSync(resolve(f.repo, 'tests.md'), 'Changed project state\n');
  const stale = f.store.prepareContext(f.project.id, '');
  assert.equal(stale.items.length, 0); assert.ok(stale.excluded.some(x => x.id === brief.id && x.reason === 'stale'));
  const revised = f.propose({ memoryId: brief.id, category: 'brief', statement: 'Status: updated integration setup.', source: { kind: 'user', note: 'Reviewed current status' } });
  assert.equal(f.store.prepareContext(f.project.id, '').items.length, 0);
  f.store.setMemoryStatus(revised.id, 'active'); assert.equal(f.store.prepareContext(f.project.id, '').items[0]?.revision, 2);
  assert.equal(f.store.getReceipt(original.id).items[0].statement, brief.statement);
  f.store.setMemoryStatus(revised.id, 'archived'); assert.equal(f.store.prepareContext(f.project.id, '').items.length, 0);
  assert.throws(() => f.propose({ category: 'brief', area: 'src' }), { message: 'A project summary applies to the whole project; leave the area empty' });
});
test('project orientation is prioritized and bounded without hiding dropped briefs', t => {
  const f = fixture(t);
  for (let i = 0; i < 5; i++) { const m = f.propose({ category: 'brief', statement: `Area ${['billing', 'search', 'onboarding', 'exports', 'alerts'][i]}: status ${i}; owner team ${String.fromCharCode(65 + i)}`, source: { kind: 'user', note: 'Reviewed fixture summary' } }); f.store.setMemoryStatus(m.id, 'active'); }
  const receipt = f.store.prepareContext(f.project.id, '');
  assert.equal(receipt.items.length, 4); assert.ok(receipt.excluded.some(x => x.reason === 'brief-limit'));
  assert.ok(receipt.warnings.some(x => /project brief/i.test(x))); assert.ok(Buffer.byteLength(receipt.packet) <= 6000);
});
test('every branch keeps the repo overview and receives only its own progress update', t => {
  const f = fixture(t);
  const addBrief = (statement, scope) => { const m = f.propose({ category: 'brief', statement, scope, source: { kind: 'user', note: 'Reviewed fixture orientation' } }); f.store.setMemoryStatus(m.id, 'active'); return m; };
  const overview = addBrief('Purpose: Journal-style project memory cockpit.', 'checkout');
  const main = addBrief('Status: main foundation complete. Next: lifecycle tests.', 'branch');
  f.git('switch', '-c', 'feature');
  const feature = addBrief('Status: feature implementation underway. Next: review feature.', 'branch');
  assert.deepEqual(f.store.prepareContext(f.project.id, '').items.map(x => x.id), [overview.id, feature.id]);
  f.git('switch', 'main');
  assert.deepEqual(f.store.prepareContext(f.project.id, 'unrelated task').items.map(x => x.id), [overview.id, main.id]);
});
test('file-backed knowledge is excluded after a change or deletion', t => {
  const f = fixture(t); const m = f.propose(); f.store.setMemoryStatus(m.id, 'active');
  writeFileSync(resolve(f.repo, 'tests.md'), 'Docker is no longer required');
  assert.equal(f.store.prepareContext(f.project.id, 'Docker').items.length, 0);
  assert.equal(f.store.listMemories(f.project.id)[0].validation, 'stale');
  rmSync(resolve(f.repo, 'tests.md'));
  assert.equal(f.store.prepareContext(f.project.id, 'Docker').items.length, 0);
});
test('branch claims do not travel to another branch, including detached HEAD', t => {
  const f = fixture(t); const m = f.propose(); f.store.setMemoryStatus(m.id, 'active');
  f.git('switch', '-c', 'feature'); assert.equal(f.store.prepareContext(f.project.id, 'Docker').items.length, 0);
  f.git('checkout', '--detach'); assert.equal(f.store.prepareContext(f.project.id, 'Docker').items.length, 0);
});
test('checkout scope remains useful across branches but never crosses projects', t => {
  const f = fixture(t); const m = f.propose({ scope: 'checkout' }); f.store.setMemoryStatus(m.id, 'active');
  f.git('switch', '-c', 'feature'); assert.equal(f.store.prepareContext(f.project.id, 'Docker').items.length, 1);
  assert.throws(() => f.store.prepareContext('unknown', 'Docker'), /project/);
});
test('evidence blocks traversal, symlink escapes, untracked files and sensitive filenames', t => {
  const f = fixture(t); writeFileSync(resolve(f.root, 'outside.txt'), 'outside');
  symlinkSync(resolve(f.root, 'outside.txt'), resolve(f.repo, 'link.txt')); f.git('add', 'link.txt');
  writeFileSync(resolve(f.repo, '.env'), 'PASSWORD=canary'); f.git('add', '.env');
  writeFileSync(resolve(f.repo, 'untracked.txt'), 'untracked');
  for (const path of ['../outside.txt', '/etc/passwd', 'link.txt', '.env', 'untracked.txt', '..\\outside.txt']) {
    assert.throws(() => f.propose({ source: { kind: 'file', path, startLine: 1, endLine: 1 } }));
  }
});
test('secret canaries are refused before any durable memory or receipt', t => {
  const f = fixture(t);
  for (const statement of ['Token sk-proj-' + 'X'.repeat(40), 'password=hunter2', 'Bearer ' + 'x'.repeat(30)]) {
    assert.throws(() => f.propose({ statement }), /credential/i);
  }
  assert.equal(f.store.listMemories(f.project.id).length, 0);
});
test('edits require new admission and cannot mutate historical context', t => {
  const f = fixture(t); const m = f.propose(); f.store.setMemoryStatus(m.id, 'active');
  const before = f.store.prepareContext(f.project.id, 'Docker');
  const updated = f.propose({ memoryId: m.id, statement: 'Docker is optional for tests' });
  assert.equal(updated.revision, 2); assert.equal(updated.status, 'candidate');
  assert.equal(f.store.prepareContext(f.project.id, 'Docker').items.length, 0);
  assert.equal(f.store.getReceipt(before.id).packet, before.packet);
  assert.equal(f.store.getReceipt(before.id).items[0].statement, m.statement);
  assert.equal(f.store.memoryHistory(m.id).length, 2);
});
test('receipts and approved knowledge survive reopening SQLite', t => {
  const f = fixture(t); const m = f.propose(); f.store.setMemoryStatus(m.id, 'active');
  const before = f.store.prepareContext(f.project.id, 'Docker'); f.store.close();
  const reopened = new JournalStore(f.path);
  try {
    assert.equal(reopened.getReceipt(before.id).packet, before.packet);
    assert.equal(reopened.prepareContext(f.project.id, 'Docker').items.length, 1);
  } finally { reopened.close(); }
});
test('FTS input is escaped and packets preserve whole claims inside the byte budget', t => {
  const f = fixture(t);
  for (let i = 0; i < 9; i++) {
    const m = f.propose({ statement: `Docker ${i} ` + '\u05de\u05d9\u05d3\u05e2 '.repeat(130), source: { kind: 'user', note: 'Explicit fixture policy' } });
    f.store.setMemoryStatus(m.id, 'active');
  }
  const receipt = f.store.prepareContext(f.project.id, 'Docker " OR NEAR(*');
  assert.ok(Buffer.byteLength(receipt.packet) <= 6000); assert.ok(receipt.items.length > 0);
  for (const item of receipt.items) assert.ok(receipt.packet.includes(item.statement));
  assert.equal(f.store.prepareContext(f.project.id, 'totally-unrelated').items.length, 0);
});
test('proposing requires a real source, valid area and allowed enum values', t => {
  const f = fixture(t);
  for (const extra of [{ source: null }, { area: '../elsewhere' }, { category: 'made-up' }, { scope: 'repo' }, { statement: '   ' }]) {
    assert.throws(() => f.propose(extra));
  }
  const m = f.propose(); writeFileSync(resolve(f.repo, 'tests.md'), 'changed');
  assert.throws(() => f.propose({ source: null }), { message: 'A note needs a source' });
  assert.throws(() => f.store.setMemoryStatus(m.id, 'active'), { message: 'Evidence or branch changed; revise the note before remembering it' });
  f.store.setMemoryStatus(m.id, 'rejected');
  assert.throws(() => f.store.setMemoryStatus(m.id, 'active'), { message: 'Only a note waiting for review can be remembered' });
});

test('untracked wildcard filenames cannot impersonate a tracked source', t => {
  const f = fixture(t); writeFileSync(resolve(f.repo, '[t]ests.md'), 'untracked evidence');
  assert.throws(() => f.propose({ source: { kind: 'file', path: '[t]ests.md', startLine: 1, endLine: 1 } }), /tracked/);
});

test('stale high-ranking matches cannot crowd out relevant current knowledge', t => {
  const f = fixture(t);
  for (let i = 0; i < 101; i++) {
    const m = f.propose({ statement: `Docker Docker Docker ${i}` }); f.store.setMemoryStatus(m.id, 'active');
  }
  writeFileSync(resolve(f.repo, 'tests.md'), 'Changed since evidence capture');
  const current = f.propose({ statement: 'Docker for integration testing is an explicit user policy', source: { kind: 'user', note: 'Fixture current rule' } });
  f.store.setMemoryStatus(current.id, 'active');
  assert.ok(f.store.prepareContext(f.project.id, 'Docker').items.some(item => item.id === current.id));
});

test('an evidence file replaced by a symlink between validation and Git lookup is refused', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); const outside = resolve(f.root, 'outside.txt'); writeFileSync(outside, 'Outside content must not be captured');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const shimDir = resolve(f.root, 'shim'); mkdirSync(shimDir); writeFileSync(resolve(shimDir, 'package.json'), '{"type":"commonjs"}');
  const target = resolve(f.repo, 'tests.md');
  const script = `#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process');const args=process.argv.slice(2);if(args.includes('ls-files')){fs.unlinkSync(${JSON.stringify(target)});fs.symlinkSync(${JSON.stringify(outside)},${JSON.stringify(target)});}const p=cp.spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(p.status??1);`;
  writeFileSync(resolve(shimDir, 'git'), script); chmodSync(resolve(shimDir, 'git'), 0o755);
  const oldPath = process.env.PATH; process.env.PATH = `${shimDir}${delimiter}${oldPath}`; t.after(() => { process.env.PATH = oldPath; });
  assert.throws(() => f.propose(), /changed|symlink|source/i);
});

test('a context preview is not stored as a receipt; a launch receipt still is', t => {
  const f = fixture(t); const memory = f.propose(); f.store.setMemoryStatus(memory.id, 'active');
  const before = f.store.listReceipts(f.project.id).length;
  const preview = f.store.prepareContext(f.project.id, 'Docker', { persist: false });
  assert.equal(preview.items.length, 1);
  assert.equal(preview.preview, true);
  assert.equal(preview.state, 'prepared', 'The UI keeps treating it as a prepared packet');
  assert.equal(f.store.listReceipts(f.project.id).length, before, 'A preview writes nothing');
  assert.throws(() => f.store.getReceipt(preview.id), /Unknown receipt/);
  const stored = f.store.prepareContext(f.project.id, 'Docker');
  assert.equal(f.store.getReceipt(stored.id).state, 'prepared', 'The default still stores');
});

test('stored previews from older versions are kept but not listed; a launch receipt is listed before delivery', t => {
  const f = fixture(t);
  // Before previews stopped being stored, each one left a prepared receipt that no session refers to.
  const legacy = f.store.prepareContext(f.project.id, 'Docker');
  const listed = () => f.store.listReceipts(f.project.id).map(r => r.id);
  assert.deepEqual(listed(), []);
  assert.equal(f.store.getReceipt(legacy.id).id, legacy.id, 'Receipts are immutable: it is not deleted');
  // A launch saves its session (which names the receipt) before delivery records the session id.
  const launch = f.store.prepareContext(f.project.id, 'Docker');
  f.store.saveSession({ id: 's1', projectId: f.project.id, provider: 'claude', status: 'starting', receiptId: launch.id, createdAt: new Date().toISOString() });
  assert.deepEqual(listed(), [launch.id]);
  f.store.updateReceiptState(launch.id, 'submitted', 's1', 'Docker');
  const failed = f.store.prepareContext(f.project.id, 'Docker'); f.store.updateReceiptState(failed.id, 'failed', null);
  assert.deepEqual(listed(), [failed.id, launch.id]);
});
test('listMemoryPage: category, counts and other branches', t => {
  const f = fixture(t);
  const note = (statement, category, extra = {}) => f.store.proposeMemory(f.project.id, { statement, category, scope: 'checkout', area: '', source: { kind: 'user', note: 'Fixture' }, ...extra });
  const lessons = [note('Docker caches layers between runs', 'lesson'), note('Retries need jitter', 'lesson')];
  note('We chose SQLite for storage', 'decision'); const rule = note('Integration tests need Docker running', 'constraint');
  f.store.setMemoryStatus(rule.id, 'active');
  const page = options => f.store.listMemoryPage(f.project.id, options);
  const lessonPage = page({ category: 'lesson' });
  assert.deepEqual(lessonPage.items.map(item => item.id).sort(), lessons.map(item => item.id).sort());
  assert.equal(lessonPage.total, 2);
  assert.deepEqual(lessonPage.categoryCounts, { all: 4, brief: 0, decision: 1, constraint: 1, convention: 0, lesson: 2, issue: 0 });
  assert.deepEqual(page({ search: 'docker', category: 'decision' }).categoryCounts, { all: 2, brief: 0, decision: 0, constraint: 1, convention: 0, lesson: 1, issue: 0 });
  assert.deepEqual(page({ filter: 'active' }).categoryCounts, { all: 1, brief: 0, decision: 0, constraint: 1, convention: 0, lesson: 0, issue: 0 });
  assert.equal(page().otherBranch, 0);

  f.git('switch', '-c', 'feature/x');
  const elsewhere = note('Feature flags live in flags.ts', 'lesson', { scope: 'branch' });
  f.git('switch', 'main');
  const all = page();
  assert.equal(all.otherBranch, 1); assert.equal(all.total, 5);
  assert.deepEqual(page({ otherBranch: true }).items.map(item => item.id), [elsewhere.id]);
  assert.equal(page({ otherBranch: true, category: 'decision' }).items.length, 0);
  assert.equal(page({ otherBranch: true, category: 'decision' }).otherBranch, 1, 'The toggle count ignores the category');
  assert.equal(page({ otherBranch: true }).categoryCounts.lesson, 1);
  assert.deepEqual(page({ ids: [rule.id, elsewhere.id] }).items.map(item => item.id).sort(), [rule.id, elsewhere.id].sort());
  assert.equal(page({ ids: [rule.id] }).total, 1);
  assert.throws(() => page({ category: 'nope' }), /category/);
  assert.throws(() => page({ ids: Array.from({ length: 201 }, (_, i) => `id-${i}`) }), /Invalid note list/);
  assert.throws(() => page({ otherBranch: 'yes' }), /Invalid filter/);
  assert.deepEqual(page().items.map(item => item.id), page({ category: 'all', otherBranch: false, ids: null }).items.map(item => item.id));
});
