import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

// Phase 8 B4: failure states. Transpiles statesModel.ts with the renderer modules it imports.
const MODULES = ['types', 'copy', 'sessionState', 'composerModel', 'statesModel'];
async function load(t) {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const dir = mkdtempSync(resolve('.cache/tmp', 'states-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of MODULES) {
    const source = readFileSync(new URL(`../src/ui/${name}.ts`, import.meta.url), 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    writeFileSync(join(dir, `${name}.mjs`), outputText.replace(/from '\.\/(\w+)'/g, "from './$1.mjs'"));
  }
  return { ...await import(pathToFileURL(join(dir, 'statesModel.mjs')).href), composer: await import(pathToFileURL(join(dir, 'composerModel.mjs')).href) };
}

const commands = provider => ({ login: { claude: 'claude auth login', codex: 'codex login', cursor: 'agent login' }[provider], install: provider === 'cursor' ? 'curl https://cursor.com/install -fsS | bash' : null, installPage: 'https://example.invalid' });
const agent = (provider, extra = {}) => ({ provider, available: true, version: '1.0', state: 'ready', auth: 'unknown', supports: { login: true }, commands: commands(provider), ...extra });
const failure = (code, message = 'It failed') => Object.assign(new Error(message), { code });

test('startProblem never says signed out for unknown auth', async t => {
  const { startProblem } = await load(t);
  for (const auth of ['unknown', 'unchecked', 'signed-in', undefined]) assert.equal(startProblem({ provider: 'codex', agent: agent('codex', { auth }), error: null }), null, String(auth));
  assert.deepEqual(startProblem({ provider: 'codex', agent: agent('codex', { auth: 'signed-out' }), error: null }), { kind: 'signed-out', provider: 'codex', command: 'codex login' });
  assert.deepEqual(startProblem({ provider: 'cursor', agent: agent('cursor', { state: 'login-required', auth: 'signed-out' }), error: null }), { kind: 'signed-out', provider: 'cursor', command: 'agent login' });
  assert.equal(startProblem({ provider: 'claude', agent: agent('claude', { state: 'checking' }), error: null }), null, 'nothing while checking');
  assert.equal(startProblem({ provider: 'claude', agent: undefined, error: null }), null);
});

test('PROVIDER_MISSING maps to missing with Cursor\'s install command only', async t => {
  const { startProblem } = await load(t);
  assert.deepEqual(startProblem({ provider: 'cursor', agent: agent('cursor'), error: failure('PROVIDER_MISSING') }), { kind: 'missing', provider: 'cursor', command: 'curl https://cursor.com/install -fsS | bash' });
  assert.deepEqual(startProblem({ provider: 'codex', agent: agent('codex'), error: failure('PROVIDER_MISSING') }), { kind: 'missing', provider: 'codex', command: null });
  // The renderer's start error is a plain { code, message } object.
  assert.deepEqual(startProblem({ provider: 'codex', agent: agent('codex'), error: { code: 'START_FAILED', message: 'spawn failed' } }), { kind: 'failed', provider: 'codex', detail: 'spawn failed' });
  assert.deepEqual(startProblem({ provider: 'cursor', agent: agent('cursor'), error: failure('PROVIDER_UNSUPPORTED', 'Update the Cursor CLI') }), { kind: 'unsupported', provider: 'cursor', detail: 'Update the Cursor CLI' });
  // A thrown error wins over the agent's state.
  assert.equal(startProblem({ provider: 'codex', agent: agent('codex', { auth: 'signed-out' }), error: failure('PROVIDER_MISSING') }).kind, 'missing');
  assert.equal(startProblem({ provider: 'codex', agent: agent('codex'), error: new Error('no code') }), null, 'an error without a code stays in the app banner');
});

test('SLOTS_FULL is not a StartError', async t => {
  const { startProblem, composer } = await load(t);
  for (const code of ['SLOTS_FULL', 'SHUTTING_DOWN', 'CONVERSATION_OPEN', 'ORPHAN_RUNNING', 'ID_UNCONFIRMED', 'NOT_LIVE'])
    assert.equal(startProblem({ provider: 'claude', agent: agent('claude', { auth: 'signed-out' }), error: failure(code) }), null, code);
  // All four slots: Start waits with the board 9 sentence; New session stays open.
  assert.equal(composer.startBlock({ connected: true, liveCount: 4, busy: false, agent: agent('claude'), provider: 'claude', mode: 'build' }), '4 of 4 running. Stop or finish one to start another. You can still write the task now.');
  // Signed out: Start stays enabled (the CLI shows its own login; the probe may lag).
  assert.equal(composer.startBlock({ connected: true, liveCount: 0, busy: false, agent: agent('codex', { auth: 'signed-out' }), provider: 'codex', mode: 'build' }), null);
});

const AT = '2026-10-05T10:00:00.000Z';
const row = (id, extra = {}) => ({ id, projectId: 'p1', provider: 'claude', nativeId: 'n-' + id, nativeIdConfirmed: true, title: id, status: 'interrupted', receiptId: 'r', createdAt: AT, ...extra });
const recovery = (...ids) => ({ at: AT, runtimeId: 'rt', total: ids.length, sessions: ids.map(id => ({ id, status: 'interrupted', identityVerified: null })) });
const byId = (...sessions) => Object.fromEntries(sessions.map(s => [s.id, s]));

test('recoveryView: resumable → continue; unconfirmed Codex → needs-id; orphaned → running and a leftover; resolved rows close the panel', async t => {
  const { recoveryView } = await load(t);
  const a = row('a'); const b = row('b', { provider: 'codex', nativeIdConfirmed: false }); const c = row('c', { status: 'orphaned' }); const d = row('d', { survivors: [{ pid: 1, started: AT, command: 'node' }] });
  const view = recoveryView(recovery('a', 'b', 'c', 'd'), byId(a, b, c, d), null);
  assert.deepEqual(view.rows.map(r => [r.session.id, r.action, r.reason]), [['a', 'continue', null], ['b', 'needs-id', null], ['c', 'running', null], ['d', 'continue', null]]);
  assert.deepEqual(view.leftovers.map(s => s.id), ['c', 'd']);
  assert.equal(view.interrupted, 4); assert.equal(view.allResumable, false);
  assert.equal(recoveryView(recovery('a'), byId(a), null).allResumable, true);
  // Continued (a newer session resumed it), removed or archived: gone. Nothing left: null.
  const resumed = row('a2', { status: 'running', resumedFrom: 'a' });
  assert.equal(recoveryView(recovery('a'), byId(a, resumed), null), null);
  assert.equal(recoveryView(recovery('a', 'b'), byId({ ...a, archived: true }, { ...b, removed: true }), null), null);
  // Leftover processes keep the panel open after every row is resolved; an archived one does not.
  const survivor = row('s', { survivors: [{ pid: 2, started: AT, command: 'node' }] });
  const kept = recoveryView(recovery('s'), byId(survivor, row('s2', { resumedFrom: 's', status: 'running' })), null);
  assert.deepEqual([kept.rows.length, kept.leftovers.map(s => s.id), kept.allResumable], [0, ['s'], false]);
  assert.equal(recoveryView(recovery('s'), byId({ ...survivor, archived: true }, row('s2', { resumedFrom: 's', status: 'running' })), null), null);
  assert.equal(recoveryView(recovery('a'), {}, null), null, 'rows not loaded are not offered');
  // A row whose status event has not arrived yet takes the recovered status.
  assert.equal(recoveryView(recovery('a'), byId({ ...a, status: 'running' }), null).rows[0].action, 'continue');
  assert.equal(recoveryView(null, byId(a), null), null);
  // The total counts sessions past the 100-row list.
  assert.equal(recoveryView({ ...recovery('a'), total: 140 }, byId(a), null).interrupted, 140);
});

test('Continue is blocked with the slots-full reason', async t => {
  const { recoveryView } = await load(t);
  const reason = '4 of 4 running. Stop or finish one to start another. You can still write the task now.';
  const view = recoveryView(recovery('a', 'b'), byId(row('a'), row('b', { status: 'orphaned' })), reason);
  assert.deepEqual(view.rows.map(r => [r.action, r.reason]), [['continue', reason], ['running', null]]);
});
