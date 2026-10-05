import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeLater } from './support/cleanup.mjs';
import { installLauncher, launcherName, launcherScript, Observers } from '../src/runtime/observers.mjs';

// The hook observer: one launcher per data folder, `<launcher> <provider>`, with the
// per-launch target, token and session in the environment. PermissionRequest relies on
// the same tool fields as the tool events (tool_use_id, Bash command, file path), already
// redacted here. Fixture payloads only: no provider CLI runs.
const hook = fileURLToPath(new URL('../src/desktop/hook.mjs', import.meta.url));
const posix = process.platform !== 'win32';
const temp = (t, name = 'hook-') => { const dir = mkdtempSync(resolve(process.env.JOURNAL_TEST_TMP ?? tmpdir(), name)); t.after(() => removeLater(dir)); return dir; };
const lines = target => existsSync(target) ? readFileSync(target, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
// Only what a hook needs: no provider variables from the real environment.
const baseEnv = () => ({ PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) });

// Runs the hook script directly, as the launcher would, for one provider and payload.
function observe(t, payload, { provider = 'claude', env = {}, dir = temp(t) } = {}) {
  const target = join(dir, 'events.jsonl');
  const result = spawnSync(process.execPath, [hook, provider], { input: JSON.stringify({ session_id: 'native-1', cwd: dir, ...payload }),
    env: { ...baseEnv(), JOURNAL_SESSION_ID: 'session-1', JOURNAL_HOOK_TARGET: target, JOURNAL_HOOK_TOKEN: 'token-value', ...env }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return { lines: lines(target), dir };
}

test('PermissionRequest for Bash keeps command, tool id and redaction', t => {
  const { lines: [line] } = observe(t, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'API_KEY=abcd1234 rm -rf build' } });
  assert.equal(line.event, 'PermissionRequest'); assert.equal(line.id, 'session-1'); assert.equal(line.token, 'token-value'); assert.equal(line.provider, 'claude');
  assert.equal(line.tool, 'Bash'); assert.equal(line.toolUseId, 't1');
  assert.equal(line.command, 'API_KEY=[redacted] rm -rf build');
  assert.ok(!JSON.stringify(line).includes('abcd1234'));
});

test('PermissionRequest for Write keeps the file path relative to the hook\'s folder', t => {
  const dir = temp(t);
  const { lines: [line] } = observe(t, { hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_use_id: 'w1', tool_input: { file_path: join(dir, 'src', 'a.mjs'), content: 'secret body' } }, { dir });
  assert.equal(line.filePath, join('src', 'a.mjs')); assert.equal(line.toolUseId, 'w1');
  assert.ok(!JSON.stringify(line).includes('secret body'), 'File contents are never forwarded');
  // Outside the folder: still relative ('..' parts); the runtime decides it is outside the session.
  const outside = observe(t, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: 'e1', tool_input: { file_path: resolve(dir, '..', 'elsewhere.txt') } }, { dir }).lines.at(-1);
  assert.equal(outside.filePath, join('..', 'elsewhere.txt'));
});

test('a payload without tool_input gives command \'\' and no filePath', t => {
  const { lines: [bash] } = observe(t, { hook_event_name: 'PermissionRequest', tool_name: 'Bash' });
  assert.equal(bash.command, ''); assert.equal(bash.toolUseId, null); assert.equal('filePath' in bash, false);
  const { lines: [write] } = observe(t, { hook_event_name: 'PermissionRequest', tool_name: 'Write' });
  assert.equal(write.filePath, ''); assert.equal('command' in write, false);
});

test('nothing is written without the session, target or token, for an unknown provider or an unregistered event', t => {
  for (const env of [{ JOURNAL_SESSION_ID: '' }, { JOURNAL_HOOK_TOKEN: '' }]) assert.deepEqual(observe(t, { hook_event_name: 'Stop' }, { env }).lines, [], JSON.stringify(env));
  assert.deepEqual(observe(t, { hook_event_name: 'Stop' }, { provider: 'other' }).lines, []);
  assert.deepEqual(observe(t, { hook_event_name: 'Notification' }).lines, [], 'Claude: not a registered event');
  assert.deepEqual(observe(t, { hook_event_name: 'PreToolUse' }, { provider: 'codex' }).lines, [], 'Codex: PreToolUse is never registered');
  assert.deepEqual(observe(t, { hook_event_name: 'beforeSubmitPrompt', conversation_id: 'c' }, { provider: 'cursor' }).lines, [], 'Cursor: no before* event');
});

test('the older argv form (target and token as arguments) still reaches the same file, with absolute paths', t => {
  const dir = temp(t); const target = join(dir, 'events.jsonl');
  const run = payload => spawnSync(process.execPath, [hook, target, 'legacy-token'], { input: JSON.stringify({ session_id: 'n', cwd: dir, ...payload }), env: { ...baseEnv(), JOURNAL_SESSION_ID: 's' } });
  assert.equal(run({ hook_event_name: 'Stop' }).status, 0);
  // An older runtime resolves a relative path against the session's folder, not the hook's: it gets the absolute path, as before.
  assert.equal(run({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_use_id: 'w', tool_input: { file_path: join(dir, 'sub', 'a.mjs') } }).status, 0);
  assert.deepEqual(lines(target).map(line => [line.token, line.event, line.provider, line.filePath]), [['legacy-token', 'Stop', 'claude', undefined], ['legacy-token', 'PostToolUse', 'claude', join(dir, 'sub', 'a.mjs')]]);
});

// Payload hygiene: only IDs, the event name, statuses, tool names, the redacted command and
// relative file paths. Never account details, prompts, assistant text, tool output,
// transcript paths or model parameters, whatever the provider sends.
const SECRETS = { user_email: 'person@example.test', prompt: 'PROMPT_TEXT', last_assistant_message: 'ASSISTANT_TEXT', text: 'RESPONSE_TEXT',
  transcript_path: '/home/x/.transcripts/abc.jsonl', model: 'model-name-x', model_parameters: { temperature: 0.7 }, tool_response: { output: 'TOOL_OUTPUT', stdout: 'STDOUT_TEXT' },
  output: 'SHELL_OUTPUT', attachments: [{ content: 'ATTACHED' }], message: 'MESSAGE_TEXT' };
const LEAKS = /person@example|PROMPT_TEXT|ASSISTANT_TEXT|RESPONSE_TEXT|transcripts|model-name|temperature|TOOL_OUTPUT|STDOUT_TEXT|SHELL_OUTPUT|ATTACHED|MESSAGE_TEXT/;
test('payload hygiene: no account, prompt, assistant, output, transcript or model data for any provider', t => {
  const cases = [
    ['claude', { hook_event_name: 'UserPromptSubmit' }], ['claude', { hook_event_name: 'Stop', stop_hook_active: false }],
    ['claude', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'b', tool_input: { command: 'ls' } }],
    ['codex', { hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1' }], ['codex', { hook_event_name: 'Stop', turn_id: 'turn-1' }],
    ['codex', { hook_event_name: 'PostToolUse', turn_id: 'turn-1', tool_name: 'Bash', tool_input: { command: ['ls', '-la'] } }],
    ['codex', { hook_event_name: 'SubagentStop', turn_id: 'turn-1', agent_id: 'agent-7', agent_type: 'explorer' }],
    ['cursor', { hook_event_name: 'stop', conversation_id: 'c-1', generation_id: 'g-1', status: 'completed' }],
    ['cursor', { hook_event_name: 'afterAgentResponse', conversation_id: 'c-1', generation_id: 'g-1' }],
    ['cursor', { hook_event_name: 'afterShellExecution', conversation_id: 'c-1', generation_id: 'g-1', command: 'TOKEN=abcdefgh12345 make', duration: 120 }],
    ['cursor', { hook_event_name: 'afterFileEdit', conversation_id: 'c-1', generation_id: 'g-1', file_path: '/w/src/a.ts', edits: [{ old_string: 'OLD', new_string: 'NEW' }], workspace_roots: ['/w'] }],
  ];
  for (const [provider, payload] of cases) {
    const { lines: [line] } = observe(t, { ...SECRETS, ...payload }, { provider });
    const label = `${provider} ${payload.hook_event_name}`;
    assert.ok(line, label);
    assert.doesNotMatch(JSON.stringify(line), LEAKS, label);
    assert.doesNotMatch(JSON.stringify(line), /OLD|NEW|abcdefgh12345/, label);
    for (const key of Object.keys(line)) assert.ok(['token', 'id', 'provider', 'at', 'nativeId', 'event', 'cwd', 'tool', 'toolUseId', 'command', 'background', 'filePath', 'exit', 'interrupted', 'durationMs', 'turn', 'status', 'source', 'agentId', 'parentNativeId', 'childId'].includes(key), `${label}: ${key}`);
  }
  // Cursor names its workspace instead of a working directory.
  const cursorEdit = observe(t, { hook_event_name: 'afterFileEdit', conversation_id: 'c', cwd: undefined, file_path: '/w/src/a.ts', workspace_roots: ['/w'] }, { provider: 'cursor' }).lines[0];
  assert.equal(cursorEdit.filePath, join('src', 'a.ts')); assert.equal(cursorEdit.cwd, '/w');
  const codex = observe(t, { hook_event_name: 'PostToolUse', session_id: 'x', turn_id: 'turn-9', tool_name: 'Bash', tool_input: { command: ['API_KEY=abcd1234', 'run'] } }, { provider: 'codex' }).lines[0];
  assert.deepEqual([codex.nativeId, codex.turn, codex.command], ['x', 'turn-9', 'API_KEY=[redacted] run']);
  // apply_patch's input is the patch (file content): never kept, whatever field holds it.
  const patch = '*** Begin Patch\n*** Update File: src/a.ts\n-SECRET_LINE\n+NEW_LINE\n*** End Patch';
  const applied = observe(t, { hook_event_name: 'PostToolUse', session_id: 'x', turn_id: 'turn-9', tool_name: 'apply_patch', tool_input: { command: patch, input: patch, patch } }, { provider: 'codex' }).lines[0];
  assert.equal(applied.tool, 'apply_patch'); assert.equal('command' in applied, false);
  assert.doesNotMatch(JSON.stringify(applied), /SECRET_LINE|NEW_LINE|Begin Patch/);
});

// ----- The launcher -----
function launcherFixture(t, { script = null, timeoutSeconds = 1 } = {}) {
  const dir = temp(t, 'launcher-'); const data = join(dir, 'data'); mkdirSync(data);
  const hookScript = script === null ? hook : join(dir, 'hook-fixture.mjs');
  if (script !== null && script !== 'missing') writeFileSync(hookScript, typeof script === 'function' ? script(dir) : script);
  const launcher = installLauncher({ dataDir: data, execPath: process.execPath, hookScript: script === 'missing' ? join(dir, 'no-such-hook.mjs') : hookScript, timeoutSeconds });
  const run = (provider, { env = {}, input = '{}' } = {}) => {
    const started = Date.now();
    const result = posix ? spawnSync('/bin/sh', ['-c', `'${launcher}' ${provider}`], { input, env: { ...baseEnv(), ...env }, encoding: 'utf8', timeout: 10_000 })
      // Verbatim, as a provider passes a command line to cmd: Node would otherwise quote the quoted path again.
      : spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${launcher}" ${provider}"`], { input, env: { ...baseEnv(), ...env }, encoding: 'utf8', timeout: 10_000, windowsVerbatimArguments: true });
    return { ...result, ms: Date.now() - started };
  };
  return { dir, data, launcher, run, target: join(dir, 'events.jsonl') };
}
const hookEnv = f => ({ JOURNAL_SESSION_ID: 's', JOURNAL_HOOK_TARGET: f.target, JOURNAL_HOOK_TOKEN: 'tok' });

test('the launcher lives at a fixed path in the data folder and is rewritten only when it changes', t => {
  const f = launcherFixture(t);
  assert.equal(f.launcher, join(f.data, 'hooks', launcherName(process.platform)));
  if (posix) assert.equal(statSync(f.launcher).mode & 0o777, 0o700);
  const again = installLauncher({ dataDir: f.data, execPath: process.execPath, hookScript: hook, timeoutSeconds: 1 });
  assert.equal(again, f.launcher);
  const content = readFileSync(f.launcher, 'utf8');
  assert.ok(content.includes(process.execPath) && content.includes(hook), 'It runs the hook script with the runtime\'s binary');
  assert.match(content, /ELECTRON_RUN_AS_NODE=1/);
  // Another app version (another binary or script) rewrites it at the same path.
  installLauncher({ dataDir: f.data, execPath: '/other/Journal', hookScript: '/other/hook.mjs', timeoutSeconds: 1 });
  assert.ok(readFileSync(f.launcher, 'utf8').includes('/other/hook.mjs'));
});

test('the hook command is the same for every launch; per-launch values travel in the environment', t => {
  const dir = temp(t, 'obs-'); const repo = join(dir, 'repo'); mkdirSync(repo);
  const observers = new Observers({ dataDir: dir, hookScript: hook, execPath: process.execPath, ingest: () => {} });
  const a = observers.prepare({ id: 'a', provider: 'claude' }, { root: repo }); const b = observers.prepare({ id: 'b', provider: 'claude' }, { root: repo });
  const commands = file => Object.values(JSON.parse(readFileSync(file, 'utf8')).hooks).map(groups => groups[0].hooks[0].command);
  assert.deepEqual(new Set([...commands(a.settingsFile), ...commands(b.settingsFile)]).size, 1);
  assert.equal(commands(a.settingsFile)[0], `${posix ? `'${observers.launcher}'` : `"${observers.launcher}"`} claude`);
  assert.notEqual(a.env.JOURNAL_HOOK_TOKEN, b.env.JOURNAL_HOOK_TOKEN); assert.notEqual(a.env.JOURNAL_HOOK_TARGET, b.env.JOURNAL_HOOK_TARGET);
  assert.ok(!readFileSync(a.settingsFile, 'utf8').includes(a.env.JOURNAL_HOOK_TOKEN), 'The token is not in the settings file');
  // Codex and Cursor register nothing yet (Phases 2 and 3): their sessions are not observed.
  assert.equal(observers.prepare({ id: 'c', provider: 'codex' }, { root: repo }), null);
  assert.equal(observers.prepare({ id: 'd', provider: 'cursor' }, { root: repo }), null);
});

test('env routing: the launcher and hook append to the target named in the environment; forged lines are rejected', { skip: !posix }, t => {
  const f = launcherFixture(t); const repo = join(f.dir, 'repo'); mkdirSync(repo);
  const seen = [];
  const observers = new Observers({ dataDir: f.data, hookScript: hook, execPath: process.execPath, ingest: (id, line) => seen.push([id, line.event]), launcherTimeoutSeconds: 1 });
  const { env } = observers.prepare({ id: 's1', provider: 'claude' }, { root: repo });
  const result = f.run('claude', { env: { JOURNAL_SESSION_ID: 's1', ...env }, input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'n', cwd: repo }) });
  assert.equal(result.status, 0); assert.equal(result.stdout, '');
  // A forged token, another session's ID and a folder outside the session are rejected.
  appendFileSync(env.JOURNAL_HOOK_TARGET, `${JSON.stringify({ token: 'f'.repeat(48), id: 's1', event: 'UserPromptSubmit', cwd: repo })}\n`);
  appendFileSync(env.JOURNAL_HOOK_TARGET, `${JSON.stringify({ token: env.JOURNAL_HOOK_TOKEN, id: 'other', event: 'UserPromptSubmit', cwd: repo })}\n`);
  appendFileSync(env.JOURNAL_HOOK_TARGET, `${JSON.stringify({ token: env.JOURNAL_HOOK_TOKEN, id: 's1', event: 'UserPromptSubmit', cwd: f.dir })}\n`);
  // Another provider's hook (a nested agent that inherited the environment) is rejected; the
  // older form, which names no provider, is Claude's.
  appendFileSync(env.JOURNAL_HOOK_TARGET, `${JSON.stringify({ token: env.JOURNAL_HOOK_TOKEN, id: 's1', provider: 'codex', event: 'UserPromptSubmit', cwd: repo })}\n`);
  appendFileSync(env.JOURNAL_HOOK_TARGET, `${JSON.stringify({ token: env.JOURNAL_HOOK_TOKEN, id: 's1', event: 'PreToolUse', cwd: repo })}\n`);
  observers.poll();
  assert.deepEqual(seen, [['s1', 'Stop'], ['s1', 'PreToolUse']]);
});

test('the launcher always exits 0 with empty output for Codex and Claude, and {} for Cursor', { skip: !posix }, t => {
  const scripts = {
    works: null,
    throws: "throw new Error('hook bug: SHOULD_NOT_SHOW');",
    missing: 'missing',
    exits: "console.log('{\"decision\":\"block\"}'); process.exit(2);",
    hangs: "process.stdout.write('{\"continue\":false}'); setInterval(() => {}, 1000);",
  };
  for (const [name, script] of Object.entries(scripts)) {
    const f = launcherFixture(t, { script, timeoutSeconds: 1 });
    for (const provider of ['codex', 'cursor', 'claude']) {
      const result = f.run(provider, { env: hookEnv(f), input: JSON.stringify({ hook_event_name: provider === 'cursor' ? 'stop' : 'Stop', session_id: 'n', conversation_id: 'n', status: 'completed', cwd: f.dir }) });
      const label = `${name} ${provider}`;
      assert.equal(result.status, 0, label);
      assert.equal(result.stdout, provider === 'cursor' ? '{}\n' : '', label);
      assert.equal(result.stderr, '', label);
      assert.ok(result.ms < 4000, `${label}: ${result.ms} ms`);
    }
  }
});

test('the launcher returns at once when the agent was not started by Journal', { skip: !posix }, t => {
  const f = launcherFixture(t, { script: dir => `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(join(dir, 'ran'))}, 'ran');` });
  const marker = join(f.dir, 'ran');
  for (const provider of ['codex', 'cursor']) {
    const result = f.run(provider, { input: '{"hook_event_name":"stop"}' });
    assert.equal(result.status, 0); assert.equal(result.stdout, provider === 'cursor' ? '{}\n' : '');
  }
  assert.equal(existsSync(marker), false, 'Without a target the hook script never runs');
  // With one, it does: the same fixture proves the script path is right.
  assert.equal(f.run('codex', { env: hookEnv(f) }).status, 0); assert.equal(existsSync(marker), true);
});

test('the Windows launcher always exits 0 and prints {} only for Cursor', { skip: posix }, t => {
  for (const script of ["throw new Error('x');", 'missing']) {
    const f = launcherFixture(t, { script });
    for (const provider of ['codex', 'cursor', 'claude']) {
      const result = f.run(provider, { env: hookEnv(f) });
      assert.equal(result.status, 0, provider);
      assert.equal(result.stdout.trim(), provider === 'cursor' ? '{}' : '', provider);
    }
  }
});

test('the launcher scripts never print anything but the neutral response', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const script = launcherScript({ execPath: '/x/Journal', hookScript: '/x/hook.mjs', platform });
    const printed = script.split(/\r?\n/).filter(line => /\b(?:echo|printf)\b/.test(line) && line !== '@echo off');
    assert.equal(printed.length, 1, platform); assert.match(printed[0], /\{\}/, platform);
    assert.match(script, /exit (?:\/b )?0\s*$/, platform);
  }
});

test('a stalled interpreter is bounded by the launcher: exit 0 within its limit', { skip: !posix }, t => {
  const dir = temp(t, 'stall-'); const data = join(dir, 'data'); mkdirSync(data);
  // The "runtime binary" never starts the script: it hangs.
  const stub = join(dir, 'stalled-node'); writeFileSync(stub, '#!/bin/sh\nsleep 30\n'); chmodSync(stub, 0o755);
  const launcher = installLauncher({ dataDir: data, execPath: stub, hookScript: hook, timeoutSeconds: 1 });
  for (const provider of ['claude', 'codex', 'cursor']) {
    const started = Date.now();
    const result = spawnSync('/bin/sh', ['-c', `'${launcher}' ${provider}`], { input: '{"hook_event_name":"Stop"}', env: { ...baseEnv(), JOURNAL_SESSION_ID: 's', JOURNAL_HOOK_TARGET: join(dir, 'e'), JOURNAL_HOOK_TOKEN: 't' }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, provider); assert.equal(result.stdout, provider === 'cursor' ? '{}\n' : '', provider);
    assert.ok(Date.now() - started < 3000, `${provider}: ${Date.now() - started} ms`);
  }
});

test('the launcher leaves no watchdog behind when the script finishes first', { skip: !posix }, t => {
  const f = launcherFixture(t, { script: '', timeoutSeconds: 37 });
  assert.equal(f.run('codex', { env: hookEnv(f) }).status, 0);
  const sleeping = () => spawnSync('ps', ['-A', '-o', 'command='], { encoding: 'utf8' }).stdout.split('\n').filter(line => line.trim() === 'sleep 37');
  const deadline = Date.now() + 2000; while (sleeping().length && Date.now() < deadline) spawnSync('sleep', ['0.1']);
  assert.deepEqual(sleeping(), []);
});

test('the hooks folder is private; a launcher that cannot be replaced is written under a versioned name', { skip: !posix }, t => {
  const dir = temp(t, 'install-'); const data = join(dir, 'data'); mkdirSync(join(data, 'hooks'), { recursive: true, mode: 0o755 }); chmodSync(join(data, 'hooks'), 0o755);
  // Something that cannot be renamed over sits at the fixed path.
  mkdirSync(join(data, 'hooks', 'journal-hook'));
  const versioned = installLauncher({ dataDir: data, execPath: process.execPath, hookScript: hook });
  assert.equal(statSync(join(data, 'hooks')).mode & 0o777, 0o700);
  assert.match(versioned, /journal-hook\.[0-9a-f]{8}$/); assert.ok(readFileSync(versioned, 'utf8').includes(hook));
  assert.equal(installLauncher({ dataDir: data, execPath: process.execPath, hookScript: hook }), versioned, 'The same version is reused');
  // Once the fixed path is free again it is used, and the versioned copy goes.
  rmSync(join(data, 'hooks', 'journal-hook'), { recursive: true });
  assert.equal(installLauncher({ dataDir: data, execPath: process.execPath, hookScript: hook }), join(data, 'hooks', 'journal-hook'));
  assert.equal(existsSync(versioned), false);
});

test('Windows: a data folder whose path cmd.exe would read is not used for hooks', t => {
  // '|' cannot be part of a folder name on Windows itself; it is still refused where it can.
  for (const name of ['a&b', 'x(1)', 'p%q', 'a^b', ...(process.platform === 'win32' ? [] : ['a|b']), 'a@b', 'a!b']) {
    const dir = join(temp(t, 'win-'), name); mkdirSync(dir);
    assert.throws(() => installLauncher({ dataDir: dir, execPath: 'C:\\J\\Journal.exe', hookScript: 'C:\\J\\hook.mjs', platform: 'win32' }), /cannot be used/, name);
    const observers = new Observers({ dataDir: dir, hookScript: 'h', execPath: 'e', platform: 'win32', ingest: () => {} });
    assert.equal(observers.launcher, null); assert.equal(observers.prepare({ id: 's', provider: 'claude' }, { root: dir }), null, `${name}: the session starts unobserved`);
  }
  const script = launcherScript({ execPath: 'C:\\Program Files (x86)\\J & Co\\Journal.exe', hookScript: 'C:\\J\\100%\\hook.mjs', platform: 'win32' });
  assert.match(script, /setlocal DisableDelayedExpansion/);
  assert.ok(script.includes('"C:\\Program Files (x86)\\J & Co\\Journal.exe" "C:\\J\\100%%\\hook.mjs" %1'));
});
