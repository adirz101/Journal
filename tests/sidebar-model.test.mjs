import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

// Transpiles sidebarModel.ts with the renderer modules it imports into one
// temporary directory, so the test runs the renderer's own code.
async function load(t) {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const dir = mkdtempSync(resolve('.cache/tmp', 'sidebar-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ['types', 'copy', 'sessionState', 'sidebarModel']) {
    const source = readFileSync(new URL(`../src/ui/${name}.ts`, import.meta.url), 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    writeFileSync(join(dir, `${name}.mjs`), outputText.replace(/from '\.\/(types|copy|sessionState)'/g, "from './$1.mjs'"));
  }
  return { ...await import(pathToFileURL(join(dir, 'sidebarModel.mjs')).href), state: await import(pathToFileURL(join(dir, 'sessionState.mjs')).href) };
}

// 4 October 2026, 10:00 local time: day boundaries are the user's midnight.
const NOW = new Date(2026, 9, 4, 10, 0).getTime();
const local = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString();
let serial = 0;
const session = (fields = {}) => ({ id: `s${++serial}`, projectId: 'p', provider: 'claude', nativeId: null, nativeIdConfirmed: false, title: 'Task', status: 'stopped', receiptId: 'r', createdAt: local(1, 8), ...fields });

test('recent groups by local day', async t => {
  const { recentGroups } = await load(t);
  const today = session({ endedAt: local(4, 9) }); const yesterday = session({ endedAt: local(3, 23, 30) }); const earlier = session({ endedAt: local(1, 12) });
  const created = session({ createdAt: local(4, 8, 30) }); // only createdAt: it decides
  const excluded = [session({ status: 'running', endedAt: null }), session({ status: 'orphaned' }), session({ archived: true, endedAt: local(4, 9) }), session({ projectId: 'other', endedAt: local(4, 9) }), session({ removed: true, endedAt: local(4, 9) })];
  const groups = recentGroups([today, yesterday, earlier, created, ...excluded], 'p', NOW);
  assert.deepEqual(groups.map(group => [group.key, group.label, group.sessions.map(s => s.id)]), [
    ['today', 'Today', [created.id, today.id]], // newest start first within the day
    ['yesterday', 'Yesterday', [yesterday.id]], ['earlier', 'Earlier', [earlier.id]]]);
  assert.deepEqual(recentGroups([today], 'p', NOW).map(group => group.key), ['today'], 'empty groups are left out');
  assert.deepEqual(recentGroups([], 'p', NOW), []);
});

test('pins order within a day group, not across groups', async t => {
  const { recentGroups } = await load(t);
  const newer = session({ createdAt: local(4, 9), endedAt: local(4, 9, 30) });
  const pinned = session({ createdAt: local(4, 7), endedAt: local(4, 8), pinned: true, pinSeq: 2 });
  const firstPin = session({ createdAt: local(4, 6), endedAt: local(4, 7), pinned: true, pinSeq: 1 });
  const oldPinned = session({ createdAt: local(2, 6), endedAt: local(2, 7), pinned: true, pinSeq: 0 });
  const groups = recentGroups([newer, pinned, oldPinned, firstPin], 'p', NOW);
  assert.deepEqual(groups.map(group => group.sessions.map(s => s.id)), [[firstPin.id, pinned.id, newer.id], [oldPinned.id]]);
});

test('suggestion counts by session', async t => {
  const { suggestionCounts } = await load(t);
  const counts = suggestionCounts([{ evidence: { sessionId: 'a' } }, { evidence: { sessionId: 'a' } }, { evidence: { sessionId: 'b' } }, { evidence: null }, {}, { evidence: { sessionId: null } }]);
  assert.deepEqual([...counts], [['a', 2], ['b', 1]]);
});

test('row detail order', async t => {
  const { rowDetail, state: { stateFor } } = await load(t);
  const now = Date.parse('2026-10-04T12:00:00.000Z');
  const detail = (s, ctx = {}) => rowDetail(s, stateFor(s, now, true), { suggestions: 0, currentProjectId: 'p', projectName: id => id === 'e' ? 'EngineForge' : 'Unknown project', ...ctx }).join(' · ');
  assert.equal(detail(session({ status: 'exited', exitCode: 0 }), { suggestions: 2 }), 'Exited 0 · 2 suggestions');
  assert.equal(detail(session({ status: 'exited', exitCode: 0 }), { suggestions: 1 }), 'Exited 0 · 1 suggestion');
  assert.equal(detail(session({ status: 'interrupted', nativeId: 'n', nativeIdConfirmed: true })), 'Interrupted · Can continue');
  assert.equal(detail(session({ provider: 'codex', status: 'running', projectId: 'e', lastOutputAt: new Date(now - 150_000).toISOString() })), 'Running · quiet 2m · EngineForge');
  assert.equal(detail(session({ status: 'stopped', research: true })), 'Stopped · Read-only');
  assert.equal(detail(session({ status: 'stopped', plan: true })), 'Stopped · Plan mode');
  assert.equal(detail(session({ status: 'running', plan: true, activity: 'working' })), 'Working', 'the mode shows on ended sessions only');
  assert.equal(detail(session({ status: 'waiting', pending: { tool: 'Bash', command: 'npm run test:desktop', path: null, at: '' } })), 'Needs approval · npm run test:desktop');
  assert.equal(detail(session({ status: 'stopped', workspaceId: 'w1', branch: 'feat/x' })), 'Stopped · ⑂ feat/x');
  assert.equal(detail(session({ status: 'stopped', workspaceId: 'root:abc', branch: 'main' })), 'Stopped', 'an additional folder is not a worktree');
});

test('relative time and names are unchanged from the old session list', async t => {
  const { relativeTime, sessionName } = await load(t);
  const now = Date.parse('2026-10-04T12:00:00.000Z');
  assert.deepEqual([0, 59, 60, 3599, 3600, 86399, 86400].map(s => relativeTime(new Date(now - s * 1000).toISOString(), now)), ['0s', '59s', '1m', '59m', '1h', '23h', '1d']);
  assert.equal(relativeTime(null, now), '');
  assert.equal(sessionName(session({ title: 'T', displayName: 'Mine' })), 'Mine'); assert.equal(sessionName(session({ title: 'T', displayName: null })), 'T');
});
