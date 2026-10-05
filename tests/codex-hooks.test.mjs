import test from 'node:test';
import assert from 'node:assert/strict';
import codex, { codexEvents, codexHookArgs, codexVersion } from '../src/runtime/adapters/codex.mjs';
import { buildAgentLaunch, codexHooksFeature } from '../src/core/agents.mjs';

const UUID = '01a0f661-908b-7193-8520-6ac6f3b44aeb';
const ALL = ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'Stop', 'Interrupt', 'SessionEnd', 'SubagentStart', 'SubagentStop'];
// Reads one `-c hooks.<Event>=[…]` value back the way Codex's TOML parser would see it.
const parse = value => {
  const match = /^hooks\.([A-Za-z]+)=\[\{hooks=\[\{type="command",command=("(?:[^"\\]|\\.)*"),timeout=(\d+)\}\]\}\]$/.exec(value);
  return match && { event: match[1], command: JSON.parse(match[2]), timeout: Number(match[3]) };
};

test('Codex versions: hooks from 0.131, each event only from the version that has it', () => {
  assert.deepEqual(codexVersion('codex-cli 0.159.3'), [0, 159, 3]);
  assert.equal(codexVersion('codex-cli unknown'), null); assert.equal(codexVersion(null), null);
  assert.deepEqual(codexEvents([0, 159, 3]), ALL);
  assert.deepEqual(codexEvents([0, 150, 0]), ALL);
  assert.deepEqual(codexEvents([0, 149, 9]), ALL.filter(e => e !== 'Interrupt'));
  assert.deepEqual(codexEvents([0, 140, 0]), ALL.filter(e => !['Interrupt', 'SessionEnd'].includes(e)));
  assert.deepEqual(codexEvents([0, 131, 0]), ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'Stop']);
  assert.deepEqual(codexEvents([0, 130, 9]), [], 'Before hook trust and review existed, nothing is registered');
  assert.deepEqual(codexEvents([1, 0, 0]), ALL);
  assert.deepEqual(codexEvents(null), []);
});

test('Codex registration: one fixed group per event, the same command, bounded timeouts, never a decision or trust key', () => {
  const command = "'/data dir/hooks/journal-hook' codex";
  const { args, files } = codex.register({ session: { cliVersion: 'codex-cli 0.159.3' }, command, launcher: '/data dir/hooks/journal-hook', platform: 'darwin' });
  assert.deepEqual(files, []);
  assert.equal(args.length, ALL.length * 2);
  const values = args.filter((_, i) => i % 2); assert.ok(args.every((arg, i) => i % 2 || arg === '-c'));
  const parsed = values.map(parse);
  assert.ok(parsed.every(Boolean), 'Every value is a valid hooks.<Event> TOML array');
  assert.deepEqual(parsed.map(p => p.event), ALL);
  assert.ok(parsed.every(p => p.command === command), 'The command is identical for every event and launch (Codex trusts by definition)');
  for (const p of parsed) assert.equal(p.timeout, ['UserPromptSubmit', 'PermissionRequest', 'Stop'].includes(p.event) ? 5 : 3, p.event);
  assert.ok(!parsed.some(p => p.event === 'PreToolUse'), 'No PreToolUse: not needed, and the fewer decision points the better');
  const text = args.join(' ');
  for (const forbidden of ['notify', 'hooks.state', 'trusted_hash', 'dangerously', 'approval', 'sandbox_mode']) assert.ok(!text.includes(forbidden), forbidden);
  // A second launch registers exactly the same arguments.
  assert.deepEqual(codex.register({ session: { cliVersion: 'codex-cli 0.159.3' }, command, launcher: '/data dir/hooks/journal-hook', platform: 'darwin' }).args, args);
  // Quotes and backslashes in the command survive TOML escaping.
  assert.equal(parse(codexHookArgs(['Stop'], 'a "b" \\c')[1]).command, 'a "b" \\c');
});

test('Codex registration is skipped (the launch is unchanged) when it cannot be honest', () => {
  const base = { command: "'/d/journal-hook' codex", launcher: '/d/journal-hook', platform: 'darwin' };
  assert.equal(codex.register({ ...base, session: { cliVersion: 'codex-cli 0.120.0' } }), null, 'Too old');
  assert.equal(codex.register({ ...base, session: { cliVersion: null } }), null, 'Unknown version');
  assert.equal(codex.register({ ...base, session: { cliVersion: 'codex-cli 0.159.3' }, hooksEnabled: false }), null, 'Hooks turned off in Codex');
  assert.ok(codex.register({ ...base, session: { cliVersion: 'codex-cli 0.159.3' }, hooksEnabled: null }), 'Unknown feature state keeps the default (on)');
  // Windows: a plain unquoted path reads the same in PowerShell and cmd; a path with spaces is not registered.
  const win = { session: { cliVersion: 'codex-cli 0.159.3' }, command: '"C:\\Users\\Ann B\\Journal\\hooks\\journal-hook.cmd" codex', platform: 'win32' };
  assert.equal(codex.register({ ...win, launcher: 'C:\\Users\\Ann B\\Journal\\hooks\\journal-hook.cmd' }), null);
  const plain = codex.register({ ...win, launcher: 'C:\\Users\\ann\\Journal\\hooks\\journal-hook.cmd' });
  assert.equal(parse(plain.args[1]).command, 'C:\\Users\\ann\\Journal\\hooks\\journal-hook.cmd codex');
});

test('Codex launch argv: hook overrides before the prompt, on new launches and exact resume; anything else is dropped', () => {
  const hookArgs = codexHookArgs(['Stop', 'SessionEnd'], "'/d/journal-hook' codex");
  assert.deepEqual(buildAgentLaunch({ provider: 'codex', prompt: 'P', hookArgs }).argv, [...hookArgs, '--', 'P']);
  assert.deepEqual(buildAgentLaunch({ provider: 'codex', resume: true, nativeId: UUID, prompt: 'P', hookArgs }).argv, ['resume', UUID, ...hookArgs, '--', 'P']);
  assert.deepEqual(buildAgentLaunch({ provider: 'codex', research: true, prompt: 'P', hookArgs }).argv, ['--sandbox', 'read-only', ...hookArgs, '--', 'P']);
  // Only hooks.<Event> overrides pass: never notify, trust state, or anything not shaped like a hook entry.
  for (const bad of [['-c', 'notify=["x"]'], ['-c', 'hooks.state."a".trusted_hash="x"'], ['--dangerously-bypass-hook-trust'], ['-c']]) {
    assert.deepEqual(buildAgentLaunch({ provider: 'codex', prompt: 'P', hookArgs: [...hookArgs, ...bad] }).argv, ['--', 'P'], bad.join(' '));
  }
  // Other providers never receive them.
  assert.ok(!buildAgentLaunch({ provider: 'claude', nativeId: UUID, prompt: 'P', hookArgs }).argv.includes('-c'));
  assert.ok(!buildAgentLaunch({ provider: 'cursor', executable: '/x/agent', prompt: 'P', hookArgs }).argv.includes('-c'));
});

test('`codex features list`: the hooks row decides, anything else is unknown', () => {
  assert.equal(codexHooksFeature('apply_patch_freeform  stable  true\nhooks                                    stable             true\n'), true);
  assert.equal(codexHooksFeature('hooks  stable  false'), false);
  assert.equal(codexHooksFeature('codex_hooks  experimental  false'), false);
  assert.equal(codexHooksFeature('hooks_review  stable  true'), null, 'Another feature whose name starts with hooks');
  assert.equal(codexHooksFeature(''), null); assert.equal(codexHooksFeature(undefined), null);
});

test('TOML: a command with DEL is escaped, one with a lone surrogate is never registered', async () => {
  const { tomlString } = await import('../src/runtime/adapters/codex.mjs');
  assert.equal(tomlString('a\x7fb'), '"a\\u007fb"');
  assert.equal(tomlString('a\ud800b'), null);
  assert.equal(codex.register({ session: { cliVersion: 'codex-cli 0.159.3' }, command: "'/d\ud800/journal-hook' codex", launcher: '/d\ud800/journal-hook', platform: 'darwin' }), null);
  // Only Codex's own event names pass the launch check.
  assert.deepEqual(buildAgentLaunch({ provider: 'codex', prompt: 'P', hookArgs: ['-c', 'hooks.Notify=[{hooks=[{type="command",command="x",timeout=5}]}]'] }).argv, ['--', 'P']);
});
