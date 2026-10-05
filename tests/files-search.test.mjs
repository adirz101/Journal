import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { JournalStore } from '../src/core/store.mjs';
import { isSensitivePath } from '../src/core/evidence.mjs';
import { listFiles, ListingCache, MAX_LISTED_FILES, PARSE_SLICE, parseListing, RANK_SLICE, rankFiles, searchFiles } from '../src/core/files.mjs';
import { gitEnv } from '../src/core/git-env.mjs';
import { gitStatus } from '../src/core/git-status.mjs';
import { removeLater } from './support/cleanup.mjs';

const posix = process.platform !== 'win32';
const write = (root, path, text = 'x\n') => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); };
const gitRepo = path => {
  mkdirSync(path, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', path]);
  return (...args) => execFileSync('git', ['-C', path, '-c', 'user.name=a', '-c', 'user.email=a@a', ...args]);
};

function fixture(t) {
  const root = mkdtempSync(resolve(process.env.JOURNAL_TEST_TMP ?? tmpdir(), 'files-search-'));
  const repo = join(root, 'repo'); const git = gitRepo(repo);
  write(repo, '.gitignore', 'ignored.txt\nbuild/\n');
  for (const path of ['README.md', 'src/core/terminal.mjs', 'docs/TERMINAL-FIRST-SPEC.md', 'src/ui/App.tsx']) write(repo, path);
  // Sensitive names, tracked and untracked, in several cases and depths.
  const sensitive = ['.env', '.env.local', 'id_rsa', 'config/secrets.json', 'certs/a.pem', '.aws/credentials', 'terraform.tfstate', 'Service_Account-x.json', 'upper/.ENV', 'sub/.ssh/known_hosts'];
  for (const path of sensitive) write(repo, path, 'secret\n');
  git('add', '-f', '.'); git('commit', '-qm', 'init');
  write(repo, 'notes/untracked.md'); write(repo, 'ignored.txt'); write(repo, 'build/out.js'); write(repo, 'untracked/.env.production', 'secret\n');
  write(repo, 'README.md', 'changed\n'); // cached and modified: listed once
  const store = new JournalStore(join(root, 'journal.sqlite')); const project = store.openProject(repo);
  t.after(() => { store.close(); removeLater(root); });
  return { root, repo, store, project, sensitive };
}

test('lists tracked and untracked files, never ignored ones', async t => {
  const f = fixture(t);
  const listing = await listFiles(f.store.fileRoot(f.project.id, 'checkout'));
  assert.equal(listing.available, true); assert.equal(listing.truncated, false);
  for (const path of ['README.md', 'src/core/terminal.mjs', 'docs/TERMINAL-FIRST-SPEC.md', 'notes/untracked.md', '.gitignore']) assert.ok(listing.paths.includes(path), path);
  for (const path of ['ignored.txt', 'build/out.js']) assert.ok(!listing.paths.includes(path), path);
  assert.equal(listing.paths.filter(path => path === 'README.md').length, 1, 'a modified tracked file is listed once');
  assert.ok(!listing.paths.some(path => path === '.git' || path.startsWith('.git/')));
});

test('sensitive files never appear', async t => {
  const f = fixture(t);
  const root = f.store.fileRoot(f.project.id, 'checkout');
  const listing = await listFiles(root);
  for (const path of [...f.sensitive, 'untracked/.env.production']) assert.ok(!listing.paths.includes(path), path);
  assert.deepEqual(listing.paths.filter(isSensitivePath), []);
  // Searching for them by name finds nothing either.
  for (const query of ['env', 'id_rsa', 'secrets', 'pem', 'credentials', 'tfstate', 'service account', 'known_hosts', '.ENV']) {
    const result = await searchFiles(root, query, { limit: 100 });
    assert.deepEqual(result.hits.filter(hit => isSensitivePath(hit.path)).map(hit => hit.path), [], query);
  }
});

test('a folder root lists only below its prefix, relative to it', async t => {
  const f = fixture(t);
  const other = join(f.root, 'other'); const git = gitRepo(other);
  write(other, 'top.md'); write(other, 'sub/inner.md'); write(other, 'sub/deep/file.ts'); write(other, 'sub/.env'); write(other, 'subway/no.md');
  git('add', '.'); git('commit', '-qm', 'init');
  const project = f.store.addProjectRoot(f.project.id, join(other, 'sub'));
  const rootKey = `root:${project.roots.find(entry => entry.name === 'sub').id}`;
  const root = f.store.fileRoot(f.project.id, rootKey);
  assert.equal(root.prefix, 'sub/');
  const listing = await listFiles(root);
  assert.deepEqual([...listing.paths].sort(), ['deep/file.ts', 'inner.md']);
});

test('a non-Git folder reports not-git', async t => {
  const f = fixture(t);
  const plain = join(f.root, 'plain'); write(plain, 'a.txt');
  const project = f.store.addProjectRoot(f.project.id, plain);
  const root = f.store.fileRoot(f.project.id, `root:${project.roots.find(entry => entry.name === 'plain').id}`);
  assert.deepEqual(await listFiles(root), { available: false, reason: 'not-git' });
  assert.deepEqual(await searchFiles(root, 'a'), { available: false, reason: 'not-git', hits: [], total: 0, truncated: false });
});

test('ranking prefers basename and segment-start matches', () => {
  const paths = ['docs/TERMINAL-FIRST-SPEC.md', 'src/core/terminal.mjs', 'src/ui/TerminalPane.tsx', 'tests/determinism.test.mjs', 'README.md'];
  const term = rankFiles(paths, 'term');
  assert.equal(term.hits[0].path, 'src/core/terminal.mjs');
  assert.ok(term.hits.findIndex(hit => hit.path === 'src/core/terminal.mjs') < term.hits.findIndex(hit => hit.path === 'docs/TERMINAL-FIRST-SPEC.md'));
  assert.deepEqual(term.hits[0].spans, [[9, 13]]);
  // A contiguous basename match beats letters scattered through the path.
  assert.ok(term.hits.findIndex(hit => hit.path === 'tests/determinism.test.mjs') > term.hits.findIndex(hit => hit.path === 'docs/TERMINAL-FIRST-SPEC.md'));
  const tm = rankFiles(['src/core/terminal.mjs'], 'tm');
  assert.equal(tm.total, 1); assert.deepEqual(tm.hits[0].spans, [[9, 10], [12, 13]]);
  // camelCase boundaries count as segment starts: "tp" finds TerminalPane first.
  assert.equal(rankFiles(paths, 'tp').hits[0].path, 'src/ui/TerminalPane.tsx');
  // Every token must match; order between tokens does not matter.
  assert.deepEqual(rankFiles(paths, 'mjs core').hits.map(hit => hit.path), ['src/core/terminal.mjs']);
  assert.deepEqual(rankFiles(paths, 'core mjs').hits.map(hit => hit.path), ['src/core/terminal.mjs']);
  assert.equal(rankFiles(paths, 'zzz').total, 0);
  // An empty query returns nothing (the renderer shows a hint).
  assert.deepEqual(rankFiles(paths, '   '), { hits: [], total: 0 });
  assert.deepEqual(rankFiles(paths, 'TERM').hits.map(hit => hit.path), term.hits.map(hit => hit.path), 'case-insensitive');
});

test('ties are stable and limited', () => {
  const paths = Array.from({ length: 60 }, (_, i) => `f/a${String(60 - i).padStart(2, '0')}.txt`);
  const result = rankFiles(paths, 'a');
  assert.equal(result.total, 60); assert.equal(result.hits.length, 50);
  assert.deepEqual(result.hits.map(hit => hit.path), Array.from({ length: 50 }, (_, i) => `f/a${String(i + 1).padStart(2, '0')}.txt`));
  assert.ok(result.hits.every(hit => hit.score === result.hits[0].score));
  assert.deepEqual(rankFiles(paths, 'a', 5).hits.map(hit => hit.path), ['f/a01.txt', 'f/a02.txt', 'f/a03.txt', 'f/a04.txt', 'f/a05.txt']);
  // Numeric order: a2 before a10.
  assert.deepEqual(rankFiles(['x/a10.md', 'x/a2.md'], 'md').hits.map(hit => hit.path), ['x/a2.md', 'x/a10.md']);
  // The query and its tokens are bounded; paths over 1024 characters are skipped.
  assert.equal(rankFiles([`${'d/'.repeat(600)}x.md`], 'x').total, 0);
  assert.equal(rankFiles(['a b c d e f g h i.md'], 'a b c d e f g h zzz').total, 1, 'a ninth token is ignored');
});

test('a path is never interpreted as a pathspec', { skip: !posix }, async t => {
  const f = fixture(t);
  const other = join(f.root, 'globs'); const git = gitRepo(other);
  write(other, ':(glob)*'); write(other, 'a/one.md'); write(other, '[ab]/two.md'); write(other, '[ab]/:(glob)*');
  git('add', '.'); git('commit', '-qm', 'init');
  const listing = await listFiles({ git: true, gitRoot: other, prefix: '', path: other });
  assert.ok(listing.paths.includes(':(glob)*'));
  // A prefix with glob characters names only that folder.
  const prefixed = await listFiles({ git: true, gitRoot: other, prefix: '[ab]/', path: join(other, '[ab]') });
  assert.deepEqual([...prefixed.paths].sort(), [':(glob)*', 'two.md']);
});

test('Git failures are reported without the message', { skip: !posix }, async t => {
  const f = fixture(t);
  const bin = join(f.root, 'fake-bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'git'), '#!/bin/sh\necho "/private/outside/secret-path"\necho "fatal: /private/outside/secret-path" >&2\nexit 128\n', { mode: 0o755 });
  const root = f.store.fileRoot(f.project.id, 'checkout');
  const path = process.env.PATH; process.env.PATH = `${bin}:${path}`;
  try {
    const result = await searchFiles(root, 'secret');
    assert.deepEqual(result, { available: false, reason: 'failed', hits: [], total: 0, truncated: false });
    assert.doesNotMatch(JSON.stringify(result), /outside/);
  } finally { process.env.PATH = path; }
});

test('the listing is capped', async () => {
  const output = `${Array.from({ length: MAX_LISTED_FILES + 1 }, (_, i) => `src/f${i}.js`).join('\0')}\0`;
  const listing = await parseListing(output);
  assert.equal(listing.paths.length, MAX_LISTED_FILES); assert.equal(listing.truncated, true); assert.equal(listing.truncatedBy, 'limit');
  assert.deepEqual(await parseListing('a.md\0b.md\0'), { available: true, paths: ['a.md', 'b.md'], truncated: false });
  // A cut-off listing drops its partial last entry and says why it is truncated.
  assert.deepEqual(await parseListing('a.md\0b.m', { cut: 'timeout' }), { available: true, paths: ['a.md'], truncated: true, truncatedBy: 'timeout' });
  // Control characters and backslashes never reach the list.
  assert.deepEqual((await parseListing('ok.md\0bad\x01.md\0win\\path.md\0')).paths, ['ok.md']);
  // searchFiles reports a truncated listing it was handed, with its reason and count, and its sliced ranking equals rankFiles.
  const paths = Array.from({ length: MAX_LISTED_FILES }, (_, i) => `pkg${i % 50}/src/module${i}/index${i % 7}.ts`);
  const list = async () => ({ available: true, paths, truncated: true, truncatedBy: 'limit' });
  const result = await searchFiles(null, 'index3 module12', { list });
  assert.equal(result.truncated, true); assert.ok(result.total > 0); assert.ok(result.hits.length <= 50);
  assert.deepEqual(result, { available: true, ...rankFiles(paths, 'index3 module12'), truncated: true, truncatedBy: 'limit', listed: MAX_LISTED_FILES });
  const timedOut = await searchFiles(null, '', { list: async () => ({ available: true, paths: paths.slice(0, 1234), truncated: true, truncatedBy: 'timeout' }) });
  assert.deepEqual(timedOut, { available: true, hits: [], total: 0, truncated: true, truncatedBy: 'timeout', listed: 1234 });
});

// Realistic monorepo paths: packages, nested source folders, tests and assets.
const realisticPaths = count => Array.from({ length: count }, (_, i) => {
  const pkg = `packages/${['app', 'core', 'ui-kit', 'server', 'shared-utils'][i % 5]}-${i % 97}`;
  const folder = ['src/components', 'src/hooks', 'src/lib/internal', 'tests/unit', 'assets/icons', 'docs/guides'][i % 6];
  return `${pkg}/${folder}/${['Button', 'useSession', 'formatDate', 'terminal', 'index', 'README'][i % 6]}${i}.${['tsx', 'ts', 'mjs', 'svg', 'md'][i % 5]}`;
});
// The work done between two yields, from the progress each yield reports (the entries or paths
// handled so far), up to the end of the run. No wall-clock time is measured: the bound holds on
// any machine and under any load.
async function slices(total, work) {
  const marks = [];
  const value = await work(async done => { marks.push(done); await new Promise(resolve => setImmediate(resolve)); });
  const points = [0, ...marks, total];
  return { value, yields: marks.length, largest: Math.max(...points.slice(1).map((point, i) => point - points[i])) };
}

test('parsing and ranking 200,000 paths yield to the event loop after a bounded amount of work', async () => {
  const paths = realisticPaths(MAX_LISTED_FILES);
  // Staged entries as ls-files --stage prints them, then untracked ones.
  const staged = `${paths.slice(0, 150_000).map(path => `100644 ${'a'.repeat(40)} 0\t${path}`).join('\0')}\0`;
  const others = `${paths.slice(150_000).join('\0')}\0`;
  const parse = await slices(MAX_LISTED_FILES, yieldTo => parseListing([{ output: staged, staged: true }, { output: others, staged: false }], { yieldTo }));
  assert.equal(parse.value.paths.length, MAX_LISTED_FILES); assert.equal(parse.value.truncated, false);
  assert.ok(parse.largest <= PARSE_SLICE, `parse read ${parse.largest} entries without yielding`);
  assert.ok(parse.yields >= MAX_LISTED_FILES / PARSE_SLICE - 1, `parse yielded ${parse.yields} times`);
  // A query matching every path (every one starts with "packages/").
  assert.equal(rankFiles(paths, 'pkg').total, MAX_LISTED_FILES);
  const broad = await slices(MAX_LISTED_FILES, yieldTo => searchFiles(null, 'pkg', { list: async () => parse.value, yieldTo }));
  assert.equal(broad.value.total, MAX_LISTED_FILES);
  assert.ok(broad.largest <= RANK_SLICE, `ranking handled ${broad.largest} paths without yielding`);
  assert.equal(broad.yields, Math.ceil(MAX_LISTED_FILES / RANK_SLICE) - 1);
  const narrow = await slices(MAX_LISTED_FILES, yieldTo => searchFiles(null, 'button 1234', { list: async () => parse.value, yieldTo }));
  assert.ok(narrow.largest <= RANK_SLICE);
  // The default yield waits for the event loop: a timer set before the search runs before it ends.
  let ticked = false; setTimeout(() => { ticked = true; }, 0);
  await searchFiles(null, 'pkg', { list: async () => parse.value });
  assert.equal(ticked, true);
});

test('the listing cache runs one listing per root at a time and serves a stale list while it refreshes', async () => {
  let now = 0; let running = 0; let most = 0; let calls = 0; const pending = [];
  const list = root => { calls++; running++; most = Math.max(most, running); return new Promise(resolve => pending.push(paths => { running--; resolve({ available: true, paths: [`${root}:${paths}`], truncated: false }); })); };
  const cache = new ListingCache({ list, refreshMs: 1500, now: () => now });
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
  // The first searches share one run.
  const first = [cache.get('a', 'A'), cache.get('a', 'A')];
  await settle(); assert.equal(calls, 1);
  // A burst of watcher events and searches while it runs starts nothing new.
  for (let i = 0; i < 20; i++) { cache.invalidate('a'); first.push(cache.get('a', 'A')); }
  await settle(); assert.equal(calls, 1);
  pending.shift()('v1');
  for (const result of await Promise.all(first)) assert.deepEqual(result.paths, ['A:v1']);
  // It was invalidated during the run, so the next search gets the stale list and starts one refresh.
  now = 2000;
  assert.deepEqual((await cache.get('a', 'A')).paths, ['A:v1']); await settle();
  assert.equal(calls, 2);
  for (let i = 0; i < 20; i++) { cache.invalidate('a'); assert.deepEqual((await cache.get('a', 'A')).paths, ['A:v1']); }
  await settle(); assert.equal(calls, 2, 'one refresh at a time');
  pending.shift()('v2'); await settle();
  // Invalidated during the refresh: still stale, and the next refresh waits for the 1.5 s gap.
  now = 2500;
  assert.deepEqual((await cache.get('a', 'A')).paths, ['A:v2']); await settle();
  assert.equal(calls, 2, 'refreshes at most every 1.5 s');
  // An unchanged list is served without Git.
  now = 3600; await new Promise(resolve => setTimeout(resolve, 1100)); await settle();
  assert.equal(calls, 3, 'the waiting refresh ran after the gap'); pending.shift()('v3'); await settle();
  assert.deepEqual((await cache.get('a', 'A')).paths, ['A:v3']); await settle(); assert.equal(calls, 3);
  // Another root is independent; a clear() during a run never starts a parallel listing of the same root.
  const b = cache.get('b', 'B'); await settle(); assert.equal(calls, 4);
  cache.clear(); const b2 = cache.get('b', 'B2'); await settle();
  assert.equal(calls, 4, 'the new listing waits for the one in flight'); assert.equal(most, 1);
  pending.shift()('old'); assert.deepEqual((await b).paths, ['B:old']); await settle();
  assert.equal(calls, 5); pending.shift()('new');
  assert.deepEqual((await b2).paths, ['B2:new'], 'a cleared list is never served'); assert.equal(most, 1);
});

test('a folder root lists relative to itself whatever the case of its stored path', { skip: process.platform !== 'darwin' && process.platform !== 'win32' }, async t => {
  const f = fixture(t);
  const other = join(f.root, 'Cased'); const git = gitRepo(other);
  write(other, 'Sub/inner.md'); write(other, 'Sub/.env'); write(other, 'top.md');
  git('add', '.'); git('commit', '-qm', 'init');
  // Stored with another case than on disk (the folder was picked as "sub"): the prefix no longer matches Git's spelling.
  const listing = await listFiles({ git: true, gitRoot: other, prefix: 'sub/', path: join(other, 'sub') });
  assert.deepEqual(listing.paths, ['inner.md']);
});

test('a sensitive folder root lists nothing', async t => {
  const f = fixture(t);
  const listing = await listFiles({ git: true, gitRoot: f.repo, prefix: '.aws/', path: join(f.repo, '.aws') });
  assert.deepEqual(listing, { available: true, paths: [], truncated: false });
});

test('Git variables that point at another repository are ignored', async t => {
  const f = fixture(t);
  const decoy = join(f.root, 'decoy'); const git = gitRepo(decoy); write(decoy, 'decoy-only.md'); git('add', '.'); git('commit', '-qm', 'decoy');
  const env = gitEnv({}, { PATH: 'x', GIT_DIR: join(decoy, '.git'), GIT_WORK_TREE: decoy, git_index_file: 'x', GIT_OBJECT_DIRECTORY: 'y', GIT_AUTHOR_NAME: 'kept' });
  assert.deepEqual(Object.keys(env).filter(name => /^git_(?:dir|work_tree|index_file|object_directory)$/i.test(name)), []);
  assert.equal(env.GIT_AUTHOR_NAME, 'kept'); assert.equal(env.GIT_LITERAL_PATHSPECS, '1');
  const root = f.store.fileRoot(f.project.id, 'checkout'); const saved = { ...process.env };
  Object.assign(process.env, { GIT_DIR: join(decoy, '.git'), GIT_WORK_TREE: decoy, GIT_INDEX_FILE: join(decoy, '.git', 'index') });
  try {
    const listing = await listFiles(root);
    assert.ok(listing.paths.includes('src/core/terminal.mjs')); assert.ok(!listing.paths.includes('decoy-only.md'));
    const status = await gitStatus(root.gitRoot);
    assert.ok(status.entries.some(entry => entry.path === 'README.md')); assert.ok(!status.entries.some(entry => entry.path === 'decoy-only.md'));
  } finally { for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) { if (name in saved) process.env[name] = saved[name]; else delete process.env[name]; } }
});

test('submodules are not listed as files', async t => {
  const f = fixture(t);
  const lib = join(f.root, 'lib'); const libGit = gitRepo(lib); write(lib, 'lib.md'); libGit('add', '.'); libGit('commit', '-qm', 'lib');
  execFileSync('git', ['-C', f.repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'vendor/lib'], { stdio: 'ignore' });
  // An untracked nested repository is listed by Git as a folder ("nested/"), which is skipped too.
  const nested = join(f.repo, 'nested'); const nestedGit = gitRepo(nested); write(nested, 'n.md'); nestedGit('add', '.'); nestedGit('commit', '-qm', 'n');
  const listing = await listFiles(f.store.fileRoot(f.project.id, 'checkout'));
  assert.ok(listing.paths.includes('.gitmodules')); assert.ok(listing.paths.includes('README.md'));
  for (const path of ['vendor/lib', 'vendor/lib/lib.md', 'nested', 'nested/', 'nested/n.md']) assert.ok(!listing.paths.includes(path), path);
  // Conflict stages list a path once.
  assert.deepEqual((await parseListing([{ output: `100644 ${'a'.repeat(40)} 1\tc.md\x00100644 ${'b'.repeat(40)} 2\tc.md\x00160000 ${'c'.repeat(40)} 0\tsub\0`, staged: true }])).paths, ['c.md']);
});

test('listing never reads file contents', { skip: !posix || process.getuid?.() === 0 }, async t => {
  const f = fixture(t);
  const file = join(f.repo, 'locked/unreadable.txt'); write(f.repo, 'locked/unreadable.txt'); chmodSync(file, 0o000);
  try {
    const result = await searchFiles(f.store.fileRoot(f.project.id, 'checkout'), 'unreadable');
    assert.deepEqual(result.hits.map(hit => hit.path), ['locked/unreadable.txt']);
  } finally { chmodSync(file, 0o644); }
});
