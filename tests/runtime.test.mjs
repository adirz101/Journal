import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn as spawnChild } from 'node:child_process';
import { JournalStore } from '../src/core/store.mjs';
import { startRuntime } from '../src/runtime/runtime.mjs';
import { RuntimeClient } from '../src/desktop/runtime-client.mjs';
import { frame } from '../src/runtime/protocol.mjs';
import { processIdentity, isAlive } from '../src/core/process.mjs';
import { removeLater } from './support/cleanup.mjs';

const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(check, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await wait(20); }
  throw new Error('Timed out waiting for condition');
}

// Fake PTYs: no PID, so stop() can only use the owned handle.
function fakeSpawner() {
  const procs = [];
  const spawn = (executable, argv, options) => {
    const proc = { executable, argv, options, inputs: [], killed: [], data: null, exit: null,
      onData(f) { this.data = f; }, onExit(f) { this.exit = f; }, write(d) { this.inputs.push(d); }, resize() {},
      kill(signal) { this.killed.push(signal ?? 'default'); setImmediate(() => this.exit?.({ exitCode: 0, signal: 15 })); } };
    procs.push(proc); return proc;
  };
  return { spawn, procs };
}

function fixture(t, { dataDir } = {}) {
  const root = mkdtempSync(resolve(process.env.JOURNAL_TEST_TMP ?? tmpdir(), 'rt-'));
  dataDir ??= join(root, 'data'); mkdirSync(dataDir, { recursive: true });
  const repo = join(root, 'repo'); mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'README.md'), 'Fixture\n'); execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'init']);
  const dbPath = join(dataDir, 'journal.sqlite');
  const store = new JournalStore(dbPath); const project = store.openProject(repo);
  const runtimes = [];
  const boot = async (fake = fakeSpawner(), extra = {}) => {
    const runtime = await startRuntime({ dataDir, store, spawn: fake.spawn, hookScript: '/dev/null', identify: () => null, table: () => null, observerMs: 20, idleMs: 3_600_000, ...extra });
    runtimes.push(runtime); return { runtime, fake };
  };
  t.after(async () => { for (const r of runtimes) { r.server.close(); r.manager.disposed = true; clearInterval(r.manager.tracker); } store.close(); removeLater(root); });
  return { root, repo, dataDir, store, project, boot };
}

function client(f, t, launch = () => {}) {
  const c = new RuntimeClient({ dataDir: f.dataDir, launch, connectTimeoutMs: 2000 });
  t.after(() => c.close()); return c;
}

test('the runtime refuses clients that cannot prove the token, and never receives it', async t => {
  const f = fixture(t); const { runtime } = await f.boot();
  const exchange = messages => new Promise(resolvePromise => {
    const socket = net.connect(runtime.path); socket.setEncoding('utf8'); let text = '';
    socket.on('data', d => { text += d; if (text.includes('\n') && messages.length) socket.write(frame(messages.shift())); }); socket.on('close', () => resolvePromise(text));
    socket.on('connect', () => socket.write(frame({ id: 1, method: 'hello', params: { protocol: 4, nonce: 'n'.repeat(48) } })));
    setTimeout(() => socket.destroy(), 500);
  });
  const reply = await exchange([{ id: 2, method: 'auth', params: { proof: 'f'.repeat(64) } }]);
  assert.match(reply, /"challenge"/); assert.match(reply, /Unauthorized/);
  assert.ok(!reply.includes(runtime.token), 'The token itself never crosses the socket');
  assert.match(await exchange([]), /challenge/);
  const legacy = await new Promise(resolvePromise => {
    const socket = net.connect(runtime.path); socket.setEncoding('utf8'); let text = '';
    socket.on('data', d => { text += d; }); socket.on('close', () => resolvePromise(text));
    socket.on('connect', () => socket.write(frame({ id: 1, method: 'hello', params: { token: runtime.token, protocol: 1 } })));
  });
  assert.match(legacy, /Protocol mismatch/, 'An older client is told the protocol differs instead of being treated as an attacker');
  const info = JSON.parse(readFileSync(join(f.dataDir, 'runtime.json'), 'utf8'));
  assert.equal(info.runtimeId, runtime.runtimeId);
  if (process.platform !== 'win32') assert.equal((await import('node:fs')).statSync(join(f.dataDir, 'runtime.json')).mode & 0o777, 0o600);
});

test('a client refuses a server that cannot prove the token', async t => {
  const f = fixture(t);
  const impostorPath = (await import('../src/runtime/protocol.mjs')).socketPath(f.dataDir);
  const seen = [];
  const impostor = net.createServer(socket => { socket.setEncoding('utf8'); socket.on('data', d => { seen.push(d); socket.write(frame({ id: 0, value: { challenge: 'c'.repeat(48), proof: '0'.repeat(64) } })); }); });
  await new Promise(r => impostor.listen(impostorPath, r)); t.after(() => impostor.close());
  writeFileSync(join(f.dataDir, 'runtime.json'), JSON.stringify({ socket: impostorPath, token: 'secret-token-value', protocol: 4 }));
  const c = new RuntimeClient({ dataDir: f.dataDir, launch: () => null, connectTimeoutMs: 600 }); t.after(() => c.close());
  await assert.rejects(c.connect(), /Could not start/);
  assert.ok(seen.length && seen.every(text => !text.includes('secret-token-value') && !/"auth"/.test(text)));
});

test('a second runtime for the same data directory is refused', async t => {
  const f = fixture(t); await f.boot();
  await assert.rejects(f.boot(), /already running/);
});

test('four concurrent sessions keep input and output separate; a fifth is refused', async t => {
  const f = fixture(t); const { fake } = await f.boot(); const c = client(f, t); await c.connect();
  const events = []; c.on('event', e => events.push(e));
  const sessions = [];
  for (let i = 0; i < 4; i++) sessions.push((await c.call('start', { projectId: f.project.id, provider: i % 2 ? 'codex' : 'claude', task: `Task ${i}` })).session);
  await assert.rejects(c.call('start', { projectId: f.project.id, provider: 'claude', task: 'fifth' }), /up to 4 sessions/);
  assert.deepEqual(sessions.map(s => s.slot), [1, 2, 3, 4]);
  assert.equal(new Set(sessions.map(s => s.id)).size, 4);
  await c.call('write', { id: sessions[1].id, data: 'only-b' });
  assert.deepEqual(fake.procs.map(p => p.inputs), [[], ['only-b'], [], []]);
  await c.call('attach', { id: sessions[2].id });
  fake.procs[0].data('from-a'); fake.procs[2].data('from-c');
  await until(() => events.some(e => e.type === 'output' && e.data === 'from-c'));
  assert.ok(!events.some(e => e.type === 'output' && e.sessionId !== sessions[2].id), 'Only the attached session streams output');
  // Switching attaches the other session and returns its bounded history.
  const snapshot = await c.call('attach', { id: sessions[0].id });
  assert.equal(snapshot.chunks.map(x => x.data).join(''), 'from-a');
  await assert.rejects(c.call('write', { id: 'not-a-session', data: 'x' }), /not active or owned/);
});

test('sessions survive the desktop client disconnecting and are rediscovered on reconnect', async t => {
  const f = fixture(t); const { fake } = await f.boot();
  const first = client(f, t); await first.connect();
  const { session } = await first.call('start', { projectId: f.project.id, provider: 'claude', task: 'Long task' });
  fake.procs[0].data('before-crash ');
  first.socket.destroy(); first.closing = true; // simulate an app crash
  fake.procs[0].data('while-away');
  const second = client(f, t); await second.connect();
  const live = await second.call('list');
  assert.deepEqual(live.map(s => [s.id, s.status]), [[session.id, 'running']]);
  const snapshot = await second.call('attach', { id: session.id });
  assert.equal(snapshot.chunks.map(c => c.data).join(''), 'before-crash while-away');
  assert.equal(fake.procs.length, 1, 'Reconnecting never relaunches or resends a prompt');
  await second.call('write', { id: session.id, data: 'still-mine' });
  assert.deepEqual(fake.procs[0].inputs, ['still-mine']);
});

test('stop, interrupt and provider exit produce distinct recorded states', async t => {
  const f = fixture(t); const { fake } = await f.boot(); const c = client(f, t); await c.connect();
  const a = (await c.call('start', { projectId: f.project.id, provider: 'claude', task: 'A' })).session;
  const b = (await c.call('start', { projectId: f.project.id, provider: 'codex', task: 'B' })).session;
  await c.call('interrupt', { id: a.id }); assert.deepEqual(fake.procs[0].inputs, ['\x03']);
  await c.call('stop', { id: a.id });
  await until(() => f.store.getSession(a.id).status === 'stopped');
  fake.procs[1].exit({ exitCode: 2 });
  await until(() => f.store.getSession(b.id).status === 'exited');
  assert.equal(f.store.getSession(b.id).exitCode, 2);
  await assert.rejects(c.call('write', { id: a.id, data: 'late' }), /not active/);
  const kinds = f.store.listEvents(a.id).map(e => e.kind);
  for (const kind of ['start', 'context', 'interrupt', 'stop']) assert.ok(kinds.includes(kind), kind);
  assert.ok(f.store.listEvents(b.id).some(e => e.kind === 'exit' && e.body.exitCode === 2));
});

test('a runtime crash leaves interrupted sessions with uncertain delivery and no resent prompt', async t => {
  const f = fixture(t); const first = await f.boot(); const c = client(f, t); await c.connect();
  const { session, receipt } = await c.call('start', { projectId: f.project.id, provider: 'claude', task: 'Do not resend me' });
  assert.equal(f.store.getReceipt(receipt.id).state, 'submitted');
  // Simulated crash: the process is gone without any shutdown bookkeeping.
  // A crash also drops its clients; waiting for the pipe to close lets Windows reuse its name.
  c.close(); first.runtime.manager.disposed = true; await Promise.race([new Promise(resolve => first.runtime.server.close(resolve)), wait(2000)]); await wait(50);
  const second = await f.boot();
  assert.equal(second.fake.procs.length, 0);
  const recovered = f.store.getSession(session.id);
  assert.equal(recovered.status, 'interrupted'); assert.ok(recovered.recoveredAt);
  assert.equal(f.store.getReceipt(receipt.id).state, 'uncertain');
  assert.ok(f.store.listEvents(session.id).some(e => e.kind === 'recovered'));
});

test('an orphaned process is terminated only when its recorded identity still matches', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  const child = spawnChild(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  let identity = null; await until(async () => (identity = await processIdentity(child.pid)));
  const base = { projectId: f.project.id, provider: 'claude', nativeId: '11111111-1111-4111-8111-111111111111', nativeIdConfirmed: true, title: 'x', receiptId: f.store.prepareContext(f.project.id, '').id, runtimeId: 'dead-runtime', createdAt: new Date().toISOString() };
  f.store.saveSession({ ...base, id: 'reused', status: 'running', pid: child.pid, identity: { ...identity, started: 'Mon Jan 1 00:00:00 2001' } });
  f.store.saveSession({ ...base, id: 'orphan', status: 'running', pid: child.pid, identity });
  await f.boot(fakeSpawner(), { identify: processIdentity });
  assert.equal(f.store.getSession('reused').status, 'interrupted', 'A PID with another start time is not ours');
  assert.equal(f.store.getSession('orphan').status, 'orphaned');
  const c = client(f, t); await c.connect();
  await assert.rejects(c.call('terminateOrphan', { id: 'reused' }), /orphaned/);
  const result = await c.call('terminateOrphan', { id: 'orphan' });
  assert.equal(result.signalled, true);
  await until(() => !isAlive(child.pid) || child.exitCode !== null || child.signalCode !== null);
  assert.equal(f.store.getSession('orphan').status, 'stopped');
});

test('Claude hook observations become redacted commands, exit codes and file events', async t => {
  const f = fixture(t); const { runtime } = await f.boot(); const c = client(f, t); await c.connect();
  const { session } = await c.call('start', { projectId: f.project.id, provider: 'claude', task: 'hooks' });
  const observer = [...runtime.manager.entries.values()][0];
  const settings = JSON.parse(readFileSync(observer.proc.argv[observer.proc.argv.indexOf('--settings') + 1], 'utf8'));
  for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']) assert.ok(settings.hooks[event], event);
  const target = join(f.dataDir, 'observers', `${session.id}.events.jsonl`);
  const token = settings.hooks.Stop[0].hooks[0].command.match(/['"]([0-9a-f]{48})['"]/)[1];
  const line = extra => appendFileSync(target, JSON.stringify({ token, id: session.id, nativeId: session.nativeId, cwd: f.repo, at: Date.now(), ...extra }) + '\n');
  line({ event: 'PreToolUse', tool: 'Bash', toolUseId: 't1', command: 'API_KEY=abcd1234 npm test' });
  line({ event: 'PostToolUseFailure', tool: 'Bash', toolUseId: 't1', exit: 3, durationMs: 1200 });
  line({ event: 'PreToolUse', tool: 'Bash', toolUseId: 't2', command: 'ls' });
  line({ event: 'PostToolUse', tool: 'Bash', toolUseId: 't2', durationMs: 10 });
  line({ event: 'PostToolUse', tool: 'Write', toolUseId: 't3', filePath: join(f.repo, 'src/a.mjs') });
  line({ event: 'PermissionRequest', tool: 'Write' });
  appendFileSync(target, JSON.stringify({ token: 'forged', id: session.id, event: 'Stop', cwd: f.repo }) + '\n');
  await until(() => f.store.getSession(session.id).status === 'waiting');
  const events = f.store.listEvents(session.id);
  const start = events.find(e => e.kind === 'command-start' && e.body.toolUseId === 't1');
  assert.equal(start.body.command, 'API_KEY=[redacted] npm test'); assert.equal(start.body.test, true);
  assert.deepEqual(events.find(e => e.kind === 'command-end' && e.body.toolUseId === 't1').body, { toolUseId: 't1', status: 'failed', exitCode: 3, durationMs: 1200 });
  assert.equal(events.find(e => e.kind === 'command-end' && e.body.toolUseId === 't2').body.exitCode, 0);
  assert.equal(events.find(e => e.kind === 'file').body.path, 'src/a.mjs');
  assert.equal(f.store.getSession(session.id).activity, 'permission');
  assert.ok(!events.some(e => e.kind === 'turn-end'), 'Forged observations are ignored');
  // A new turn clears the open Write prompt; the next one shows its redacted command.
  line({ event: 'UserPromptSubmit' });
  line({ event: 'PermissionRequest', tool: 'Bash', toolUseId: 't9', command: 'API_KEY=abcd1234 rm x' });
  await until(() => f.store.getSession(session.id).pending?.tool === 'Bash');
  assert.equal(f.store.getSession(session.id).pending.command, 'API_KEY=[redacted] rm x');
  assert.ok(!JSON.stringify(f.store.getSession(session.id)).includes('abcd1234'));
});

test('archiving a live session hides it but keeps it running; releasing still needs a stop', async t => {
  const f = fixture(t); const { fake } = await f.boot(); const c = client(f, t); await c.connect();
  const { session } = await c.call('start', { projectId: f.project.id, provider: 'claude', task: 'close me' });
  f.store.archiveSession(session.id);
  assert.equal(f.store.getSession(session.id).status, 'running', 'Archiving never stops the agent');
  assert.throws(() => f.store.removeSession(session.id), /Stop the session/);
  await assert.rejects(c.call('release', { id: session.id }), /Stop the session/);
  fake.procs[0].exit({ exitCode: 0 });
  await until(() => f.store.getSession(session.id).status === 'exited');
  await c.call('release', { id: session.id }); f.store.archiveSession(session.id);
  assert.equal(f.store.listSessions(f.project.id).length, 0);
  assert.equal(f.store.listSessions(f.project.id, true).length, 1);
});

test('a stale lock is replaced, a live owner keeps it, and launches are capped', async t => {
  const f = fixture(t);
  const { acquireLock } = await import('../src/runtime/runtime.mjs');
  writeFileSync(join(f.dataDir, 'runtime.lock'), JSON.stringify({ pid: 999999, identity: { started: 'x', commandHash: 'y' } }));
  const release = await acquireLock(f.dataDir, join(f.dataDir, 'none.sock'), () => ({ started: 'me', commandHash: 'me' }));
  assert.equal(JSON.parse(readFileSync(join(f.dataDir, 'runtime.lock'), 'utf8')).pid, process.pid); release();
  const child = spawnChild(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); t.after(() => child.kill('SIGKILL'));
  writeFileSync(join(f.dataDir, 'runtime.lock'), JSON.stringify({ pid: child.pid, identity: { started: 'same', commandHash: 'same' } }));
  await assert.rejects(acquireLock(f.dataDir, join(f.dataDir, 'none.sock'), () => ({ started: 'same', commandHash: 'same' })), /already running/);
  let launches = 0; const failures = [];
  const c = new RuntimeClient({ dataDir: join(f.root, 'empty-data'), launch: () => { launches++; return null; }, connectTimeoutMs: 300 });
  c.on('failed', message => failures.push(message)); t.after(() => c.close());
  for (let i = 0; i < 5; i++) await assert.rejects(c.connect());
  assert.equal(launches, 3); assert.ok(failures.length >= 1);
});

test('orphan recovery: unverifiable live processes stay orphaned and block resume and signals', async t => {
  const f = fixture(t);
  const child = spawnChild(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); t.after(() => child.kill('SIGKILL'));
  const nativeId = '22222222-2222-4222-8222-222222222222';
  f.store.saveSession({ id: 'unknown', projectId: f.project.id, provider: 'claude', nativeId, nativeIdConfirmed: true, status: 'running', pid: child.pid, identity: null, receiptId: 'r', runtimeId: 'gone', title: 'x', createdAt: new Date().toISOString() });
  const { runtime } = await f.boot(fakeSpawner(), { identify: () => null });
  const recovered = f.store.getSession('unknown');
  assert.equal(recovered.status, 'orphaned'); assert.equal(recovered.identityVerified, false); assert.equal(recovered.endedAt, null);
  const c = client(f, t); await c.connect();
  await assert.rejects(c.call('terminateOrphan', { id: 'unknown' }), /cannot verify/);
  await assert.rejects(c.call('confirmNativeId', { id: 'unknown', nativeId }), /Stop this session/);
  f.store.saveSession({ id: 'older', projectId: f.project.id, provider: 'claude', nativeId, nativeIdConfirmed: true, status: 'stopped', receiptId: 'r', title: 'y', createdAt: new Date().toISOString() });
  await assert.rejects(c.call('start', { projectId: f.project.id, provider: 'claude', resumeId: 'older' }), /orphaned process/);
  assert.ok(isAlive(child.pid), 'Nothing was signalled');
  child.kill('SIGKILL'); await until(() => !isAlive(child.pid));
  await runtime.manager.recheckOrphans();
  assert.equal(f.store.getSession('unknown').status, 'interrupted', 'Once the process is gone the session is released');
});

test('confirming a resume ID survives later saves of a retained session', async t => {
  const f = fixture(t); const { fake, runtime } = await f.boot(); const c = client(f, t); await c.connect();
  const { session } = await c.call('start', { projectId: f.project.id, provider: 'codex', task: 'x' });
  fake.procs[0].exit({ exitCode: 0 }); await until(() => f.store.getSession(session.id).status === 'exited');
  await c.call('confirmNativeId', { id: session.id, nativeId: '33333333-3333-4333-8333-333333333333' });
  runtime.manager.persist(runtime.manager.entry(session.id).session, true); await wait(20);
  assert.equal(f.store.getSession(session.id).nativeIdConfirmed, true);
});

test('the client relaunches and reconnects when the runtime goes away', async t => {
  const f = fixture(t); let current = await f.boot(); let launches = 0;
  const c = client(f, t, () => { launches++; void f.boot().then(next => { current = next; }); });
  await c.connect(); assert.equal(launches, 0);
  const reconnected = new Promise(resolvePromise => c.once('reconnected', resolvePromise));
  const disconnected = new Promise(resolvePromise => c.once('disconnected', resolvePromise));
  current.runtime.server.close(); for (const s of [c.socket]) s.destroy();
  await disconnected; rmSync(join(f.dataDir, 'runtime.json'));
  const hello = await reconnected;
  assert.equal(launches, 1); assert.notEqual(hello.runtimeId, undefined);
  assert.deepEqual(await c.call('list'), []);
});

test('concurrent sessions in different projects receive only their own project and branch knowledge', async t => {
  const f = fixture(t); const { fake } = await f.boot(); const c = client(f, t); await c.connect();
  const other = join(f.root, 'other'); mkdirSync(other); execFileSync('git', ['init', '-q', '-b', 'main', other]);
  const second = f.store.openProject(other);
  const add = (projectId, statement, scope = 'checkout') => { const m = f.store.proposeMemory(projectId, { statement, category: 'constraint', scope, area: '', source: { kind: 'user', note: 'x' } }); f.store.setMemoryStatus(m.id, 'active'); };
  add(f.project.id, 'ALPHA_ONLY deployment rule'); add(second.id, 'BETA_ONLY deployment rule');
  execFileSync('git', ['-C', f.repo, 'switch', '-q', '-c', 'feature']); add(f.project.id, 'FEATURE_BRANCH deployment rule', 'branch');
  const a = await c.call('start', { projectId: f.project.id, provider: 'claude', task: 'deployment' });
  const b = await c.call('start', { projectId: second.id, provider: 'codex', task: 'deployment' });
  const promptA = fake.procs[0].argv.at(-1); const promptB = fake.procs[1].argv.at(-1);
  assert.match(promptA, /ALPHA_ONLY/); assert.match(promptA, /FEATURE_BRANCH/); assert.doesNotMatch(promptA, /BETA_ONLY/);
  assert.match(promptB, /BETA_ONLY/); assert.doesNotMatch(promptB, /ALPHA_ONLY|FEATURE_BRANCH/);
  assert.equal(fake.procs[1].options.cwd, f.store.project(second.id).root);
  assert.equal(a.session.branch, 'feature'); assert.equal(b.session.projectId, second.id);
  assert.equal(f.store.getReceipt(a.receipt.id).launchPrompt, promptA, 'Each session keeps its own immutable receipt');
});

test('recovery tolerates partial session metadata without inventing state', async t => {
  const f = fixture(t);
  f.store.saveSession({ id: 'partial', projectId: f.project.id, provider: 'codex', status: 'running', receiptId: 'missing-receipt', runtimeId: 'gone', createdAt: new Date().toISOString() });
  f.store.saveSession({ id: 'no-runtime', projectId: f.project.id, provider: 'claude', status: 'stopping', receiptId: 'missing', createdAt: new Date().toISOString() });
  await f.boot();
  for (const id of ['partial', 'no-runtime']) {
    const session = f.store.getSession(id);
    assert.equal(session.status, 'interrupted'); assert.equal(session.nativeId, undefined, 'No native ID is invented');
  }
});

// A real child process behind the PTY interface: real PID, group and signals.
function childSpawner(script) {
  const procs = [];
  const spawn = () => {
    const child = spawnChild(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' });
    const proc = { pid: child.pid, child, inputs: [], exit: null, onData() {}, onExit(f) { child.on('exit', (code, signal) => f({ exitCode: code, signal })); }, write(d) { this.inputs.push(d); }, resize() {}, kill(signal) { try { child.kill(signal); } catch {} } };
    procs.push(proc); return proc;
  };
  return { spawn, procs };
}

test('a real process gets a start-time identity, and stop escalates from SIGTERM to SIGKILL', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  const fake = childSpawner("process.on('SIGTERM', () => {}); process.title = 'renamed'; setInterval(() => {}, 1000)");
  t.after(() => { for (const p of fake.procs) try { process.kill(p.pid, 'SIGKILL'); } catch {} });
  const { runtime } = await f.boot(fake, { identify: processIdentity, stopGraceMs: 300 });
  const c = client(f, t); await c.connect();
  const { session } = await c.call('start', { projectId: f.project.id, provider: 'claude', task: 'real' });
  const pid = fake.procs[0].pid;
  await until(() => f.store.getSession(session.id).identity?.started);
  assert.deepEqual(f.store.getSession(session.id).identity.started, (await processIdentity(pid)).started);
  await wait(400); // let the child install its SIGTERM handler
  await c.call('stop', { id: session.id });
  await until(() => f.store.getSession(session.id).status === 'stopped', 5000);
  assert.equal(f.store.getSession(session.id).signal, 'SIGKILL', 'SIGTERM was ignored, so the grace period ended with SIGKILL');
  assert.ok(!isAlive(pid)); void runtime;
});

test('observer files rotate after consumption and report lost observation at the size cap', async t => {
  const { Observers } = await import('../src/runtime/observers.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'obs-')); t.after(() => removeLater(dir));
  const repo = join(dir, 'repo'); mkdirSync(repo);
  writeFileSync(join(dir, 'stale.events.jsonl'), 'old'); mkdirSync(join(dir, 'observers'), { recursive: true }); writeFileSync(join(dir, 'observers', 'old.events.jsonl'), 'x');
  const seen = []; const lost = [];
  const observers = new Observers({ dataDir: dir, hookScript: 'hook.mjs', execPath: 'node', ingest: (id, e) => seen.push(e.n), lost: id => lost.push(id) });
  assert.deepEqual((await import('node:fs')).readdirSync(join(dir, 'observers')), [], 'Files from a previous runtime are swept');
  const settings = observers.settings({ id: 's1' }, { root: repo });
  const token = JSON.parse(readFileSync(settings, 'utf8')).hooks.Stop[0].hooks[0].command.match(/['"]([0-9a-f]{48})['"]/)[1];
  const target = join(dir, 'observers', 's1.events.jsonl');
  const line = n => JSON.stringify({ token, id: 's1', cwd: repo, event: 'Stop', n, pad: 'p'.repeat(900) }) + '\n';
  let text = ''; for (let n = 0; n < 400; n++) text += line(n); writeFileSync(target, text);
  observers.poll(); observers.poll();
  assert.equal(seen.length, 400); assert.ok(!(await import('node:fs')).existsSync(target), 'Consumed events are removed');
  appendFileSync(target, line(400)); observers.poll(); assert.equal(seen.at(-1), 400);
  text = ''; for (let n = 0; n < 1200; n++) text += line(1000 + n); appendFileSync(target, text);
  for (let i = 0; i < 6; i++) observers.poll();
  assert.deepEqual(lost, ['s1']);
});

test('a runtime from another protocol version is reported and never launched over', async t => {
  const f = fixture(t);
  const path = (await import('../src/runtime/protocol.mjs')).socketPath(f.dataDir);
  const old = net.createServer(socket => { socket.setEncoding('utf8'); socket.on('data', () => socket.end(frame({ id: 0, error: 'Protocol mismatch', protocol: 1 }))); });
  await new Promise(r => old.listen(path, r)); t.after(() => old.close());
  writeFileSync(join(f.dataDir, 'runtime.json'), JSON.stringify({ socket: path, token: 't', protocol: 1 }));
  let launches = 0; const warnings = [];
  const c = new RuntimeClient({ dataDir: f.dataDir, launch: () => { launches++; return null; }, connectTimeoutMs: 1000 }); t.after(() => c.close());
  c.on('warning', w => warnings.push(w));
  await assert.rejects(c.connect(), /another version/);
  assert.equal(launches, 0); assert.equal(warnings.length, 1);
});

test('the runtime lock records a real identity and recognizes a live owner', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t); const { acquireLock } = await import('../src/runtime/runtime.mjs');
  const release = await acquireLock(f.dataDir, join(f.dataDir, 'none.sock'));
  const lock = JSON.parse(readFileSync(join(f.dataDir, 'runtime.lock'), 'utf8'));
  assert.equal(lock.identity.started, (await processIdentity(process.pid)).started); release();
  const child = spawnChild(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); t.after(() => child.kill('SIGKILL'));
  let identity; await until(async () => (identity = await processIdentity(child.pid)));
  writeFileSync(join(f.dataDir, 'runtime.lock'), JSON.stringify({ pid: child.pid, identity }));
  await assert.rejects(acquireLock(f.dataDir, join(f.dataDir, 'none.sock')), /already running/);
});

test('the SLOTS_FULL code reaches the client with the unchanged message; hello reports protocol 4', async t => {
  const f = fixture(t); await f.boot(); const c = client(f, t);
  const hello = await c.connect();
  assert.equal(hello.protocol, 4);
  for (let i = 0; i < 4; i++) await c.call('start', { projectId: f.project.id, provider: 'claude', task: `Task ${i}` });
  const error = await c.call('start', { projectId: f.project.id, provider: 'claude', task: 'fifth' }).catch(e => e);
  assert.equal(error.code, 'SLOTS_FULL');
  assert.equal(error.message, 'Journal runs up to 4 sessions at once. Stop one before starting another.');
  const plain = await c.call('nope').catch(e => e);
  assert.equal(plain.message, 'Unknown runtime operation'); assert.equal(plain.code, undefined);
  const listed = await c.call('list');
  assert.deepEqual(listed.map(s => s.slot).sort(), [1, 2, 3, 4]);
});

test('the proposals event names the session and reports zero', async t => {
  const f = fixture(t); const { fake } = await f.boot(); const c = client(f, t); await c.connect();
  const events = []; c.on('event', e => { if (e.type === 'proposals') events.push(e); });
  const plain = (await c.call('start', { projectId: f.project.id, provider: 'claude', task: 'Nothing to keep here' })).session;
  const ruled = (await c.call('start', { projectId: f.project.id, provider: 'claude', task: 'Ship it.\nRule: Release tags must be signed by CI.' })).session;
  fake.procs[0].exit({ exitCode: 0 }); fake.procs[1].exit({ exitCode: 0 });
  await until(() => events.length === 2, 5000);
  const by = id => events.find(e => e.sessionId === id);
  assert.deepEqual(by(plain.id), { type: 'proposals', projectId: f.project.id, sessionId: plain.id, count: 0 });
  assert.deepEqual(by(ruled.id), { type: 'proposals', projectId: f.project.id, sessionId: ruled.id, count: 1 });
});

test('the proposals event says when generating suggestions failed', async t => {
  const f = fixture(t); f.store.generateProposals = () => { throw new Error('disk full'); };
  const { fake } = await f.boot(); const c = client(f, t); await c.connect();
  const events = []; c.on('event', e => { if (e.type === 'proposals') events.push(e); });
  const session = (await c.call('start', { projectId: f.project.id, provider: 'claude', task: 'Ship it.\nRule: Release tags must be signed by CI.' })).session;
  fake.procs[0].exit({ exitCode: 0 });
  await until(() => events.length === 1, 5000);
  assert.deepEqual(events[0], { type: 'proposals', projectId: f.project.id, sessionId: session.id, count: 0, failed: true });
});

// Phase 8: recovery in the hello.
test('the hello reports sessions recovered from a crashed runtime', async t => {
  const f = fixture(t);
  // A live session of a runtime that is gone (no process): recovery marks it interrupted.
  f.store.saveSession({ id: 'crashed', projectId: f.project.id, provider: 'claude', nativeId: '44444444-4444-4444-8444-444444444444', nativeIdConfirmed: true, status: 'running', receiptId: 'r', runtimeId: 'gone', title: 'x', createdAt: new Date().toISOString() });
  const { runtime } = await f.boot(); const c = client(f, t);
  const hello = await c.connect();
  assert.equal(hello.protocol, 4, 'an optional field: no protocol change');
  assert.equal(hello.recovery.runtimeId, runtime.runtimeId); assert.ok(!Number.isNaN(Date.parse(hello.recovery.at)));
  assert.deepEqual(hello.recovery.sessions, [{ id: 'crashed', status: 'interrupted', identityVerified: null }]);
  assert.equal(hello.recovery.total, 1);
  assert.equal(c.info.recovery.sessions[0].status, 'interrupted');
  assert.equal(f.store.getSession('crashed').status, 'interrupted');
});

test('acknowledging recovery clears it for the next client, and a stale at is ignored', async t => {
  const f = fixture(t);
  f.store.saveSession({ id: 'crashed', projectId: f.project.id, provider: 'codex', status: 'running', receiptId: 'r', runtimeId: 'gone', title: 'x', createdAt: new Date().toISOString() });
  await f.boot();
  const first = client(f, t); const { recovery } = await first.connect();
  assert.equal(recovery.sessions.length, 1);
  assert.deepEqual(await first.call('acknowledgeRecovery', { at: '2000-01-01T00:00:00.000Z' }), { cleared: false });
  assert.deepEqual(await first.call('acknowledgeRecovery', {}), { cleared: false });
  // A later client (a restarted app) still sees it.
  await first.close(); const second = client(f, t);
  assert.deepEqual((await second.connect()).recovery, recovery);
  assert.deepEqual(await second.call('acknowledgeRecovery', { at: recovery.at }), { cleared: true });
  await second.close(); const third = client(f, t);
  assert.equal((await third.connect()).recovery, null);
  assert.deepEqual(await third.call('acknowledgeRecovery', { at: recovery.at }), { cleared: false });
});

test('a clean start has no recovery', async t => {
  const f = fixture(t); await f.boot(); const c = client(f, t);
  assert.equal((await c.connect()).recovery, null);
});

test('after a runtime crash, the next hello carries the interrupted session until acknowledged', async t => {
  const f = fixture(t); const first = await f.boot(); const c = client(f, t); await c.connect();
  const { session } = await c.call('start', { projectId: f.project.id, provider: 'claude', task: 'Do not resend me' });
  // Simulated crash, as in the crash test above: no shutdown bookkeeping.
  c.close(); first.runtime.manager.disposed = true; await Promise.race([new Promise(resolve => first.runtime.server.close(resolve)), wait(2000)]); await wait(50);
  const second = await f.boot(); const next = client(f, t);
  const hello = await next.connect();
  assert.equal(hello.runtimeId, second.runtime.runtimeId);
  assert.deepEqual(hello.recovery.sessions, [{ id: session.id, status: 'interrupted', identityVerified: null }]);
  assert.equal(second.fake.procs.length, 0, 'nothing was started or resent');
  await next.call('acknowledgeRecovery', { at: hello.recovery.at });
  await next.close(); const later = client(f, t);
  assert.equal((await later.connect()).recovery, null);
});
