import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { JournalStore } from '../src/core/store.mjs';
import { IDLE_SETTLE_MS, TerminalManager } from '../src/core/terminal.mjs';
import { folderDecorations, gitStatus, parseStatusV2, scopeStatus } from '../src/core/git-status.mjs';
import { fingerprintSync, headDiff, listDirectory, locate, previewFile, treePath } from '../src/core/files.mjs';
import { formatReference, pathFromCwd, referenceEvent, referencesBlock } from '../src/core/references.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'explorer-')));
  const repo = join(root, 'repo'); mkdirSync(repo);
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=a', '-c', 'user.email=a@a', ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
  git(repo, 'init', '-q', '-b', 'main');
  mkdirSync(join(repo, 'src')); writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
  writeFileSync(join(repo, 'src', 'old.ts'), 'old\n'.repeat(20)); writeFileSync(join(repo, 'gone.txt'), 'bye\n');
  writeFileSync(join(repo, 'README.md'), '# Fixture\n'); writeFileSync(join(repo, '.gitignore'), 'build/\nnode_modules/\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'init');
  const store = new JournalStore(join(root, 'journal.sqlite')); const project = store.openProject(repo);
  t.after(() => { try { store.close(); } catch {} rmSync(root, { recursive: true, force: true }); });
  return { root, repo, git, store, project };
}

test('porcelain v2 records become explorer states, scoped to a folder and summarised for parents', () => {
  const out = ['# branch.oid abc', '# branch.head main', '1 .M N... 100644 100644 100644 h h src/a.ts', '1 A. N... 000000 100644 100644 h h src/new file.ts',
    '1 .D N... 100644 100644 000000 h h gone.txt', '2 R. N... 100644 100644 100644 h h R100 src/renamed.ts', 'src/old.ts',
    'u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict.txt', '? notes/', '! build/', '1 .M S.M. 160000 160000 160000 h h vendor/lib', ''].join('\0');
  const status = parseStatusV2(out);
  assert.equal(status.branch, 'main'); assert.equal(status.head, 'abc');
  const kinds = Object.fromEntries(status.entries.map(e => [e.path, e.kind]));
  assert.deepEqual(kinds, { 'src/a.ts': 'modified', 'src/new file.ts': 'added', 'gone.txt': 'deleted', 'src/renamed.ts': 'renamed', 'conflict.txt': 'conflict', notes: 'untracked', build: 'ignored', 'vendor/lib': 'submodule' });
  assert.equal(status.entries.find(e => e.path === 'src/renamed.ts').from, 'src/old.ts');
  assert.ok(status.entries.find(e => e.path === 'notes').directory);
  assert.equal(status.entries.find(e => e.path === 'src/new file.ts').staged, true);
  const folders = folderDecorations(status.entries);
  assert.equal(folders.src, 'modified'); assert.equal(folders[''], 'conflict'); assert.equal(folders.build, undefined, 'Ignored folders are not marked');
  const scoped = scopeStatus(status, 'src/');
  assert.deepEqual(scoped.entries.map(e => e.path).sort(), ['a.ts', 'new file.ts', 'renamed.ts']);
  assert.equal(scoped.entries.find(e => e.path === 'renamed.ts').from, 'old.ts');
  assert.equal(parseStatusV2(out, 2).truncated, true);
  const nested = scopeStatus(parseStatusV2(['2 R. N... 100644 100644 100644 h h R100 a/b/new.ts', 'x/old.ts', ''].join('\0')), 'a/b/');
  assert.equal(nested.entries[0].from, '../../x/old.ts');
});

test('git status reports real working-tree states, including conflicts, without walking ignored folders', async t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'src', 'a.ts'), 'export const a = 10;\n'); unlinkSync(join(f.repo, 'gone.txt'));
  f.git(f.repo, 'mv', 'src/old.ts', 'src/moved.ts');
  mkdirSync(join(f.repo, 'drafts')); writeFileSync(join(f.repo, 'drafts', 'x.md'), 'x\n');
  mkdirSync(join(f.repo, 'node_modules', 'pkg'), { recursive: true }); writeFileSync(join(f.repo, 'node_modules', 'pkg', 'i.js'), '1');
  const status = await gitStatus(f.repo);
  const kinds = Object.fromEntries(status.entries.map(e => [e.path, e.kind]));
  assert.equal(kinds['src/a.ts'], 'modified'); assert.equal(kinds['gone.txt'], 'deleted'); assert.equal(kinds['src/moved.ts'], 'renamed');
  assert.equal(kinds.drafts, 'untracked'); assert.equal(kinds.node_modules, 'ignored');
  assert.ok(!status.entries.some(e => e.path.startsWith('node_modules/')), 'Ignored folders stay collapsed');
  // A merge conflict.
  f.git(f.repo, 'checkout', '-q', '.'); f.git(f.repo, 'reset', '-q', '--hard');
  f.git(f.repo, 'checkout', '-q', '-b', 'other'); writeFileSync(join(f.repo, 'README.md'), '# Other\n'); f.git(f.repo, 'commit', '-qam', 'other');
  f.git(f.repo, 'checkout', '-q', 'main'); writeFileSync(join(f.repo, 'README.md'), '# Main\n'); f.git(f.repo, 'commit', '-qam', 'main');
  try { f.git(f.repo, 'merge', '-q', 'other'); } catch { /* conflict expected */ }
  const conflicted = await gitStatus(f.repo);
  assert.equal(conflicted.entries.find(e => e.path === 'README.md').kind, 'conflict');
  assert.equal(conflicted.folders[''], 'conflict');
});

test('paths are validated; listings hide .git, flag links and sensitive files, and never escape', async t => {
  const f = fixture(t);
  for (const bad of ['', '/etc', '../x', 'a/../b', 'a//b', 'a\\b', 'x\u0000', './a']) assert.throws(() => treePath(bad), /Invalid file path/, bad);
  assert.equal(treePath('a:b.txt', false, 'darwin'), 'a:b.txt'); assert.throws(() => treePath('a:b.txt', false, 'win32'));
  writeFileSync(join(f.repo, '.env'), 'TOKEN=x\n'); mkdirSync(join(f.repo, 'Docs')); writeFileSync(join(f.repo, 'file10.txt'), ''); writeFileSync(join(f.repo, 'file2.txt'), '');
  symlinkSync(f.root, join(f.repo, 'escape'));
  const listing = await listDirectory(f.repo, '');
  const names = listing.entries.map(e => e.name);
  assert.ok(!names.includes('.git'), '.git is never listed');
  assert.ok(names.indexOf('Docs') < names.indexOf('README.md') && names.indexOf('src') < names.indexOf('README.md'), 'Folders first');
  assert.ok(names.indexOf('file2.txt') < names.indexOf('file10.txt'), 'Numeric order');
  assert.equal(listing.entries.find(e => e.name === 'escape').type, 'symlink');
  assert.equal(listing.entries.find(e => e.name === '.env').sensitive, true);
  await assert.rejects(listDirectory(f.repo, 'escape'), /Links are not followed/);
  await assert.rejects(previewFile(f.repo, 'escape/repo/README.md'), /Links are not followed/);
  assert.throws(() => fingerprintSync(f.repo, 'escape/repo/README.md'), /Links are not followed/);
  assert.equal((await locate(f.repo, 'escape')).stat.isSymbolicLink(), true, 'A link itself can be revealed');
  assert.equal((await listDirectory(f.repo, '', 3)).truncated, true);
});

test('previews are bounded: text, binary, sensitive, large, invalid UTF-8, BOM and line endings', async t => {
  const f = fixture(t);
  const text = await previewFile(f.repo, 'src/a.ts');
  assert.equal(text.kind, 'text'); assert.equal(text.lineCount, 4); assert.equal(text.eol, 'lf'); assert.equal(text.highlight, true); assert.match(text.contentHash, /^[0-9a-f]{64}$/);
  writeFileSync(join(f.repo, 'bin.dat'), Buffer.from([1, 2, 0, 3])); assert.equal((await previewFile(f.repo, 'bin.dat')).kind, 'binary');
  writeFileSync(join(f.repo, '.env.local'), 'SECRET=1'); const sensitive = await previewFile(f.repo, '.env.local');
  assert.equal(sensitive.kind, 'sensitive'); assert.equal(sensitive.text, undefined, 'Sensitive contents are never read');
  writeFileSync(join(f.repo, 'big.log'), Buffer.alloc(5 * 1024 * 1024 + 1, 97)); assert.equal((await previewFile(f.repo, 'big.log')).kind, 'too-large');
  writeFileSync(join(f.repo, 'mid.txt'), Buffer.alloc(2 * 1024 * 1024, 97)); assert.equal((await previewFile(f.repo, 'mid.txt')).highlight, false);
  writeFileSync(join(f.repo, 'latin.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9])); assert.equal((await previewFile(f.repo, 'latin.txt')).invalidUtf8, true);
  writeFileSync(join(f.repo, 'bom.txt'), '﻿hello\r\nworld\r\n'); const bom = await previewFile(f.repo, 'bom.txt');
  assert.equal(bom.text.startsWith('hello'), true); assert.equal(bom.eol, 'crlf');
  await assert.rejects(previewFile(f.repo, 'src'), /Not a regular file/);
});

test('fingerprints identify files and line ranges; a changed file gets a new hash', async t => {
  const f = fixture(t);
  const whole = fingerprintSync(f.repo, 'src/a.ts'); const lines = fingerprintSync(f.repo, 'src/a.ts', 2, 3);
  assert.equal(whole.kind, 'file'); assert.equal(lines.kind, 'lines'); assert.equal(lines.contentHash, whole.contentHash);
  assert.equal(fingerprintSync(f.repo, 'src').kind, 'folder');
  assert.throws(() => fingerprintSync(f.repo, 'src/a.ts', 3, 9), /not in the file/);
  assert.throws(() => fingerprintSync(f.repo, 'src/a.ts', 0, 1), /not in the file/);
  writeFileSync(join(f.repo, '.env'), 'x'); assert.throws(() => fingerprintSync(f.repo, '.env'), /Sensitive/);
  writeFileSync(join(f.repo, 'src', 'a.ts'), 'export const a = 1;\nexport const b = 22;\nexport const c = 3;\n');
  const after = fingerprintSync(f.repo, 'src/a.ts', 2, 3);
  assert.notEqual(after.contentHash, whole.contentHash); assert.notEqual(after.rangeHash, lines.rangeHash);
  assert.equal(fingerprintSync(f.repo, 'src/a.ts', 1, 1).rangeHash, fingerprintSync(f.repo, 'src/a.ts', 1, 1).rangeHash);
});

test('diffs against HEAD cover tracked, untracked and sensitive files', async t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'src', 'a.ts'), 'export const a = 2;\n');
  const diff = await headDiff(f.repo, f.repo, '', 'src/a.ts');
  assert.match(diff.text, /-export const a = 1;/); assert.match(diff.text, /\+export const a = 2;/);
  writeFileSync(join(f.repo, 'fresh.txt'), 'one\ntwo\n'); assert.match((await headDiff(f.repo, f.repo, '', 'fresh.txt')).text, /\+one/);
  unlinkSync(join(f.repo, 'gone.txt')); assert.match((await headDiff(f.repo, f.repo, '', 'gone.txt')).text, /-bye/);
  assert.equal((await headDiff(f.repo, f.repo, '', '.env')).hidden, true);
  // A folder path never diffs its contents (it could include sensitive files).
  mkdirSync(join(f.repo, 'config')); writeFileSync(join(f.repo, 'config', '.env'), 'SECRET=old\n'); f.git(f.repo, 'add', '-f', 'config/.env'); f.git(f.repo, 'commit', '-qm', 'cfg');
  writeFileSync(join(f.repo, 'config', '.env'), 'SECRET=new\n');
  await assert.rejects(headDiff(f.repo, f.repo, '', 'config'), /single files/);
  await assert.rejects(headDiff(f.repo, f.repo, '', 'nothing-here'), /no longer exists/);
  // A staged deletion is no longer in the index but still diffs against HEAD.
  f.git(f.repo, 'rm', '-q', 'README.md'); assert.match((await headDiff(f.repo, f.repo, '', 'README.md')).text, /-# Fixture/);
  assert.equal((await listDirectory(f.repo, '')).entries.find(e => e.name === 'src').sensitive, false);
  mkdirSync(join(f.repo, 'auth')); writeFileSync(join(f.repo, 'auth', 'login.ts'), 'x\n'); assert.equal((await previewFile(f.repo, 'auth/login.ts')).kind, 'text', 'An auth folder holds code, not credentials');
  writeFileSync(join(f.repo, 'auth.json'), '{}'); assert.equal((await previewFile(f.repo, 'auth.json')).kind, 'sensitive');
  // Case differences cannot reach a sensitive file on case-insensitive file systems.
  assert.equal((await previewFile(f.repo, 'config/.ENV')).kind, 'sensitive');
});

test('references use each CLI\'s own syntax and refuse control characters', () => {
  assert.equal(formatReference('claude', { path: 'src/a.ts', kind: 'file' }), '@src/a.ts');
  assert.equal(formatReference('claude', { path: 'src/a.ts', kind: 'lines', startLine: 10, endLine: 20 }), '@src/a.ts#L10-20');
  assert.equal(formatReference('claude', { path: 'src/a.ts', kind: 'lines', startLine: 7, endLine: 7 }), '@src/a.ts#L7');
  assert.equal(formatReference('claude', { path: 'src', kind: 'folder' }), '@src/');
  assert.equal(formatReference('claude', { path: 'my docs/a b.md', kind: 'file' }), '"my docs/a b.md"');
  assert.equal(formatReference('codex', { path: 'src/a.ts', kind: 'lines', startLine: 10, endLine: 20 }), 'src/a.ts (lines 10-20)');
  assert.equal(formatReference('codex', { path: 'src/a.ts', kind: 'lines', startLine: 4, endLine: 4 }), 'src/a.ts (line 4)');
  assert.equal(formatReference('codex', { path: 'a "q".md', kind: 'file' }), '"a \\"q\\".md"');
  assert.throws(() => formatReference('claude', { path: 'a\u001b[201~b', kind: 'file' }), /cannot be referenced/);
  assert.throws(() => formatReference('claude', { path: 'a\nb', kind: 'file' }), /cannot be referenced/);
  assert.equal(pathFromCwd('/p/repo', '/p/repo/src/a.ts'), 'src/a.ts'); assert.equal(pathFromCwd('/p/repo', '/p/other/a.ts'), null); assert.equal(pathFromCwd('/p/repo', '/p/repo'), '.');
  const event = referenceEvent({ kind: 'lines', path: 'a.ts', startLine: 2, endLine: 3, contentHash: 'x', rangeHash: 'a'.repeat(64), extra: 'secret' }, 'copied');
  assert.equal(event.contentHash, null); assert.equal(event.rangeHash, 'a'.repeat(64)); assert.equal(event.extra, undefined);
  assert.match(referencesBlock([{ display: 'src/a.ts', kind: 'lines', startLine: 1, endLine: 2, contentHash: 'f'.repeat(64) }]), /- src\/a\.ts lines 1-2 \(sha256 ffffffffffff\)/);
});

test('roots resolve from records only: checkout, ready worktrees and folders of this project', t => {
  const f = fixture(t);
  const ws = f.store.createWorkspace(f.project.id, { branch: 'feature/x', base: 'main' }, join(f.root, 'worktrees'));
  const extra = join(f.root, 'extra'); mkdirSync(extra); writeFileSync(join(extra, 'notes.md'), 'n\n');
  const added = f.store.addProjectRoot(f.project.id, extra); const folder = added.roots[0];
  const roots = f.store.fileRoots(f.project.id);
  assert.deepEqual(roots.primary.map(r => r.key), ['checkout', ws.id]);
  assert.deepEqual(roots.folders.map(r => r.key), [`root:${folder.id}`]);
  assert.equal(f.store.fileRoot(f.project.id, ws.id).path, realpathSync(ws.path));
  assert.equal(f.store.fileRoot(f.project.id, `root:${folder.id}`).git, false);
  const otherRepo = join(f.root, 'other'); mkdirSync(otherRepo); f.git(otherRepo, 'init', '-q'); writeFileSync(join(otherRepo, 'x'), 'x'); f.git(otherRepo, 'add', '.'); f.git(otherRepo, 'commit', '-qm', 'x');
  const other = f.store.openProject(otherRepo);
  assert.throws(() => f.store.fileRoot(other.id, ws.id), /another project/, 'A worktree of one project never resolves under another');
  assert.throws(() => f.store.fileRoot(other.id, `root:${folder.id}`), /no longer part/);
  assert.throws(() => f.store.fileRoot(f.project.id, '/etc'), /Unknown workspace|Invalid/);
});

test('next-task references are recorded in the receipt as paths and hashes, never contents', t => {
  const f = fixture(t);
  const receipt = f.store.prepareContext(f.project.id, 'Fix it', { references: [{ rootKey: 'checkout', path: 'src/a.ts', startLine: 2, endLine: 3 }, { rootKey: 'checkout', path: 'src' }] });
  assert.equal(receipt.references.length, 2);
  assert.equal(receipt.references[0].kind, 'lines'); assert.equal(receipt.references[0].display, 'src/a.ts'); assert.match(receipt.references[0].rangeHash, /^[0-9a-f]{64}$/);
  assert.equal(receipt.references[1].kind, 'folder');
  assert.match(receipt.packet, /Referenced by the user/); assert.match(receipt.packet, /src\/a\.ts lines 2-3/);
  assert.doesNotMatch(receipt.packet, /export const b/, 'File contents never enter the packet');
  assert.deepEqual(f.store.getReceipt(receipt.id).references, receipt.references);
  assert.throws(() => f.store.prepareContext(f.project.id, 'x', { references: [{ rootKey: 'checkout', path: '.env' }] }), /Sensitive|no such file|ENOENT/);
  assert.throws(() => f.store.prepareContext(f.project.id, 'x', { references: Array.from({ length: 21 }, () => ({ rootKey: 'checkout', path: 'README.md' })) }), /up to 20/);
  // A worktree session cannot be handed the checkout's copy.
  const ws = f.store.createWorkspace(f.project.id, { branch: 'feature/y', base: 'main' }, join(f.root, 'worktrees'));
  assert.throws(() => f.store.prepareContext(f.project.id, 'x', { workspaceId: ws.id, references: [{ rootKey: 'checkout', path: 'README.md' }] }), /runs in .*worktree/);
  const inWorktree = f.store.prepareContext(f.project.id, 'x', { workspaceId: ws.id, references: [{ rootKey: ws.id, path: 'README.md' }] });
  assert.equal(inWorktree.references[0].display, 'README.md');
  assert.equal(f.store.describeReference(f.project.id, null, { rootKey: 'checkout', path: 'README.md' }).kind, 'file');
  assert.throws(() => f.store.prepareContext(f.project.id, 'x', { references: [{ projectId: 'another-project', rootKey: 'checkout', path: 'README.md' }] }), /another project/);
  assert.equal(f.store.listReceipts(f.project.id).filter(r => r.references?.length).length, 2, 'Describing a reference records nothing');
  // Referenced folders select area-scoped knowledge.
  const claim = f.store.proposeMemory(f.project.id, { statement: 'Billing amounts are integer cents', category: 'convention', scope: 'checkout', area: 'src', source: { kind: 'user', note: 'team rule' } });
  f.store.setMemoryStatus(claim.id, 'active');
  assert.ok(!f.store.prepareContext(f.project.id, 'Fix it').items.some(i => i.id === claim.id));
  assert.ok(f.store.prepareContext(f.project.id, 'Fix it', { references: [{ rootKey: 'checkout', path: 'src' }] }).items.some(i => i.id === claim.id));
});

test('references are typed into a running Claude session only when it is known to be ready', async t => {
  const f = fixture(t); const writes = []; let exit;
  const manager = new TerminalManager({ store: f.store, trackMs: 0, identify: () => null, table: () => null,
    spawn: () => ({ onData(cb) { this.data = cb; }, onExit(cb) { exit = cb; }, write(d) { writes.push(d); }, resize() {}, kill() {} }) });
  t.after(() => { manager.disposed = true; });
  const { session } = await manager.start({ projectId: f.project.id, provider: 'claude', task: 'x' });
  const entry = manager.entry(session.id);
  assert.equal(manager.paste(session.id, '@src/a.ts').inserted, false, 'Unknown readiness: not typed');
  manager.ingest(session.id, { event: 'SessionStart', nativeId: session.nativeId });
  entry.proc.data('\x1b[?2004h');
  assert.match(manager.paste(session.id, '@src/a.ts').reason, /does not know yet/, 'Just turned idle: a prompt could still be on its way');
  await new Promise(r => setTimeout(r, IDLE_SETTLE_MS + 50));
  assert.deepEqual(manager.paste(session.id, '@src/a.ts#L2-3', { kind: 'lines', path: 'src/a.ts', startLine: 2, endLine: 3 }), { inserted: true });
  assert.equal(writes.at(-1), '\x1b[200~@src/a.ts#L2-3 \x1b[201~', 'Bracketed paste, never Enter');
  manager.ingest(session.id, { event: 'UserPromptSubmit', nativeId: session.nativeId });
  assert.match(manager.paste(session.id, '@src/a.ts').reason, /working/, 'Never while the agent works: a permission prompt can open before its hook is seen');
  manager.ingest(session.id, { event: 'PermissionRequest', nativeId: session.nativeId, tool: 'Bash' });
  const refused = manager.paste(session.id, '@src/a.ts');
  assert.equal(refused.inserted, false); assert.match(refused.reason, /permission/);
  assert.throws(() => manager.paste(session.id, 'a\rb'), /cannot be typed/);
  manager.ingest(session.id, { event: 'Stop', nativeId: session.nativeId }); entry.proc.data('\x1b[?2004l');
  await new Promise(r => setTimeout(r, IDLE_SETTLE_MS + 50));
  manager.paste(session.id, '@README.md'); assert.equal(writes.at(-1), '@README.md ');
  await new Promise(r => setTimeout(r, 20));
  assert.ok(f.store.listEvents(session.id).some(e => e.kind === 'reference' && e.body.delivery === 'inserted' && e.body.path === 'src/a.ts'));
  const codex = await manager.start({ projectId: f.project.id, provider: 'codex', task: 'y' });
  assert.match(manager.paste(codex.session.id, 'src/a.ts').reason, /Codex/);
  const reference = f.store.referenceFor(session.id, { rootKey: 'checkout', path: 'src/a.ts', startLine: 1, endLine: 2 });
  assert.equal(reference.provider, 'claude'); assert.equal(reference.display, 'src/a.ts');
  assert.throws(() => f.store.referenceFor(session.id, { projectId: 'someone-else', rootKey: 'checkout', path: 'src/a.ts' }), /another project/);
  exit?.({ exitCode: 0 });
});
