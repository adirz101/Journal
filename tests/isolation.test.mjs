import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { testProviderAllowed } from '../src/core/process.mjs';
import { detectProvider } from '../src/core/agents.mjs';
import { findCursor } from '../src/core/cursor.mjs';
import { assertNoRealProviders, fixtureEnv } from './support/env.ts';

// Test isolation (AGENTS.md, Testing): no desktop spec, launch helper or launch script may build
// an Electron environment from the real one. Only tests/support/env.ts reads it, from an allow-list.
const here = resolve(import.meta.dirname);
const repo = resolve(here, '..');
const posix = process.platform !== 'win32';

const launchers = () => {
  const specs = readdirSync(here).filter(name => /^desktop.*\.spec\.ts$/.test(name)).map(name => join(here, name));
  const support = readdirSync(join(here, 'support')).filter(name => name !== 'env.ts').map(name => join(here, 'support', name));
  // Committed scripts that launch the app (smoke tests, CI diagnostics).
  const scripts = readdirSync(join(repo, 'scripts')).map(name => join(repo, 'scripts', name))
    .filter(path => /electron\.launch\(/.test(readFileSync(path, 'utf8')));
  return { specs, all: [...specs, ...support, ...scripts] };
};

test('no desktop spec, support helper or launch script reads the real environment', () => {
  const { all } = launchers();
  assert.ok(all.length > 20);
  const offenders = [];
  for (const path of all) {
    readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
      // Spreading or listing process.env, or reading PATH or HOME from it, is never allowed;
      // reading one of Journal's own test switches (process.env.JOURNAL_SCREENSHOT) is.
      const bad = /\.\.\.\s*process\.env\b|process\.env\.(?:PATH|Path|HOME|USERPROFILE)\b|process\.env\[|Object\.(?:entries|keys|assign)\(\s*process\.env|process\.env\s*[,)}]/.test(line)
        || /process\.env\.(?!JOURNAL_[A-Z_]+\b)\w+/.test(line);
      if (bad) offenders.push(`${path.slice(repo.length + 1)}:${index + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('every desktop spec and launch script that starts Electron builds its environment with fixtureEnv', () => {
  const { all } = launchers();
  const missing = all.filter(path => { const text = readFileSync(path, 'utf8'); return /electron\.launch\(/.test(text) && !/\bfixtureEnv\(/.test(text); });
  assert.deepEqual(missing.map(path => path.slice(repo.length + 1)), []);
});

test('fixtureEnv: allow-listed, fixture PATH and home, no provider variables, guard folder set', () => {
  const root = mkdtempSync(join(tmpdir(), 'journal-env-'));
  try {
    const env = fixtureEnv({ root, bin: join(root, 'bin'), extra: { JOURNAL_DATA_DIR: join(root, 'data') } });
    const home = join(root, 'home');
    for (const key of ['HOME', 'USERPROFILE']) assert.equal(env[key], home);
    for (const key of ['LOCALAPPDATA', 'APPDATA', 'XDG_CONFIG_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) assert.ok(env[key].startsWith(home), key);
    assert.equal(env.JOURNAL_TEST_PROVIDER_DIR, root);
    assert.equal(env.JOURNAL_DATA_DIR, join(root, 'data'));
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
    assert.deepEqual(env.PATH.split(posix ? ':' : ';').slice(0, 2), [join(root, 'bin'), join(root, 'tools')]);
    assert.deepEqual(Object.keys(env).filter(key => /^(?:ANTHROPIC|OPENAI|CURSOR)_/i.test(key)), []);
    if (posix) for (const tool of ['node', 'git', 'sh', 'ps']) assert.ok(readdirSync(join(root, 'tools')).includes(tool), tool);
    assert.throws(() => fixtureEnv({ root, bin: join(root, 'bin'), extra: { PATH: '/usr/bin' } }), /sets PATH itself/);
    assert.throws(() => fixtureEnv({ root, bin: join(root, 'bin'), extra: { ANTHROPIC_API_KEY: 'x' } }), /provider variables/);
    // The positional form (fixtureEnv(root, bin, extra)) builds the same environment.
    assert.deepEqual(fixtureEnv(root, join(root, 'bin'), { JOURNAL_DATA_DIR: join(root, 'data') }), env);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('assertNoRealProviders: throws for a provider CLI on PATH or in a known location outside bin', { skip: !posix }, () => {
  const root = mkdtempSync(join(tmpdir(), 'journal-env-'));
  try {
    const bin = join(root, 'bin'); const env = fixtureEnv({ root, bin });
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\n'); chmodSync(join(bin, 'claude'), 0o755);
    assert.doesNotThrow(() => assertNoRealProviders(env, bin));
    const elsewhere = join(root, 'elsewhere'); mkdirSync(elsewhere); writeFileSync(join(elsewhere, 'codex'), '#!/bin/sh\n'); chmodSync(join(elsewhere, 'codex'), 0o755);
    assert.throws(() => assertNoRealProviders({ ...env, PATH: `${bin}:${elsewhere}` }, bin), /outside the fixture bin.*codex/);
    // A link in bin to a CLI elsewhere is outside bin too (real paths are compared).
    symlinkSync(join(elsewhere, 'codex'), join(bin, 'codex'));
    assert.throws(() => assertNoRealProviders(env, bin), /codex/);
    rmSync(join(bin, 'codex'));
    mkdirSync(join(root, 'home', '.local', 'bin'), { recursive: true }); writeFileSync(join(root, 'home', '.local', 'bin', 'agent'), '');
    assert.throws(() => assertNoRealProviders(env, bin), /\.local\/bin\/agent/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('testProviderAllowed: in a headless test run, only CLIs inside JOURNAL_TEST_PROVIDER_DIR', { skip: !posix }, () => {
  const root = mkdtempSync(join(tmpdir(), 'journal-guard-'));
  try {
    const inside = join(root, 'bin', 'claude'); const outside = join(tmpdir(), `journal-guard-outside-${process.pid}`);
    mkdirSync(join(root, 'bin')); writeFileSync(inside, ''); writeFileSync(outside, '');
    const link = join(root, 'bin', 'codex'); symlinkSync(outside, link);
    const env = { JOURNAL_HEADLESS: '1', JOURNAL_TEST_PROVIDER_DIR: root };
    assert.equal(testProviderAllowed(inside, env), true);
    assert.equal(testProviderAllowed(outside, env), false);
    assert.equal(testProviderAllowed(link, env), false, 'a link is judged by its real path');
    assert.equal(testProviderAllowed(join(root, 'bin', 'missing'), env), false);
    assert.equal(testProviderAllowed(root, env), false);
    // Outside headless test runs nothing changes.
    assert.equal(testProviderAllowed(outside, { JOURNAL_TEST_PROVIDER_DIR: root }), true);
    assert.equal(testProviderAllowed(outside, { JOURNAL_HEADLESS: '1' }), true);
    rmSync(outside);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the guard: detection never runs a CLI outside the test provider folder', { skip: !posix }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'journal-guard-'));
  try {
    const fixtures = join(root, 'fixtures'); const real = join(root, 'real'); mkdirSync(fixtures); mkdirSync(real);
    for (const name of ['claude', 'agent']) { writeFileSync(join(real, name), '#!/bin/sh\necho 2026.10.01-e373342\n'); chmodSync(join(real, name), 0o755); }
    const env = { PATH: real, JOURNAL_HEADLESS: '1', JOURNAL_TEST_PROVIDER_DIR: fixtures };
    const ran = []; const runner = async path => { ran.push(path); return 'fixture 1.0'; };
    const row = await detectProvider('claude', env, { runner, probes: false });
    assert.equal(row.state, 'missing'); assert.equal(row.path, null);
    const cursor = await findCursor(env, { home: root, runner });
    assert.equal(cursor.path, null);
    assert.deepEqual(ran, []);
    // inspect: false (headless without Cursor probes) runs nothing even inside the folder.
    const allowed = { PATH: real, JOURNAL_HEADLESS: '1', JOURNAL_TEST_PROVIDER_DIR: root };
    assert.equal((await findCursor(allowed, { home: root, runner, inspect: false })).path, null);
    assert.deepEqual(ran, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the app never asks Electron for the home folder: it ignores HOME, so a fixture home would not hold', () => {
  for (const dir of ['src/desktop', 'src/runtime', 'src/core']) {
    for (const name of readdirSync(dir)) {
      if (!/\.(?:mjs|cjs|js|ts)$/.test(name)) continue;
      assert.ok(!/getPath\(\s*['"]home['"]\s*\)/.test(readFileSync(join(dir, name), 'utf8')), `${dir}/${name} uses app.getPath('home'); use os.homedir()`);
    }
  }
});
