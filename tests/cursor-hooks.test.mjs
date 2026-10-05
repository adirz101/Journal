import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import cursor, { cursorHookCommand, pluginFiles, USER_FILE_EVENTS } from '../src/runtime/adapters/cursor.mjs';
import { applyCursorPlan, cursorJournalInstalled, planCursorInstall, planCursorRemove, readCursorHooks } from '../src/core/cursor-hooks.mjs';
import { buildAgentLaunch } from '../src/core/agents.mjs';

// Fixture homes only: never the user's ~/.cursor.
const home = t => { const dir = mkdtempSync(join(tmpdir(), 'journal-cursor-home-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const LAUNCHER = '/data dir/hooks/journal-hook';
const COMMAND = `'${LAUNCHER}' cursor`;
const PERMISSION_STEPS = ['beforeShellExecution', 'beforeMCPExecution', 'beforeReadFile', 'beforeSubmitPrompt', 'preToolUse', 'subagentStart'];
const UUID = '5b1f0d3e-8c4a-4e2b-9f6a-1c2d3e4f5a6b';

test('the Cursor plugin: version 1, only after-type and lifecycle events, a timeout each, never a permission step', () => {
  const { manifest, hooks } = pluginFiles(COMMAND);
  const parsed = JSON.parse(hooks);
  assert.equal(parsed.version, 1, 'Without version 1 the CLI silently skips every hook');
  assert.deepEqual(Object.keys(parsed.hooks), ['sessionStart', 'sessionEnd', 'postToolUse', 'postToolUseFailure', 'afterShellExecution', 'afterMCPExecution', 'afterFileEdit', 'subagentStop']);
  for (const [event, entries] of Object.entries(parsed.hooks)) assert.deepEqual(entries, [{ command: COMMAND, timeout: 5 }], event);
  for (const step of [...PERMISSION_STEPS, ...USER_FILE_EVENTS]) assert.ok(!(step in parsed.hooks), step);
  assert.ok(!/failClosed/.test(hooks));
  assert.equal(JSON.parse(manifest).name, 'journal-observer');
  assert.equal(cursor.response, '{}');
});

test('Cursor registration: the plugin folder next to the launcher, only when the CLI lists --plugin-dir', t => {
  const dir = home(t); const launcher = join(dir, 'hooks', 'journal-hook'); mkdirSync(join(dir, 'hooks')); writeFileSync(launcher, '');
  const userHome = home(t);
  assert.equal(cursor.register({ command: COMMAND, launcher, platform: 'darwin', hooksEnabled: null, home: userHome }), null, 'Unknown plugin support: nothing');
  assert.equal(cursor.register({ command: COMMAND, launcher, platform: 'darwin', hooksEnabled: false, home: userHome }), null);
  const registration = cursor.register({ command: COMMAND, launcher, platform: 'darwin', hooksEnabled: true, home: userHome });
  assert.deepEqual(registration.args, ['--plugin-dir', join(dir, 'hooks', 'cursor-plugin')]);
  assert.deepEqual(registration.observes, { turns: false, approvals: false }, 'Level 1: no turn end, never approvals');
  assert.equal(JSON.parse(readFileSync(join(dir, 'hooks', 'cursor-plugin', 'hooks', 'hooks.json'), 'utf8')).version, 1);
  // Windows: unquoted launcher paths only (spaces are not registered).
  assert.equal(cursorHookCommand(COMMAND, 'C:\\Users\\Ann B\\hooks\\journal-hook.cmd', 'win32'), null);
  assert.equal(cursorHookCommand(COMMAND, 'C:\\Users\\ann\\hooks\\journal-hook.cmd', 'win32'), 'C:\\Users\\ann\\hooks\\journal-hook.cmd cursor');
});

test('Cursor launch argv: exactly --plugin-dir and one absolute folder; anything else is dropped', () => {
  const plugin = ['--plugin-dir', '/data/hooks/cursor-plugin'];
  assert.deepEqual(buildAgentLaunch({ provider: 'cursor', executable: '/x/agent', nativeId: UUID, prompt: 'P', hookArgs: plugin }).argv, [`--resume=${UUID}`, ...plugin, '--', 'P']);
  for (const bad of [['--plugin-dir', 'relative'], ['--trust'], ['--plugin-dir', '/a', '--force'], ['--yolo', '/a']]) {
    assert.deepEqual(buildAgentLaunch({ provider: 'cursor', executable: '/x/agent', nativeId: UUID, prompt: 'P', hookArgs: bad }).argv, [`--resume=${UUID}`, '--', 'P'], bad.join(' '));
  }
});

test('level 2: the exact change adds Journal\'s two entries and keeps every other entry and field', t => {
  const dir = home(t); mkdirSync(join(dir, '.cursor'));
  const existing = { version: 1, hooks: { stop: [{ command: 'their-stop.sh' }], beforeShellExecution: [{ command: 'their-guard.sh', failClosed: true }] }, extra: 'kept' };
  writeFileSync(join(dir, '.cursor', 'hooks.json'), JSON.stringify(existing), { mode: 0o640 });
  const plan = planCursorInstall(dir, COMMAND);
  assert.equal(plan.action, 'install'); assert.equal(plan.before, JSON.stringify(existing)); assert.ok(plan.changed);
  const after = JSON.parse(plan.after);
  assert.deepEqual(after.hooks.stop, [{ command: 'their-stop.sh' }, { command: COMMAND, timeout: 5 }]);
  assert.deepEqual(after.hooks.afterAgentResponse, [{ command: COMMAND, timeout: 5 }]);
  assert.deepEqual(after.hooks.beforeShellExecution, existing.hooks.beforeShellExecution);
  assert.equal(after.extra, 'kept'); assert.equal(after.version, 1);
  // Nothing is written by planning.
  assert.equal(readFileSync(join(dir, '.cursor', 'hooks.json'), 'utf8'), JSON.stringify(existing));
  assert.equal(cursorJournalInstalled(dir, COMMAND), false);
  assert.deepEqual(applyCursorPlan(dir, plan), { applied: true });
  assert.equal(readFileSync(join(dir, '.cursor', 'hooks.json'), 'utf8'), plan.after);
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, '.cursor', 'hooks.json')).mode & 0o777, 0o640, 'The file keeps its mode');
  assert.equal(cursorJournalInstalled(dir, COMMAND), true);
  // Installing again changes nothing (no duplicate entries).
  assert.equal(planCursorInstall(dir, COMMAND).changed, false);
  // Remove takes out only Journal's entries; the event Journal added alone loses its key.
  const removal = planCursorRemove(dir, COMMAND); applyCursorPlan(dir, removal);
  const removed = JSON.parse(readFileSync(join(dir, '.cursor', 'hooks.json'), 'utf8'));
  assert.deepEqual(removed.hooks, existing.hooks); assert.equal(removed.extra, 'kept');
  assert.equal(cursorJournalInstalled(dir, COMMAND), false);
});

test('level 2: a missing file is created with version 1 and only Journal\'s entries', t => {
  const dir = home(t);
  const plan = planCursorInstall(dir, COMMAND);
  assert.equal(plan.before, null);
  assert.deepEqual(JSON.parse(plan.after), { version: 1, hooks: { stop: [{ command: COMMAND, timeout: 5 }], afterAgentResponse: [{ command: COMMAND, timeout: 5 }] } });
  assert.deepEqual(applyCursorPlan(dir, plan), { applied: true });
  assert.equal(cursorJournalInstalled(dir, COMMAND), true);
});

test('level 2 refuses files it must not touch, and a plan whose file changed since it was shown', t => {
  const dir = home(t); mkdirSync(join(dir, '.cursor')); const file = join(dir, '.cursor', 'hooks.json');
  writeFileSync(file, '{not json'); assert.equal(planCursorInstall(dir, COMMAND).refused, 'invalid');
  // No version: Cursor ignores the file; adding one would switch the user's dormant hooks on.
  writeFileSync(file, JSON.stringify({ hooks: { stop: [{ command: 'x' }] } })); assert.equal(planCursorInstall(dir, COMMAND).refused, 'no-version');
  writeFileSync(file, JSON.stringify({ version: 1, hooks: [] })); assert.equal(planCursorInstall(dir, COMMAND).refused, 'invalid');
  rmSync(file); const real = join(dir, 'real.json'); writeFileSync(real, JSON.stringify({ version: 1 })); symlinkSync(real, file);
  assert.equal(planCursorInstall(dir, COMMAND).refused, 'symlink');
  assert.equal(applyCursorPlan(dir, { action: 'install', path: file, after: '{}', changed: true, baseHash: 'x' }).applied, false);
  rmSync(file); writeFileSync(file, JSON.stringify({ version: 1 }));
  const plan = planCursorInstall(dir, COMMAND);
  writeFileSync(file, JSON.stringify({ version: 1, hooks: { stop: [{ command: 'new.sh' }] } }));
  assert.deepEqual(applyCursorPlan(dir, plan), { applied: false, reason: 'changed' });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).hooks.stop, [{ command: 'new.sh' }], 'The newer file is untouched');
  // A command that is not Journal's launcher is never planned.
  assert.equal(planCursorInstall(dir, 'rm -rf ~').refused, 'no-launcher');
  assert.equal(readCursorHooks(join(dir, 'nowhere')).state, 'missing');
});

test('Cursor normalize: the aborted+error pair, child events, and a stop without status or generation', () => {
  const base = { nativeId: UUID, cwd: '/w', turn: 'g1' };
  assert.equal(cursor.normalize({ ...base, event: 'stop', status: 'aborted' }).outcome, 'interrupted');
  assert.equal(cursor.normalize({ ...base, event: 'stop', status: 'error' }).outcome, 'error');
  assert.equal(cursor.normalize({ ...base, event: 'stop' }), null);
  assert.equal(cursor.normalize({ ...base, event: 'stop', status: 'completed', turn: undefined }), null);
  assert.equal(cursor.normalize({ ...base, event: 'postToolUse', parentNativeId: 'p' }).child, true);
  assert.equal(cursor.normalize({ ...base, event: 'beforeShellExecution' }), null, 'Never registered, never mapped');
});

test('level 2 recognises only Journal\'s exact command: a similar entry of the user\'s own is kept', t => {
  const dir = home(t); mkdirSync(join(dir, '.cursor'));
  const lookalikes = [{ command: `${COMMAND} --verbose` }, { command: `'${LAUNCHER}.bak' cursor` }, { command: `wrapper ${COMMAND}` }];
  writeFileSync(join(dir, '.cursor', 'hooks.json'), JSON.stringify({ version: 1, hooks: { stop: lookalikes } }));
  assert.equal(cursorJournalInstalled(dir, COMMAND), false);
  applyCursorPlan(dir, planCursorInstall(dir, COMMAND));
  applyCursorPlan(dir, planCursorRemove(dir, COMMAND));
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.cursor', 'hooks.json'), 'utf8')).hooks.stop, lookalikes);
});

test('Windows hook paths: only plain characters are registered, for Codex and Cursor alike', async () => {
  const { default: codex } = await import('../src/runtime/adapters/codex.mjs');
  const session = { cliVersion: 'codex-cli 0.159.3' };
  for (const launcher of ['C:\\Users\\a&b\\hooks\\journal-hook.cmd', 'C:\\Users\\a;b\\journal-hook.cmd', 'C:\\Users\\$x\\journal-hook.cmd', 'C:\\Users\\a`b\\journal-hook.cmd', 'C:\\Users\\Ann B\\journal-hook.cmd', 'C:\\Users\\a(b)\\journal-hook.cmd']) {
    assert.equal(cursorHookCommand('x', launcher, 'win32'), null, launcher);
    assert.equal(codex.register({ session, command: 'x', launcher, platform: 'win32' }), null, launcher);
  }
  assert.equal(cursorHookCommand('x', 'C:\\Users\\André\\Journal\\hooks\\journal-hook.cmd', 'win32'), 'C:\\Users\\André\\Journal\\hooks\\journal-hook.cmd cursor', 'Letters in any script are fine');
});
