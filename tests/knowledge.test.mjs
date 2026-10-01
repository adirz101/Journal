import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
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
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
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
  const reopened = new JournalStore(f.path); t.after(() => reopened.close());
  assert.equal(reopened.getReceipt(before.id).packet, before.packet);
  assert.equal(reopened.prepareContext(f.project.id, 'Docker').items.length, 1);
});
test('FTS input is escaped and packets preserve whole claims inside the byte budget', t => {
  const f = fixture(t);
  for (let i = 0; i < 9; i++) {
    const m = f.propose({ statement: `Docker ${i} ` + 'מידע '.repeat(130), source: { kind: 'user', note: 'Explicit fixture policy' } });
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
  assert.throws(() => f.store.setMemoryStatus(m.id, 'active'), /evidence/i);
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
