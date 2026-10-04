import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

// Transpiles wrapUpModel.ts with the renderer modules it imports into one temporary
// directory, so the test runs the renderer's own code (Phase 6 B11).
async function load(t) {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const dir = mkdtempSync(resolve('.cache/tmp', 'wrap-up-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ['types', 'copy', 'wrapUpModel']) {
    const source = readFileSync(new URL(`../src/ui/${name}.ts`, import.meta.url), 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    writeFileSync(join(dir, `${name}.mjs`), outputText.replace(/from '\.\/(types|copy)'/g, "from './$1.mjs'"));
  }
  return import(pathToFileURL(join(dir, 'wrapUpModel.mjs')).href);
}

const START = '2026-10-04T10:00:00.000Z';
const at = minutes => new Date(Date.parse(START) + minutes * 60_000).toISOString();
const session = (fields = {}) => ({ id: 's1', projectId: 'p', provider: 'claude', nativeId: 'c7d2a1b0-0000-4000-8000-0000000081af', nativeIdConfirmed: true, title: 'Task', status: 'exited',
  receiptId: 'r1', createdAt: START, endedAt: at(18), exitCode: 0, ...fields });
const identity = (fields = {}) => ({ nativeId: 'c7d2a1b0-0000-4000-8000-0000000081af', confirmed: true, source: 'preassigned-observed', mismatch: false, ...fields });
const proposal = (id, fields = {}) => ({ id, kind: 'rule', category: 'constraint', statement: `Rule ${id}`, scope: 'checkout', branch: null, state: 'open', createdAt: START, source: null, ...fields });
const project = { id: 'p', name: 'p', root: '/p', branch: 'main', head: 'abc' };

test('exitLine covers exit codes, signals, stops, interruptions and failed starts', async t => {
  const m = await load(t);
  assert.equal(m.exitLine(session()), 'Exited 0 after 18m');
  assert.equal(m.exitLine(session({ exitCode: 3, endedAt: at(0.5) })), 'Exited 3 after <1m');
  assert.equal(m.exitLine(session({ exitCode: null, signal: 'SIGTERM', endedAt: at(3) })), 'Ended by SIGTERM after 3m');
  assert.equal(m.exitLine(session({ status: 'stopped', endedAt: at(65) })), 'Stopped after 1h 5m');
  assert.equal(m.exitLine(session({ status: 'interrupted' })), 'Interrupted');
  assert.equal(m.exitLine(session({ status: 'failed' })), 'Couldn’t start');
  // The summary's duration and exit code win over the session row.
  assert.equal(m.exitLine(session(), { durationMs: 11 * 60_000, exitCode: 0, signal: null }), 'Exited 0 after 11m');
  assert.equal(m.durationText(null), '<1m');
});

test('isErrorExit; endedView keeps orphans and live sessions out', async t => {
  const m = await load(t);
  assert.equal(m.isErrorExit(session()), false);
  assert.equal(m.isErrorExit(session({ exitCode: 1 })), true);
  assert.equal(m.isErrorExit(session({ status: 'failed', exitCode: null })), true);
  assert.equal(m.isErrorExit(session({ status: 'stopped', exitCode: null })), false);
  for (const status of ['exited', 'stopped', 'failed', 'interrupted']) assert.equal(m.endedView({ status }), 'wrap-up', status);
  for (const status of ['orphaned', 'running', 'starting', 'waiting', 'stopping']) assert.equal(m.endedView({ status }), null, status);
  assert.equal(m.endedView(null), null);
});

test('identityLine for each source and the mismatch', async t => {
  const m = await load(t);
  const line = (fields, provider = 'claude') => m.identityLine(identity(fields), provider);
  assert.deepEqual(line({}), { text: 'Same conversation · ID confirmed by Claude', tone: 'ok', canContinue: true, needsConfirm: false });
  assert.equal(line({ source: 'preassigned' }).text, 'ID set by Journal at start; Claude didn’t report it back');
  assert.equal(line({ source: 'preassigned' }).canContinue, true);
  assert.equal(line({ source: 'create-chat' }, 'cursor').text, 'Chat created by Journal before the start');
  assert.deepEqual(line({ source: 'exit-banner', confirmed: false }, 'codex'), { text: 'From Codex’s exit message · confirm before continuing', tone: 'amber', canContinue: false, needsConfirm: true });
  assert.deepEqual(line({ source: 'user' }, 'codex'), { text: 'Confirmed by you', tone: 'ok', canContinue: true, needsConfirm: false });
  assert.deepEqual(line({ mismatch: true, confirmed: false }), { text: 'Claude reported a different conversation. Confirm the ID before continuing.', tone: 'amber', canContinue: false, needsConfirm: true });
  // A mismatch blocks Continue even if a confirmed flag lingers.
  assert.equal(line({ mismatch: true }).canContinue, false);
  assert.deepEqual(line({ nativeId: null, source: null, confirmed: false }, 'codex'), { text: 'No conversation ID yet', tone: 'quiet', canContinue: false, needsConfirm: true });
  assert.equal(line({ nativeId: null, source: null, confirmed: false }, 'claude').needsConfirm, false);
  assert.equal(m.shortId('c7d2a1b0-0000-4000-8000-0000000081af'), 'c7d2…81af');
});

test('testsLine: counts, failed in red, nothing seen, hidden for Codex', async t => {
  const m = await load(t);
  assert.deepEqual(m.testsLine({ passed: 3, failed: 0, unknown: 0, commands: [] }, 'claude'), { parts: [{ text: '3 passed', tone: null }], empty: false });
  assert.deepEqual(m.testsLine({ passed: 2, failed: 1, unknown: 0, commands: [] }, 'claude').parts, [{ text: '2 passed', tone: null }, { text: '1 failed', tone: 'red' }]);
  assert.deepEqual(m.testsLine({ passed: 0, failed: 0, unknown: 0, commands: [] }, 'claude'), { parts: [{ text: 'No test commands seen', tone: null }], empty: true });
  assert.equal(m.testsLine(null, 'codex').parts[0].text, 'Not visible for Codex');
});

test('rememberAllIds is hidden for one or more than five and skips branch updates and conflicts', async t => {
  const m = await load(t);
  const ready = [{ id: 'w', state: 'ready', branch: 'feature/x' }];
  assert.equal(m.rememberAllIds([proposal('a')], project, []), null);
  assert.deepEqual(m.rememberAllIds([proposal('a'), proposal('b')], project, []), ['a', 'b']);
  assert.equal(m.rememberAllIds(['a', 'b', 'c', 'd', 'e', 'f'].map(id => proposal(id)), project, []), null);
  assert.deepEqual(m.rememberAllIds(['a', 'b', 'c', 'd', 'e'].map(id => proposal(id)), project, []), ['a', 'b', 'c', 'd', 'e']);
  // Branch updates and possible conflicts never count; two rememberable left is enough.
  const list = [proposal('a'), proposal('b', { kind: 'branch-status', category: 'brief', scope: 'branch', branch: 'main' }), proposal('c', { conflicts: [{ id: 'm', revision: 1, statement: 'x' }] })];
  assert.equal(m.rememberAllIds(list, project, []), null);
  assert.deepEqual(m.rememberAllIds([...list, proposal('d')], project, []), ['a', 'd']);
  // A branch no copy has is not one-click; a ready separate copy on it is.
  const other = proposal('e', { scope: 'branch', branch: 'feature/x' });
  assert.equal(m.rememberable(other, project, []), false);
  assert.equal(m.rememberable(other, project, ready), true);
  assert.equal(m.rememberable(other, project, [{ ...ready[0], state: 'missing' }]), false);
  assert.equal(m.rememberable(proposal('f', { scope: 'branch', branch: 'main' }), project, []), true);
});

test('noteActions hides Revise on another branch and allows approve only with a copy on it', async t => {
  const m = await load(t);
  assert.deepEqual(m.noteActions({ scope: 'checkout', branch: null }, project, []), { revise: true, approve: true });
  assert.deepEqual(m.noteActions({ scope: 'branch', branch: 'main' }, project, []), { revise: true, approve: true });
  assert.deepEqual(m.noteActions({ scope: 'branch', branch: 'feature/x' }, project, []), { revise: false, approve: false });
  assert.deepEqual(m.noteActions({ scope: 'branch', branch: 'feature/x' }, project, [{ id: 'w', state: 'ready', branch: 'feature/x' }]), { revise: false, approve: true });
  assert.deepEqual(m.noteActions({ scope: 'branch', branch: 'feature/x' }, project, [{ id: 'w', state: 'failed', branch: 'feature/x' }]), { revise: false, approve: false });
});

test('handoffPrefill copies task, references and mode, never raises the mode, drops a removed workspace', async t => {
  const m = await load(t);
  const receipt = { query: 'rule: Release tags must be signed by CI', references: [
    { kind: 'lines', rootKey: 'primary', path: 'src/a.js', startLine: 1, endLine: 2, contentHash: 'f'.repeat(64), rangeHash: 'e'.repeat(64) },
    { kind: 'file', rootKey: 'primary', path: 'README.md', startLine: null, endLine: null }] };
  const events = [
    { kind: 'reference', at: START, body: { delivery: 'inserted', kind: 'file', rootKey: 'primary', path: 'docs/x.md', startLine: null, endLine: null, contentHash: 'a'.repeat(64) } },
    { kind: 'reference', at: START, body: { delivery: 'copied', kind: 'file', rootKey: 'primary', path: 'copied-only.md' } },
    { kind: 'reference', at: START, body: { delivery: 'inserted', kind: 'lines', rootKey: 'primary', path: 'src/a.js', startLine: 1, endLine: 2 } },
    { kind: 'file', at: START, body: { path: 'src/b.js' } }];
  const prefill = m.handoffPrefill(session({ research: true, workspaceId: 'w1' }), receipt, events, 'codex', [{ id: 'w1', state: 'ready' }]);
  assert.equal(prefill.task, receipt.query);
  assert.equal(prefill.provider, 'codex');
  assert.equal(prefill.mode, 'read-only');
  assert.equal(prefill.workspaceId, 'w1');
  // De-duplicated by root, path and range; copied references and file events are not references; no hashes travel.
  assert.deepEqual(prefill.references.map(ref => ref.path), ['src/a.js', 'README.md', 'docs/x.md']);
  assert.ok(prefill.references.every(ref => !('contentHash' in ref) && !('rangeHash' in ref)));
  assert.equal(m.handoffPrefill(session({ plan: true }), receipt, [], 'cursor', []).mode, 'plan');
  assert.equal(m.handoffPrefill(session(), null, [], 'claude', []).mode, 'build');
  assert.equal(m.handoffPrefill(session(), null, [], 'claude', []).task, '');
  // A removed workspace falls back to the checkout; a folder survives while the project has it.
  assert.equal(m.handoffPrefill(session({ workspaceId: 'w1' }), receipt, [], 'codex', [{ id: 'w1', state: 'removed' }]).workspaceId, '');
  assert.equal(m.handoffPrefill(session({ workspaceId: 'root:r1' }), receipt, [], 'codex', [], [{ id: 'r1' }]).workspaceId, 'root:r1');
  assert.equal(m.handoffPrefill(session({ workspaceId: 'root:gone' }), receipt, [], 'codex', [], [{ id: 'r1' }]).workspaceId, '');
  // Capped at the core's limit.
  const many = Array.from({ length: 30 }, (_, i) => ({ kind: 'file', rootKey: 'primary', path: `f${i}`, startLine: null, endLine: null }));
  assert.equal(m.handoffPrefill(session(), { query: '', references: many }, [], 'claude', []).references.length, m.MAX_REFERENCES);
});

test('staged actions commit after 10 s, never after Undo, and at once on flushAll', async t => {
  const m = await load(t);
  mock.timers.enable({ apis: ['setTimeout'] }); t.after(() => mock.timers.reset());
  const staged = m.createStagedActions({ setTimeout, clearTimeout });
  const done = [];
  staged.stage('a', () => done.push('a')); staged.stage('b', () => done.push('b')); staged.stage('c', () => done.push('c'));
  // Staging a key twice keeps the first commit.
  staged.stage('a', () => done.push('a again'));
  assert.equal(staged.pending('a'), true);
  mock.timers.tick(9_999); assert.deepEqual(done, []);
  assert.equal(staged.undo('b'), true); assert.equal(staged.undo('b'), false);
  mock.timers.tick(1); assert.deepEqual(done, ['a', 'c']);
  assert.equal(staged.pending('a'), false);
  staged.stage('d', () => done.push('d')); staged.stage('e', () => done.push('e'));
  staged.flushAll(); assert.deepEqual(done, ['a', 'c', 'd', 'e']);
  mock.timers.tick(20_000); assert.deepEqual(done, ['a', 'c', 'd', 'e'], 'a flushed commit never runs twice');
});

test('ranges, hunk counts and key labels', async t => {
  const m = await load(t);
  assert.equal(m.validRange(41, 58), true);
  assert.equal(m.validRange(1, 30), true);
  assert.equal(m.validRange(1, 31), false);
  assert.equal(m.validRange(5, 4), false);
  assert.equal(m.validRange(0, 4), false);
  assert.deepEqual(m.hunkCounts([{ lines: [{ kind: ' ' }, { kind: '-' }, { kind: '+' }, { kind: '+' }] }]), { added: 2, removed: 1 });
  assert.deepEqual(m.hunkCounts(null), { added: 0, removed: 0 });
  assert.equal(m.keyLabels(true).continue, '⌘↵');
  assert.equal(m.keyLabels(false).continue, 'Ctrl+Enter');
  assert.equal(m.keyLabels(false).rememberAll, 'Ctrl+Shift+Enter');
});
