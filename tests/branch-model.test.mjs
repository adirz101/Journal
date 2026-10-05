import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

// The branch picker's rules (src/ui/branchModel.ts), transpiled with the copy it imports.
const MODULES = ['copy', 'branchModel'];
async function load(t) {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const dir = mkdtempSync(resolve('.cache/tmp', 'branch-model-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of MODULES) {
    const source = readFileSync(new URL(`../src/ui/${name}.ts`, import.meta.url), 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    writeFileSync(join(dir, `${name}.mjs`), outputText.replace(/from '\.\/(\w+)'/g, "from './$1.mjs'"));
  }
  return import(pathToFileURL(join(dir, 'branchModel.mjs')).href);
}

const NOW = Date.parse('2026-10-05T12:00:00Z');
const branch = (name, extra = {}) => ({ kind: 'local', name, commit: 'c', upstream: null, track: null, date: null, subject: '', current: false, worktree: null, ...extra });
const list = (extra = {}) => ({ key: 'checkout', label: 'repo (checkout)', family: 'primary', branch: 'main', head: 'h', detached: false, truncated: false, blocked: null,
  local: [branch('main', { current: true }), branch('feature/Login'), branch('side', { worktree: '/w', worktreeKey: 'w1', worktreeLabel: 'repo (worktree side)' })],
  remote: [branch('origin/LOGIN-fix', { kind: 'remote', localName: 'LOGIN-fix' }), branch('origin/dup', { kind: 'remote', localName: 'dup', conflict: 'dup' })], ...extra });

test('the filter is a case-insensitive substring match on the name', async t => {
  const m = await load(t);
  const items = [{ name: 'main' }, { name: 'feature/Login' }, { name: 'origin/LOGIN-fix' }];
  assert.deepEqual(m.filterBranches(items, 'login').map(b => b.name), ['feature/Login', 'origin/LOGIN-fix']);
  assert.deepEqual(m.filterBranches(items, ' Gin-F ').map(b => b.name), ['origin/LOGIN-fix']);
  assert.deepEqual(m.filterBranches(items, '  ').map(b => b.name), ['main', 'feature/Login', 'origin/LOGIN-fix']);
  assert.deepEqual(m.filterBranches(items, 'zzz'), []);
  assert.deepEqual(m.matchSpan('feature/Login', 'LOG'), [8, 11]); assert.equal(m.matchSpan('main', 'x'), null); assert.equal(m.matchSpan('main', ''), null);
});

test('groups list local branches first, then remote ones, with reasons for the unavailable', async t => {
  const m = await load(t);
  const groups = m.branchGroups(list(), '');
  assert.deepEqual(groups.map(g => [g.id, g.label, g.options.map(o => [o.branch.name, o.enabled])]), [
    ['local', 'Local branches', [['main', true], ['feature/Login', true], ['side', false]]],
    ['remote', 'Remote branches', [['origin/LOGIN-fix', true], ['origin/dup', false]]]]);
  assert.equal(groups[0].options[2].reason, 'Checked out in repo (worktree side). Choose it in the root picker.');
  assert.equal(groups[1].options[1].reason, 'A local branch dup already exists');
  // Filtering drops empty groups.
  assert.deepEqual(m.branchGroups(list(), 'login').map(g => [g.id, g.options.map(o => o.branch.name)]), [['local', ['feature/Login']], ['remote', ['origin/LOGIN-fix']]]);
  assert.deepEqual(m.branchGroups(list(), 'nothing'), []);
  assert.deepEqual(m.branchGroups(null, ''), []);
});

test('a running session makes every other branch unavailable', async t => {
  const m = await load(t);
  const groups = m.branchGroups(list({ blocked: '“Fix” is running in repo (checkout).' }), '');
  assert.deepEqual(groups.flatMap(g => g.options).filter(o => o.enabled).map(o => o.branch.name), ['main']);
  assert.equal(groups[0].options[1].reason, 'A session is running here');
});

test('the active option starts on the first switchable branch that is not current, and moves with the keys', async t => {
  const m = await load(t);
  const groups = m.branchGroups(list(), '');
  const first = m.keepActiveBranch(groups, null); assert.equal(first, 'local:feature/Login');
  assert.equal(m.keepActiveBranch(groups, 'remote:origin/dup'), 'remote:origin/dup', 'a listed choice is kept');
  assert.equal(m.keepActiveBranch(groups, 'local:gone'), 'local:feature/Login');
  assert.equal(m.moveActiveBranch(groups, first, 1), 'local:side');
  assert.equal(m.moveActiveBranch(groups, 'local:side', 1), 'remote:origin/LOGIN-fix', 'down crosses into the remote group');
  assert.equal(m.moveActiveBranch(groups, 'local:main', -1), 'local:main', 'stops at the top');
  assert.equal(m.moveActiveBranch(groups, 'remote:origin/dup', 1), 'remote:origin/dup', 'stops at the bottom');
  assert.equal(m.moveActiveBranch(groups, first, 'last'), 'remote:origin/dup'); assert.equal(m.moveActiveBranch(groups, first, 'first'), 'local:main');
  assert.equal(m.moveActiveBranch([], null, 1), null);
});

test('the detail shows the current mark, ahead/behind and the last commit age', async t => {
  const m = await load(t);
  assert.equal(m.branchDetail(branch('main', { current: true, track: 'ahead 2', date: new Date(NOW - 3 * 3600_000).toISOString() }), NOW), 'current · ahead 2 · 3h ago');
  assert.equal(m.branchDetail(branch('x', { track: 'gone', date: new Date(NOW - 90 * 86400_000).toISOString() }), NOW), 'upstream gone · 3mo ago');
  assert.equal(m.branchDetail(branch('x', { date: new Date(NOW - 20_000).toISOString() }), NOW), '1m ago');
  assert.equal(m.branchDetail(branch('x'), NOW), '');
});
