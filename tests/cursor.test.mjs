import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, realpathSync, readFileSync, existsSync } from 'node:fs';
import { join, delimiter, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { JournalStore } from '../src/core/store.mjs';
import { TerminalManager } from '../src/core/terminal.mjs';
import { buildAgentLaunch, detectCursor } from '../src/core/agents.mjs';
import { captureCursorId, createChat, cursorAuth, cursorState, findCursor, inspectCursor, installCommand, installEnv, knownLocations, parseAuth } from '../src/core/cursor.mjs';
import { formatReference } from '../src/core/references.mjs';
import { removeLater } from './support/cleanup.mjs';

const CHAT = '11111111-2222-4333-8444-555555555555';
const WIN = process.platform === 'win32';
// The fake CLIs need Node on PATH on Windows (their .cmd shim runs node); nothing else is on it.
const pathOf = (...dirs) => [...dirs, ...(WIN ? [dirname(process.execPath)] : [])].join(delimiter);
const EMPTY = { PATH: pathOf() };
const samePath = (a, b) => assert.equal(WIN ? a?.toLowerCase() : a, WIN ? b?.toLowerCase() : b);
// A fake Cursor CLI: documented commands only, state in files next to it.
function fakeCursor(dir, { version = '2026.10.01-e373342', help = 'Usage: agent [options] [command] [prompt...]\n\nStart the Cursor Agent\n\n  --resume [chatId]\n  --mode <mode>\nCommands:\n  login\n  status|whoami\n  create-chat  Create a new empty chat and return its ID', name = 'agent' } = {}) {
  mkdirSync(dir, { recursive: true });
  // POSIX: an executable script. Windows: a Node script behind an npm-style .cmd
  // shim, the form Journal launches through its Node script (src/core/process.mjs).
  const path = WIN ? join(dir, `${name}.cmd`) : join(dir, name);
  const script = WIN ? join(dir, `${name}.js`) : path;
  if (WIN) writeFileSync(path, `@ECHO off\r\nnode "%~dp0\\${name}.js" %*\r\n`);
  writeFileSync(script, `${WIN ? '' : `#!${process.execPath}\n`}const fs=require('node:fs');const path=require('node:path');const a=process.argv.slice(2);const here=${JSON.stringify(dir)};
if(a[0]==='--version'){console.log(${JSON.stringify(version)});process.exit(0)}
if(a[0]==='--help'){console.log(${JSON.stringify(help)});process.exit(0)}
if(a[0]==='create-chat'){fs.writeFileSync(path.join(here,'chat-cwd'),process.cwd());if(fs.existsSync(path.join(here,'fail-chat')))process.exit(1);const hang=fs.existsSync(path.join(here,'hang-chat'));if(hang)fs.writeFileSync(path.join(here,'chat-pid'),String(process.pid));console.log(${JSON.stringify(CHAT)});if(hang){setInterval(()=>{},1000);return}process.exit(0)}
if(a[0]==='status'){const ok=fs.existsSync(path.join(here,'logged-in'));if(a.includes('--format')){if(fs.existsSync(path.join(here,'no-json'))){console.error('unknown option --format');process.exit(1)}console.log(JSON.stringify({authenticated:ok,email:ok?'person@example.com':null}));process.exit(0)}console.log(ok?'Logged in as person@example.com':'Not logged in');process.exit(0)}
console.log('RAN '+JSON.stringify(a));`);
  if (!WIN) chmodSync(path, 0o755);
  return path;
}

function fixture(t) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cursor-')));
  const repo = join(root, 'repo'); mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=a', '-c', 'user.email=a@a', ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main'); writeFileSync(join(repo, 'README.md'), '# Repo\n'); git('add', '.'); git('commit', '-qm', 'init');
  const store = new JournalStore(join(root, 'j.sqlite')); const project = store.openProject(repo);
  t.after(() => { try { store.close(); } catch {} removeLater(root); });
  return { root, repo, store, project };
}

test('install commands are the official ones, run without shell startup files or elevation', () => {
  const mac = installCommand('darwin', {});
  assert.equal(mac.display, 'curl https://cursor.com/install -fsS | bash');
  assert.deepEqual(mac.args, ['--noprofile', '--norc', '-c', 'curl https://cursor.com/install -fsS | bash']); assert.equal(mac.file, '/bin/bash');
  const win = installCommand('win32', { SystemRoot: 'C:\\Windows' });
  assert.equal(win.display, "irm 'https://cursor.com/install?win32=true' | iex");
  assert.match(win.file, /powershell\.exe$/); assert.deepEqual(win.args, ['-NoProfile', '-NonInteractive', '-Command', "irm 'https://cursor.com/install?win32=true' | iex"]);
  for (const command of [mac, win]) assert.ok(!command.args.join(' ').match(/sudo|runas|-Verb|ExecutionPolicy/i), 'Never elevated, never changes execution policy');
  const env = installEnv({ PATH: '/bin', BASH_ENV: '/x', ENV: '/y', ELECTRON_RUN_AS_NODE: '1' });
  assert.deepEqual(env, { PATH: '/bin' });
  assert.deepEqual(knownLocations('darwin', {}, '/Users/me'), ['/Users/me/.local/bin/agent', '/Users/me/.local/bin/cursor-agent']);
  assert.match(knownLocations('win32', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'C:\\Users\\me')[0], /cursor-agent\\agent\.exe$/);
});

test('detection requires the genuine Cursor CLI: missing, impostor, on PATH, known location, unsupported', async t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cursor-detect-'))); t.after(() => removeLater(root));
  const home = join(root, 'home'); const bin = join(root, 'bin'); mkdirSync(home); mkdirSync(bin);
  const options = { platform: process.platform, home };
  const local = join(root, 'local'); const env = (...dirs) => ({ PATH: pathOf(...dirs), LOCALAPPDATA: local });
  // Where the official installer puts the CLI on this platform.
  const knownDir = WIN ? join(local, 'cursor-agent') : join(home, '.local', 'bin');
  assert.equal(cursorState(await findCursor(env(bin), options)).state, 'missing');
  // Some other program called "agent".
  fakeCursor(bin, { version: 'agent 3.1.4', help: 'Usage: agent - a build agent' });
  const impostor = await findCursor(env(bin), options);
  assert.equal(impostor.path, null); samePath(impostor.impostor, WIN ? join(bin, 'agent.cmd') : join(bin, 'agent')); assert.equal(cursorState(impostor).state, 'not-cursor');
  // Installed to ~/.local/bin while Journal's PATH has not caught up.
  const known = fakeCursor(knownDir);
  const found = await findCursor(env(bin), options);
  samePath(found.path, known); assert.equal(found.onPath, false); assert.equal(found.version, '2026.10.01-e373342'); assert.equal(cursorState(found).state, 'ready');
  // On PATH wins.
  const bin2 = join(root, 'bin2'); const onPath = fakeCursor(bin2);
  samePath((await findCursor(env(bin2, bin), options)).path, onPath);
  assert.equal((await findCursor(env(bin2, bin), options)).onPath, true);
  // A build without exact-ID chats is unsupported.
  const old = join(root, 'old'); fakeCursor(old, { version: '2025.01.01-abcdef0', help: 'Start the Cursor Agent\n  --resume [chatId]' });
  assert.equal(cursorState(await findCursor({ PATH: pathOf(old) }, { ...options, home: join(root, 'nohome') })).state, 'unsupported');
  const row = await detectCursor(env(bin2), options);
  assert.equal(row.provider, 'cursor'); assert.equal(row.available, true); assert.equal(row.supports.mode, true); assert.equal(row.auth, 'unchecked');
  // A Windows launcher Journal cannot start safely is reported as such, not as "not Cursor".
  const shim = join(root, 'win', 'agent.cmd'); mkdirSync(join(root, 'win')); writeFileSync(shim, '@echo off\r\n"%~dp0versions\\node.exe" index.js %*\r\n');
  const winInfo = await inspectCursor(shim, {}, { platform: 'win32' });
  assert.equal(winInfo.cursor, false); assert.match(winInfo.unlaunchable, /cmd\.exe launcher|recognizable/);
});

test('sign-in state is read without keeping any account details', async t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cursor-auth-'))); t.after(() => removeLater(root));
  const path = fakeCursor(root);
  assert.equal(await cursorAuth(path, EMPTY), 'signed-out');
  writeFileSync(join(root, 'logged-in'), '');
  const state = await cursorAuth(path, EMPTY);
  assert.equal(state, 'signed-in'); assert.equal(typeof state, 'string');
  writeFileSync(join(root, 'no-json'), ''); assert.equal(await cursorAuth(path, EMPTY), 'signed-in', 'Falls back to text status');
  assert.equal(parseAuth('Not logged in'), 'signed-out'); assert.equal(parseAuth('Partially authenticated (missing refresh token)'), 'signed-out');
  assert.equal(parseAuth('Logged in as a@b.c'), 'signed-in'); assert.equal(parseAuth('{"isAuthenticated":false}'), 'signed-out');
  assert.equal(parseAuth('something else'), 'unknown');
  assert.equal(parseAuth('{"status":"authenticated"}'), 'signed-in'); assert.equal(parseAuth('{"status":"unauthenticated"}'), 'signed-out'); assert.equal(parseAuth('Not authenticated'), 'signed-out');
});

test('a chat is created in the session folder; exit hints are captured but never trusted alone', async t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cursor-chat-'))); t.after(() => removeLater(root));
  const path = fakeCursor(join(root, 'bin')); const cwd = join(root, 'work'); mkdirSync(cwd);
  assert.equal(await createChat(path, cwd, EMPTY), CHAT);
  assert.equal(readFileSync(join(root, 'bin', 'chat-cwd'), 'utf8'), cwd);
  // Current builds print the ID and keep running: the ID is taken at once and the process ended.
  writeFileSync(join(root, 'bin', 'hang-chat'), ''); const started = Date.now();
  assert.equal(await createChat(path, cwd, EMPTY), CHAT); assert.ok(Date.now() - started < 5000, 'Does not wait for exit');
  const pid = Number(readFileSync(join(root, 'bin', 'chat-pid'), 'utf8'));
  await new Promise(r => setTimeout(r, 300)); assert.throws(() => process.kill(pid, 0), /ESRCH/, 'The lingering process is ended');
  rmSync(join(root, 'bin', 'hang-chat'));
  writeFileSync(join(root, 'bin', 'fail-chat'), ''); assert.equal(await createChat(path, cwd, EMPTY), null);
  assert.equal(captureCursorId(`bye\n\x1b[2mTo resume this session: cursor-agent --resume=${CHAT}\x1b[0m`), CHAT);
  assert.equal(captureCursorId(`To resume this session: agent --resume="${CHAT.toUpperCase()}"`), CHAT);
  assert.equal(captureCursorId('To resume this session: agent --resume=not-a-uuid'), null);
});

test('launch arguments: exact chat ID, documented modes, never force or resume-latest', () => {
  const base = { provider: 'cursor', executable: '/x/agent', prompt: 'Journal packet\nTask:\nDo it' };
  assert.deepEqual(buildAgentLaunch({ ...base, nativeId: CHAT }).argv, [`--resume=${CHAT}`, '--', base.prompt]);
  assert.deepEqual(buildAgentLaunch({ ...base, nativeId: CHAT, research: true }).argv, [`--resume=${CHAT}`, '--mode=ask', '--', base.prompt]);
  assert.deepEqual(buildAgentLaunch({ ...base, nativeId: CHAT, plan: true }).argv, [`--resume=${CHAT}`, '--mode=plan', '--', base.prompt]);
  assert.deepEqual(buildAgentLaunch({ ...base, nativeId: CHAT, resume: true, prompt: '' }).argv, [`--resume=${CHAT}`]);
  assert.deepEqual(buildAgentLaunch({ ...base, nativeId: null }).argv, ['--', base.prompt]);
  assert.equal(buildAgentLaunch({ ...base, nativeId: CHAT }).executable, '/x/agent');
  for (const args of [buildAgentLaunch({ ...base, nativeId: CHAT, research: true }).argv]) assert.ok(!args.some(a => /--force|--yolo|--continue|--sandbox|--approve-mcps|^resume$|^ls$/.test(a)));
  assert.throws(() => buildAgentLaunch({ ...base, executable: null }), /not installed/);
  assert.throws(() => buildAgentLaunch({ ...base, nativeId: 'latest', resume: true }), /exact native session ID/);
  assert.throws(() => buildAgentLaunch({ provider: 'codex', plan: true }), /no plan mode/);
  assert.deepEqual(buildAgentLaunch({ provider: 'claude', nativeId: CHAT, plan: true }).argv.slice(2, 4), ['--permission-mode', 'plan']);
  assert.equal(formatReference('cursor', { path: 'src/a.ts', kind: 'lines', startLine: 3, endLine: 9 }), 'src/a.ts (lines 3-9)');
});

function manager(f, t, { supports = { resume: true, createChat: true, mode: true }, chat = () => CHAT } = {}) {
  const spawned = []; const exits = [];
  const created = [];
  const m = new TerminalManager({ store: f.store, trackMs: 0, identify: () => null, table: () => null,
    cursor: { find: () => ({ path: '/fake/agent', cursor: true, version: '2026.10.01-e373342', supports }), createChat: async (path, cwd) => { created.push(cwd); return chat(); } },
    spawn: (executable, argv, options) => { const proc = { executable, argv, cwd: options.cwd, writes: [], onData(cb) { this.data = cb; }, onExit(cb) { exits.push(cb); this.exit = cb; }, write(d) { this.writes.push(d); }, resize() {}, kill() {} }; spawned.push(proc); return proc; } });
  t.after(() => { m.disposed = true; });
  return { m, spawned, created };
}

test('Cursor sessions launch with an exact chat ID, context and references, in their workspace', async t => {
  const f = fixture(t); const { m, spawned, created } = manager(f, t);
  const ws = f.store.createWorkspace(f.project.id, { branch: 'feature/cursor', base: 'main' }, join(f.root, 'worktrees'));
  const claim = f.store.proposeMemory(f.project.id, { statement: 'CURSOR_BRIEF: repo overview for every agent', category: 'brief', scope: 'checkout', area: '', source: { kind: 'user', note: 'x' } });
  f.store.setMemoryStatus(claim.id, 'active');
  const { session, receipt } = await m.start({ projectId: f.project.id, provider: 'cursor', task: 'Fix the parser', workspaceId: ws.id, references: [{ rootKey: ws.id, path: 'README.md' }] });
  assert.equal(session.provider, 'cursor'); assert.equal(session.nativeId, CHAT); assert.equal(session.nativeIdConfirmed, true);
  assert.equal(spawned[0].executable, '/fake/agent'); assert.equal(spawned[0].cwd, realpathSync.native(ws.path)); assert.equal(created[0], realpathSync.native(ws.path), 'The chat is created where the session runs');
  assert.equal(spawned[0].argv[0], `--resume=${CHAT}`); assert.equal(spawned[0].argv[1], '--');
  const prompt = spawned[0].argv.at(-1);
  assert.match(prompt, /CURSOR_BRIEF/); assert.match(prompt, /Referenced by the user/); assert.match(prompt, /Task:\nFix the parser/);
  assert.equal(f.store.getReceipt(receipt.id).state, 'submitted');
  // Interrupt and stop go to this session's own process.
  m.interrupt(session.id); assert.deepEqual(spawned[0].writes, ['\x03']);
  // Never typed: Journal cannot see when Cursor is ready.
  const pasted = m.paste(session.id, 'README.md'); assert.equal(pasted.inserted, false); assert.match(pasted.reason, /Cursor/);
  assert.deepEqual(spawned[0].writes, ['\x03']);
  spawned[0].exit({ exitCode: 0 }); await new Promise(r => setTimeout(r, 20));
  // Exact resume reopens the same chat in the same worktree, without creating another.
  const resumed = await m.start({ projectId: f.project.id, provider: 'cursor', resumeId: session.id });
  assert.equal(resumed.session.nativeId, CHAT); assert.equal(spawned[1].argv[0], `--resume=${CHAT}`); assert.equal(spawned[1].cwd, realpathSync.native(ws.path));
  assert.equal(created.length, 1, 'Resume never creates a new chat');
});

test('modes, unsupported builds and a chat that could not be created', async t => {
  const f = fixture(t);
  const ask = manager(f, t); await ask.m.start({ projectId: f.project.id, provider: 'cursor', task: 'Look', research: true });
  assert.ok(ask.spawned[0].argv.includes('--mode=ask'));
  await ask.m.start({ projectId: f.project.id, provider: 'cursor', task: 'Plan', plan: true });
  assert.ok(ask.spawned[1].argv.includes('--mode=plan')); assert.equal((await f.store.listSessions(f.project.id)).find(s => s.plan)?.plan, true);
  const old = manager(f, t, { supports: { resume: true, createChat: true, mode: false } });
  await assert.rejects(old.m.start({ projectId: f.project.id, provider: 'cursor', task: 'x', research: true }), /no Ask mode/);
  const noChat = manager(f, t, { chat: () => null });
  const { session } = await noChat.m.start({ projectId: f.project.id, provider: 'cursor', task: 'x' });
  assert.equal(session.nativeId, null); assert.equal(session.nativeIdConfirmed, false); assert.ok(!noChat.spawned[0].argv.some(a => a.startsWith('--resume')));
  // The exit banner becomes a hint that still needs confirmation.
  noChat.spawned[0].data(`To resume this session: agent --resume=${CHAT}\n`);
  assert.equal(noChat.m.entry(session.id).session.nativeId, CHAT); assert.equal(noChat.m.entry(session.id).session.nativeIdConfirmed, false);
  const missing = new TerminalManager({ store: f.store, trackMs: 0, identify: () => null, table: () => null, spawn: () => { throw new Error('unused'); }, cursor: { find: () => ({ path: null }), createChat: async () => null } });
  await assert.rejects(missing.start({ projectId: f.project.id, provider: 'cursor', task: 'x' }), /not installed/);
  await assert.rejects(ask.m.start({ projectId: f.project.id, provider: 'codex', task: 'x', plan: true }), /no plan mode/);
});

test('Cursor, Claude and Codex sessions run side by side without mixing input or identities', async t => {
  const f = fixture(t); let n = 0;
  const { m, spawned } = manager(f, t, { chat: () => `11111111-2222-4333-8444-${String(++n).padStart(12, '0')}` });
  const a = await m.start({ projectId: f.project.id, provider: 'cursor', task: 'one' });
  const b = await m.start({ projectId: f.project.id, provider: 'cursor', task: 'two' });
  const c = await m.start({ projectId: f.project.id, provider: 'claude', task: 'three' });
  const d = await m.start({ projectId: f.project.id, provider: 'codex', task: 'four' });
  assert.notEqual(a.session.nativeId, b.session.nativeId); assert.notEqual(c.session.nativeId, a.session.nativeId);
  m.write(b.session.id, 'only b');
  assert.deepEqual(spawned.map(p => p.writes), [[], ['only b'], [], []]);
  assert.equal(spawned[2].executable, 'claude'); assert.equal(spawned[3].executable, 'codex'); assert.equal(spawned[0].executable, '/fake/agent');
  await assert.rejects(m.start({ projectId: f.project.id, provider: 'cursor', task: 'five' }), /up to 4 sessions/);
  // A runtime restart recovers Cursor sessions like any other: interrupted, never resent.
  const recovered = new JournalStore(join(f.root, 'j.sqlite')); t.after(() => recovered.close());
  recovered.recoverSessions();
  assert.equal(recovered.getSession(a.session.id).status, 'interrupted'); assert.equal(recovered.getSession(a.session.id).nativeId, a.session.nativeId);
});

test('Journal never stores Cursor account details', async t => {
  const f = fixture(t); const path = fakeCursor(join(f.root, 'bin')); writeFileSync(join(f.root, 'bin', 'logged-in'), '');
  assert.equal(await cursorAuth(path, EMPTY), 'signed-in');
  const { m } = manager(f, t); await m.start({ projectId: f.project.id, provider: 'cursor', task: 'x' });
  f.store.checkpoint?.();
  for (const file of ['j.sqlite', 'j.sqlite-wal']) if (existsSync(join(f.root, file))) assert.ok(!readFileSync(join(f.root, file)).includes('person@example.com'));
});

// The visible-process runner (install and sign-in) is tested in tests/process-runner.test.mjs.
