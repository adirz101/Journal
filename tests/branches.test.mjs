import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { JournalStore } from '../src/core/store.mjs';
import { listBranches, switchFailure } from '../src/core/branches.mjs';
import { removeLater } from './support/cleanup.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=a', '-c', 'user.email=a@a', ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
const commit = (repo, file, body, message) => { writeFileSync(join(repo, file), body); git(repo, 'add', '.'); git(repo, 'commit', '-qm', message); };

// A primary repository cloned from a bare origin (so it has remote-tracking branches), with
// local branches, and an added Git folder that is its own repository.
function fixture(t) {
  const root = realpathSync.native(mkdtempSync(join(process.env.JOURNAL_TEST_TMP ?? tmpdir(), 'branches-')));
  const seed = join(root, 'seed'); const origin = join(root, 'origin.git'); const repo = join(root, 'repo'); const api = join(root, 'api');
  mkdirSync(seed); git(seed, 'init', '-q', '-b', 'main'); commit(seed, 'README.md', 'one\n', 'init');
  git(seed, 'switch', '-qc', 'remote-only'); commit(seed, 'remote.txt', 'r\n', 'remote work'); git(seed, 'switch', '-q', 'main');
  execFileSync('git', ['clone', '-q', '--bare', seed, origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', '-q', origin, repo], { stdio: 'pipe' });
  git(repo, 'switch', '-qc', 'feature/login'); commit(repo, 'login.txt', 'login\n', 'Add login'); git(repo, 'switch', '-q', 'main');
  git(repo, 'branch', 'Fix-Typo');
  mkdirSync(api); git(api, 'init', '-q', '-b', 'develop'); commit(api, 'api.txt', 'api\n', 'api init'); git(api, 'branch', 'release');
  const store = new JournalStore(join(root, 'journal.sqlite')); const project = store.openProject(repo);
  const folder = store.addProjectRoot(project.id, api).roots.at(-1);
  t.after(() => { store.close(); removeLater(root); });
  return { root, repo, api, store, project, folderKey: `root:${folder.id}`, worktreeRoot: join(root, 'worktrees') };
}
const liveSession = (f, overrides = {}) => f.store.saveSession({ id: `s-${Math.random().toString(16).slice(2)}`, projectId: f.project.id, provider: 'claude', status: 'running', title: 'Fix login', createdAt: new Date().toISOString(), receiptId: 'r', workspaceId: null, cwd: f.repo, ...overrides });

test('lists local branches first (current first), then remote-only branches, from for-each-ref', t => {
  const f = fixture(t);
  const list = f.store.listBranches(f.project.id, 'checkout');
  assert.equal(list.branch, 'main'); assert.equal(list.detached, false); assert.equal(list.blocked, null);
  assert.equal(list.local[0].name, 'main'); assert.equal(list.local[0].current, true); assert.equal(list.local[0].upstream, 'origin/main');
  assert.deepEqual(list.local.map(b => b.name).sort(), ['Fix-Typo', 'feature/login', 'main']);
  const login = list.local.find(b => b.name === 'feature/login');
  assert.equal(login.subject, 'Add login'); assert.match(login.date, /^\d{4}-/); assert.match(login.commit, /^[0-9a-f]{40}$/);
  // origin/main is main's upstream and origin/HEAD is a symbolic ref: neither is listed again.
  assert.deepEqual(list.remote.map(b => [b.name, b.localName]), [['origin/remote-only', 'remote-only']]);
  assert.equal(list.truncated, false);
});

test('a branch checked out in another worktree is marked with that worktree', t => {
  const f = fixture(t);
  const ws = f.store.createWorkspace(f.project.id, { branch: 'side', base: 'main' }, f.worktreeRoot);
  const side = f.store.listBranches(f.project.id, 'checkout').local.find(b => b.name === 'side');
  assert.equal(side.worktree, ws.path); assert.equal(side.worktreeKey, ws.id); assert.match(side.worktreeLabel, /worktree side/);
  // From the worktree, main is the occupied one (in the checkout).
  const main = f.store.listBranches(f.project.id, ws.id).local.find(b => b.name === 'main');
  assert.equal(main.worktreeKey, 'checkout');
  assert.throws(() => f.store.switchBranch(f.project.id, 'checkout', { kind: 'local', name: 'side' }), /side is checked out in .*worktree side.*root picker/);
  assert.equal(git(f.repo, 'branch', '--show-current'), 'main');
});

test('switches the checkout, refreshes the project and records an audit entry', t => {
  const f = fixture(t);
  const result = f.store.switchBranch(f.project.id, 'checkout', { kind: 'local', name: 'feature/login' });
  assert.equal(result.branch, 'feature/login'); assert.equal(result.previous, 'main'); assert.equal(result.created, false);
  assert.equal(git(f.repo, 'branch', '--show-current'), 'feature/login');
  assert.equal(f.store.project(f.project.id).branch, 'feature/login');
  assert.equal(f.store.fileRoots(f.project.id).primary[0].branch, 'feature/login');
  assert.ok(f.store.listAudit().some(a => a.action === 'branch-switched' && a.body.to === 'feature/login' && a.body.from === 'main' && a.body.root === 'checkout'));
  // Switching to the current branch changes nothing and records nothing.
  const before = f.store.listAudit().length;
  assert.equal(f.store.switchBranch(f.project.id, 'checkout', { kind: 'local', name: 'feature/login' }).unchanged, true);
  assert.equal(f.store.listAudit().length, before);
});

test('a worktree switches on its own and its record follows', t => {
  const f = fixture(t);
  const ws = f.store.createWorkspace(f.project.id, { branch: 'side', base: 'main' }, f.worktreeRoot);
  f.store.switchBranch(f.project.id, ws.id, { kind: 'local', name: 'Fix-Typo' });
  assert.equal(git(ws.path, 'branch', '--show-current'), 'Fix-Typo'); assert.equal(git(f.repo, 'branch', '--show-current'), 'main');
  assert.equal(f.store.getWorkspace(ws.id).branch, 'Fix-Typo');
});

test('a remote-only branch creates its local tracking branch', t => {
  const f = fixture(t);
  const result = f.store.switchBranch(f.project.id, 'checkout', { kind: 'remote', name: 'origin/remote-only' });
  assert.equal(result.branch, 'remote-only'); assert.equal(result.created, true); assert.equal(result.from, 'origin/remote-only');
  assert.equal(git(f.repo, 'rev-parse', '--abbrev-ref', 'remote-only@{upstream}'), 'origin/remote-only');
  assert.equal(readFileSync(join(f.repo, 'remote.txt'), 'utf8'), 'r\n');
  // Now tracked locally, the remote branch is no longer listed separately.
  assert.deepEqual(f.store.listBranches(f.project.id, 'checkout').remote, []);
  assert.ok(f.store.listAudit().some(a => a.action === 'branch-switched' && a.body.created === true && a.body.remote === 'origin/remote-only'));
});

test('a remote branch whose local name already exists is refused', t => {
  const f = fixture(t);
  git(f.repo, 'branch', 'remote-only', 'main');
  const remote = f.store.listBranches(f.project.id, 'checkout').remote.find(b => b.name === 'origin/remote-only');
  assert.equal(remote.conflict, 'remote-only');
  assert.throws(() => f.store.switchBranch(f.project.id, 'checkout', { kind: 'remote', name: 'origin/remote-only' }), /local branch named remote-only already exists/);
});

test('refuses while a session runs in that repository; another repository is not blocked', t => {
  const f = fixture(t);
  liveSession(f, { status: 'waiting' });
  assert.match(f.store.listBranches(f.project.id, 'checkout').blocked, /“Fix login” is running in .*\(checkout\)/);
  assert.throws(() => f.store.switchBranch(f.project.id, 'checkout', { kind: 'local', name: 'feature/login' }), /Not switched: “Fix login” is running/);
  assert.equal(git(f.repo, 'branch', '--show-current'), 'main');
  // The added folder is its own repository: a session in the checkout does not block it.
  assert.equal(f.store.listBranches(f.project.id, f.folderKey).blocked, null);
  // A session in a folder blocks that folder only.
  liveSession(f, { workspaceId: f.folderKey, cwd: f.api, title: 'API work' });
  assert.match(f.store.listBranches(f.project.id, f.folderKey).blocked, /“API work” is running in api/);
});

test('a session whose cwd is inside the repository blocks it too', t => {
  const f = fixture(t);
  mkdirSync(join(f.repo, 'sub'));
  // Recorded under another project, but running inside this checkout.
  const other = f.store.openProject(f.api);
  liveSession(f, { projectId: other.id, cwd: join(f.repo, 'sub'), title: 'Elsewhere' });
  assert.match(f.store.listBranches(f.project.id, 'checkout').blocked, /“Elsewhere” is running/);
});

test('ended sessions do not block', t => {
  const f = fixture(t);
  liveSession(f, { status: 'exited' });
  assert.equal(f.store.switchBranch(f.project.id, 'checkout', { kind: 'local', name: 'Fix-Typo' }).branch, 'Fix-Typo');
});

test('Git refuses to overwrite uncommitted changes and the working tree is left as it was', t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'README.md'), 'local edit\n');
  git(f.repo, 'switch', '-q', 'feature/login'); commit(f.repo, 'README.md', 'login readme\n', 'readme on login'); git(f.repo, 'switch', '-q', 'main');
  writeFileSync(join(f.repo, 'README.md'), 'local edit\n');
  const status = git(f.repo, 'status', '--porcelain');
  assert.throws(() => f.store.switchBranch(f.project.id, 'checkout', { kind: 'local', name: 'feature/login' }), /Not switched to feature\/login: your uncommitted changes to README\.md would be overwritten\. .*Nothing was changed/);
  assert.equal(git(f.repo, 'branch', '--show-current'), 'main');
  assert.equal(readFileSync(join(f.repo, 'README.md'), 'utf8'), 'local edit\n');
  assert.equal(git(f.repo, 'status', '--porcelain'), status);
  assert.equal(git(f.repo, 'stash', 'list'), '', 'nothing was stashed');
  assert.ok(!f.store.listAudit().some(a => a.action === 'branch-switched'));
});

test('uncommitted changes that do not conflict are carried over, as git switch does', t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'notes.txt'), 'untracked\n');
  f.store.switchBranch(f.project.id, 'checkout', { kind: 'local', name: 'Fix-Typo' });
  assert.equal(readFileSync(join(f.repo, 'notes.txt'), 'utf8'), 'untracked\n');
});

test('the added Git folder switches independently of the primary checkout', t => {
  const f = fixture(t);
  const list = f.store.listBranches(f.project.id, f.folderKey);
  assert.equal(list.label, 'api'); assert.equal(list.branch, 'develop'); assert.deepEqual(list.local.map(b => b.name).sort(), ['develop', 'release']);
  f.store.switchBranch(f.project.id, f.folderKey, { kind: 'local', name: 'release' });
  assert.equal(git(f.api, 'branch', '--show-current'), 'release'); assert.equal(git(f.repo, 'branch', '--show-current'), 'main');
  assert.equal(f.store.fileRoots(f.project.id).folders[0].branch, 'release');
});

test('a detached HEAD lists no current branch and can switch to one', t => {
  const f = fixture(t);
  git(f.repo, 'switch', '-q', '--detach', 'HEAD');
  const list = f.store.listBranches(f.project.id, 'checkout');
  assert.equal(list.branch, null); assert.equal(list.detached, true); assert.ok(!list.local.some(b => b.current));
  assert.equal(f.store.switchBranch(f.project.id, 'checkout', { kind: 'local', name: 'main' }).previous, null);
  assert.equal(git(f.repo, 'branch', '--show-current'), 'main');
});

test('bad requests are refused before Git runs', t => {
  const f = fixture(t);
  assert.throws(() => f.store.switchBranch(f.project.id, 'checkout', { kind: 'local', name: '--force' }), /Invalid branch name/);
  assert.throws(() => f.store.switchBranch(f.project.id, 'checkout', { kind: 'local', name: 'a..b' }), /Invalid branch name/);
  assert.throws(() => f.store.switchBranch(f.project.id, 'checkout', { kind: 'local', name: 'gone' }), /no longer exists/);
  assert.throws(() => f.store.switchBranch(f.project.id, 'checkout', { kind: 'other', name: 'main' }), /Choose a branch/);
  assert.throws(() => f.store.switchBranch(f.project.id, 'checkout', { kind: 'remote', name: 'origin/nope' }), /no longer exists/);
  assert.throws(() => f.store.listBranches(f.project.id, 'root:unknown'), /no longer part of this project/);
});

test('a plain folder has no branches', t => {
  const f = fixture(t);
  const plain = join(f.root, 'plain'); mkdirSync(plain);
  const key = `root:${f.store.addProjectRoot(f.project.id, plain).roots.at(-1).id}`;
  assert.throws(() => f.store.listBranches(f.project.id, key), /plain is not a Git repository/);
});

test('listing is bounded', t => {
  const f = fixture(t);
  for (let i = 0; i < 12; i++) git(f.repo, 'branch', `bulk-${i}`);
  const list = listBranches(f.repo, { limit: 5 });
  assert.equal(list.local.length, 5); assert.equal(list.truncated, true);
});

test('git refusals read as plain sentences', () => {
  assert.match(switchFailure('error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt\n\tb.txt\nPlease commit your changes or stash them before you switch branches.\nAborting', 'x'), /^Not switched to x: your uncommitted changes to a\.txt, b\.txt would be overwritten/);
  assert.match(switchFailure('error: The following untracked working tree files would be overwritten by checkout:\n\tnew.txt\nPlease move or remove them before you switch branches.\nAborting', 'x'), /untracked files \(new\.txt\) are in the way/);
  assert.match(switchFailure('fatal: you need to resolve your current index first', 'x'), /merge, rebase or conflict is in progress/);
  assert.equal(switchFailure('fatal: something odd', 'x'), 'Git did not switch to x: something odd.');
});
