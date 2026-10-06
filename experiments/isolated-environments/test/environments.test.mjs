import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fixture, edit, expectCode } from './helpers.mjs';

// Prototype 1: isolated environments from one logical branch.
test('three environments from one branch: same recorded base, detached, private refs, separate folders', async t => {
  const f = fixture(t); const m = f.manager();
  const base = f.git(f.repo, 'rev-parse', 'feature/auth');
  const envs = [];
  for (const task of ['backend API', 'frontend form', 'tests']) envs.push(await m.createEnvironment({ projectId: 'p1', logicalBranch: 'feature/auth', sessionId: `s-${task}`, task }));
  assert.deepEqual(envs.map(e => [e.state, e.base]), envs.map(() => ['ready', base]));
  for (const env of envs) {
    assert.equal(f.git(env.details.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'detached HEAD');
    for (const ref of Object.values(env.details.refs)) if (!ref.endsWith('/result')) assert.equal(f.git(f.repo, 'rev-parse', ref), base);
    assert.ok(env.details.path.startsWith(join(f.data, 'env')), 'inside Journal\'s data folder, outside the checkout');
    assert.ok(env.details.path.length - f.data.length < 30, 'short paths (Windows MAX_PATH)');
  }
  // The user's branch list is clean: only main and feature/auth; feature/auth still checked out in the user's checkout.
  assert.deepEqual(f.git(f.repo, 'branch', '--format=%(refname:short)').split('\n').sort(), ['feature/auth', 'main']);
  assert.equal(f.git(f.repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/auth');
  assert.equal(new Set(envs.map(e => e.details.path)).size, 3);
  assert.equal(new Set(envs.map(e => e.ports[0])).size, 3, 'separate port blocks');
});

test('concurrent writes stay in their own environments; the checkout never changes', async t => {
  const f = fixture(t); const m = f.manager();
  const [a, b, c] = await Promise.all(['a', 'b', 'c'].map(name => m.createEnvironment({ projectId: 'p1', logicalBranch: 'feature/auth', sessionId: name, task: name })));
  const api = join('src', 'api.js');
  const original = readFileSync(join(f.repo, api), 'utf8');
  // Different files, the same file and the same lines, at once.
  await Promise.all([
    Promise.resolve().then(() => writeFileSync(join(a.details.path, api), edit(original, 2, 'api A'))),
    Promise.resolve().then(() => writeFileSync(join(b.details.path, api), edit(original, 2, 'api B'))),
    Promise.resolve().then(() => writeFileSync(join(c.details.path, 'src', 'form.js'), 'form by C\n')),
  ]);
  assert.match(readFileSync(join(a.details.path, api), 'utf8'), /api A/);
  assert.match(readFileSync(join(b.details.path, api), 'utf8'), /api B/);
  assert.equal(readFileSync(join(c.details.path, api), 'utf8'), original);
  assert.equal(readFileSync(join(f.repo, api), 'utf8'), original, 'the user\'s checkout is untouched');
  assert.equal(f.git(f.repo, 'status', '--porcelain'), '');
});

// Prototype 2: result snapshots.
test('a result captures commits, uncommitted edits and untracked files, without touching the worker\'s index', async t => {
  const f = fixture(t); const m = f.manager();
  const env = await m.createEnvironment({ projectId: 'p1', logicalBranch: 'feature/auth', sessionId: 's1', task: 'API' });
  const p = env.details.path;
  writeFileSync(join(p, 'src', 'api.js'), 'committed by the worker\n'); f.git(p, 'add', 'src/api.js'); f.git(p, 'commit', '-qm', 'worker commit');
  writeFileSync(join(p, 'src', 'form.js'), 'staged edit\n'); f.git(p, 'add', 'src/form.js');
  writeFileSync(join(p, 'README.md'), 'unstaged edit\n');
  writeFileSync(join(p, 'NEW.md'), 'untracked\n');
  writeFileSync(join(p, 'debug.log'), 'ignored\n');
  const gitPath = f.git(p, 'rev-parse', '--git-path', 'index'); const indexFile = isAbsolute(gitPath) ? gitPath : join(p, gitPath);
  const indexBefore = readFileSync(indexFile); const statusBefore = f.git(p, 'status', '--porcelain');
  const snap = m.snapshotEnvironment(env.id);
  assert.deepEqual(snap.result.files.map(x => `${x.status} ${x.path}`).sort(), ['A NEW.md', 'M README.md', 'M src/api.js', 'M src/form.js']);
  assert.ok(!snap.result.files.some(x => x.path === 'debug.log'), 'ignored files are not part of the result');
  assert.deepEqual(readFileSync(indexFile), indexBefore, 'the worker\'s index is byte-identical');
  assert.equal(f.git(p, 'status', '--porcelain'), statusBefore);
  // Provenance travels with the result commit, and the result's parent is the worker's own commit.
  const message = f.git(f.repo, 'log', '-1', '--format=%B', snap.result.id);
  for (const line of [`Journal-Environment: ${env.id}`, 'Journal-Session: s1', 'Journal-Logical-Branch: feature/auth', `Journal-Base: ${env.base}`]) assert.ok(message.includes(line), line);
  assert.equal(f.git(f.repo, 'rev-parse', `${snap.result.id}^`), f.git(p, 'rev-parse', 'HEAD'));
  assert.deepEqual(m.provenance(env.id), { environmentId: env.id, sessionId: 's1', logicalBranch: 'feature/auth', base: env.base, result: snap.result.id, applied: false, integration: null });
  // Idempotent: nothing changed, the same result.
  assert.equal(m.snapshotEnvironment(env.id).result.id, snap.result.id);
  writeFileSync(join(p, 'NEW.md'), 'changed\n');
  assert.notEqual(m.snapshotEnvironment(env.id).result.id, snap.result.id);
});

test('private refs keep the work after the worktree is removed and git gc runs; the branch list stays clean', async t => {
  const f = fixture(t); const m = f.manager();
  const env = await m.createEnvironment({ projectId: 'p1', logicalBranch: 'feature/auth', sessionId: 's1' });
  writeFileSync(join(env.details.path, 'src', 'api.js'), 'precious work\n'); f.git(env.details.path, 'commit', '-qam', 'detached commit');
  writeFileSync(join(env.details.path, 'UNCOMMITTED.md'), 'also precious\n');
  m.markCompleted(env.id); m.markEnvironmentAbandoned(env.id);
  const result = m.getEnvironment(env.id).result.id;
  assert.equal(m.cleanupEnvironment(env.id).state, 'removed');
  assert.ok(!existsSync(env.details.path));
  f.git(f.repo, 'reflog', 'expire', '--expire=now', '--all'); f.git(f.repo, 'gc', '-q', '--prune=now');
  assert.equal(f.git(f.repo, 'show', `${result}:src/api.js`), 'precious work');
  assert.equal(f.git(f.repo, 'show', `${result}:UNCOMMITTED.md`), 'also precious');
  assert.equal(f.git(f.repo, 'show', `${env.details.refs.head}:src/api.js`), 'precious work', 'the worker\'s own commit survives too');
  assert.deepEqual(f.git(f.repo, 'branch', '--format=%(refname:short)').split('\n').sort(), ['feature/auth', 'main']);
  assert.equal(f.git(f.repo, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).length, 1);
});

// Prototype 5: lifecycle a coordinator can query.
test('lifecycle: explicit, durable transitions; invalid ones refused; the overview answers a coordinator\'s questions', async t => {
  const f = fixture(t); const m = f.manager();
  const envs = await Promise.all(['A', 'B', 'C', 'D'].map(task => m.createEnvironment({ projectId: 'p1', logicalBranch: 'feature/auth', task })));
  m.markRunning(envs[0].id, { pid: process.pid }); m.markRunning(envs[1].id); m.markWaiting(envs[1].id);
  writeFileSync(join(envs[2].details.path, 'C.md'), 'c\n'); m.markCompleted(envs[2].id); m.markFailed(envs[3].id, 'setup failed');
  // A fresh manager reads the same durable record.
  const again = f.manager(); const o = again.overview('p1');
  assert.deepEqual([o.running, o.waiting, o.completed, o.failed, o.unapplied].map(list => list.map(x => x.task)), [['A'], ['B'], ['C'], ['D'], ['C']]);
  assert.deepEqual(o.cleanable.map(x => x.task), ['D']);
  await expectCode(() => again.applyEnvironment(envs[0].id), 'INVALID_STATE');
  await expectCode(() => again.cleanupEnvironment(envs[0].id), 'INVALID_STATE');
  assert.deepEqual(again.getEnvironment(envs[2].id).details.path === envs[2].details.path, true);
  assert.ok(statSync(join(f.data, 'environments.json')).size > 0);
  assert.deepEqual(again.record(envs[1].id).history.map(h => h.state), ['creating', 'ready', 'running', 'waiting']);
});
