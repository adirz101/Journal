import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, edit, expectCode, lines } from './helpers.mjs';

// Prototype 3: previewed Apply. "Nothing written" is checked byte for byte: the branch ref, the
// checkout's index and every file are the same before and after a refused Apply.
const state = f => ({ head: f.git(f.repo, 'rev-parse', 'feature/auth'), index: readFileSync(join(f.repo, '.git', 'index')), api: readFileSync(join(f.repo, 'src', 'api.js'), 'utf8'),
  form: readFileSync(join(f.repo, 'src', 'form.js'), 'utf8'), status: f.git(f.repo, 'status', '--porcelain') });
async function worker(m, f, task, change) {
  const env = await m.createEnvironment({ projectId: 'p1', logicalBranch: 'feature/auth', sessionId: task, task });
  change(env.details.path); m.markCompleted(env.id); return m.getEnvironment(env.id);
}
const api = lines('api', 10); const form = lines('form', 10);

test('different files: both apply, the second preview recomputed after the first lands', async t => {
  const f = fixture(t); const m = f.manager();
  const a = await worker(m, f, 'A', p => writeFileSync(join(p, 'src', 'api.js'), edit(api, 1, 'api by A')));
  const c = await worker(m, f, 'C', p => writeFileSync(join(p, 'TESTS.md'), 'tests by C\n'));
  const before = m.previewApply(c.id);
  assert.deepEqual([before.clean, before.moved, before.changes.map(x => `${x.status} ${x.path}`)], [true, false, ['A TESTS.md']]);
  assert.equal(m.applyEnvironment(a.id).state, 'integrated');
  const after = m.previewApply(c.id);
  assert.deepEqual([after.clean, after.moved, after.commitsSince, after.logicalHead === before.logicalHead], [true, true, 1, false]);
  m.applyEnvironment(c.id);
  assert.match(readFileSync(join(f.repo, 'src', 'api.js'), 'utf8'), /api by A/);
  assert.equal(readFileSync(join(f.repo, 'TESTS.md'), 'utf8'), 'tests by C\n');
  assert.equal(f.git(f.repo, 'status', '--porcelain'), '', 'the checkout follows the branch');
  assert.deepEqual(f.git(f.repo, 'log', '--format=%s', '-3').split('\n'), ['Apply C', 'Apply A', 'init']);
  assert.equal(m.provenance(a.id).applied, true); assert.ok(m.provenance(a.id).integration);
});

test('same file, different lines: merged in memory, then applied', async t => {
  const f = fixture(t); const m = f.manager();
  const a = await worker(m, f, 'A', p => writeFileSync(join(p, 'src', 'api.js'), edit(api, 2, 'line 2 by A')));
  const b = await worker(m, f, 'B', p => writeFileSync(join(p, 'src', 'api.js'), edit(api, 8, 'line 8 by B')));
  m.applyEnvironment(a.id);
  const preview = m.previewApply(b.id);
  assert.deepEqual([preview.clean, preview.conflicts], [true, []]);
  m.applyEnvironment(b.id);
  const text = readFileSync(join(f.repo, 'src', 'api.js'), 'utf8');
  assert.match(text, /line 2 by A/); assert.match(text, /line 8 by B/);
});

test('same lines: the conflict is found before anything is written', async t => {
  const f = fixture(t); const m = f.manager();
  const a = await worker(m, f, 'A', p => writeFileSync(join(p, 'src', 'api.js'), edit(api, 3, 'A was here')));
  const b = await worker(m, f, 'B', p => writeFileSync(join(p, 'src', 'api.js'), edit(api, 3, 'B was here')));
  m.applyEnvironment(a.id);
  const preview = m.previewApply(b.id);
  assert.deepEqual([preview.clean, preview.canApply, preview.conflicts], [false, false, [{ path: 'src/api.js', kind: 'content' }]]);
  const before = state(f);
  const error = await expectCode(() => m.applyEnvironment(b.id), 'CONFLICT');
  assert.deepEqual(error.detail.conflicts, [{ path: 'src/api.js', kind: 'content' }]);
  assert.deepEqual(state(f), before, 'branch, index and files unchanged');
  assert.equal(m.getEnvironment(b.id).state, 'conflict');
  assert.deepEqual(f.manager().overview('p1').conflict.map(x => x.task), ['B']);
});

test('delete versus edit: a conflict, nothing written', async t => {
  const f = fixture(t); const m = f.manager();
  const a = await worker(m, f, 'A', p => rmSync(join(p, 'src', 'form.js')));
  const b = await worker(m, f, 'B', p => writeFileSync(join(p, 'src', 'form.js'), edit(form, 5, 'edited by B')));
  m.applyEnvironment(a.id);
  const preview = m.previewApply(b.id);
  assert.equal(preview.clean, false); assert.deepEqual(preview.conflicts.map(x => x.path), ['src/form.js']); assert.match(preview.conflicts[0].kind, /modify\/delete/);
  const before = { head: f.git(f.repo, 'rev-parse', 'feature/auth'), status: f.git(f.repo, 'status', '--porcelain'), index: readFileSync(join(f.repo, '.git', 'index')) };
  await expectCode(() => m.applyEnvironment(b.id), 'CONFLICT');
  assert.deepEqual({ head: f.git(f.repo, 'rev-parse', 'feature/auth'), status: f.git(f.repo, 'status', '--porcelain'), index: readFileSync(join(f.repo, '.git', 'index')) }, before);
});

test('branch moved by the user: detected, merged three-way from the recorded base', async t => {
  const f = fixture(t); const m = f.manager();
  const a = await worker(m, f, 'A', p => writeFileSync(join(p, 'src', 'api.js'), edit(api, 1, 'A')));
  writeFileSync(join(f.repo, 'src', 'form.js'), edit(form, 1, 'user commit')); f.git(f.repo, 'commit', '-qam', 'user work');
  const preview = m.previewApply(a.id);
  assert.deepEqual([preview.moved, preview.commitsSince, preview.baseOnBranch, preview.clean], [true, 1, true, true]);
  m.applyEnvironment(a.id);
  assert.match(readFileSync(join(f.repo, 'src', 'form.js'), 'utf8'), /user commit/);
  assert.match(readFileSync(join(f.repo, 'src', 'api.js'), 'utf8'), /^A$/m);
  // A rewritten branch (the base is no longer on it) is reported.
  const b = await worker(m, f, 'B', p => writeFileSync(join(p, 'NOTE.md'), 'b\n'));
  f.git(f.repo, 'reset', '-q', '--hard', 'main');
  assert.equal(m.previewApply(b.id).baseOnBranch, false);
});

test('a race between preview and landing: the checkout is locked against commits; another writer is refused by compare-and-swap', async t => {
  const f = fixture(t);
  let userCommit = null; let raced = false;
  const m = f.manager({ hooks: { beforeLand: () => {
    if (raced) return; raced = true;
    // The user commits in the checkout during the landing: Git refuses (Journal holds the index lock).
    try { f.git(f.repo, 'commit', '-q', '--allow-empty', '-m', 'user commit'); userCommit = 'committed'; } catch (error) { userCommit = String(error.stderr); }
    // Another writer moves the branch (a push, another tool): compare-and-swap must refuse.
    const tree = f.git(f.repo, 'rev-parse', 'feature/auth^{tree}'); const other = f.git(f.repo, 'commit-tree', tree, '-p', 'feature/auth', '-m', 'someone else');
    f.git(f.repo, 'update-ref', 'refs/heads/feature/auth', other);
  } } });
  const a = await worker(m, f, 'A', p => writeFileSync(join(p, 'src', 'api.js'), edit(api, 4, 'A')));
  await expectCode(() => m.applyEnvironment(a.id), 'BRANCH_MOVED');
  assert.match(userCommit, /index\.lock/, 'the user\'s commit was refused, not given half-applied files');
  assert.equal(f.git(f.repo, 'log', '-1', '--format=%s', 'feature/auth'), 'someone else', 'the other writer\'s commit is kept, never overwritten');
  assert.equal(readFileSync(join(f.repo, 'src', 'api.js'), 'utf8'), api, 'the checkout was put back');
  assert.equal(f.git(f.repo, 'status', '--porcelain'), '');
  assert.equal(m.getEnvironment(a.id).state, 'completed');
  assert.equal(m.applyEnvironment(a.id).state, 'integrated', 'a second Apply, after a fresh preview, lands');
  assert.match(readFileSync(join(f.repo, 'src', 'api.js'), 'utf8'), /^A$/m);
  assert.equal(f.git(f.repo, 'status', '--porcelain'), '');
});

test('the user\'s uncommitted edits: unrelated ones survive; overlapping ones refuse the Apply', async t => {
  const f = fixture(t); const m = f.manager();
  const a = await worker(m, f, 'A', p => writeFileSync(join(p, 'src', 'api.js'), edit(api, 1, 'A')));
  // Unrelated: an unstaged edit, a staged edit and an untracked file.
  writeFileSync(join(f.repo, 'README.md'), 'my unsaved notes\n');
  writeFileSync(join(f.repo, 'src', 'form.js'), edit(form, 9, 'staged by me')); f.git(f.repo, 'add', 'src/form.js');
  writeFileSync(join(f.repo, 'scratch.txt'), 'mine\n');
  m.applyEnvironment(a.id);
  assert.equal(readFileSync(join(f.repo, 'README.md'), 'utf8'), 'my unsaved notes\n');
  assert.match(readFileSync(join(f.repo, 'src', 'form.js'), 'utf8'), /staged by me/);
  assert.equal(f.git(f.repo, 'diff', '--cached', '--name-only'), 'src/form.js', 'my staged change is still staged');
  assert.equal(readFileSync(join(f.repo, 'scratch.txt'), 'utf8'), 'mine\n');
  assert.match(readFileSync(join(f.repo, 'src', 'api.js'), 'utf8'), /^A$/m);
  // Overlapping: an uncommitted edit to a file the result changes.
  const b = await worker(m, f, 'B', p => writeFileSync(join(p, 'README.md'), '# by B\n'));
  const before = state(f);
  const error = await expectCode(() => m.applyEnvironment(b.id), 'DIRTY_OVERLAP');
  assert.deepEqual(error.detail.paths, ['README.md']);
  assert.deepEqual(state(f), before);
  // An untracked file where the result adds one is overlap too.
  const c = await worker(m, f, 'C', p => writeFileSync(join(p, 'scratch.txt'), 'by C\n'));
  assert.deepEqual(m.previewApply(c.id).blockedBy, ['scratch.txt']);
});

test('worker commits and leftovers are applied together; the branch not checked out anywhere moves by ref only', async t => {
  const f = fixture(t); const m = f.manager();
  f.git(f.repo, 'checkout', '-q', 'main');
  const a = await worker(m, f, 'A', p => { writeFileSync(join(p, 'src', 'api.js'), 'committed\n'); f.git(p, 'commit', '-qam', 'worker commit'); writeFileSync(join(p, 'LEFT.md'), 'left over\n'); });
  m.applyEnvironment(a.id);
  assert.equal(f.git(f.repo, 'show', 'feature/auth:src/api.js'), 'committed');
  assert.equal(f.git(f.repo, 'show', 'feature/auth:LEFT.md'), 'left over');
  assert.equal(f.git(f.repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main'); assert.equal(f.git(f.repo, 'status', '--porcelain'), '');
});

test('conflict resolved in the worker\'s environment, never in the checkout, then applied', async t => {
  const f = fixture(t); const m = f.manager();
  const a = await worker(m, f, 'A', p => writeFileSync(join(p, 'src', 'api.js'), edit(api, 3, 'A was here')));
  const b = await worker(m, f, 'B', p => writeFileSync(join(p, 'src', 'api.js'), edit(api, 3, 'B was here')));
  m.applyEnvironment(a.id); await expectCode(() => m.applyEnvironment(b.id), 'CONFLICT');
  const checkout = readFileSync(join(f.repo, 'src', 'api.js'), 'utf8');
  const { conflicts } = m.updateFromBranch(b.id);
  assert.deepEqual(conflicts, ['src/api.js']);
  assert.match(readFileSync(join(m.getEnvironment(b.id).details.path, 'src', 'api.js'), 'utf8'), /<<<<<<< /, 'markers in the environment');
  assert.equal(readFileSync(join(f.repo, 'src', 'api.js'), 'utf8'), checkout, 'never in the checkout');
  // The worker resolves; the result is captured again; the preview is clean against the moved base.
  writeFileSync(join(m.getEnvironment(b.id).details.path, 'src', 'api.js'), edit(api, 3, 'A and B'));
  m.markRunning(b.id); m.markCompleted(b.id);
  assert.equal(m.previewApply(b.id).clean, true);
  m.applyEnvironment(b.id);
  assert.match(readFileSync(join(f.repo, 'src', 'api.js'), 'utf8'), /A and B/);
});

test('crash during Apply: reconcile finishes a landed Apply and rolls back one that did not land', async t => {
  const f = fixture(t);
  const crash = new Error('simulated crash');
  const m1 = f.manager({ hooks: { afterFiles: () => { throw crash; } } });
  const a = await worker(m1, f, 'A', p => writeFileSync(join(p, 'src', 'api.js'), edit(api, 6, 'A')));
  await assert.rejects(async () => m1.applyEnvironment(a.id), /simulated crash/);
  assert.equal(m1.getEnvironment(a.id).state, 'integrating');
  assert.match(readFileSync(join(f.repo, 'src', 'api.js'), 'utf8'), /^A$/m, 'files were updated, the branch was not');
  assert.throws(() => f.git(f.repo, 'commit', '-q', '--allow-empty', '-m', 'x'), /index\.lock/, 'until reconcile, Git in the checkout is held off');
  const report = f.manager().reconcile();
  assert.deepEqual(report.map(r => r.slice(1)), [['integrating', 'completed']]);
  assert.equal(readFileSync(join(f.repo, 'src', 'api.js'), 'utf8'), api, 'rolled back');
  assert.equal(f.git(f.repo, 'status', '--porcelain'), '');
  assert.equal(f.manager().applyEnvironment(a.id).state, 'integrated', 'and can be applied normally afterwards');
});

test('crash right after the branch moved: reconcile finishes the Apply (index put in place, lock released)', async t => {
  const f = fixture(t);
  const m1 = f.manager({ hooks: { afterLand: () => { throw new Error('crash after landing'); } } });
  const a = await worker(m1, f, 'A', p => writeFileSync(join(p, 'src', 'api.js'), edit(api, 7, 'A')));
  await assert.rejects(async () => m1.applyEnvironment(a.id), /crash after landing/);
  const commit = m1.getEnvironment(a.id).integration.commit;
  assert.equal(f.git(f.repo, 'rev-parse', 'feature/auth'), commit);
  assert.deepEqual(f.manager().reconcile().map(r => r.slice(1)), [['integrating', 'integrated']]);
  assert.equal(f.git(f.repo, 'status', '--porcelain'), '', 'the index matches the new branch head');
  f.git(f.repo, 'commit', '-q', '--allow-empty', '-m', 'the user can commit again');
});
