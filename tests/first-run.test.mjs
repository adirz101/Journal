import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { JournalStore } from '../src/core/store.mjs';
import { STORE_METHODS } from '../src/core/store-methods.mjs';
import { fillDraft } from '../src/core/status.mjs';
import { removeLater } from './support/cleanup.mjs';

// Phase 7 Group A: orientation offered once per project (D10) and one-action Remember
// of both first-run cards (D1, via 'first-run'), on temporary repositories and a real store.

function fixture(t, { commit = true } = {}) {
  const root = mkdtempSync(resolve(process.env.JOURNAL_TEST_TMP ?? tmpdir(), 'first-run-'));
  const repo = join(root, 'repo'); mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
  const commitAll = message => { git('add', '-A'); git('-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', message); };
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# Ledger\n\nLedger records invoices for small shops.\n');
  mkdirSync(join(repo, 'src')); writeFileSync(join(repo, 'src', 'a.js'), 'export const a = 1;\n');
  if (commit) commitAll('init');
  const store = new JournalStore(join(root, 'journal.sqlite')); const project = store.openProject(repo);
  t.after(() => { store.close(); removeLater(root); });
  const audits = action => store.listAudit(1000).filter(row => row.action === action);
  const flag = () => store.storedProject(project.id).orientation?.state ?? null;
  // The cards as the renderer sends them: filled statements plus each draft's base and head.
  const parts = (drafts, fields = { currentWork: 'Refund export', next: 'Wire the CSV button' }) => ({
    overview: drafts.overview && { statement: fillDraft(drafts.overview.statement, fields), base: drafts.overview.source.base, head: drafts.overview.basis.head },
    branch: drafts.branch && { statement: fillDraft(drafts.branch.statement, fields), base: drafts.branch.source.base, head: drafts.branch.basis.head },
  });
  return { root, repo, git, commitAll, store, project, audits, flag, parts };
}

test('the store exposes the first-run methods to the worker', () => {
  for (const name of ['needsOrientation', 'firstRunDrafts', 'rememberDraft', 'skipOrientation', 'hasActiveNotes']) assert.ok(STORE_METHODS.includes(name), name);
});

test('a fresh repo needs orientation once', t => {
  const f = fixture(t);
  assert.equal(f.store.needsOrientation(f.project.id), true);
  const drafts = f.store.firstRunDrafts(f.project.id);
  assert.equal(drafts.projectId, f.project.id); assert.equal(drafts.head, f.git('rev-parse', 'HEAD'));
  assert.equal(drafts.overview.scope, 'checkout'); assert.match(drafts.overview.statement, /^Purpose: Ledger records invoices/);
  assert.deepEqual(drafts.overview.basis.facts, { readme: 'README.md', folders: 1, commits: 1, counted: true });
  assert.equal(drafts.branch.scope, 'branch'); assert.equal(drafts.branchSkipped, null);
  assert.equal(f.flag(), 'shown', 'marked when the drafts are produced, even if the user walks away');
  assert.equal(f.store.needsOrientation(f.project.id), false);
  assert.equal(f.store.firstRunDrafts(f.project.id), null);
  // Reopening the folder keeps the flag.
  f.store.openProject(f.repo); assert.equal(f.flag(), 'shown');
  assert.equal(f.store.listMemories(f.project.id).length, 0, 'drafting stores no note');
});

test('a project with any brief never needs orientation', t => {
  const f = fixture(t);
  f.store.proposeMemory(f.project.id, { statement: 'Ledger is a billing service.', category: 'brief', scope: 'checkout', source: { kind: 'user', note: 'mine' } });
  assert.equal(f.store.needsOrientation(f.project.id), false, 'a candidate counts');
  assert.equal(f.store.firstRunDrafts(f.project.id), null); assert.equal(f.flag(), null);
  const other = fixture(t);
  const note = other.store.proposeMemory(other.project.id, { statement: 'Use npm test.', category: 'convention', scope: 'checkout', source: { kind: 'user', note: 'mine' } });
  other.store.setMemoryStatus(note.id, 'active');
  assert.equal(other.store.needsOrientation(other.project.id), true, 'only a project summary counts');
});

test('an unborn repo returns null and stays eligible', t => {
  const f = fixture(t, { commit: false });
  assert.equal(f.store.firstRunDrafts(f.project.id), null);
  assert.equal(f.flag(), null); assert.equal(f.store.needsOrientation(f.project.id), true);
  f.commitAll('first');
  const drafts = f.store.firstRunDrafts(f.project.id);
  assert.ok(drafts.overview && drafts.branch); assert.equal(f.flag(), 'shown');
});

test('a detached HEAD drafts the overview only', t => {
  const f = fixture(t);
  f.git('checkout', '-q', '--detach');
  const drafts = f.store.firstRunDrafts(f.project.id);
  assert.ok(drafts.overview); assert.equal(drafts.branch, null); assert.equal(drafts.branchSkipped, 'detached');
  const notes = f.store.rememberDraft(f.project.id, f.parts(drafts), { via: 'first-run' });
  assert.equal(notes.length, 1); assert.equal(notes[0].scope, 'checkout');
});

test('rememberDraft remembers both in one step', t => {
  const f = fixture(t);
  const drafts = f.store.firstRunDrafts(f.project.id);
  const notes = f.store.rememberDraft(f.project.id, f.parts(drafts, { currentWork: 'Refund export', next: '' }), { via: 'first-run' });
  assert.deepEqual(notes.map(note => [note.scope, note.status, note.category]), [['checkout', 'active', 'brief'], ['branch', 'active', 'brief']]);
  assert.match(notes[1].statement, /^Current work: Refund export$/m); assert.doesNotMatch(notes[1].statement, /^Next:/m);
  assert.doesNotMatch(notes[0].statement, /Constraints:/, 'the empty optional line is gone');
  assert.equal(notes[1].branch, 'main'); assert.equal(notes[0].source.kind, 'git'); assert.equal(notes[0].source.head, drafts.head);
  const approved = f.store.db.prepare('SELECT approved_at FROM memories WHERE project_id=?').all(f.project.id);
  assert.ok(approved.every(row => row.approved_at));
  const active = f.audits('memory-active');
  assert.equal(active.length, 2); assert.ok(active.every(row => row.body.via === 'first-run'));
  assert.deepEqual(f.audits('orientation-remembered').map(row => row.body), [{ projectId: f.project.id, notes: 2 }]);
  assert.equal(f.flag(), 'remembered'); assert.equal(f.store.hasActiveNotes(), true);
  // The packet every session receives now carries both.
  const receipt = f.store.prepareContext(f.project.id, '', { persist: false });
  assert.equal(receipt.items.filter(item => item.category === 'brief').length, 2);
});

test('rememberDraft is all-or-nothing', t => {
  const f = fixture(t);
  const drafts = f.store.firstRunDrafts(f.project.id);
  const input = f.parts(drafts);
  input.branch.statement = input.branch.statement.replace('Refund export', 'token ghp_0123456789abcdefghijklmnopqrstuvwxyzAB');
  assert.throws(() => f.store.rememberDraft(f.project.id, input, { via: 'first-run' }), /credential/);
  assert.equal(f.store.listMemories(f.project.id).length, 0); assert.equal(f.audits('memory-active').length, 0);
  assert.equal(f.flag(), 'shown');
  // A failure inside the transaction (the second write) also rolls back the first.
  const ok = f.parts(drafts); const original = f.store.writeMemory.bind(f.store); let writes = 0;
  f.store.writeMemory = (item, expected) => { if (++writes === 2) throw new Error('disk full'); return original(item, expected); };
  assert.throws(() => f.store.rememberDraft(f.project.id, ok, { via: 'first-run' }), /disk full/);
  f.store.writeMemory = original;
  assert.equal(f.store.listMemories(f.project.id).length, 0); assert.equal(f.audits('memory-active').length, 0); assert.equal(f.audits('orientation-remembered').length, 0);
  assert.equal(f.flag(), 'shown'); assert.equal(f.store.hasActiveNotes(), false);
  // A placeholder never reaches storage.
  const raw = { overview: { statement: drafts.overview.statement.replace(/^Purpose:.*$/m, 'Purpose: [describe it]'), base: null, head: drafts.head }, branch: null };
  assert.throws(() => f.store.rememberDraft(f.project.id, raw, { via: 'first-run' }), /placeholders/);
});

test('rememberDraft refuses a moved HEAD and a brief added meanwhile', t => {
  const f = fixture(t);
  const drafts = f.store.firstRunDrafts(f.project.id);
  writeFileSync(join(f.repo, 'src', 'b.js'), 'export const b = 2;\n'); f.commitAll('more');
  assert.throws(() => f.store.rememberDraft(f.project.id, f.parts(drafts), { via: 'first-run' }), /The project changed since these drafts were made\. Open Project memory to draft them again\./);
  const fresh = fixture(t);
  const later = fresh.store.firstRunDrafts(fresh.project.id);
  fresh.store.proposeMemory(fresh.project.id, { statement: 'Ledger is a billing service.', category: 'brief', scope: 'checkout', source: { kind: 'user', note: 'mine' } });
  assert.throws(() => fresh.store.rememberDraft(fresh.project.id, fresh.parts(later), { via: 'first-run' }), /A project summary was added meanwhile; review it in Project memory/);
  assert.equal(fresh.store.listMemories(fresh.project.id).filter(note => note.status === 'active').length, 0, 'nothing was remembered');
  // The branch card alone still works when only the overview was added meanwhile.
  const notes = fresh.store.rememberDraft(fresh.project.id, { ...fresh.parts(later), overview: null }, { via: 'first-run' });
  assert.deepEqual(notes.map(note => note.scope), ['branch']);
});

test('rememberDraft refuses any via but first-run, and malformed parts', t => {
  const f = fixture(t);
  const drafts = f.store.firstRunDrafts(f.project.id); const input = f.parts(drafts);
  for (const via of [undefined, 'wrap-up', 'reaffirm', 'renderer']) assert.throws(() => f.store.rememberDraft(f.project.id, input, { via }), /Invalid remember path/);
  assert.throws(() => f.store.rememberDraft(f.project.id, { overview: null, branch: null }, { via: 'first-run' }), /Choose a draft/);
  assert.throws(() => f.store.rememberDraft(f.project.id, { overview: { statement: 'x' }, branch: null }, { via: 'first-run' }), /Invalid draft/);
  assert.throws(() => f.store.rememberDraft(f.project.id, { overview: 'text', branch: null }, { via: 'first-run' }), /Invalid draft/);
  assert.equal(f.store.listMemories(f.project.id).length, 0);
});

test('skipOrientation stores nothing but the flag', t => {
  const f = fixture(t);
  f.store.firstRunDrafts(f.project.id);
  f.store.skipOrientation(f.project.id);
  assert.equal(f.flag(), 'skipped'); assert.equal(f.store.listMemories(f.project.id).length, 0);
  assert.deepEqual(f.audits('orientation-skipped').map(row => row.body), [{ projectId: f.project.id }]);
  assert.equal(f.store.firstRunDrafts(f.project.id), null);
  // Skipping without ever seeing the drafts also counts (the screen was left some other way).
  const other = fixture(t); other.store.skipOrientation(other.project.id); assert.equal(other.store.needsOrientation(other.project.id), false);
  // Removing the project from Journal (without deleting data) and opening it again keeps the choice.
  f.store.removeProject(f.project.id); f.store.openProject(f.repo); assert.equal(f.flag(), 'skipped');
});

test('hasActiveNotes looks across every project', t => {
  const a = fixture(t); const b = fixture(t);
  assert.equal(a.store.hasActiveNotes(), false);
  const note = b.store.proposeMemory(b.project.id, { statement: 'Use npm test.', category: 'convention', scope: 'checkout', source: { kind: 'user', note: 'mine' } });
  assert.equal(b.store.hasActiveNotes(), false, 'a candidate is not remembered');
  b.store.setMemoryStatus(note.id, 'active'); assert.equal(b.store.hasActiveNotes(), true);
});
