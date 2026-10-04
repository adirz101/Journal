import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { JournalStore } from '../src/core/store.mjs';
import { isSensitivePath } from '../src/core/evidence.mjs';
import { listFiles, MAX_LISTED_FILES, parseListing, rankFiles, searchFiles } from '../src/core/files.mjs';
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
  const listing = parseListing(output, '');
  assert.equal(listing.paths.length, MAX_LISTED_FILES); assert.equal(listing.truncated, true);
  assert.equal(parseListing('a.md\0b.md\0', '').truncated, false);
  // A cut-off listing drops its partial last entry and says it is truncated.
  assert.deepEqual(parseListing('a.md\0b.m', '', { partial: true }), { available: true, paths: ['a.md'], truncated: true });
  // Control characters and backslashes never reach the list.
  assert.deepEqual(parseListing('ok.md\0bad\x01.md\0win\\path.md\0', '').paths, ['ok.md']);
  // searchFiles reports a truncated listing it was handed, and its sliced ranking equals rankFiles.
  const paths = Array.from({ length: MAX_LISTED_FILES }, (_, i) => `pkg${i % 50}/src/module${i}/index${i % 7}.ts`);
  const list = async () => ({ available: true, paths, truncated: true });
  const result = await searchFiles(null, 'index3 module12', { list });
  assert.equal(result.truncated, true); assert.ok(result.total > 0); assert.ok(result.hits.length <= 50);
  assert.deepEqual(result, { available: true, ...rankFiles(paths, 'index3 module12'), truncated: true });
  // Measured, not asserted (plan A3). searchFiles yields every 20,000 paths, so
  // main blocks for about a tenth of these times at most.
  const timings = ['index3 module12', 'pkg4 idx', 'a', 'zzz'].map(query => {
    const started = performance.now(); rankFiles(paths, query); return `${query}: ${(performance.now() - started).toFixed(1)} ms`;
  });
  console.log(`rankFiles over ${paths.length} paths in one block: ${timings.join(', ')}`);
});

test('listing never reads file contents', { skip: !posix || process.getuid?.() === 0 }, async t => {
  const f = fixture(t);
  const file = join(f.repo, 'locked/unreadable.txt'); write(f.repo, 'locked/unreadable.txt'); chmodSync(file, 0o000);
  try {
    const result = await searchFiles(f.store.fileRoot(f.project.id, 'checkout'), 'unreadable');
    assert.deepEqual(result.hits.map(hit => hit.path), ['locked/unreadable.txt']);
  } finally { chmodSync(file, 0o644); }
});
