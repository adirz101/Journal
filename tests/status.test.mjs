import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { JournalStore } from '../src/core/store.mjs';

function fixture(t) {
  const root = mkdtempSync(resolve(process.env.JOURNAL_TEST_TMP ?? tmpdir(), 'journal-status-'));
  const repo = resolve(root, 'status repo'); mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
  const commit = (path, content, message) => {
    mkdirSync(resolve(repo, path, '..'), { recursive: true }); writeFileSync(resolve(repo, path), content);
    git('add', '--', path); git('-c', 'user.name=Fixture', '-c', 'user.email=test@example.test', 'commit', '-m', message);
  };
  git('init', '-b', 'main');
  commit('README.md', '# Ledger\n\nLedger records invoices and refunds for small shops.\n', 'Initial ledger');
  commit('src/invoices/create.mjs', 'export const create = () => 1;\n', 'Add invoice creation');
  const store = new JournalStore(resolve(root, 'journal.sqlite')); const project = store.openProject(repo);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const save = (draft, statement = draft.statement.replaceAll(/\[describe[^\]]*\]/g, 'Reviewed by operator')) =>
    store.proposeMemory(project.id, { memoryId: draft.memoryId ?? undefined, statement, category: 'brief', scope: draft.scope, area: '', source: draft.source });
  return { repo, git, commit, store, project, save };
}

test('a branch draft summarizes commits since the default branch and saves nothing', t => {
  const f = fixture(t); f.git('switch', '-c', 'feature/refunds');
  f.commit('src/refunds/model.mjs', 'export const model = 1;\n', 'Add refund model');
  f.commit('src/refunds/route.mjs', 'export const route = 1;\n', 'Add refund route');
  writeFileSync(resolve(f.repo, 'scratch.txt'), 'work in progress');
  const draft = f.store.proposeStatusUpdate(f.project.id, 'branch');
  assert.equal(draft.scope, 'branch'); assert.equal(draft.memoryId, null);
  assert.equal(draft.basis.commitCount, 2); assert.match(draft.basis.label, /main/);
  assert.match(draft.statement, /Add refund model/); assert.match(draft.statement, /Add refund route/);
  assert.doesNotMatch(draft.statement, /Add invoice creation/, 'Commits already on main are not branch progress');
  assert.match(draft.statement, /src\/refunds \(2\)/); assert.match(draft.statement, /Uncommitted: 1 file/);
  assert.match(draft.statement, /\[describe/); assert.ok(draft.statement.length <= 2000);
  assert.equal(draft.source.kind, 'git'); assert.equal(draft.source.base, f.git('rev-parse', 'main'));
  assert.equal(f.store.listMemories(f.project.id).length, 0, 'A proposal is never persisted');
});

test('saved git-backed updates need approval, record the range and report drift', t => {
  const f = fixture(t); f.git('switch', '-c', 'feature/refunds');
  f.commit('src/refunds/model.mjs', 'export const model = 1;\n', 'Add refund model');
  const draft = f.store.proposeStatusUpdate(f.project.id, 'branch');
  assert.throws(() => f.store.proposeMemory(f.project.id, { statement: draft.statement, category: 'brief', scope: 'branch', area: '', source: draft.source }), /placeholder/i);
  const saved = f.save(draft);
  assert.equal(saved.status, 'candidate'); assert.equal(saved.source.head, f.git('rev-parse', 'HEAD'));
  assert.equal(saved.source.commitCount, 1);
  assert.equal(f.store.prepareContext(f.project.id, '').items.length, 0, 'Unapproved drafts never reach agents');
  f.store.setMemoryStatus(saved.id, 'active');
  assert.equal(f.store.prepareContext(f.project.id, '').items[0].id, saved.id);
  f.commit('src/refunds/route.mjs', 'export const route = 1;\n', 'Add refund route');
  const listed = f.store.listMemories(f.project.id)[0];
  assert.equal(listed.validation, 'current'); assert.equal(listed.drift, 1);
  const receipt = f.store.prepareContext(f.project.id, '');
  assert.match(receipt.packet, /1 commit since this update/);
  assert.ok(receipt.warnings.some(w => /1 commit/.test(w)));
  const next = f.store.proposeStatusUpdate(f.project.id, 'branch');
  assert.equal(next.memoryId, saved.id); assert.equal(next.basis.commitCount, 1);
  assert.match(next.basis.label, /last update/); assert.match(next.statement, /Add refund route/);
  assert.doesNotMatch(next.statement, /Add refund model/);
});

test('current work and next step carry over from the previous update for confirmation', t => {
  const f = fixture(t); f.git('switch', '-c', 'feature/refunds');
  f.commit('src/refunds/model.mjs', 'export const model = 1;\n', 'Add refund model');
  const first = f.store.proposeStatusUpdate(f.project.id, 'branch');
  const statement = first.statement.replace(/Current work: .*/, 'Current work: partial refunds.').replace(/Next: .*/, 'Next: validate refund totals.');
  const saved = f.save(first, statement); f.store.setMemoryStatus(saved.id, 'active');
  f.commit('src/refunds/route.mjs', 'export const route = 1;\n', 'Add refund route');
  const next = f.store.proposeStatusUpdate(f.project.id, 'branch');
  assert.match(next.statement, /Current work: partial refunds\./); assert.match(next.statement, /Next: validate refund totals\./);
  assert.deepEqual(next.basis.carried, ['Current work', 'Next']);
});

test('rewritten history makes a git-backed update stale', t => {
  const f = fixture(t); f.git('switch', '-c', 'feature/refunds');
  f.commit('src/refunds/model.mjs', 'export const model = 1;\n', 'Add refund model');
  const saved = f.save(f.store.proposeStatusUpdate(f.project.id, 'branch')); f.store.setMemoryStatus(saved.id, 'active');
  f.git('reset', '--hard', 'main');
  assert.equal(f.store.listMemories(f.project.id)[0].validation, 'stale');
  assert.equal(f.store.prepareContext(f.project.id, '').items.length, 0);
});

test('credential-looking commit subjects are omitted from drafts', t => {
  const f = fixture(t); f.git('switch', '-c', 'feature/secrets');
  f.commit('src/a.mjs', 'export {};\n', 'Configure api_key=abcdef123456 for tests');
  f.commit('src/b.mjs', 'export {};\n', 'Add safe change');
  const draft = f.store.proposeStatusUpdate(f.project.id, 'branch');
  assert.doesNotMatch(draft.statement, /abcdef123456/); assert.match(draft.statement, /Add safe change/);
  assert.ok(draft.basis.notes.some(note => /omitted/.test(note)));
});

test('long histories stay within the statement limit', t => {
  const f = fixture(t); f.git('switch', '-c', 'feature/large');
  for (let i = 0; i < 40; i++) f.commit(`src/file-${i}.mjs`, `export const v = ${i};\n`, `Change number ${i} ${'detail '.repeat(20)}`);
  const draft = f.store.proposeStatusUpdate(f.project.id, 'branch');
  assert.ok(draft.statement.length <= 2000); assert.match(draft.statement, /and \d+ more/);
  assert.equal(draft.basis.commitCount, 40);
});

test('an overview draft starts from README purpose and tracked structure', t => {
  const f = fixture(t);
  const draft = f.store.proposeStatusUpdate(f.project.id, 'checkout');
  assert.equal(draft.scope, 'checkout');
  assert.match(draft.statement, /Purpose: Ledger records invoices and refunds for small shops\./);
  assert.match(draft.statement, /Structure: .*src \(1\)/);
  const saved = f.save(draft); f.store.setMemoryStatus(saved.id, 'active');
  const unchanged = f.store.proposeStatusUpdate(f.project.id, 'checkout');
  assert.equal(unchanged.memoryId, saved.id); assert.equal(unchanged.basis.unchanged, true);
  f.commit('docs/guide.md', 'Guide\n', 'Add docs');
  const changed = f.store.proposeStatusUpdate(f.project.id, 'checkout');
  assert.equal(changed.basis.unchanged, false); assert.ok(changed.basis.structureChanges.some(x => /docs/.test(x)));
  assert.match(changed.statement, /Structure: .*docs \(1\)/);
});

test('branch updates require a named branch and git evidence must belong to current history', t => {
  const f = fixture(t);
  assert.throws(() => f.store.proposeMemory(f.project.id, { statement: 'Status', category: 'brief', scope: 'branch', area: '', source: { kind: 'git', base: 'f'.repeat(40) } }), /commit/i);
  f.git('checkout', '--detach');
  assert.throws(() => f.store.proposeStatusUpdate(f.project.id, 'branch'), /named branch/);
});

test('uncommitted tracked edits keep their full paths in the draft', t => {
  const f = fixture(t); f.git('switch', '-c', 'feature/edit');
  writeFileSync(resolve(f.repo, 'src/invoices/create.mjs'), 'export const create = () => 2;\n');
  const draft = f.store.proposeStatusUpdate(f.project.id, 'branch');
  assert.match(draft.statement, /Uncommitted: 1 file \(src\/invoices\/create\.mjs\)/);
  assert.match(draft.statement, /^Recent commits \(latest 2;/);
});

test('a git-backed repo overview stays current on older branches; branch updates do not travel', t => {
  const f = fixture(t); f.git('switch', '-c', 'older'); f.git('switch', 'main');
  f.commit('src/invoices/total.mjs', 'export const total = 1;\n', 'Add totals');
  const overview = f.save(f.store.proposeStatusUpdate(f.project.id, 'checkout')); f.store.setMemoryStatus(overview.id, 'active');
  f.git('switch', 'older');
  assert.equal(f.store.listMemories(f.project.id)[0].validation, 'current');
  assert.deepEqual(f.store.prepareContext(f.project.id, '').items.map(i => i.id), [overview.id]);
  f.git('switch', 'main'); f.git('switch', '-c', 'feature/x'); f.commit('a.txt', 'a\n', 'Feature work');
  const update = f.save(f.store.proposeStatusUpdate(f.project.id, 'branch')); f.store.setMemoryStatus(update.id, 'active');
  f.git('switch', 'older');
  assert.ok(!f.store.prepareContext(f.project.id, '').items.some(i => i.id === update.id));
});

test('a repo overview goes stale once no branch, remote or tag contains its commit', t => {
  const f = fixture(t); f.commit('docs/a.md', 'a\n', 'Docs to be discarded');
  const overview = f.save(f.store.proposeStatusUpdate(f.project.id, 'checkout')); f.store.setMemoryStatus(overview.id, 'active');
  assert.equal(f.store.listMemories(f.project.id)[0].validation, 'current');
  f.git('reset', '--hard', 'HEAD~1');
  assert.equal(f.store.listMemories(f.project.id)[0].validation, 'stale', 'Only the reflog still holds the commit');
});
