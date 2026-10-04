import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { descendants, isAlive, launchTarget, parseProcessTable, processIdentity, resolveExecutable, sameIdentity, signalVerified, survivors } from '../src/core/process.mjs';
import { redact } from '../src/core/validation.mjs';
import { removeLater } from './support/cleanup.mjs';

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
  const child = spawn(process.execPath, ['-e', 'process.title = "renamed-by-cli"; setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  let identity = null; for (let i = 0; i < 50 && !identity; i++) { identity = await processIdentity(child.pid); await wait(20); }
  assert.ok(identity?.started); assert.deepEqual(Object.keys(identity), ['started'], 'Identity stores no command text');
  await wait(200);
  // A CLI that rewrites its process title keeps the same identity.
  assert.ok(sameIdentity(identity, await processIdentity(child.pid)));
  assert.deepEqual(await signalVerified(child.pid, { ...identity, started: 'Mon Jan 1 00:00:00 2001' }, 'SIGTERM'), { signalled: false, reason: 'identity-mismatch' });
  assert.deepEqual(await signalVerified(child.pid, null, 'SIGTERM'), { signalled: false, reason: 'identity-mismatch' });
  assert.ok(isAlive(child.pid));
  assert.deepEqual(await signalVerified(child.pid, identity, 'SIGTERM'), { signalled: true });
  await new Promise(r => child.once('exit', r));
  assert.equal((await signalVerified(child.pid, identity, 'SIGTERM')).signalled, false);
  assert.equal(await processIdentity(-1), null);
});

test('identity start times are reported in UTC regardless of the caller time zone', { skip: !posix }, async () => {
  const { execFileSync } = await import('node:child_process');
  // The same fixed process (this test runner) must read identically from every zone.
  const script = `import('${new URL('../src/core/process.mjs', import.meta.url).href}').then(async m => console.log((await m.processIdentity(${process.pid})).started))`;
  const zones = ['UTC', 'America/Los_Angeles', 'Asia/Tokyo'].map(TZ => execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, TZ } }).trim());
  assert.match(zones[0], /^\w{3} \w{3} \d+ [\d:]+ \d{4}$/); assert.equal(new Set(zones).size, 1, zones.join(' | '));
});

test('executables resolve from PATH, including Windows PATHEXT shims', t => {
  const dir = mkdtempSync(join(tmpdir(), 'exe-')); t.after(() => removeLater(dir));
  writeFileSync(join(dir, 'claude'), '#!/bin/sh\n'); chmodSync(join(dir, 'claude'), 0o755);
  // Named as PATHEXT spells it: Linux file systems are case-sensitive (Windows is not).
  writeFileSync(join(dir, 'codex.CMD'), '@ECHO off\r\n"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
  assert.equal(resolveExecutable('claude', { PATH: dir }, 'darwin'), join(dir, 'claude'));
  assert.equal(resolveExecutable('codex', { PATH: dir, PATHEXT: '.EXE;.CMD' }, 'win32')?.toLowerCase(), join(dir, 'codex.CMD').toLowerCase());
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

test('runFile is asynchronous, ignores stdin, keeps both streams and ends the process tree on timeout', { skip: !posix }, async t => {
  const { runFile } = await import('../src/core/process.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'journal-runfile-')); t.after(() => removeLater(dir));
  const cli = join(dir, 'cli');
  writeFileSync(cli, `#!${process.execPath}
const a=process.argv.slice(2);
if(a[0]==='both'){console.log('out');console.error('err');process.exit(0)}
if(a[0]==='fail'){console.log('partial');console.error('bad');process.exit(3)}
if(a[0]==='stdin'){let got='';process.stdin.on('data',d=>got+=d);process.stdin.on('end',()=>{console.log('stdin:'+got.length);process.exit(0)});}
if(a[0]==='env'){console.log(JSON.stringify({open:process.env.NO_OPEN_BROWSER,node:process.env.ELECTRON_RUN_AS_NODE??null}));process.exit(0)}
if(a[0]==='hang'){const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(join(dir, 'child'))},String(c.pid));setInterval(()=>{},1000)}
`);
  chmodSync(cli, 0o755);
  assert.equal(await runFile(cli, ['both'], process.env), 'out\n');
  assert.deepEqual(await runFile(cli, ['both'], process.env, { output: 'both' }), { stdout: 'out\n', stderr: 'err\n' });
  await assert.rejects(runFile(cli, ['fail'], process.env), error => error.code === 3 && error.stdout === 'partial\n' && error.stderr === 'bad\n');
  assert.equal(await runFile(cli, ['stdin'], process.env), 'stdin:0\n', 'stdin is closed, so nothing waits on input');
  assert.deepEqual(JSON.parse(await runFile(cli, ['env'], { ...process.env, ELECTRON_RUN_AS_NODE: '1' })), { open: '1', node: null });
  const started = Date.now();
  await assert.rejects(runFile(cli, ['hang'], process.env, { timeout: 500 }), error => error.timedOut === true);
  assert.ok(Date.now() - started < 4000);
  const { readFileSync } = await import('node:fs');
  const child = Number(readFileSync(join(dir, 'child'), 'utf8'));
  for (let i = 0; i < 40 && isAlive(child); i++) await wait(100);
  assert.equal(isAlive(child), false, 'the grandchild in the group was ended too');
});
