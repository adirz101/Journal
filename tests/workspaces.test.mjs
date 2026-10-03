import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { JournalStore } from '../src/core/store.mjs';
import { TerminalManager } from '../src/core/terminal.mjs';
import { buildAgentLaunch } from '../src/core/agents.mjs';
import { removeLater } from './support/cleanup.mjs';

function fixture(t) {
  const root = realpathSync.native(mkdtempSync(join(process.env.JOURNAL_TEST_TMP ?? tmpdir(), 'ws-')));
  const repo = join(root, 'repo'); mkdirSync(repo);
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
  git(repo, 'init', '-q', '-b', 'main'); writeFileSync(join(repo, 'README.md'), 'Ledger\n'); writeFileSync(join(repo, '.gitignore'), 'build/\n');
  git(repo, 'add', '.'); git(repo, '-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'init');
  const store = new JournalStore(join(root, 'journal.sqlite')); const project = store.openProject(repo);
  const worktreeRoot = join(root, 'worktrees');
  t.after(() => { store.close(); removeLater(root); });
  return { root, repo, git, store, project, worktreeRoot };
}

test('a managed worktree is created from an explicit base with notices about what it will not contain', t => {
  const f = fixture(t); writeFileSync(join(f.repo, 'local.txt'), 'uncommitted\n');
  const plan = f.store.planWorkspace(f.project.id, { branch: 'feature/refunds', base: 'main' }, f.worktreeRoot);
  assert.ok(plan.notices.some(n => /uncommitted or untracked change/.test(n)));
  assert.ok(!existsSync(plan.path), 'Planning has no side effects');
  const ws = f.store.createWorkspace(f.project.id, { branch: 'feature/refunds', base: 'main' }, f.worktreeRoot);
  assert.equal(ws.state, 'ready'); assert.equal(ws.kind, 'managed'); assert.equal(ws.branch, 'feature/refunds');
  assert.ok(existsSync(join(ws.path, 'README.md'))); assert.ok(!existsSync(join(ws.path, 'local.txt')), 'Uncommitted changes are never transferred');
  assert.ok(existsSync(join(f.repo, 'local.txt')), 'Nothing is stashed');
  assert.throws(() => f.store.createWorkspace(f.project.id, { branch: 'feature/refunds', base: 'main' }, f.worktreeRoot), /already exists/);
  assert.throws(() => f.store.planWorkspace(f.project.id, { branch: 'bad..name', base: 'main' }, f.worktreeRoot), /Invalid branch/);
  assert.throws(() => f.store.planWorkspace(f.project.id, { branch: 'ok', base: '--upload-pack=evil' }, f.worktreeRoot), /Invalid base/);
  assert.throws(() => f.store.planWorkspace(f.project.id, { branch: 'ok', base: 'nope' }, f.worktreeRoot), /not a commit/);
  assert.ok(f.store.listAudit().some(a => a.action === 'workspace-intent') && f.store.listAudit().some(a => a.action === 'workspace-created'));
});

test('a crash between intent and Git is reconciled from Git without touching files', t => {
  const f = fixture(t);
  const done = f.store.planWorkspace(f.project.id, { branch: 'finished', base: 'main' }, f.worktreeRoot);
  f.store.saveWorkspace({ id: done.id, projectId: f.project.id, kind: 'managed', path: done.path, branch: 'finished', base: done.base, state: 'intent' });
  mkdirSync(join(done.path, '..'), { recursive: true }); f.git(f.repo, 'worktree', 'add', '-b', 'finished', done.path, 'main');
  const lost = f.store.planWorkspace(f.project.id, { branch: 'lost', base: 'main' }, f.worktreeRoot);
  f.store.saveWorkspace({ id: lost.id, projectId: f.project.id, kind: 'managed', path: lost.path, branch: 'lost', base: lost.base, state: 'intent' });
  const half = f.store.planWorkspace(f.project.id, { branch: 'half', base: 'main' }, f.worktreeRoot);
  mkdirSync(half.path, { recursive: true }); writeFileSync(join(half.path, 'keep.txt'), 'user data');
  f.store.saveWorkspace({ id: half.id, projectId: f.project.id, kind: 'managed', path: half.path, branch: 'half', base: half.base, state: 'intent' });
  const { workspaces } = f.store.listWorkspaces(f.project.id);
  const state = id => workspaces.find(w => w.id === id).state;
  assert.equal(state(done.id), 'ready'); assert.equal(state(lost.id), 'failed'); assert.equal(state(half.id), 'failed');
  assert.ok(existsSync(join(half.path, 'keep.txt')), 'An unregistered folder is left untouched');
});

test('removal refuses dirty, untracked, ignored and in-use worktrees; success keeps the branch', t => {
  const f = fixture(t);
  const ws = f.store.createWorkspace(f.project.id, { branch: 'cleanup', base: 'main' }, f.worktreeRoot);
  writeFileSync(join(ws.path, 'new.txt'), 'x'); mkdirSync(join(ws.path, 'build')); writeFileSync(join(ws.path, 'build/out.js'), 'x');
  writeFileSync(join(ws.path, 'README.md'), 'edited\n');
  const blockers = f.store.workspaceRemovalBlockers(ws.id).join(' ');
  assert.match(blockers, /uncommitted change/); assert.match(blockers, /untracked file/); assert.match(blockers, /ignored path/);
  assert.throws(() => f.store.removeWorkspace(ws.id), /Not removed/); assert.ok(existsSync(join(ws.path, 'new.txt')));
  rmSync(join(ws.path, 'new.txt')); rmSync(join(ws.path, 'build'), { recursive: true }); f.git(ws.path, 'checkout', '--', 'README.md');
  f.store.saveSession({ id: 's', projectId: f.project.id, provider: 'claude', status: 'running', workspaceId: ws.id, receiptId: 'r', createdAt: '' });
  assert.match(f.store.workspaceRemovalBlockers(ws.id).join(' '), /still running/);
  f.store.saveSession({ id: 's', projectId: f.project.id, provider: 'claude', status: 'stopped', workspaceId: ws.id, receiptId: 'r', createdAt: '' });
  assert.equal(f.store.removeWorkspace(ws.id).state, 'removed');
  assert.ok(!existsSync(ws.path)); assert.equal(f.git(f.repo, 'rev-parse', '--verify', 'refs/heads/cleanup').length, 40, 'The branch is kept');
});

test('existing worktrees can be imported but are never deleted by Journal', t => {
  const f = fixture(t); const external = join(f.root, 'external'); f.git(f.repo, 'worktree', 'add', '-b', 'mine', external, 'main');
  const listed = f.store.listWorkspaces(f.project.id);
  assert.deepEqual(listed.importable.map(w => w.path), [external]);
  const imported = f.store.importWorkspace(f.project.id, external);
  assert.equal(imported.kind, 'imported');
  assert.throws(() => f.store.importWorkspace(f.project.id, external), /already in Journal/);
  assert.throws(() => f.store.importWorkspace(f.project.id, f.repo), /another registered worktree/);
  assert.throws(() => f.store.removeWorkspace(imported.id), /never deleted/);
  f.store.forgetWorkspace(imported.id); assert.ok(existsSync(join(external, 'README.md')));
  rmSync(external, { recursive: true, force: true });
  const again = f.store.importWorkspace.bind(f.store);
  assert.throws(() => again(f.project.id, external), /another registered worktree/);
});

test('a missing worktree is reported, and sessions cannot start in it', t => {
  const f = fixture(t); const ws = f.store.createWorkspace(f.project.id, { branch: 'gone', base: 'main' }, f.worktreeRoot);
  f.git(f.repo, 'worktree', 'remove', '--force', ws.path);
  assert.equal(f.store.listWorkspaces(f.project.id).workspaces[0].state, 'missing');
  assert.throws(() => f.store.view(f.project.id, ws.id), /missing/);
});

test('sessions run in their workspace with its branch knowledge, resume in place, and research uses native read-only modes', async t => {
  const f = fixture(t); const ws = f.store.createWorkspace(f.project.id, { branch: 'feature/x', base: 'main' }, f.worktreeRoot);
  const add = (statement, scope) => { const m = f.store.proposeMemory(f.project.id, { statement, category: 'constraint', scope, area: '', source: { kind: 'user', note: 'n' } }); f.store.setMemoryStatus(m.id, 'active'); };
  add('MAIN_BRANCH_RULE for deployment', 'branch');
  const launches = [];
  const manager = new TerminalManager({ store: f.store, trackMs: 0, identify: () => null, table: () => null, spawn: (executable, argv, options) => {
    launches.push({ executable, argv, cwd: options.cwd });
    return { onData() {}, onExit(fn) { this.exit = fn; }, write() {}, resize() {}, kill() {} };
  } });
  const started = await manager.start({ projectId: f.project.id, provider: 'codex', task: 'deployment', workspaceId: ws.id, research: true });
  assert.equal(launches[0].cwd, ws.path); assert.equal(started.session.branch, 'feature/x'); assert.equal(started.session.workspaceId, ws.id);
  assert.doesNotMatch(launches[0].argv.at(-1) ?? '', /MAIN_BRANCH_RULE/, 'Branch knowledge follows the workspace branch');
  assert.deepEqual(launches[0].argv.slice(0, 2), ['--sandbox', 'read-only']);
  await assert.rejects(manager.start({ projectId: f.project.id, provider: 'claude', workspaceId: 'not-a-workspace' }), /Unknown workspace/);
  assert.deepEqual(buildAgentLaunch({ provider: 'claude', prompt: 'x', research: true }).argv.slice(0, 2), ['--permission-mode', 'plan']);
  const claude = await manager.start({ projectId: f.project.id, provider: 'claude', task: 'x', workspaceId: ws.id });
  manager.entry(claude.session.id).proc.exit({ exitCode: 0 });
  await manager.start({ projectId: f.project.id, provider: 'claude', resumeId: claude.session.id });
  assert.equal(launches.at(-1).cwd, ws.path, 'Resume reuses the original workspace');
  manager.disposed = true;
});

test('review fixes: create the reviewed plan exactly; removed worktrees leave readable history', t => {
  const f = fixture(t);
  const plan = f.store.planWorkspace(f.project.id, { branch: 'reviewed', base: 'main' }, f.worktreeRoot);
  writeFileSync(join(f.repo, 'moved.txt'), 'x'); f.git(f.repo, 'add', '.'); f.git(f.repo, '-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'main moved');
  const ws = f.store.createWorkspace(f.project.id, { branch: 'reviewed', base: 'main', baseCommit: plan.base, planId: plan.id }, f.worktreeRoot);
  assert.equal(ws.path, plan.path); assert.equal(f.git(ws.path, 'rev-parse', 'HEAD'), plan.base, 'The base reviewed, not the moved branch');
  f.store.saveSession({ id: 'old', projectId: f.project.id, provider: 'claude', status: 'stopped', workspaceId: ws.id, receiptId: 'r', head: plan.base, createdAt: '' });
  f.store.removeWorkspace(ws.id);
  const changes = f.store.sessionChanges('old');
  assert.equal(changes.available, false); assert.match(changes.reason, /no longer available/);
  const keep = f.store.proposeMemory(f.project.id, { statement: 'Keep me', category: 'lesson', scope: 'checkout', area: '', source: { kind: 'user', note: 'n' } });
  f.store.setMemoryStatus(keep.id, 'active');
  assert.throws(() => f.store.proposeMemory(f.project.id, { memoryId: keep.id, supersedes: keep.id, statement: 'Self', category: 'lesson', scope: 'checkout', area: '', source: { kind: 'user', note: 'n' } }), /another approved claim/);
});

test('a plan ID cannot be replayed to overwrite a workspace, and revisions keep what they replace', t => {
  const f = fixture(t);
  const plan = f.store.planWorkspace(f.project.id, { branch: 'once', base: 'main' }, f.worktreeRoot);
  f.store.createWorkspace(f.project.id, { branch: 'once', base: 'main', baseCommit: plan.base, planId: plan.id }, f.worktreeRoot);
  assert.throws(() => f.store.createWorkspace(f.project.id, { branch: 'twice', base: 'main', baseCommit: plan.base, planId: plan.id }, f.worktreeRoot), /already used/);
  assert.equal(f.store.getWorkspace(plan.id).branch, 'once');
  const old = f.store.proposeMemory(f.project.id, { statement: 'Old rule about retries.', category: 'lesson', scope: 'checkout', area: '', source: { kind: 'user', note: 'n' } }); f.store.setMemoryStatus(old.id, 'active');
  const replacement = f.store.proposeMemory(f.project.id, { supersedes: old.id, statement: 'New rule about retries.', category: 'lesson', scope: 'checkout', area: '', source: { kind: 'user', note: 'n' } });
  const revised = f.store.proposeMemory(f.project.id, { memoryId: replacement.id, statement: 'New rule about retries, revised.', category: 'lesson', scope: 'checkout', area: '', source: { kind: 'user', note: 'n' } });
  assert.equal(revised.supersedes.id, old.id);
  f.store.setMemoryStatus(revised.id, 'active'); assert.equal(f.store.getMemory(old.id).status, 'archived');
});
