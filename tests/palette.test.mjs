import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { COMMAND_IDS, shortcutKeys } from '../src/desktop/shortcuts.mjs';

// Phase 8 B1: the command palette's rules. Transpiles paletteModel.ts with the renderer
// modules it imports into one temporary directory, so the test runs the renderer's code.
const MODULES = ['types', 'copy', 'sessionState', 'sidebarModel', 'paletteModel'];
async function load(t) {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const dir = mkdtempSync(resolve('.cache/tmp', 'palette-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of MODULES) {
    const source = readFileSync(new URL(`../src/ui/${name}.ts`, import.meta.url), 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    writeFileSync(join(dir, `${name}.mjs`), outputText.replace(/from '\.\/(\w+)'/g, "from './$1.mjs'"));
  }
  return import(pathToFileURL(join(dir, 'paletteModel.mjs')).href);
}

const NOW = Date.parse('2026-10-05T12:00:00Z');
const ago = ms => new Date(NOW - ms).toISOString();
let n = 0;
const session = (extra = {}) => ({ id: `s${++n}`, projectId: 'p1', provider: 'claude', nativeId: null, nativeIdConfirmed: false, title: 'Untitled', status: 'running', receiptId: 'r', createdAt: ago(600_000), ...extra });
const keys = shortcutKeys('darwin');
const labels = groups => groups.map(group => [group.id, group.items.map(item => item.label)]);

test('> restricts results to actions', async t => {
  const m = await load(t);
  assert.deepEqual(m.parseQuery('  > new '), { text: 'new', actionsOnly: true });
  assert.deepEqual(m.parseQuery('new'), { text: 'new', actionsOnly: false });
  const { text, actionsOnly } = m.parseQuery('>new');
  const groups = m.buildGroups({ text, actionsOnly, sessions: [], quiet: [], actions: m.actionItems(m.PALETTE_ACTIONS, keys, () => null, text), notes: [], notesLoading: false });
  assert.deepEqual(groups.map(group => group.id), ['actions']);
  assert.ok(groups[0].items.every(item => item.kind === 'action'));
  assert.equal(groups[0].items[0].label, 'New session');
  assert.equal(m.searchesMemory('new', true), false, 'no note search for > queries');
  assert.equal(m.searchesMemory('n', false), false, 'no note search under two characters');
});

test('sessions match title, provider and branch; live first by slot', async t => {
  const m = await load(t);
  const a = session({ title: 'Fix worktree removal', provider: 'codex', slot: 2, lastOutputAt: ago(1000) });
  const b = session({ title: 'Locked worktrees on Windows', status: 'exited', exitCode: 0, endedAt: ago(2 * 86_400_000), nativeId: 'n', nativeIdConfirmed: true });
  const c = session({ title: 'Another', slot: 1, branch: 'feature/worktree' });
  const d = session({ title: 'worktree docs', status: 'stopped', projectId: 'p2', endedAt: ago(1000) });
  const removed = session({ title: 'worktree gone', status: 'stopped', removed: true });
  const items = m.sessionMatches([a, b, c, d, removed], 'p1', 'work', NOW, true, keys);
  assert.deepEqual(items.map(item => item.session.id), [c.id, a.id, b.id, d.id], 'live by slot, then this project, then others');
  assert.equal(items[1].keys, '⌘2'); assert.equal(items[1].detail, 'Running · output just now');
  assert.equal(items[2].detail, 'Exited 0 · 2d'); assert.equal(items[2].action, 'continue', 'an ended resumable session hints Continue');
  assert.equal(items[0].action, 'open');
  assert.deepEqual(items[1].spans, [[4, 8]], 'the matched word is marked');
  assert.deepEqual(m.sessionMatches([a, b, c], 'p1', 'codex', NOW, true).map(item => item.session.id), [a.id], 'provider name matches');
  assert.deepEqual(m.sessionMatches([a, b, c], 'p1', '', NOW, true).map(item => item.session.id), [c.id, a.id], 'an empty query lists live sessions only');
  const many = Array.from({ length: 9 }, (_, i) => session({ title: `task ${i}`, status: 'stopped', endedAt: ago(i * 1000) }));
  assert.equal(m.sessionMatches(many, 'p1', 'task', NOW, true).length, 6);
  // Disconnected: a live session's state is unknown.
  assert.equal(m.sessionMatches([a], 'p1', '', NOW, false)[0].detail, 'Disconnected · state unknown');
});

test('quiet sessions are Codex and Cursor live sessions quiet for at least 2 minutes, never Claude, never while disconnected', async t => {
  const m = await load(t);
  const codex = session({ provider: 'codex', lastOutputAt: ago(130_000) });
  const cursor = session({ provider: 'cursor', lastOutputAt: null, createdAt: ago(600_000), title: 'Plan the export' });
  const fresh = session({ provider: 'codex', lastOutputAt: ago(30_000) });
  const claude = session({ provider: 'claude', lastOutputAt: ago(900_000) });
  const ended = session({ provider: 'codex', status: 'exited', lastOutputAt: ago(900_000) });
  assert.deepEqual(m.quietSessions([codex, cursor, fresh, claude, ended], NOW).map(s => s.id), [cursor.id, codex.id], 'quietest first');
  const items = m.quietItems([cursor], NOW);
  assert.equal(items[0].detail, 'Cursor · no output yet');
  assert.equal(m.quietItems([codex], NOW)[0].detail, 'Codex · quiet 2m');
  // The palette passes no quiet sessions while disconnected; buildGroups lists what it gets.
  const empty = m.buildGroups({ text: '', actionsOnly: false, sessions: [], quiet: [], actions: [], notes: [], notesLoading: false });
  assert.deepEqual(empty, []);
});

test('every routed command except slots and the palette itself is an action with its key label', async t => {
  const m = await load(t);
  const expected = COMMAND_IDS.filter(id => !/^slot-/.test(id) && id !== 'command-palette' && id !== 'open-file');
  assert.deepEqual([...m.PALETTE_COMMANDS].sort(), [...expected].sort());
  for (const platform of ['darwin', 'win32', 'linux']) {
    const platformKeys = shortcutKeys(platform);
    const items = m.actionItems(m.PALETTE_ACTIONS, platformKeys, () => null, '');
    for (const id of expected) {
      const item = items.find(entry => entry.action === id);
      assert.ok(item, id); assert.equal(item.keys, platformKeys[id]?.label ?? null, `${platform} ${id}`);
      assert.ok(item.label && item.label !== id, `${id} has a label`);
    }
    assert.ok(items.some(item => item.action === 'manage-workspaces') && items.some(item => item.action === 'check-agents'));
  }
});

test('a disabled action keeps its reason', async t => {
  const m = await load(t);
  const items = m.actionItems(m.PALETTE_ACTIONS, keys, id => id === 'new-session' ? 'Open a project first' : null, 'session');
  const item = items.find(entry => entry.action === 'new-session');
  assert.equal(item.enabled, false); assert.equal(item.reason, 'Open a project first');
  assert.ok(items.filter(entry => entry.action !== 'new-session').every(entry => entry.enabled));
});

test('no results offers New session with this task first', async t => {
  const m = await load(t);
  const input = { text: 'flaky ci on windows', actionsOnly: false, sessions: [], quiet: [], actions: [], notes: [], notesLoading: false };
  const groups = m.buildGroups(input);
  assert.deepEqual(labels(groups), [['none', ['New session with this task', 'Add as a note']]]);
  assert.equal(groups[0].label, 'No sessions, commands or notes match “flaky ci on windows”.');
  assert.equal(m.keepActive(groups, null), 'new-with-task', 'the first fallback is active');
  assert.deepEqual(m.buildGroups({ ...input, notesLoading: true }), [], 'nothing is offered while notes are still searched');
  assert.deepEqual(m.buildGroups({ ...input, text: '' }), []);
  assert.deepEqual(labels(m.buildGroups({ ...input, fallbacks: false })), [['none', []]], 'without a project the message stays and nothing is offered');
});

test('moveActive wraps and jumps groups', async t => {
  const m = await load(t);
  const item = id => ({ kind: 'fallback', id, label: id });
  const groups = [{ id: 'sessions', label: '', items: [item('a'), item('b')] }, { id: 'actions', label: '', items: [item('c'), item('d'), item('e')] }, { id: 'memory', label: '', items: [item('f')] }];
  assert.equal(m.moveActive(groups, 'a', 1), 'b');
  assert.equal(m.moveActive(groups, 'f', 1), 'a', 'down wraps');
  assert.equal(m.moveActive(groups, 'a', -1), 'f', 'up wraps');
  assert.equal(m.moveActive(groups, 'b', 'next-group'), 'c');
  assert.equal(m.moveActive(groups, 'f', 'next-group'), 'a');
  assert.equal(m.moveActive(groups, 'd', 'prev-group'), 'a');
  assert.equal(m.moveActive(groups, 'a', 'prev-group'), 'f');
  assert.equal(m.moveActive(groups, null, 1), 'a');
  assert.equal(m.moveActive(groups, 'gone', -1), 'f');
  assert.equal(m.moveActive([], 'a', 1), null);
});

test('the active option survives late memory results', async t => {
  const m = await load(t);
  const actions = m.actionItems(m.PALETTE_ACTIONS, keys, () => null, 'note');
  const before = m.buildGroups({ text: 'note', actionsOnly: false, sessions: [], quiet: [], actions, notes: [], notesLoading: true });
  const active = m.moveActive(before, m.keepActive(before, null), 1);
  const note = { id: 'm1', statement: 'Never add a note without a source', category: 'constraint', scope: 'checkout' };
  const after = m.buildGroups({ text: 'note', actionsOnly: false, sessions: [], quiet: [], actions, notes: m.noteItems([note], 'note'), notesLoading: false });
  assert.deepEqual(after.map(group => group.id), ['actions', 'memory']);
  assert.equal(m.keepActive(after, active), active, 'the selection stays on the same option');
  assert.equal(m.keepActive(after, 'note:gone'), after[0].items[0].id, 'a vanished option falls back to the first');
  const item = after[1].items[0];
  assert.equal(item.category, 'Rule'); assert.deepEqual(item.spans, [[12, 16]]);
});

test('highlights merge overlapping words and file paths split into name and folder', async t => {
  const m = await load(t);
  assert.deepEqual(m.highlight('worktree work', 'work tree'), [[0, 8], [9, 13]]);
  assert.deepEqual(m.highlight('İstanbul', 'i'), [], 'a label whose lower case changes length is not marked');
  assert.deepEqual(m.splitPath('src/core/terminal.mjs'), { name: 'terminal.mjs', folder: 'src/core', nameStart: 9 });
  assert.deepEqual(m.splitPath('README.md'), { name: 'README.md', folder: '', nameStart: 0 });
  assert.deepEqual(m.fileGroup([]), []);
  assert.equal(m.fileGroup([{ path: 'README.md', spans: [[0, 6]] }])[0].items[0].id, 'file:README.md');
});
