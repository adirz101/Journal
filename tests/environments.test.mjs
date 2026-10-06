import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { JournalStore } from '../src/core/store.mjs';
import { LIFECYCLE } from '../src/core/environments.mjs';
import { removeLater } from './support/cleanup.mjs';

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

test('creation: detached at the branch commit, outside the checkout, private refs, lock and marker; the branch list stays clean', async t => {
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

test('a session in an environment: its folder, logical branch, launch variables; receipts and notes follow the logical branch', async t => {
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

test('result: commits, staged, unstaged and untracked work; the worker\'s index untouched; sensitive files left out; idempotent', async t => {
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

test('Apply: clean, then the second worker is re-previewed against the moved branch; history and checkout follow', async t => {
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

test('Apply refuses without writing: same lines, delete versus edit, overlapping uncommitted work', async t => {
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

test('Apply keeps the user\'s unrelated staged, unstaged and untracked work', async t => {
  const f = fixture(t);
  const a = await f.worker('A', p => writeFileSync(join(p, 'src', 'api.js'), edit(API, 1, 'A')));
  writeFileSync(join(f.repo, 'README.md'), 'mine\n'); writeFileSync(join(f.repo, 'src', 'form.js'), edit(FORM, 9, 'staged by me')); f.git(f.repo, 'add', 'src/form.js'); writeFileSync(join(f.repo, 'scratch.txt'), 'x\n');
  f.store.applyEnvironment(a.id);
  assert.equal(readFileSync(join(f.repo, 'README.md'), 'utf8'), 'mine\n');
  assert.equal(f.git(f.repo, 'diff', '--cached', '--name-only'), 'src/form.js');
  assert.ok(existsSync(join(f.repo, 'scratch.txt')));
  assert.match(readFileSync(join(f.repo, 'src', 'api.js'), 'utf8'), /^A$/m);
});

test('Apply race: the checkout is locked against commits and another writer is refused by compare-and-swap; nothing applied', async t => {
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

test('recovery: a crash before landing rolls back; a crash after landing finishes; both leave Git usable', async t => {
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

test('recovery: an unfinished creation, and a session that ended while Journal was closed', async t => {
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

test('resolve in the environment: markers only there, the work kept, then applied', async t => {
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

test('abandon keeps the result in refs and cleans the folder; restore makes it applicable again', async t => {
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

test('cleanup refuses what it cannot prove: a live session, a user worktree, a folder outside its root; never forces; links as links', async t => {
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

test('cleanup: a held folder (simulated) and late work give cleanup_pending, retried safely; no repository-wide prune', async t => {
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

test('notes from an isolated session carry structured provenance, marked unapplied until the result lands; conflicting proposals both kept', async t => {
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

test('ports: two environments listen side by side on their own blocks; reconcile only follows the ended one', async t => {
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

test('the environment follows its session: running, waiting, then completed with its result; no branch switching inside it', async t => {
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
