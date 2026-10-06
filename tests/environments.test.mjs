import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { JournalStore } from '../src/core/store.mjs';
import { LIFECYCLE } from '../src/core/environments.mjs';
import { removeLater } from './support/cleanup.mjs';

// Isolated sessions are a macOS milestone: on Windows only the refusal is tested.
const windows = process.platform === 'win32';
const it = windows ? (name, fn) => test(name, { skip: 'isolated sessions are macOS only in this milestone' }, fn) : test;

// Isolated sessions (src/core/environments.mjs) through Journal's store, on real temporary
// repositories: creation, private refs, results, the previewed Apply (clean, conflict, race,
// dirty checkout), resolve in the environment, abandon and restore, cleanup refusals, recovery,
// and what receipts, notes, Files and Changes see. No provider CLI.
const lines = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n';
const edit = (text, line, value) => { const all = text.split('\n'); all[line - 1] = value; return all.join('\n'); };
const API = lines('api', 10); const FORM = lines('form', 10);

function fixture(t, environments = {}) {
  const root = realpathSync.native(mkdtempSync(resolve(process.env.JOURNAL_TEST_TMP ?? tmpdir(), 'env-')));
  const repo = join(root, 'project'); mkdirSync(repo); const data = join(root, 'data'); mkdirSync(data);
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=User', '-c', 'user.email=user@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(repo, 'init', '-q', '-b', 'main'); mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n*.log\n'); writeFileSync(join(repo, 'src', 'api.js'), API); writeFileSync(join(repo, 'src', 'form.js'), FORM); writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init'); git(repo, 'checkout', '-q', '-b', 'feature/auth');
  const open = (extra = {}) => new JournalStore(join(data, 'journal.sqlite'), { environmentRoot: data, environments: { probe: async () => true, ...environments, ...extra } });
  const store = open(); const project = store.openProject(repo);
  const stores = [store];
  t.after(() => { for (const s of stores) { try { s.close(); } catch {} } removeLater(root); });
  // A session as the runtime stores it, working in an environment.
  const session = (environmentId, status = 'running', s = store) => {
    const receipt = s.prepareContext(project.id, 'task', { workspaceId: environmentId });
    const record = { id: `s-${Math.random().toString(16).slice(2)}`, projectId: project.id, provider: 'claude', nativeId: null, nativeIdConfirmed: true, status, receiptId: receipt.id,
      createdAt: new Date().toISOString(), workspaceId: environmentId, environmentId, cwd: s.getWorkspace(environmentId).path, survivors: [] };
    s.saveSession(record); return { ...record, receipt };
  };
  const worker = async (task, change, s = store) => {
    const env = await s.createEnvironment({ projectId: project.id, logicalBranch: 'feature/auth', task });
    const sess = session(env.id, 'running', s); s.attachEnvironmentSession(env.id, sess.id);
    change(env.details.path, git);
    s.saveSession({ ...s.getSession(sess.id), status: 'exited' }); s.syncEnvironment({ ...s.getSession(sess.id) });
    return s.getEnvironment(env.id);
  };
  return { root, repo, data, git, store, project, session, worker, reopen: extra => { const s = open(extra); stores.push(s); return s; } };
}
const checkout = f => ({ head: f.git(f.repo, 'rev-parse', 'feature/auth'), index: readFileSync(join(f.repo, '.git', 'index')), api: readFileSync(join(f.repo, 'src', 'api.js'), 'utf8'), status: f.git(f.repo, 'status', '--porcelain') });
async function rejects(fn, code) { try { await fn(); } catch (error) { assert.equal(error.code, code, error.message); return error; } assert.fail(`expected ${code}`); }

it('creation: detached at the branch commit, outside the checkout, private refs, lock and marker; the branch list stays clean', async t => {
  const f = fixture(t);
  const envs = await Promise.all(['A', 'B', 'C'].map(task => f.store.createEnvironment({ projectId: f.project.id, logicalBranch: 'feature/auth', task })));
  const base = f.git(f.repo, 'rev-parse', 'feature/auth');
  for (const env of envs) {
    assert.deepEqual([env.state, env.base, env.folder], ['ready', base, true]);
    assert.equal(f.git(env.details.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');
    assert.ok(env.details.path.startsWith(join(f.data, 'env')));
    assert.equal(f.git(f.repo, 'rev-parse', env.details.refs.base), base);
  }
  assert.match(f.git(f.repo, 'worktree', 'list', '--porcelain'), /locked journal env/);
  assert.deepEqual(f.git(f.repo, 'branch', '--format=%(refname:short)').split('\n').sort(), ['feature/auth', 'main']);
  assert.equal(new Set(envs.map(e => e.ports[0])).size, 3);
  assert.deepEqual(f.store.listWorkspaces(f.project.id).workspaces, [], 'not offered as workspaces');
  assert.ok(!f.store.listWorkspaces(f.project.id).importable.some(w => w.path.includes(join(f.data, 'env'))), 'nor as importable worktrees');
  assert.ok(LIFECYCLE.includes('cleanup_pending'));
  await rejects(() => f.store.createEnvironment({ projectId: f.project.id, logicalBranch: 'no/such' }), 'NOT_FOUND');
  await rejects(() => f.store.createEnvironment({ projectId: f.project.id, logicalBranch: '--force' }), 'INVALID_BRANCH');
});

it('a session in an environment: its folder, logical branch, launch variables; receipts and notes follow the logical branch', async t => {
  const f = fixture(t);
  const note = f.store.proposeMemory(f.project.id, { statement: 'Auth tokens refresh in the gateway, never in the form', category: 'decision', scope: 'branch', area: '', source: { kind: 'user', note: 'team' } });
  f.store.setMemoryStatus(note.id, 'active');
  const env = await f.store.createEnvironment({ projectId: f.project.id, logicalBranch: 'feature/auth', task: 'tokens' });
  // The user's checkout moves to main: the isolated session still works for feature/auth.
  f.git(f.repo, 'checkout', '-q', 'main');
  const view = f.store.view(f.project.id, env.id);
  assert.deepEqual([view.root, view.branch, view.isolated.logicalBranch], [env.details.path, 'feature/auth', 'feature/auth']);
  const receipt = f.store.prepareContext(f.project.id, 'refresh tokens', { workspaceId: env.id });
  assert.ok(receipt.items.some(item => item.id === note.id), 'the branch note reaches the isolated session');
  assert.deepEqual(receipt.environment, { id: env.id, base: env.base, logicalBranch: 'feature/auth' });
  assert.equal(f.store.prepareContext(f.project.id, 'refresh tokens').items.some(item => item.id === note.id), false, 'the checkout (now main) does not get it');
  const vars = f.store.environmentLaunch(env.id);
  assert.deepEqual([vars.JOURNAL_ENV_ID, vars.JOURNAL_ENV_BASE, vars.JOURNAL_LOGICAL_BRANCH, vars.JOURNAL_PORT, vars.JOURNAL_PORT_COUNT], [env.id, env.base, 'feature/auth', String(env.ports[0]), '10']);
  assert.equal(vars.JOURNAL_PORTS, env.ports.join(','));
  assert.ok(vars.TMPDIR.startsWith(env.details.tmpDir) && vars.TEMP === env.details.tmpDir && vars.JOURNAL_ENV_LOG_DIR === env.details.logDir);
  // Files: the environment is a root; Changed compares with its recorded base.
  const roots = f.store.fileRoots(f.project.id).primary;
  assert.ok(roots.some(root => root.key === env.id && root.kind === 'isolated' && root.branch === 'feature/auth'));
  const sess = f.session(env.id);
  writeFileSync(join(env.details.path, 'src', 'api.js'), edit(API, 1, 'changed in isolation')); writeFileSync(join(env.details.path, 'NEW.md'), 'n\n');
  const changes = f.store.sessionChanges(sess.id);
  assert.deepEqual([changes.base, changes.files.map(file => file.path).sort()], [env.base, ['NEW.md', 'src/api.js']]);
  assert.equal(f.git(f.repo, 'status', '--porcelain'), '', 'the checkout never changed');
});

it('result: commits, staged, unstaged and untracked work; the worker\'s index untouched; sensitive files left out; idempotent', async t => {
  const f = fixture(t);
  const env = await f.store.createEnvironment({ projectId: f.project.id, logicalBranch: 'feature/auth' }); const p = env.details.path;
  writeFileSync(join(p, 'src', 'api.js'), 'committed\n'); f.git(p, 'commit', '-qam', 'worker commit');
  writeFileSync(join(p, 'src', 'form.js'), 'staged\n'); f.git(p, 'add', 'src/form.js');
  writeFileSync(join(p, 'README.md'), 'unstaged\n'); writeFileSync(join(p, 'NEW.md'), 'untracked\n'); writeFileSync(join(p, 'debug.log'), 'ignored\n');
  writeFileSync(join(p, '.env'), 'TOKEN=secret\n');
  const gitPath = f.git(p, 'rev-parse', '--git-path', 'index'); const indexFile = isAbsolute(gitPath) ? gitPath : join(p, gitPath);
  const index = readFileSync(indexFile); const status = f.git(p, 'status', '--porcelain');
  const result = f.store.snapshotEnvironment(env.id).result;
  assert.deepEqual(result.files.map(x => `${x.status} ${x.path}`).sort(), ['A NEW.md', 'M README.md', 'M src/api.js', 'M src/form.js']);
  assert.deepEqual(result.excluded, ['.env'], 'a new file with a sensitive name is left out and listed');
  assert.deepEqual(readFileSync(indexFile), index); assert.equal(f.git(p, 'status', '--porcelain'), status);
  const message = f.git(f.repo, 'log', '-1', '--format=%B', result.id);
  assert.match(message, new RegExp(`Journal-Environment: ${env.id}`)); assert.match(message, /Journal-Logical-Branch: feature\/auth/);
  assert.equal(f.store.snapshotEnvironment(env.id).result.id, result.id, 'unchanged content: the same result');
});

it('Apply: clean, then the second worker is re-previewed against the moved branch; history and checkout follow', async t => {
  const f = fixture(t);
  const a = await f.worker('backend', p => writeFileSync(join(p, 'src', 'api.js'), edit(API, 2, 'line 2 by A')));
  const b = await f.worker('form', p => writeFileSync(join(p, 'src', 'api.js'), edit(API, 8, 'line 8 by B')));
  assert.deepEqual([a.state, b.state], ['completed', 'completed'], 'the session\'s end captured each result');
  const first = f.store.previewEnvironmentApply(b.id); assert.deepEqual([first.clean, first.moved], [true, false]);
  const applied = f.store.applyEnvironment(a.id);
  assert.equal(applied.state, 'integrated');
  const second = f.store.previewEnvironmentApply(b.id);
  assert.deepEqual([second.clean, second.moved, second.commitsSince], [true, true, 1]);
  f.store.applyEnvironment(b.id);
  const text = readFileSync(join(f.repo, 'src', 'api.js'), 'utf8'); assert.match(text, /line 2 by A/); assert.match(text, /line 8 by B/);
  assert.deepEqual(f.git(f.repo, 'log', '--format=%s', '-3').split('\n'), ['Apply form', 'Apply backend', 'init']);
  assert.equal(f.git(f.repo, 'status', '--porcelain'), '');
  const events = f.store.listEvents(f.store.getEnvironment(a.id).sessionId).filter(e => e.kind === 'environment').map(e => e.body.action);
  assert.deepEqual(events, ['created', 'result', 'apply-started', 'applied']);
});

it('Apply refuses without writing: same lines, delete versus edit, overlapping uncommitted work', async t => {
  const f = fixture(t);
  const a = await f.worker('A', p => writeFileSync(join(p, 'src', 'api.js'), edit(API, 3, 'A')));
  const b = await f.worker('B', p => writeFileSync(join(p, 'src', 'api.js'), edit(API, 3, 'B')));
  const c = await f.worker('C', p => rmSync(join(p, 'src', 'form.js')));
  const d = await f.worker('D', p => writeFileSync(join(p, 'src', 'form.js'), edit(FORM, 4, 'D')));
  f.store.applyEnvironment(a.id);
  let before = checkout(f);
  assert.deepEqual((await rejects(() => f.store.applyEnvironment(b.id), 'CONFLICT')).detail.conflicts, [{ path: 'src/api.js', kind: 'content' }]);
  assert.deepEqual(checkout(f), before); assert.equal(f.store.getEnvironment(b.id).state, 'conflict');
  f.store.applyEnvironment(c.id); before = checkout(f);
  const dd = await rejects(() => f.store.applyEnvironment(d.id), 'CONFLICT'); assert.match(dd.detail.conflicts[0].kind, /modify\/delete/);
  assert.deepEqual(checkout(f), before);
  const e = await f.worker('E', p => writeFileSync(join(p, 'README.md'), '# by E\n'));
  writeFileSync(join(f.repo, 'README.md'), 'my unsaved notes\n'); before = checkout(f);
  assert.deepEqual((await rejects(() => f.store.applyEnvironment(e.id), 'DIRTY_OVERLAP')).detail.paths, ['README.md']);
  assert.deepEqual(checkout(f), before); assert.equal(f.store.getEnvironment(e.id).state, 'completed');
  assert.deepEqual(f.store.environmentsOverview(f.project.id).conflict.map(x => x.task), ['B', 'D']);
});

it('Apply keeps the user\'s unrelated staged, unstaged and untracked work', async t => {
  const f = fixture(t);
  const a = await f.worker('A', p => writeFileSync(join(p, 'src', 'api.js'), edit(API, 1, 'A')));
  writeFileSync(join(f.repo, 'README.md'), 'mine\n'); writeFileSync(join(f.repo, 'src', 'form.js'), edit(FORM, 9, 'staged by me')); f.git(f.repo, 'add', 'src/form.js'); writeFileSync(join(f.repo, 'scratch.txt'), 'x\n');
  f.store.applyEnvironment(a.id);
  assert.equal(readFileSync(join(f.repo, 'README.md'), 'utf8'), 'mine\n');
  assert.equal(f.git(f.repo, 'diff', '--cached', '--name-only'), 'src/form.js');
  assert.ok(existsSync(join(f.repo, 'scratch.txt')));
  assert.match(readFileSync(join(f.repo, 'src', 'api.js'), 'utf8'), /^A$/m);
});

it('Apply race: the checkout is locked against commits and another writer is refused by compare-and-swap; nothing applied', async t => {
  const f = fixture(t); let raced = false; let commitError = '';
  const s = f.reopen({ hooks: { beforeLand: () => {
    if (raced) return; raced = true;
    try { f.git(f.repo, 'commit', '-q', '--allow-empty', '-m', 'user'); } catch (error) { commitError = String(error.stderr); }
    const tree = f.git(f.repo, 'rev-parse', 'feature/auth^{tree}'); f.git(f.repo, 'update-ref', 'refs/heads/feature/auth', f.git(f.repo, 'commit-tree', tree, '-p', 'feature/auth', '-m', 'someone else'));
  } } });
  const a = await f.worker('A', p => writeFileSync(join(p, 'src', 'api.js'), edit(API, 4, 'A')), s);
  await rejects(() => s.applyEnvironment(a.id), 'BRANCH_MOVED');
  assert.match(commitError, /index\.lock/);
  assert.equal(f.git(f.repo, 'log', '-1', '--format=%s'), 'someone else');
  assert.equal(readFileSync(join(f.repo, 'src', 'api.js'), 'utf8'), API); assert.equal(f.git(f.repo, 'status', '--porcelain'), '');
  assert.equal(s.applyEnvironment(a.id).state, 'integrated');
});

it('recovery: a crash before landing rolls back; a crash after landing finishes; both leave Git usable', async t => {
  const f = fixture(t);
  const crashing = f.reopen({ hooks: { afterFiles: () => { throw new Error('crash before landing'); } } });
  const a = await f.worker('A', p => writeFileSync(join(p, 'src', 'api.js'), edit(API, 6, 'A')), crashing);
  await assert.rejects(async () => crashing.applyEnvironment(a.id), /crash before landing/);
  assert.throws(() => f.git(f.repo, 'commit', '-q', '--allow-empty', '-m', 'x'), /index\.lock/);
  assert.deepEqual(f.reopen().reconcileEnvironments().map(r => r.slice(1)), [['integrating', 'completed']]);
  assert.equal(readFileSync(join(f.repo, 'src', 'api.js'), 'utf8'), API); assert.equal(f.git(f.repo, 'status', '--porcelain'), '');
  const late = f.reopen({ hooks: { afterLand: () => { throw new Error('crash after landing'); } } });
  await assert.rejects(async () => late.applyEnvironment(a.id), /crash after landing/);
  const report = f.reopen().reconcileEnvironments().map(r => r.slice(1));
  assert.deepEqual(report[0], ['integrating', 'integrated']);
  assert.equal(f.git(f.repo, 'status', '--porcelain'), ''); f.git(f.repo, 'commit', '-q', '--allow-empty', '-m', 'usable');
});

it('recovery: an unfinished creation, and a session that ended while Journal was closed', async t => {
  const f = fixture(t);
  const env = await f.store.createEnvironment({ projectId: f.project.id, logicalBranch: 'feature/auth' });
  const sess = f.session(env.id, 'running');
  f.store.saveWorkspace({ ...f.store.getWorkspace(env.id), lifecycle: 'creating', state: 'intent' });
  const ghost = { ...f.store.getWorkspace(env.id), id: '00000000-0000-4000-8000-000000000000', path: join(f.data, 'env', 'never-made'), lifecycle: 'creating', state: 'intent' };
  f.store.saveWorkspace(ghost);
  f.store.saveSession({ ...f.store.getSession(sess.id), status: 'interrupted' });
  const report = Object.fromEntries(f.reopen().reconcileEnvironments().map(([id, , to]) => [id, to]));
  assert.deepEqual([report[env.id], report[ghost.id]], ['ready', 'failed']);
  f.store.saveWorkspace({ ...f.store.getWorkspace(env.id), lifecycle: 'running' });
  writeFileSync(join(env.details.path, 'late.md'), 'work\n');
  assert.deepEqual(f.reopen().reconcileEnvironments().find(([id]) => id === env.id).slice(1), ['running', 'completed']);
  assert.deepEqual(f.store.getEnvironment(env.id).result.files.map(file => file.path), ['late.md']);
});

it('resolve in the environment: markers only there, the work kept, then applied', async t => {
  const f = fixture(t);
  const a = await f.worker('A', p => writeFileSync(join(p, 'src', 'api.js'), edit(API, 3, 'A was here')));
  const b = await f.worker('B', p => writeFileSync(join(p, 'src', 'api.js'), edit(API, 3, 'B was here')));
  f.store.applyEnvironment(a.id); await rejects(() => f.store.applyEnvironment(b.id), 'CONFLICT');
  const { conflicts } = f.store.updateEnvironmentFromBranch(b.id);
  assert.deepEqual(conflicts, ['src/api.js']);
  const path = f.store.getEnvironment(b.id).details.path;
  assert.match(readFileSync(join(path, 'src', 'api.js'), 'utf8'), /<<<<<<< /); assert.doesNotMatch(readFileSync(join(f.repo, 'src', 'api.js'), 'utf8'), /<<<<<<< /);
  writeFileSync(join(path, 'src', 'api.js'), edit(API, 3, 'A and B'));
  f.store.snapshotEnvironment(b.id);
  const preview = f.store.previewEnvironmentApply(b.id); assert.equal(preview.clean, true);
  f.store.applyEnvironment(b.id); assert.match(readFileSync(join(f.repo, 'src', 'api.js'), 'utf8'), /A and B/);
});

it('abandon keeps the result in refs and cleans the folder; restore makes it applicable again', async t => {
  const f = fixture(t);
  const a = await f.worker('A', (p, git) => { writeFileSync(join(p, 'src', 'api.js'), 'precious\n'); git(p, 'commit', '-qam', 'w'); writeFileSync(join(p, 'LEFT.md'), 'left\n'); });
  const abandoned = f.store.abandonEnvironment(a.id);
  assert.deepEqual([abandoned.state, abandoned.folder], ['removed', false]);
  f.git(f.repo, 'reflog', 'expire', '--expire=now', '--all'); f.git(f.repo, 'gc', '-q', '--prune=now');
  assert.equal(f.git(f.repo, 'show', `${abandoned.result.id}:LEFT.md`), 'left');
  const changes = f.store.sessionChanges(abandoned.sessionId);
  assert.deepEqual([changes.saved, changes.files.map(file => file.path).sort()], [true, ['LEFT.md', 'src/api.js']], 'Changes read the saved result');
  assert.equal(f.store.restoreEnvironment(a.id).state, 'completed');
  f.store.applyEnvironment(a.id);
  assert.equal(readFileSync(join(f.repo, 'LEFT.md'), 'utf8'), 'left\n');
  await rejects(() => f.store.restoreEnvironment(a.id), 'INVALID_STATE');
});

it('cleanup refuses what it cannot prove: a live session, a user worktree, a folder outside its root; never forces; links as links', async t => {
  const f = fixture(t);
  const env = await f.store.createEnvironment({ projectId: f.project.id, logicalBranch: 'feature/auth' });
  const sess = f.session(env.id, 'running'); f.store.attachEnvironmentSession(env.id, sess.id);
  await rejects(() => f.store.abandonEnvironment(env.id), 'INVALID_STATE');
  f.store.saveSession({ ...f.store.getSession(sess.id), status: 'exited' }); f.store.syncEnvironment(f.store.getSession(sess.id));
  const target = join(f.root, 'store'); mkdirSync(join(target, 'pkg'), { recursive: true }); writeFileSync(join(target, 'pkg', 'index.js'), 'keep\n');
  mkdirSync(join(env.details.path, 'node_modules')); symlinkSync(join(target, 'pkg'), join(env.details.path, 'node_modules', 'pkg'), 'dir');
  const userTree = join(f.data, 'env', 'users-own'); f.git(f.repo, 'worktree', 'add', '--detach', userTree, 'main');
  const record = f.store.getWorkspace(env.id);
  f.store.saveWorkspace({ ...record, lifecycle: 'abandoned', path: userTree });
  assert.match((await rejects(() => f.store.cleanupEnvironment(env.id), 'UNSAFE_CLEANUP')).message, /did not create/);
  f.store.saveWorkspace({ ...record, lifecycle: 'abandoned', path: f.repo });
  await rejects(() => f.store.cleanupEnvironment(env.id), 'UNSAFE_CLEANUP');
  assert.ok(existsSync(join(userTree, 'README.md')) && existsSync(join(f.repo, '.git')));
  f.store.saveWorkspace({ ...record, lifecycle: 'abandoned' });
  assert.equal(f.store.cleanupEnvironment(env.id).state, 'removed');
  assert.equal(readFileSync(join(target, 'pkg', 'index.js'), 'utf8'), 'keep\n');
  assert.ok(!/['"]--force['"]/.test(readFileSync(new URL('../src/core/environments.mjs', import.meta.url), 'utf8')));
});

it('cleanup: a held folder (simulated) and late work give cleanup_pending, retried safely; no repository-wide prune', async t => {
  const f = fixture(t); let held = true;
  const s = f.reopen({ remove: (repo, path) => { if (held) { const error = new Error('EBUSY: resource busy or locked'); error.code = 'EBUSY'; throw error; } execFileSync('git', ['-C', repo, 'worktree', 'remove', path]); } });
  const a = await f.worker('A', p => writeFileSync(join(p, 'work.md'), 'w\n'), s);
  const pending = s.abandonEnvironment(a.id);
  assert.deepEqual([pending.state, /EBUSY/.test(pending.cleanup.reason)], ['cleanup_pending', true]);
  writeFileSync(join(pending.details.path, 'late.md'), 'late\n');
  held = false;
  const again = s.cleanupEnvironment(a.id); assert.equal(again.state, 'cleanup_pending'); assert.match(again.cleanup.reason, /new work/);
  assert.equal(f.git(f.repo, 'show', `${s.getEnvironment(a.id).result.id}:late.md`), 'late');
  assert.equal(s.cleanupEnvironment(a.id).state, 'removed');
  // A folder deleted by hand next to another missing worktree.
  const b = await f.worker('B', p => writeFileSync(join(p, 'b.md'), 'b\n'), s);
  const other = join(f.root, 'unmounted'); f.git(f.repo, 'worktree', 'add', '--detach', other, 'main'); rmSync(other, { recursive: true });
  s.saveWorkspace({ ...s.getWorkspace(b.id), lifecycle: 'abandoned' }); rmSync(b.details.path, { recursive: true });
  assert.equal(s.cleanupEnvironment(b.id).state, 'removed');
  assert.match(f.git(f.repo, 'worktree', 'list', '--porcelain'), /unmounted/);
});

it('notes from an isolated session carry structured provenance, marked unapplied until the result lands; conflicting proposals both kept', async t => {
  const f = fixture(t);
  const a = await f.worker('A', p => writeFileSync(join(p, 'src', 'api.js'), 'retry 3\n'));
  const b = await f.worker('B', p => writeFileSync(join(p, 'src', 'api.js'), 'retry 5\n'));
  const pa = f.store.proposeMemory(f.project.id, { statement: 'Uploads retry three times before failing', category: 'decision', scope: 'checkout', area: 'src', sessionId: a.sessionId, source: { kind: 'user', note: 'worker A' } });
  const pb = f.store.proposeMemory(f.project.id, { statement: 'Uploads retry five times before failing', category: 'decision', scope: 'checkout', area: 'src', sessionId: b.sessionId, source: { kind: 'user', note: 'worker B' } });
  assert.deepEqual(f.store.getMemory(pa.id).origin, { sessionId: a.sessionId, environmentId: a.id, logicalBranch: 'feature/auth', base: a.base, result: a.result.id, applied: false, environmentState: 'completed' });
  assert.deepEqual([f.store.getMemory(pa.id).status, f.store.getMemory(pb.id).status], ['candidate', 'candidate']);
  f.store.applyEnvironment(a.id);
  assert.deepEqual([f.store.getMemory(pa.id).origin.applied, f.store.getMemory(pb.id).origin.applied], [true, false]);
  const page = f.store.listMemoryPage(f.project.id, { filter: 'review' });
  assert.equal(page.items.find(item => item.id === pb.id).origin.applied, false);
  // A checkout session gets the session, nothing about environments.
  assert.equal(f.store.originFor(f.project.id, 'missing-session'), null);
});

it('ports: two environments listen side by side on their own blocks; reconcile only follows the ended one', async t => {
  const f = fixture(t, { probe: undefined, range: { start: 47400, end: 47600, size: 10 } });
  const [a, b] = await Promise.all(['A', 'B'].map(task => f.store.createEnvironment({ projectId: f.project.id, logicalBranch: 'feature/auth', task })));
  assert.equal(a.ports.filter(port => b.ports.includes(port)).length, 0);
  const worker = env => spawn(process.execPath, ['-e', `require('net').createServer(s=>s.end(process.env.JOURNAL_ENV_ID)).listen(+process.env.JOURNAL_PORT,'127.0.0.1',()=>console.log('up'))`],
    { cwd: env.details.path, env: { ...process.env, ...f.store.environmentLaunch(env.id) }, stdio: ['ignore', 'pipe', 'ignore'] });
  const children = [worker(a), worker(b)]; t.after(() => children.forEach(child => child.kill('SIGKILL')));
  await Promise.all(children.map(child => new Promise(r => child.stdout.once('data', r))));
  const ask = port => new Promise((done, failed) => { const socket = require_net().connect({ port, host: '127.0.0.1' }); let data = ''; socket.on('data', d => { data += d; }); socket.on('end', () => done(data)); socket.on('error', failed); });
  assert.deepEqual(await Promise.all([ask(a.ports[0]), ask(b.ports[0])]), [a.id, b.id]);
});
import net from 'node:net';
const require_net = () => net;

it('the environment follows its session: running, waiting, then completed with its result; no branch switching inside it', async t => {
  const f = fixture(t);
  const env = await f.store.createEnvironment({ projectId: f.project.id, logicalBranch: 'feature/auth', task: 'sync' });
  const sess = f.session(env.id, 'running'); f.store.attachEnvironmentSession(env.id, sess.id);
  assert.equal(f.store.syncEnvironment({ ...sess, status: 'running' }).state, 'running');
  assert.equal(f.store.syncEnvironment({ ...sess, status: 'waiting' }).state, 'waiting');
  writeFileSync(join(env.details.path, 'out.md'), 'o\n');
  const done = f.store.syncEnvironment({ ...sess, status: 'exited' });
  assert.deepEqual([done.state, done.result.files.map(file => file.path)], ['completed', ['out.md']]);
  assert.equal(f.store.syncEnvironment({ ...sess, status: 'running' }).state, 'running', 'Continue makes it running again');
  assert.throws(() => f.store.switchBranch(f.project.id, env.id, { kind: 'local', name: 'main' }), /stays where it started/);
  assert.equal(f.git(env.details.path, 'rev-parse', 'HEAD'), env.base);
  assert.deepEqual(f.store.environmentsOverview(f.project.id).running.map(x => x.task), ['sync']);
});

// ---- Regression tests for the independent review's findings ----
it('review: sensitive names are left out even when Git would quote them (non-ASCII); saved Changes read such names', async t => {
  const f = fixture(t);
  const dir = 'conf\u00efg'; const note = 'na\u00efve "notes".md';
  const a = await f.worker('A', p => { mkdirSync(join(p, dir)); writeFileSync(join(p, dir, '.env'), 'TOKEN=x\n'); writeFileSync(join(p, note), 'n\n'); });
  assert.deepEqual(a.result.excluded, [`${dir}/.env`]);
  assert.deepEqual(a.result.files.map(file => file.path), [note]);
  assert.throws(() => f.git(f.repo, 'show', `${a.result.id}:${dir}/.env`));
  // The left-out secret is still in the folder, so cleanup waits rather than delete it.
  const kept = f.store.abandonEnvironment(a.id); assert.equal(kept.state, 'cleanup_pending'); assert.ok(existsSync(join(kept.details.path, dir, '.env')));
  const b = await f.worker('B', p => writeFileSync(join(p, note), 'n\n'));
  assert.equal(f.store.abandonEnvironment(b.id).folder, false);
  assert.deepEqual(f.store.sessionChanges(b.sessionId).files.map(file => file.path), [note]);
});

it('review: Apply after resolving lands the resolution without a manual result; markers left refuse Apply; a clean take-in is the new result', async t => {
  const f = fixture(t);
  const a = await f.worker('A', p => writeFileSync(join(p, 'src', 'api.js'), edit(API, 3, 'A was here')));
  const b = await f.worker('B', p => writeFileSync(join(p, 'src', 'api.js'), edit(API, 3, 'B was here')));
  const c = await f.worker('C', p => writeFileSync(join(p, 'src', 'api.js'), edit(API, 9, 'C was here')));
  f.store.applyEnvironment(a.id); await rejects(() => f.store.applyEnvironment(b.id), 'CONFLICT');
  f.store.updateEnvironmentFromBranch(b.id);
  assert.deepEqual(f.store.previewEnvironmentApply(b.id).unresolved, ['src/api.js']);
  await rejects(() => f.store.updateEnvironmentFromBranch(b.id), 'UNRESOLVED');
  const before = checkout(f);
  assert.deepEqual((await rejects(() => f.store.applyEnvironment(b.id), 'UNRESOLVED')).detail.paths, ['src/api.js']);
  assert.deepEqual(checkout(f), before);
  // The worker resolves by editing only (no git add, no new result): Apply captures and lands it.
  writeFileSync(join(f.store.getEnvironment(b.id).details.path, 'src', 'api.js'), edit(API, 3, 'A and B'));
  assert.equal(f.store.applyEnvironment(b.id).state, 'integrated');
  assert.equal(readFileSync(join(f.repo, 'src', 'api.js'), 'utf8'), edit(API, 3, 'A and B'));
  // C took in the branch cleanly: its result now holds both, and Apply adds only its own line.
  assert.deepEqual(f.store.updateEnvironmentFromBranch(c.id).conflicts, []);
  assert.equal(f.store.getEnvironment(c.id).base, f.git(f.repo, 'rev-parse', 'feature/auth'));
  assert.deepEqual(f.store.previewEnvironmentApply(c.id).changes.map(x => x.path), ['src/api.js']);
  f.store.applyEnvironment(c.id);
  assert.equal(readFileSync(join(f.repo, 'src', 'api.js'), 'utf8'), edit(edit(API, 3, 'A and B'), 9, 'C was here'));
});

it('review: nothing to apply, a busy branch, a live session and a switched copy are all refused or reported; nothing written', async t => {
  const f = fixture(t);
  const a = await f.worker('A', p => writeFileSync(join(p, 'src', 'api.js'), edit(API, 2, 'A')));
  const empty = await f.worker('E', () => {});
  const preview = f.store.previewEnvironmentApply(empty.id);
  assert.deepEqual([preview.empty, preview.canApply], [true, false]); await rejects(() => f.store.applyEnvironment(empty.id), 'NOTHING_TO_APPLY');
  // A merge in progress in the checkout holding the branch.
  writeFileSync(join(f.repo, '.git', 'MERGE_HEAD'), `${f.git(f.repo, 'rev-parse', 'main')}\n`);
  assert.equal(f.store.previewEnvironmentApply(a.id).busy, 'merge');
  let before = checkout(f); await rejects(() => f.store.applyEnvironment(a.id), 'BRANCH_BUSY'); assert.deepEqual(checkout(f), before);
  rmSync(join(f.repo, '.git', 'MERGE_HEAD'));
  // A rebase of the branch running in another worktree of the user.
  const other = join(f.root, 'other'); f.git(f.repo, 'worktree', 'add', '-q', '--detach', other, 'main');
  const admin = f.git(other, 'rev-parse', '--absolute-git-dir'); mkdirSync(join(admin, 'rebase-merge')); writeFileSync(join(admin, 'rebase-merge', 'head-name'), 'refs/heads/feature/auth\n');
  assert.equal(f.store.previewEnvironmentApply(a.id).busy, 'rebase');
  rmSync(join(admin, 'rebase-merge'), { recursive: true });
  // Continue running in it: Apply and take-in wait for the session.
  const live = f.session(a.id, 'running');
  await rejects(() => f.store.applyEnvironment(a.id), 'INVALID_STATE'); await rejects(() => f.store.updateEnvironmentFromBranch(a.id), 'INVALID_STATE');
  f.store.saveSession({ ...f.store.getSession(live.id), status: 'exited' });
  // The worker switched its copy onto a branch of its own: reported, its files still apply.
  f.git(f.store.getEnvironment(a.id).details.path, 'switch', '-q', '-c', 'side');
  f.store.snapshotEnvironment(a.id);
  assert.equal(f.store.previewEnvironmentApply(a.id).switchedTo, 'side');
  assert.equal(f.store.applyEnvironment(a.id).state, 'integrated');
});

it('review: the session follows an orphaned agent and does not complete while another session still runs there', async t => {
  const f = fixture(t);
  const env = await f.store.createEnvironment({ projectId: f.project.id, logicalBranch: 'feature/auth' });
  const one = f.session(env.id, 'running'); f.store.attachEnvironmentSession(env.id, one.id);
  assert.equal(f.store.syncEnvironment({ ...one, status: 'running' }).state, 'running');
  assert.equal(f.store.syncEnvironment({ ...one, status: 'orphaned' }).state, 'running');
  const two = f.session(env.id, 'running');
  f.store.saveSession({ ...f.store.getSession(one.id), status: 'exited' });
  assert.equal(f.store.syncEnvironment({ ...f.store.getSession(one.id) }).state, 'running');
  f.store.saveSession({ ...f.store.getSession(two.id), status: 'exited' });
  assert.equal(f.store.syncEnvironment({ ...f.store.getSession(two.id) }).state, 'completed');
});

it('review: an Apply interrupted at each step is finished or rolled back, and the checkout\'s index lock is always released', async t => {
  const f = fixture(t);
  const a = await f.worker('A', p => writeFileSync(join(p, 'src', 'api.js'), edit(API, 5, 'A')));
  const lockFile = join(f.repo, '.git', 'index.lock');
  // Landed, the side index already renamed to index.lock (crash between the two renames).
  const late = f.reopen({ hooks: { afterLand: env => { renameSync(env.integration.sideIndex, env.integration.indexLock); throw new Error('crash mid-swap'); } } });
  await assert.rejects(async () => late.applyEnvironment(a.id), /crash mid-swap/);
  assert.equal(f.store.getWorkspace(a.id).integration.phase, 'landed');
  assert.deepEqual(f.reopen().reconcileEnvironments().map(r => r.slice(1)), [['integrating', 'integrated']]);
  assert.ok(!existsSync(lockFile)); assert.equal(f.git(f.repo, 'status', '--porcelain'), '');
  // Not landed, the side index already gone: the lock is released, nothing applied.
  const b = await f.worker('B', p => writeFileSync(join(p, 'src', 'form.js'), edit(FORM, 5, 'B')));
  const early = f.reopen({ hooks: { afterFiles: env => { rmSync(env.integration.sideIndex); throw new Error('crash'); } } });
  const head = f.git(f.repo, 'rev-parse', 'feature/auth');
  await assert.rejects(async () => early.applyEnvironment(b.id), /crash/);
  f.reopen().reconcileEnvironments();
  assert.ok(!existsSync(lockFile)); assert.equal(f.git(f.repo, 'rev-parse', 'feature/auth'), head);
  f.git(f.repo, 'checkout', '--', '.'); assert.equal(f.git(f.repo, 'status', '--porcelain'), '');
  // An ordinary error before landing is undone at once, without waiting for reconcile.
  // (A plain error, unlike a hook's simulated crash: recording the files phase fails once.)
  const failing = f.reopen(); const original = failing.environments.patch.bind(failing.environments); let calls = 0;
  failing.environments.patch = (id, patch) => { if (patch.integration?.phase === 'files' && ++calls === 1) { original(id, patch); throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } return original(id, patch); };
  await assert.rejects(async () => failing.applyEnvironment(b.id), /disk full/);
  assert.ok(!existsSync(lockFile)); assert.equal(f.store.getEnvironment(b.id).state, 'completed');
  assert.equal(readFileSync(join(f.repo, 'src', 'form.js'), 'utf8'), FORM); assert.equal(f.git(f.repo, 'status', '--porcelain'), '');
});

it('review: cleanup keeps ignored work and nested repositories until confirmed; regenerable folders go', async t => {
  const f = fixture(t);
  const a = await f.worker('A', p => { mkdirSync(join(p, 'node_modules', 'x'), { recursive: true }); writeFileSync(join(p, 'node_modules', 'x', 'i.js'), '1\n'); writeFileSync(join(p, 'debug.log'), 'l\n'); });
  assert.equal(f.store.abandonEnvironment(a.id).state, 'removed', 'node_modules and logs are regenerable');
  const b = await f.worker('B', p => { writeFileSync(join(p, '.gitignore'), 'node_modules/\n*.log\nnotes/\n'); mkdirSync(join(p, 'notes')); writeFileSync(join(p, 'notes', 'mine.md'), 'keep\n'); });
  const held = f.store.abandonEnvironment(b.id);
  assert.deepEqual([held.state, held.cleanup.code], ['cleanup_pending', 'ignored']); assert.match(held.cleanup.reason, /notes/);
  assert.ok(existsSync(join(held.details.path, 'notes', 'mine.md')));
  assert.equal(f.store.cleanupEnvironment(b.id, { removeIgnored: true }).state, 'removed');
  const c = await f.worker('C', p => { mkdirSync(join(p, 'vendor')); f.git(join(p, 'vendor'), 'init', '-q'); writeFileSync(join(p, 'vendor', 'v.txt'), 'v\n'); });
  const nested = f.store.abandonEnvironment(c.id);
  assert.equal(nested.state, 'cleanup_pending'); assert.match(nested.cleanup.reason, /another Git repository/);
  assert.equal(f.store.cleanupEnvironment(c.id, { removeIgnored: true }).state, 'cleanup_pending');
  assert.ok(existsSync(join(nested.details.path, 'vendor', '.git')));
});

it('review: a copy no session started in is set aside after a while; a failed one is cleaned; forget refuses isolated', async t => {
  const f = fixture(t);
  const stray = await f.store.createEnvironment({ projectId: f.project.id, logicalBranch: 'feature/auth' });
  assert.deepEqual(f.store.reconcileEnvironments(f.project.id), [], 'young copies wait for their session');
  const report = f.store.reconcileEnvironments(f.project.id, { orphanAge: -1 });
  assert.deepEqual(report.map(r => r.slice(1)), [['ready', 'removed']]); assert.equal(existsSync(stray.details.path), false);
  assert.throws(() => f.store.forgetWorkspace(stray.id), /never forgotten/);
  const live = await f.store.createEnvironment({ projectId: f.project.id, logicalBranch: 'feature/auth' }); f.session(live.id, 'running');
  assert.deepEqual(f.store.reconcileEnvironments(f.project.id, { orphanAge: -1 }), []);
});

it('review: a finished copy takes no new session; Files lists copies in use only; status proposals skip isolated sessions; revisions keep their origin', async t => {
  const f = fixture(t);
  const { TerminalManager } = await import('../src/core/terminal.mjs');
  const manager = new TerminalManager({ store: f.store, trackMs: 0, identify: () => null, table: () => null, spawn: () => ({ onData() {}, onExit(fn) { this.exit = fn; }, write() {}, resize() {}, kill() {} }) });
  t.after(() => { manager.disposed = true; });
  const a = await f.worker('A', (p, git) => { writeFileSync(join(p, 'src', 'api.js'), edit(API, 1, 'A')); git(p, 'commit', '-qam', 'A'); });
  assert.ok(f.store.fileRoots(f.project.id).primary.some(root => root.key === a.id), 'a completed copy is browsable');
  assert.deepEqual(f.store.generateProposals(a.sessionId).filter(p => p.kind === 'branch-status'), [], 'its commits are not on the branch');
  const note = f.store.proposeMemory(f.project.id, { statement: 'The API retries once', category: 'decision', scope: 'checkout', area: 'src', sessionId: a.sessionId, source: { kind: 'user', note: 'A' } });
  const revised = f.store.proposeMemory(f.project.id, { memoryId: note.id, statement: 'The API retries once, then fails', category: 'decision', scope: 'checkout', area: 'src', source: { kind: 'user', note: 'edit' } });
  assert.equal(f.store.getMemory(revised.id).origin.environmentId, a.id);
  f.store.applyEnvironment(a.id);
  assert.ok(!f.store.fileRoots(f.project.id).primary.some(root => root.key === a.id));
  await assert.rejects(manager.start({ projectId: f.project.id, provider: 'claude', task: 'more', workspaceId: a.id }), /no longer takes new work|Unknown|not/);
});

// ---- Regression tests for the second review ----
it('review 2: conflicts markers cannot show (binary, modify/delete) stay unresolved until staged; kinds recorded', async t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'img.bin'), Buffer.from([0, 1, 2, 3])); f.git(f.repo, 'add', '-A'); f.git(f.repo, 'commit', '-qm', 'bin');
  const w = await f.worker('W', p => { writeFileSync(join(p, 'img.bin'), Buffer.from([0, 9, 9, 9])); writeFileSync(join(p, 'src', 'form.js'), edit(FORM, 2, 'W')); });
  writeFileSync(join(f.repo, 'img.bin'), Buffer.from([0, 7, 7, 7])); f.git(f.repo, 'rm', '-q', 'src/form.js'); f.git(f.repo, 'commit', '-qam', 'branch');
  await rejects(() => f.store.applyEnvironment(w.id), 'CONFLICT');
  const { environment } = f.store.updateEnvironmentFromBranch(w.id);
  assert.deepEqual(environment.conflict.paths.map(x => [x.path, x.kind]).sort(), [['img.bin', 'binary'], ['src/form.js', 'modify/delete']]);
  assert.deepEqual(f.store.previewEnvironmentApply(w.id).unresolved.sort(), ['img.bin', 'src/form.js']);
  const head = f.git(f.repo, 'rev-parse', 'feature/auth');
  await rejects(() => f.store.applyEnvironment(w.id), 'UNRESOLVED'); assert.equal(f.git(f.repo, 'rev-parse', 'feature/auth'), head);
  // The worker decides: keeps the branch's image, keeps its edited form, and stages both.
  const path = environment.details.path; f.git(path, 'checkout', '--theirs', 'img.bin'); f.git(path, 'add', 'img.bin', 'src/form.js');
  assert.deepEqual(f.store.previewEnvironmentApply(w.id).unresolved, []);
  f.store.applyEnvironment(w.id);
  assert.deepEqual([...readFileSync(join(f.repo, 'img.bin'))], [0, 7, 7, 7]); assert.equal(readFileSync(join(f.repo, 'src', 'form.js'), 'utf8'), edit(FORM, 2, 'W'));
});

it('review 2: a secret or another repository the worker committed is left out of the result, at any depth', async t => {
  const f = fixture(t);
  const a = await f.worker('A', (p, git) => {
    writeFileSync(join(p, '.env'), 'TOKEN=x\n'); mkdirSync(join(p, 'tools', 'vendor'), { recursive: true }); writeFileSync(join(p, 'tools', 'a.js'), 'a\n');
    git(join(p, 'tools', 'vendor'), 'init', '-q'); writeFileSync(join(p, 'tools', 'vendor', 'v.txt'), 'v\n'); git(join(p, 'tools', 'vendor'), 'add', '-A'); git(join(p, 'tools', 'vendor'), 'commit', '-qm', 'v');
    git(p, 'add', '.env', 'tools/a.js'); git(p, 'commit', '-qm', 'with a secret');
  });
  assert.deepEqual(a.result.excluded, ['.env']);
  assert.deepEqual(a.result.files.map(file => file.path), ['tools/a.js']);
  assert.throws(() => f.git(f.repo, 'show', `${a.result.id}:.env`));
  assert.equal(f.git(f.repo, 'ls-tree', '-r', a.result.id, '--', 'tools/vendor'), '');
  const b = await f.worker('B', (p, git) => { mkdirSync(join(p, 'lib')); git(join(p, 'lib'), 'init', '-q'); writeFileSync(join(p, 'lib', 'x'), 'x\n'); git(join(p, 'lib'), 'add', '-A'); git(join(p, 'lib'), 'commit', '-qm', 'x'); git(p, 'add', 'lib'); git(p, 'commit', '-qm', 'gitlink'); });
  assert.equal(f.git(f.repo, 'ls-tree', '-r', b.result.id, '--', 'lib'), '', 'a committed submodule entry is left out');
  const held = f.store.abandonEnvironment(a.id); assert.equal(held.state, 'cleanup_pending'); assert.match(held.cleanup.reason, /another Git repository \(tools\/vendor\)/);
});

it('review 2: taking in the branch twice works; the copy is left with no merge in progress', async t => {
  const f = fixture(t);
  const c = await f.worker('C', p => writeFileSync(join(p, 'src', 'api.js'), edit(API, 9, 'C')));
  const commit = (line, text) => { writeFileSync(join(f.repo, 'src', 'api.js'), edit(readFileSync(join(f.repo, 'src', 'api.js'), 'utf8'), line, text)); f.git(f.repo, 'commit', '-qam', text); };
  commit(1, 'one'); assert.deepEqual(f.store.updateEnvironmentFromBranch(c.id).conflicts, []);
  const path = f.store.getEnvironment(c.id).details.path;
  assert.ok(!existsSync(join(f.git(path, 'rev-parse', '--absolute-git-dir'), 'MERGE_HEAD')));
  commit(2, 'two'); assert.deepEqual(f.store.updateEnvironmentFromBranch(c.id).conflicts, []);
  // A conflicted take-in resolved by editing (no commit), then another take-in.
  commit(9, 'branch nine'); assert.deepEqual(f.store.updateEnvironmentFromBranch(c.id).conflicts, ['src/api.js']);
  writeFileSync(join(path, 'src', 'api.js'), edit(edit(edit(API, 1, 'one'), 2, 'two'), 9, 'both nine'));
  commit(3, 'three'); assert.deepEqual(f.store.updateEnvironmentFromBranch(c.id).conflicts, []);
  f.store.applyEnvironment(c.id);
  assert.equal(readFileSync(join(f.repo, 'src', 'api.js'), 'utf8'), edit(edit(edit(edit(API, 1, 'one'), 2, 'two'), 3, 'three'), 9, 'both nine'));
});

it('review 2: recovery removes only Journal\'s own index lock, swaps in only the exact new index, and sees a landed Apply the branch moved past', async t => {
  const f = fixture(t); const lockFile = join(f.repo, '.git', 'index.lock');
  // Crash right after taking the lock (phase still planned): Journal's lock is recognised and released.
  const a = await f.worker('A', p => writeFileSync(join(p, 'src', 'api.js'), edit(API, 5, 'A')));
  const s = f.reopen(); const patch = s.environments.patch.bind(s.environments);
  s.environments.patch = (id, change) => { if (change.integration?.phase === 'locked') throw Object.assign(new Error('crash'), { crash: true }); return patch(id, change); };
  await assert.rejects(async () => s.applyEnvironment(a.id), /crash/);
  assert.equal(f.store.getWorkspace(a.id).integration.phase, 'planned'); assert.ok(existsSync(lockFile));
  f.reopen().reconcileEnvironments(); assert.ok(!existsSync(lockFile)); assert.equal(f.store.getEnvironment(a.id).state, 'completed');
  // Crash after both renames, before the state was saved: a lock the user's Git holds then is left alone.
  const late = f.reopen({ hooks: { afterLand: env => { renameSync(env.integration.sideIndex, env.integration.indexLock); renameSync(env.integration.indexLock, join(f.repo, '.git', 'index')); writeFileSync(lockFile, 'users git\n'); throw new Error('crash'); } } });
  await assert.rejects(async () => late.applyEnvironment(a.id), /crash/);
  f.reopen().reconcileEnvironments();
  assert.equal(readFileSync(lockFile, 'utf8'), 'users git\n'); rmSync(lockFile);
  assert.equal(f.store.getEnvironment(a.id).state, 'integrated'); assert.equal(f.git(f.repo, 'status', '--porcelain'), '');
  // Landed, then the user committed on top before Journal came back: it is integrated, nothing rolled back.
  const b = await f.worker('B', p => writeFileSync(join(p, 'src', 'form.js'), edit(FORM, 5, 'B')));
  const third = f.reopen({ hooks: { afterLand: env => { renameSync(env.integration.sideIndex, env.integration.indexLock); renameSync(env.integration.indexLock, join(f.repo, '.git', 'index')); f.git(f.repo, 'commit', '-q', '--allow-empty', '-m', 'user on top'); throw new Error('crash'); } } });
  await assert.rejects(async () => third.applyEnvironment(b.id), /crash/);
  assert.deepEqual(f.reopen().reconcileEnvironments().find(([id]) => id === b.id).slice(1), ['integrating', 'integrated']);
  assert.equal(readFileSync(join(f.repo, 'src', 'form.js'), 'utf8'), edit(FORM, 5, 'B')); assert.equal(f.git(f.repo, 'status', '--porcelain'), '');
});

it('review 2: Apply refuses a result that changed after the preview', async t => {
  const f = fixture(t);
  const a = await f.worker('A', p => writeFileSync(join(p, 'src', 'api.js'), edit(API, 5, 'A')));
  const preview = f.store.previewEnvironmentApply(a.id);
  writeFileSync(join(a.details.path, 'late.md'), 'written after the preview\n');
  const head = f.git(f.repo, 'rev-parse', 'feature/auth');
  await rejects(() => f.store.applyEnvironment(a.id, { expect: preview.result }), 'RESULT_CHANGED');
  assert.equal(f.git(f.repo, 'rev-parse', 'feature/auth'), head);
  const again = f.store.previewEnvironmentApply(a.id); assert.deepEqual(again.changes.map(x => x.path).sort(), ['late.md', 'src/api.js']);
  assert.equal(f.store.applyEnvironment(a.id, { expect: again.result }).state, 'integrated');
});

it('review 2: a session start that races an Apply is refused before it counts as live', async t => {
  const f = fixture(t);
  const a = await f.worker('A', p => writeFileSync(join(p, 'src', 'api.js'), edit(API, 5, 'A')));
  const { TerminalManager } = await import('../src/core/terminal.mjs');
  let spawned = 0;
  const manager = new TerminalManager({ store: f.store, trackMs: 0, identify: () => null, table: () => null, spawn: () => { spawned++; return { onData() {}, onExit(fn) { this.exit = fn; }, write() {}, resize() {}, kill() {} }; } });
  t.after(() => { manager.disposed = true; });
  const prepare = f.store.prepareContext.bind(f.store);
  f.store.prepareContext = (...args) => { f.store.applyEnvironment(a.id); return prepare(...args); };
  await assert.rejects(manager.start({ projectId: f.project.id, provider: 'claude', task: 'more', workspaceId: a.id }), /no longer takes new work/);
  assert.equal(spawned, 0); assert.equal(f.store.getEnvironment(a.id).state, 'integrated');
});

test('on Windows, creating an isolated session is refused before any Git change', { skip: !windows && 'Windows only' }, async t => {
  const f = fixture(t);
  await rejects(() => f.store.createEnvironment({ projectId: f.project.id, logicalBranch: 'feature/auth' }), 'UNSUPPORTED_PLATFORM');
  assert.deepEqual(f.store.listEnvironments(f.project.id), []);
});
