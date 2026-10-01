import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { descendants, isAlive, launchTarget, parseProcessTable, processIdentity, resolveExecutable, sameIdentity, signalVerified, survivors } from '../src/core/process.mjs';
import { redact } from '../src/core/validation.mjs';

const wait = ms => new Promise(r => setTimeout(r, ms));
const posix = process.platform !== 'win32';

test('process table parsing keeps start times and builds descendants including group members', () => {
  const table = parseProcessTable([
    '  100     1   100 Thu Oct  2 09:00:00 2026 claude --session-id x',
    '  101   100   100 Thu Oct  2 09:00:01 2026 node build.js',
    '  102   101   100 Thu Oct  2 09:00:02 2026 sleep 100',
    '  103     1   100 Thu Oct  2 09:00:03 2026 daemon reparented but still in the group',
    '  200     1   200 Thu Oct  2 09:00:04 2026 unrelated',
    'garbage line',
  ].join('\n'));
  assert.equal(table.length, 5); assert.equal(table[0].started, 'Thu Oct 2 09:00:00 2026');
  assert.deepEqual(descendants(table, 100).map(r => r.pid).sort(), [101, 102, 103]);
  assert.equal(descendants(null, 100), null, 'Unknown when the platform cannot list processes');
  assert.ok(!table.some(r => 'command' in r && r.command.length > 200));
});

test('survivors only include recorded processes whose identity still matches', () => {
  const recorded = parseProcessTable('  101   100   100 Thu Oct  2 09:00:01 2026 node build.js\n  102   100   100 Thu Oct  2 09:00:02 2026 sleep 100');
  const now = parseProcessTable('  101     1   101 Thu Oct  2 09:00:01 2026 node build.js\n  102     1   102 Thu Oct  2 11:11:11 2026 sleep 100');
  assert.deepEqual(survivors(recorded, now).map(r => r.pid), [101], 'PID 102 was reused by a new process');
  assert.equal(survivors(recorded, null), null);
});

test('a verified signal refuses a reused PID and reaches the recorded process', { skip: !posix }, async t => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  let identity = null; for (let i = 0; i < 50 && !identity; i++) { identity = processIdentity(child.pid); await wait(20); }
  assert.ok(identity?.started && identity.commandHash); assert.ok(!('command' in identity), 'Identity stores a hash, not prompt text');
  assert.ok(sameIdentity(identity, processIdentity(child.pid)));
  assert.deepEqual(signalVerified(child.pid, { ...identity, started: 'Mon Jan 1 00:00:00 2001' }, 'SIGTERM'), { signalled: false, reason: 'identity-mismatch' });
  assert.deepEqual(signalVerified(child.pid, { ...identity, commandHash: 'other' }, 'SIGTERM'), { signalled: false, reason: 'identity-mismatch' });
  assert.ok(isAlive(child.pid));
  assert.deepEqual(signalVerified(child.pid, identity, 'SIGTERM'), { signalled: true });
  await new Promise(r => child.once('exit', r));
  assert.equal(signalVerified(child.pid, identity, 'SIGTERM').signalled, false);
  assert.equal(processIdentity(-1), null);
});

test('executables resolve from PATH, including Windows PATHEXT shims', t => {
  const dir = mkdtempSync(join(tmpdir(), 'exe-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'claude'), '#!/bin/sh\n'); chmodSync(join(dir, 'claude'), 0o755);
  writeFileSync(join(dir, 'codex.cmd'), '@ECHO off\r\n"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
  assert.equal(resolveExecutable('claude', { PATH: dir }, 'darwin'), join(dir, 'claude'));
  assert.equal(resolveExecutable('codex', { PATH: dir, PATHEXT: '.EXE;.CMD' }, 'win32')?.toLowerCase(), join(dir, 'codex.cmd').toLowerCase());
  assert.equal(resolveExecutable('missing', { PATH: dir }, 'linux'), null);
});

test('Windows .cmd shims launch their Node script so multi-line prompts never pass through cmd.exe', () => {
  const shim = '@ECHO off\r\nGOTO start\r\n:start\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n';
  const target = launchTarget('C:\\npm\\codex.cmd', ['--', 'line one\nline two & calc'], { platform: 'win32', env: { PATH: '' }, read: () => shim, node: 'C:\\node\\node.exe' });
  assert.equal(target.file, 'C:\\node\\node.exe'); assert.equal(target.args[0], 'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js');
  assert.match(target.args[0], /codex\.js$/); assert.deepEqual(target.args.slice(1), ['--', 'line one\nline two & calc']);
  assert.throws(() => launchTarget('C:\\tools\\other.cmd', ['x'], { platform: 'win32', env: { PATH: '' }, read: () => 'echo %*' }), /cmd\.exe/);
  assert.deepEqual(launchTarget('/usr/bin/claude', ['a'], { platform: 'darwin' }), { file: '/usr/bin/claude', args: ['a'] });
});

test('redaction removes credential-looking values from commands and logs', () => {
  const text = redact('GITHUB_TOKEN=ghp_' + 'a'.repeat(36) + ' curl -H "Authorization: Bearer ' + 'b'.repeat(24) + '" --password=hunter22 -----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----');
  assert.doesNotMatch(text, /ghp_a|bbbbbbbb|hunter22|abc/); assert.match(text, /password=\[redacted\]/);
  assert.equal(redact('npm test -- --grep money'), 'npm test -- --grep money');
  assert.equal(redact('x'.repeat(5000)).length, 2000);
});
