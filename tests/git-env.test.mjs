import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { removeLater } from './support/cleanup.mjs';
import { git, inspectProject } from '../src/core/project.mjs';
import { checkoutBaseline, sessionChanges } from '../src/core/changes.mjs';
import { committedMatches, diffText } from '../src/core/hunks.mjs';
import { listGitWorktrees, validateBranchName } from '../src/core/workspaces.mjs';
import { branchDraft, commitsSince, isCommit } from '../src/core/status.mjs';
import { folderStatus } from '../src/core/projects.mjs';

// Every Git runner uses gitEnv(), so a Journal started from a Git hook or an
// editor terminal (which can export GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE)
// never reads or writes another repository.

function repo(root, name, files, branch = 'main') {
  const dir = resolve(root, name); mkdirSync(dir, { recursive: true });
  const run = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
  run('init', '-q', '-b', branch);
  for (const [path, content] of Object.entries(files)) { mkdirSync(resolve(dir, path, '..'), { recursive: true }); writeFileSync(resolve(dir, path), content); }
  run('add', '.'); run('-c', 'user.name=Fixture', '-c', 'user.email=test@example.test', 'commit', '-qm', `${name} first`);
  return { dir, run, head: run('rev-parse', 'HEAD') };
}

const REDIRECT = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR'];

test('an inherited GIT_DIR cannot redirect any Git runner to another repository', t => {
  const root = mkdtempSync(resolve(process.env.JOURNAL_TEST_TMP ?? tmpdir(), 'journal-git-env-'));
  t.after(() => removeLater(root));
  const real = repo(root, 'real', { 'README.md': '# Real\n', 'src/app.mjs': 'export const app = 1;\n' }, 'main');
  const decoy = repo(root, 'decoy', { 'decoy-only.md': 'decoy\n' }, 'decoy-branch');
  writeFileSync(resolve(real.dir, 'src/app.mjs'), 'export const app = 2;\n');
  const appHash = createHash('sha256').update('export const app = 1;\n').digest('hex');

  const saved = Object.fromEntries(REDIRECT.map(name => [name, process.env[name]]));
  Object.assign(process.env, { GIT_DIR: resolve(decoy.dir, '.git'), GIT_WORK_TREE: decoy.dir, GIT_INDEX_FILE: resolve(decoy.dir, '.git', 'index'),
    GIT_OBJECT_DIRECTORY: resolve(decoy.dir, '.git', 'objects'), GIT_COMMON_DIR: resolve(decoy.dir, '.git') });
  try {
    // Sanity: without gitEnv the decoy wins, so the assertions below prove the stripping.
    assert.equal(execFileSync('git', ['-C', real.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), decoy.head);

    // project.mjs (also used by status.mjs, store.mjs, projects.mjs and evidence.mjs)
    assert.equal(git(real.dir, ['rev-parse', 'HEAD']), real.head);
    const project = inspectProject(real.dir);
    assert.equal(project.head, real.head); assert.equal(project.branch, 'main');
    // projects.mjs
    const folder = folderStatus({ path: real.dir, kind: 'git' });
    assert.equal(folder.head, real.head); assert.equal(folder.currentBranch, 'main');

    // status.mjs
    assert.equal(isCommit(real.dir, real.head), true); assert.equal(isCommit(real.dir, decoy.head), false);
    assert.equal(commitsSince(real.dir, real.head), 0);
    const draft = branchDraft(project, null).statement;
    assert.match(draft, /real first/); assert.doesNotMatch(draft, /decoy first/); assert.match(draft, /Uncommitted: 1 file \(src\/app.mjs\)/);

    // changes.mjs
    const baseline = checkoutBaseline(project);
    assert.deepEqual(baseline.dirty, ['src/app.mjs']);
    const changes = sessionChanges(project, { baseline: { head: real.head, dirty: [] } });
    assert.equal(changes.available, true); assert.deepEqual(changes.files.map(file => file.path), ['src/app.mjs']);

    // hunks.mjs
    assert.equal(committedMatches(real.dir, real.head, 'src/app.mjs', appHash), true);
    assert.match(diffText(real.dir, real.head, 'src/app.mjs') ?? '', /\+export const app = 2;/);

    // workspaces.mjs
    const worktrees = listGitWorktrees(real.dir);
    assert.equal(worktrees.length, 1); assert.equal(worktrees[0].branch, 'main');
    assert.doesNotThrow(() => validateBranchName(real.dir, 'feature/x'));
  } finally {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
  // The decoy repository is untouched: no index written, no new commit.
  assert.equal(decoy.run('rev-parse', 'HEAD'), decoy.head);
  assert.equal(decoy.run('status', '--porcelain'), '');
});
