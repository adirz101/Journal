import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { JournalStore } from '../src/core/store.mjs';
import { nestedTrees, treeBase } from '../src/core/changes.mjs';
import { removeLater } from './support/cleanup.mjs';

// Files → Changed also lists other Git working trees inside the checkout that the session worked
// in: a worktree in an ignored folder (.worktrees/name), which the checkout's Git never sees.
function fixture(t) {
  const root = realpathSync.native(mkdtempSync(resolve(process.env.JOURNAL_TEST_TMP ?? tmpdir(), 'changes-trees-')));
  const repo = join(root, 'repo'); mkdirSync(repo);
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=a', '-c', 'user.email=a@a', ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
  git(repo, 'init', '-q', '-b', 'main');
  mkdirSync(join(repo, 'src')); writeFileSync(join(repo, 'src', 'app.js'), 'one\n'); writeFileSync(join(repo, '.gitignore'), '.worktrees/\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init');
  const tree = join(repo, '.worktrees', 'feat');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat', tree);
  const store = new JournalStore(join(root, 'journal.sqlite')); const project = store.openProject(repo);
  t.after(() => { store.close(); removeLater(root); });
  const view = store.view(project.id, null);
  const session = { id: 's1', projectId: project.id, provider: 'claude', nativeId: null, nativeIdConfirmed: true, status: 'running', receiptId: store.prepareContext(project.id, '').id,
    createdAt: new Date(Date.now() - 60_000).toISOString(), head: view.head, branch: view.branch, cwd: repo, baseline: store.checkoutBaseline(project.id, null), survivors: [] };
  store.saveSession(session);
  return { root, repo, tree, git, store, session };
}

test('a worktree inside the checkout that the session edited is listed with its own branch and base', t => {
  const f = fixture(t);
  // Main moves on after the session started; the worktree is rebased onto it (main's commit comes along).
  writeFileSync(join(f.repo, 'src', 'main-only.js'), 'main\n'); f.git(f.repo, 'add', '-A'); f.git(f.repo, 'commit', '-qm', 'main moves on');
  f.git(f.tree, 'rebase', '-q', 'main');
  // The agent's own work there: one commit and one uncommitted edit; and one edit in the checkout.
  writeFileSync(join(f.tree, 'src', 'feature.js'), 'feature\n'); f.git(f.tree, 'add', '-A'); f.git(f.tree, 'commit', '-qm', 'Add the feature');
  writeFileSync(join(f.tree, 'src', 'app.js'), 'one\ntwo\n');
  writeFileSync(join(f.repo, 'notes.md'), 'n\n');
  f.store.appendEvent('s1', 'file', { path: '.worktrees/feat/src/app.js', tool: 'Edit' });
  const changes = f.store.sessionChanges('s1');
  assert.deepEqual(changes.trees.map(t => [t.path, t.branch, t.commitsSince, t.files]), [['.worktrees/feat', 'feat', 1, 2]]);
  // The checkout's own view still has main's new commit (it is in the checkout since the start); the
  // worktree's view does not, although the rebase gave that commit a new date there.
  assert.deepEqual(changes.files.map(file => file.path).sort(), ['.worktrees/feat/src/app.js', '.worktrees/feat/src/feature.js', 'notes.md', 'src/main-only.js']);
  assert.ok(!changes.files.some(file => file.path === '.worktrees/feat/src/main-only.js'), 'A commit from main is not the session\'s work in the worktree');
  assert.equal(changes.files.find(file => file.path.endsWith('feature.js')).additions, 1);
  // Its diff and opening work on the listed path.
  assert.match(f.store.sessionFileDiff('s1', '.worktrees/feat/src/app.js').text, /^\+two$/m);
  assert.match(f.store.sessionFileDiff('s1', '.worktrees/feat/src/feature.js').text, /^\+feature$/m);
  assert.equal(f.store.openableFile('s1', '.worktrees/feat/src/feature.js').path, join(f.tree, 'src', 'feature.js'));
  assert.throws(() => f.store.sessionFileDiff('s1', '.worktrees/feat/src/main-only.js'), /not in this session's changes/);
  assert.throws(() => f.store.sessionFileDiff('s1', '.worktrees/feat/../../outside.txt'), /path|changes/i);
});

test('a command run in the worktree is enough; a worktree the session never touched is not listed', t => {
  const f = fixture(t);
  writeFileSync(join(f.tree, 'src', 'app.js'), 'changed by a script\n');
  assert.deepEqual(f.store.sessionChanges('s1').trees, [], 'Nothing recorded there yet');
  f.store.appendEvent('s1', 'command-start', { toolUseId: 'c1', command: 'python3 gen.py', cwd: '.worktrees/feat/src' });
  const changes = f.store.sessionChanges('s1');
  assert.deepEqual([changes.trees.map(t => t.path), changes.files.map(file => file.path)], [['.worktrees/feat'], ['.worktrees/feat/src/app.js']]);
  assert.equal(changes.trees[0].commitsSince, 0, 'No commit: the base is its HEAD');
});

test('nested trees: the outermost below the checkout, never the checkout itself or outside it', t => {
  const f = fixture(t);
  assert.deepEqual(nestedTrees(f.repo, [join(f.repo, 'src'), f.repo, join(f.root)]), []);
  assert.deepEqual(nestedTrees(f.repo, [join(f.tree, 'src'), f.tree, join(f.tree, 'missing')]).map(t => t.prefix), ['.worktrees/feat/']);
  // A base for a session whose start is unknown is HEAD.
  assert.equal(treeBase(f.tree, undefined), f.git(f.tree, 'rev-parse', 'HEAD'));
});
