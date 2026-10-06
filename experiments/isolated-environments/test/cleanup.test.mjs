import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture, expectCode } from './helpers.mjs';
import { git as runGit } from '../src/git.mjs';

// Prototype 7 (portable parts): cleanup refuses anything unsafe and never forces.
async function abandoned(m, f, task = 'X', change = () => {}) {
  const env = await m.createEnvironment({ projectId: 'p1', logicalBranch: 'feature/auth', task });
  change(env.details.path); m.markEnvironmentAbandoned(env.id); return m.getEnvironment(env.id);
}

test('cleanup refuses an environment whose process is still alive (cleanup_pending, nothing removed)', async t => {
  const f = fixture(t); const m = f.manager();
  const env = await abandoned(m, f);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); t.after(() => child.kill('SIGKILL'));
  m.patch(env.id, { processes: [{ pid: child.pid }] });
  const pending = m.cleanupEnvironment(env.id);
  assert.equal(pending.state, 'cleanup_pending'); assert.match(pending.cleanup.reason, /processes still running/);
  assert.ok(existsSync(env.details.path));
  child.kill('SIGKILL'); await new Promise(r => child.once('exit', r));
  assert.equal(m.cleanupEnvironment(env.id).state, 'removed', 'retried safely once the process is gone');
});

test('cleanup refuses folders it cannot prove are its own: outside the root, user-created worktrees, wrong marker', async t => {
  const f = fixture(t); const m = f.manager();
  const env = await abandoned(m, f, 'A');
  // A user's own worktree (not created by Journal), even placed under Journal's folder.
  const userTree = join(f.data, 'env', 'users-own'); runGit(f.repo, ['worktree', 'add', '--detach', userTree, 'main']);
  const before = m.record(env.id).path;
  m.patch(env.id, { path: userTree });
  assert.match((await expectCode(() => m.cleanupEnvironment(env.id), 'UNSAFE_CLEANUP')).message, /not created by Journal/);
  assert.ok(existsSync(join(userTree, 'README.md')), 'the user\'s worktree is untouched');
  // A folder outside Journal's environments root.
  m.patch(env.id, { path: f.repo });
  await expectCode(() => m.cleanupEnvironment(env.id), 'UNSAFE_CLEANUP');
  assert.ok(existsSync(join(f.repo, '.git')));
  // Its own folder still cleans up.
  m.patch(env.id, { path: before });
  assert.equal(m.cleanupEnvironment(env.id).state, 'removed');
  assert.ok(existsSync(userTree), 'and the user\'s worktree is still there');
});

test('cleanup never forces and keeps work that appeared after the result was captured', async t => {
  const f = fixture(t); const m = f.manager();
  const source = readFileSync(fileURLToPath(new URL('../src/environments.mjs', import.meta.url)), 'utf8');
  assert.ok(!/['"]--force['"]/.test(source), 'no --force anywhere in the environment manager');
  const env = await abandoned(m, f, 'A', p => writeFileSync(join(p, 'work.md'), 'v1\n'));
  writeFileSync(join(env.details.path, 'late.md'), 'written after abandon\n');
  const pending = m.cleanupEnvironment(env.id);
  assert.equal(pending.state, 'cleanup_pending'); assert.match(pending.cleanup.reason, /changed after its result/);
  // The retry captured the late file first; then it removes.
  assert.equal(m.cleanupEnvironment(env.id).state, 'removed');
  assert.equal(runGit(f.repo, ['show', `${m.getEnvironment(env.id).result.id}:late.md`]), 'written after abandon');
});

test('links inside an environment are removed as links; their targets survive', async t => {
  const f = fixture(t); const m = f.manager();
  const target = join(f.root, 'shared-store'); mkdirSync(join(target, 'pkg'), { recursive: true }); writeFileSync(join(target, 'pkg', 'index.js'), 'keep me\n');
  const env = await abandoned(m, f, 'A', p => {
    mkdirSync(join(p, 'node_modules'));
    symlinkSync(join(target, 'pkg'), join(p, 'node_modules', 'pkg'), process.platform === 'win32' ? 'junction' : 'dir');
    symlinkSync(target, join(p, 'store-link'), process.platform === 'win32' ? 'junction' : 'dir');
  });
  assert.equal(m.cleanupEnvironment(env.id).state, 'removed');
  assert.ok(!existsSync(env.details.path));
  assert.equal(readFileSync(join(target, 'pkg', 'index.js'), 'utf8'), 'keep me\n', 'the link targets survive');
});

test('a file held open (simulated): cleanup_pending, the worktree locked again, the retry succeeds', async t => {
  const f = fixture(t); let held = true;
  const m = f.manager({ remove: (repo, path) => { if (held) { const error = new Error('EBUSY: resource busy or locked, rmdir'); error.code = 'EBUSY'; throw error; } runGit(repo, ['worktree', 'remove', path]); } });
  const env = await abandoned(m, f, 'A', p => writeFileSync(join(p, 'open.txt'), 'held\n'));
  const pending = m.cleanupEnvironment(env.id);
  assert.equal(pending.state, 'cleanup_pending'); assert.match(pending.cleanup.reason, /EBUSY/);
  assert.ok(existsSync(join(env.details.path, 'open.txt')), 'nothing deleted');
  assert.match(runGit(f.repo, ['worktree', 'list', '--porcelain']), /locked journal env/);
  held = false;
  assert.equal(m.cleanupEnvironment(env.id).state, 'removed');
});

test('a folder deleted by hand: cleanup removes only its own admin entry, never other missing worktrees', async t => {
  const f = fixture(t); const m = f.manager();
  const env = await abandoned(m, f, 'A');
  const other = join(f.root, 'unmounted'); runGit(f.repo, ['worktree', 'add', '--detach', other, 'main']);
  const { rmSync } = await import('node:fs'); rmSync(other, { recursive: true }); rmSync(env.details.path, { recursive: true });
  assert.equal(m.cleanupEnvironment(env.id).state, 'removed');
  const list = runGit(f.repo, ['worktree', 'list', '--porcelain']);
  assert.match(list, /unmounted/, 'the other missing worktree is still registered (no repository-wide prune)');
  assert.ok(!list.includes(env.details.path));
});
