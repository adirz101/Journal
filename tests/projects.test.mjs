import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { JournalStore } from '../src/core/store.mjs';
import { TerminalManager } from '../src/core/terminal.mjs';
import { removeLater } from './support/cleanup.mjs';

const gitInit = dir => { mkdirSync(dir, { recursive: true }); execFileSync('git', ['init', '-q', '-b', 'main', dir]); writeFileSync(join(dir, 'README.md'), `${dir}\n`); execFileSync('git', ['-C', dir, 'add', '.']); execFileSync('git', ['-C', dir, '-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'init']); return dir; };
function fixture(t) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'projects-')));
  const repo = gitInit(join(root, 'engineforge'));
  const store = new JournalStore(join(root, 'journal.sqlite')); const project = store.openProject(repo);
  t.after(() => { try { store.close(); } catch {} removeLater(root); });
  const approve = (statement, extra = {}) => { const m = store.proposeMemory(project.id, { statement, category: 'convention', scope: 'checkout', area: '', source: { kind: 'user', note: 'n' }, ...extra }); store.setMemoryStatus(m.id, 'active'); return m; };
  return { root, repo, store, project, approve };
}

test('rename persists, shows everywhere and resets to the folder name; reopening keeps it', t => {
  const f = fixture(t);
  f.store.renameProject(f.project.id, 'EngineForge Studio');
  assert.equal(f.store.project(f.project.id).name, 'EngineForge Studio'); assert.equal(f.store.listProjects()[0].name, 'EngineForge Studio');
  assert.match(f.store.prepareContext(f.project.id, '').packet || 'Project: EngineForge Studio', /EngineForge Studio/);
  assert.equal(f.store.openProject(f.repo).name, 'EngineForge Studio', 'Reopening the folder keeps the display name');
  assert.equal(f.store.project(f.project.id).root, f.repo, 'The folder path is unchanged');
  f.store.renameProject(f.project.id, null); assert.equal(f.store.project(f.project.id).name, 'engineforge');
  assert.throws(() => f.store.renameProject(f.project.id, 'x'.repeat(200)), /project name/);
});

test('pinned projects come first in pin order and survive reopening the store', t => {
  const f = fixture(t);
  const b = f.store.openProject(gitInit(join(f.root, 'beta'))); const c = f.store.openProject(gitInit(join(f.root, 'gamma')));
  assert.deepEqual(f.store.listProjects().map(p => p.id), [c.id, b.id, f.project.id], 'Most recently opened first');
  f.store.setProjectPinned(f.project.id, true); f.store.setProjectPinned(b.id, true);
  assert.deepEqual(f.store.listProjects().map(p => p.id), [f.project.id, b.id, c.id]);
  f.store.close(); const reopened = new JournalStore(join(f.root, 'journal.sqlite')); t.after(() => reopened.close());
  assert.deepEqual(reopened.listProjects().map(p => p.id), [f.project.id, b.id, c.id]);
  reopened.setProjectPinned(f.project.id, false);
  assert.deepEqual(reopened.listProjects().map(p => p.id), [b.id, c.id, f.project.id]);
});

test('remove from Journal never deletes files; keeping data restores everything on reopen', t => {
  const f = fixture(t); const memory = f.approve('Build with the editor tool chain.');
  f.store.removeProject(f.project.id);
  assert.ok(existsSync(join(f.repo, 'README.md')) && existsSync(join(f.repo, '.git')), 'Files and Git data are untouched');
  assert.equal(f.store.listProjects().length, 0); assert.throws(() => f.store.project(f.project.id), /removed from Journal/);
  const restored = f.store.openProject(f.repo);
  assert.equal(restored.id, f.project.id); assert.equal(f.store.getMemory(memory.id).status, 'active');
});

test('remove and delete Journal data deletes only Journal records, refusing while sessions run or worktrees exist', t => {
  const f = fixture(t); const memory = f.approve('Deploy notes for the plugin.');
  const receipt = f.store.prepareContext(f.project.id, '');
  f.store.saveSession({ id: 'live', projectId: f.project.id, provider: 'claude', status: 'running', receiptId: receipt.id, createdAt: '' });
  assert.throws(() => f.store.removeProject(f.project.id, { deleteData: true }), /running sessions/);
  f.store.saveSession({ id: 'live', projectId: f.project.id, provider: 'claude', status: 'stopped', receiptId: receipt.id, createdAt: '' }); f.store.appendEvent('live', 'start', {});
  const ws = f.store.createWorkspace(f.project.id, { branch: 'wt', base: 'main' }, join(f.root, 'worktrees'));
  assert.throws(() => f.store.removeProject(f.project.id, { deleteData: true }), /worktrees first/);
  f.store.removeWorkspace(ws.id);
  f.store.removeProject(f.project.id, { deleteData: true });
  assert.throws(() => f.store.getMemory(memory.id), /Unknown memory/); assert.throws(() => f.store.getSession('live'), /Unknown session/);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM memory_fts').get().n, 0);
  assert.ok(existsSync(join(f.repo, 'README.md'))); assert.equal(execFileSync('git', ['-C', f.repo, 'rev-parse', '--verify', 'refs/heads/wt'], { encoding: 'utf8' }).trim().length, 40);
  assert.notEqual(f.store.openProject(f.repo).id, f.project.id, 'Reopening after deletion starts fresh');
});

test('additional folders: other Git repos and plain folders are accepted; duplicates, overlaps, missing and same-repo paths are not', t => {
  const f = fixture(t);
  const plugin = gitInit(join(f.root, 'unity-plugin')); const docs = join(f.root, 'docs'); mkdirSync(docs);
  const nestedRepo = gitInit(join(f.repo, 'vendor', 'sdk')); mkdirSync(join(f.repo, 'src'));
  let project = f.store.addProjectRoot(f.project.id, plugin);
  assert.equal(project.roots[0].kind, 'git'); assert.equal(project.roots[0].nested, false);
  project = f.store.addProjectRoot(f.project.id, docs); assert.equal(project.roots[1].kind, 'folder');
  project = f.store.addProjectRoot(f.project.id, nestedRepo); assert.equal(project.roots[2].nested, true, 'A separate repository inside the primary is allowed and marked');
  assert.throws(() => f.store.addProjectRoot(f.project.id, plugin), /already part/);
  assert.throws(() => f.store.addProjectRoot(f.project.id, join(f.repo, 'src')), /inside the primary repository/);
  assert.throws(() => f.store.addProjectRoot(f.project.id, f.repo), /primary repository/);
  assert.throws(() => f.store.addProjectRoot(f.project.id, f.root), /contains the primary/);
  assert.throws(() => f.store.addProjectRoot(f.project.id, join(f.root, 'nope')), /does not exist/);
  const worktree = join(f.root, 'same-repo-worktree'); execFileSync('git', ['-C', f.repo, 'worktree', 'add', '-q', '-b', 'side', worktree]);
  assert.throws(() => f.store.addProjectRoot(f.project.id, worktree), /same repository/);
  mkdirSync(join(plugin, 'inner'));
  assert.throws(() => f.store.addProjectRoot(f.project.id, join(plugin, 'inner')), /overlaps/);
  assert.equal(f.store.project(f.project.id).commonDir, realpathSync.native(join(f.repo, '.git')), 'Git identities are never merged');
});

test('evidence keeps its folder identity; removing a folder excludes only its claims, re-adding restores them', t => {
  const f = fixture(t); const plugin = gitInit(join(f.root, 'unity-plugin')); const docs = join(f.root, 'docs'); mkdirSync(docs); writeFileSync(join(docs, 'guide.md'), 'Docs guide line\n');
  let project = f.store.addProjectRoot(f.project.id, plugin); project = f.store.addProjectRoot(f.project.id, docs);
  const [pluginRoot, docsRoot] = project.roots;
  const primary = f.approve('Primary README names the repository.', { source: { kind: 'file', path: 'README.md', startLine: 1, endLine: 1 } });
  const fromPlugin = f.approve('Plugin README names the plugin repository.', { source: { kind: 'file', rootId: pluginRoot.id, path: 'README.md', startLine: 1, endLine: 1 } });
  const fromDocs = f.approve('Docs guide explains the plugin.', { source: { kind: 'file', rootId: docsRoot.id, path: 'guide.md', startLine: 1, endLine: 1 } });
  assert.equal(f.store.getMemory(fromPlugin.id).source.rootId, pluginRoot.id); assert.equal(f.store.getMemory(fromDocs.id).source.commit, null);
  assert.throws(() => f.approve('Branch claim from plugin', { scope: 'branch', source: { kind: 'file', rootId: pluginRoot.id, path: 'README.md', startLine: 1, endLine: 1 } }), { message: 'Notes on one branch must come from the primary repository; choose All branches for notes from additional folders' });
  const packet = f.store.prepareContext(f.project.id, 'README plugin repository guide').packet;
  assert.match(packet, /unity-plugin\/README\.md:1/); assert.match(packet, /docs\/guide\.md:1 @ untracked folder/);
  f.store.removeProjectRoot(f.project.id, pluginRoot.id);
  const states = Object.fromEntries(f.store.listMemories(f.project.id).map(m => [m.id, m.validation]));
  assert.deepEqual([states[primary.id], states[fromPlugin.id], states[fromDocs.id]], ['current', 'folder-removed', 'current']);
  f.store.addProjectRoot(f.project.id, plugin);
  assert.equal(f.store.listMemories(f.project.id).find(m => m.id === fromPlugin.id).validation, 'current', 'Same path, same identity');
  writeFileSync(join(docs, 'guide.md'), 'changed\n');
  assert.equal(f.store.listMemories(f.project.id).find(m => m.id === fromDocs.id).validation, 'stale');
});

test('knowledge never crosses projects, even when both share an additional folder', t => {
  const f = fixture(t); const shared = join(f.root, 'shared-docs'); mkdirSync(shared); writeFileSync(join(shared, 'a.md'), 'Shared line\n');
  const other = f.store.openProject(gitInit(join(f.root, 'other')));
  const mine = f.store.addProjectRoot(f.project.id, shared).roots[0]; const theirs = f.store.addProjectRoot(other.id, shared).roots[0];
  assert.notEqual(mine.id, theirs.id, 'Folder identities are per project');
  f.approve('ALPHA shared docs rule', { source: { kind: 'file', rootId: mine.id, path: 'a.md', startLine: 1, endLine: 1 } });
  assert.equal(f.store.prepareContext(other.id, 'ALPHA shared docs rule').items.length, 0);
  assert.throws(() => f.store.proposeMemory(other.id, { statement: 'x', category: 'lesson', scope: 'checkout', area: '', source: { kind: 'file', rootId: mine.id, path: 'a.md', startLine: 1, endLine: 1 } }), /no longer part/);
});

test('sessions keep one explicit cwd: display names never change it, and a folder can be chosen as the workspace', async t => {
  const f = fixture(t); const plugin = gitInit(join(f.root, 'unity-plugin')); const root = f.store.addProjectRoot(f.project.id, plugin).roots[0];
  const launches = [];
  const manager = new TerminalManager({ store: f.store, trackMs: 0, identify: () => null, table: () => null, spawn: (executable, argv, options) => { launches.push(options.cwd); return { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }; } });
  f.store.renameProject(f.project.id, 'Renamed');
  const primary = await manager.start({ projectId: f.project.id, provider: 'claude', task: 'x' });
  const inFolder = await manager.start({ projectId: f.project.id, provider: 'codex', task: 'y', workspaceId: `root:${root.id}` });
  assert.deepEqual(launches, [f.repo, plugin]); assert.equal(primary.session.cwd, f.repo); assert.equal(inFolder.session.cwd, plugin);
  assert.equal(inFolder.session.branch, 'main'); assert.equal(f.store.sessionChanges(inFolder.session.id).available, true);
  const docs = join(f.root, 'plain'); mkdirSync(docs); const plain = f.store.addProjectRoot(f.project.id, docs).roots.at(-1);
  const plainSession = await manager.start({ projectId: f.project.id, provider: 'claude', task: 'z', workspaceId: `root:${plain.id}` });
  assert.equal(plainSession.session.baseline, null); assert.equal(f.store.sessionChanges(plainSession.session.id).available, false);
  assert.throws(() => f.store.removeProjectRoot(f.project.id, plain.id), /still running/);
  manager.disposed = true;
});

test('an existing v5 project row migrates without losing data', t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'mig6-'))); t.after(() => removeLater(root));
  const repo = gitInit(join(root, 'legacy')); const path = join(root, 'j.sqlite');
  const first = new JournalStore(path); const project = first.openProject(repo); const newer = first.openProject(gitInit(join(root, 'newer'))); first.close();
  const raw = new DatabaseSync(path);
  for (const row of raw.prepare('SELECT id, body FROM projects').all()) {
    const body = JSON.parse(row.body);
    for (const key of ['displayName', 'pinned', 'pinnedAt', 'roots', 'removed', 'folderName', 'openSeq']) delete body[key];
    raw.prepare('UPDATE projects SET body=? WHERE id=?').run(JSON.stringify(body), row.id);
  }
  raw.exec('PRAGMA user_version=5'); raw.close();
  const migrated = new JournalStore(path); t.after(() => migrated.close());
  const listed = migrated.listProjects();
  assert.deepEqual(listed.map(p => p.id), [newer.id, project.id], 'The previous most-recent-first order is kept');
  assert.equal(listed[1].name, 'legacy'); assert.equal(listed[1].pinned, false); assert.deepEqual(listed[1].roots, []);
});

test('folders ignored by an enclosing repository are plain folders; subfolders of another repository say so', t => {
  const f = fixture(t); const host = gitInit(join(f.root, 'host'));
  writeFileSync(join(host, '.gitignore'), 'cache/\n'); mkdirSync(join(host, 'cache')); mkdirSync(join(host, 'docs')); writeFileSync(join(host, 'docs', 'x.md'), 'x\n');
  const ignored = f.store.addProjectRoot(f.project.id, join(host, 'cache')).roots.at(-1);
  assert.equal(ignored.kind, 'folder');
  const sub = f.store.addProjectRoot(f.project.id, join(host, 'docs')).roots.at(-1);
  assert.equal(sub.kind, 'git'); assert.equal(sub.gitRoot, host); assert.notEqual(sub.gitRoot, sub.path);
});

test('review fixes: .git folders are refused; a moved project can still be inspected and removed', t => {
  const f = fixture(t); const other = gitInit(join(f.root, 'other'));
  assert.throws(() => f.store.addProjectRoot(f.project.id, join(f.repo, '.git')), /\.git/);
  assert.throws(() => f.store.addProjectRoot(f.project.id, join(other, '.git', 'hooks')), /\.git/);
  const moved = join(f.root, 'moved'); execFileSync('mv', [f.repo, moved]);
  const details = f.store.projectDetails(f.project.id);
  assert.equal(details.missing, true); assert.equal(details.project.name, 'engineforge');
  f.store.removeProject(f.project.id, { deleteData: true });
  assert.equal(f.store.listProjects().length, 0); assert.ok(existsSync(join(moved, 'README.md')));
});

test('review fixes: folder sessions never create primary-branch proposals; subfolders list only their own changes', async t => {
  const f = fixture(t); const host = gitInit(join(f.root, 'host')); mkdirSync(join(host, 'docs')); writeFileSync(join(host, 'docs', 'a.md'), 'a\n'); writeFileSync(join(host, 'top.md'), 't\n');
  execFileSync('git', ['-C', host, 'add', '.']); execFileSync('git', ['-C', host, '-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'docs']);
  const root = f.store.addProjectRoot(f.project.id, join(host, 'docs')).roots[0];
  const manager = new TerminalManager({ store: f.store, trackMs: 0, identify: () => null, table: () => null, spawn: () => ({ onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }) });
  const { session, receipt } = await manager.start({ projectId: f.project.id, provider: 'claude', task: 'Rule: Docs pages use sentence case headings everywhere.', workspaceId: `root:${root.id}` });
  void receipt;
  f.store.appendEvent(session.id, 'command-start', { toolUseId: 'a', command: 'npm test', test: true }); f.store.appendEvent(session.id, 'command-end', { toolUseId: 'a', status: 'succeeded', exitCode: 0 });
  writeFileSync(join(host, 'docs', 'a.md'), 'changed\n'); writeFileSync(join(host, 'top.md'), 'changed outside the folder\n');
  const kinds = f.store.generateProposals(session.id).map(p => p.kind);
  assert.deepEqual(kinds, ['rule'], 'Folder test commands and commits are not primary-branch knowledge');
  const changes = f.store.sessionChanges(session.id);
  assert.deepEqual(changes.files.map(file => file.path), ['docs/a.md']); assert.equal(changes.folderPrefix, 'docs/');
  assert.match(f.store.sessionFileDiff(session.id, 'docs/a.md').text, /\+changed/);
  assert.throws(() => f.store.sessionFileDiff(session.id, 'top.md'));
  manager.disposed = true;
});

test('review fixes: packets name the working folder and absolute folder evidence; exports keep the folder', t => {
  const f = fixture(t); const docs = join(f.root, 'docs'); mkdirSync(docs); writeFileSync(join(docs, 'g.md'), 'Guide line about deployment\n');
  const root = f.store.addProjectRoot(f.project.id, docs).roots[0];
  f.approve('Deployment guide lives in the docs folder.', { source: { kind: 'file', rootId: root.id, path: 'g.md', startLine: 1, endLine: 1 } });
  const packet = f.store.prepareContext(f.project.id, 'deployment guide', { workspaceId: `root:${root.id}` }).packet;
  assert.match(packet, new RegExp(`Working folder: ${docs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)); assert.ok(packet.includes(`${docs}/g.md:1`));
  const exported = f.store.exportBrain(f.project.id).json;
  assert.deepEqual(exported.memories[0].revisions[0].source.folder, { name: 'docs' }, 'No local absolute paths in exports');
  assert.ok(!JSON.stringify(exported).includes(f.root));
  const other = f.store.openProject(gitInit(join(f.root, 'other')));
  f.store.importBrain(other.id, JSON.stringify(exported));
  assert.match(f.store.listMemories(other.id)[0].source.note, /folder docs: g\.md:1/);
});
