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
import { StoreClient } from '../src/desktop/store-client.mjs';
import { frame, PROTOCOL } from '../src/runtime/protocol.mjs';
import { processIdentity, isAlive } from '../src/core/process.mjs';
import { removeLater } from './support/cleanup.mjs';
import { fileURLToPath } from 'node:url';
import { ToolClient } from '../src/agent-tools/client.mjs';
import { fixtureEnv } from './support/env.ts';

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
    const runtime = await startRuntime({ dataDir, store, spawn: fake.spawn, hookScript: '/dev/null', identify: () => null, table: () => null, observerMs: 20, idleMs: 3_600_000, capacitySample: async () => ({ availableBytes: 16e9, totalBytes: 24e9, freeDiskBytes: 20e9, pressure: 'normal', load: 0, cores: 8 }), ...extra });
    runtimes.push(runtime); return { runtime, fake };
  };
  t.after(async () => { for (const r of runtimes) { r.server.close(); r.manager.disposed = true; clearInterval(r.manager.tracker); } store.close(); removeLater(root); });
  return { root, repo, dataDir, store, project, boot };
}

function client(f, t, launch = () => {}) {
  const c = new RuntimeClient({ dataDir: f.dataDir, launch, connectTimeoutMs: 2000 });
  t.after(() => c.close()); return c;
}

test('runtime-only coordinator tools launch a worker and tool connections never replace the desktop', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t); const { runtime, fake } = await f.boot();
  const desktop = client(f, t); await desktop.connect();
  const input = { callerId: 'desktop', requestId: 'run-fixture', projectId: f.project.id, logicalBranch: 'main', goal: 'Implement a fixture', provider: 'claude', journalToolsAllowed: true };
  const run = await runtime.workers.startRun(input);
  const env = fake.procs[0].options.env;
  assert.ok(env.JOURNAL_TOOL_TOKEN); assert.ok(!fake.procs[0].argv.join(' ').includes(env.JOURNAL_TOOL_TOKEN));
  const tool = new ToolClient({ socket: runtime.path, credentialId: env.JOURNAL_TOOL_ID, token: env.JOURNAL_TOOL_TOKEN }); t.after(() => tool.close());
  await tool.connect(); assert.equal((await desktop.call('ping')).runtimeId, runtime.runtimeId);
  const task = await tool.call('create_task', { requestId: 'task', title: 'Fixture worker' });
  const attempt = await tool.call('create_worker', { requestId: 'worker', taskId: task.id, provider: 'claude', model: 'fixture-model', attachments: [{ path: 'README.md' }] });
  await until(() => f.store.listAttempts(run.id).find(item => item.id === attempt.id)?.presence === 'live', 10000);
  assert.equal(fake.procs.length, 2); assert.equal(runtime.manager.liveEntries().length, 2);
  const workerEnv = fake.procs[1].options.env;
  assert.equal(workerEnv.JOURNAL_TASK_ID, task.id); assert.equal(workerEnv.JOURNAL_RUN_ID, run.id);
  assert.ok(fake.procs[1].argv.includes('fixture-model'));
  const workerSession = f.store.getSession(f.store.listAttempts(run.id)[0].currentSessionId);
  assert.match(f.store.getReceipt(workerSession.receiptId).packet, /README.md/);
  assert.deepEqual(JSON.parse(readFileSync(join(f.dataDir, 'observers', `${workerSession.id}.settings.json`), 'utf8')).permissions, { allow: ['mcp__journal__*'] });
  const worker = new ToolClient({ socket: runtime.path, credentialId: workerEnv.JOURNAL_TOOL_ID, token: workerEnv.JOURNAL_TOOL_TOKEN }); t.after(() => worker.close());
  await assert.rejects(worker.call('create_worker', { requestId: 'denied', taskId: task.id, provider: 'claude' }), { code: 'FORBIDDEN' });
  assert.equal((await desktop.call('ping')).runtimeId, runtime.runtimeId);
  const grant = runtime.continuation.issue({ sessionId: run.coordinatorSessionId, launchId: runtime.manager.entry(run.coordinatorSessionId).launchId, runId: run.id, role: 'coordinator' });
  const hook = new ToolClient({ role: 'hook', socket: runtime.path, credentialId: grant.id, token: grant.token }); t.after(() => hook.close());
  await hook.connect();
  assert.deepEqual(await hook.request('continue', { event: 'PermissionRequest', invocationId: 'fake' }), {});
  await assert.rejects(hook.request('toolCall', { tool: 'create_task', args: { requestId: 'forbidden', title: 'No' } }), { code: 'FORBIDDEN' });
  assert.equal((await desktop.call('ping')).runtimeId, runtime.runtimeId); hook.close();
  tool.close(); worker.close(); await runtime.capacity.close();
});

test('an isolated session captures its result in the runtime without a desktop connection', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  const env = await f.store.createEnvironment({ projectId: f.project.id, logicalBranch: 'main' });
  const workerStore = new StoreClient(join(f.dataDir, 'journal.sqlite')); await workerStore.ready;
  t.after(() => workerStore.close());
  const { runtime, fake } = await f.boot(undefined, { store: workerStore });
  const started = await runtime.manager.start({ projectId: f.project.id, workspaceId: env.id, provider: 'claude', task: 'fixture worker' });
  await until(() => f.store.getEnvironment(env.id).state === 'running');
  writeFileSync(join(env.details.path, 'README.md'), 'runtime-owned result\n');
  fake.procs[0].exit({ exitCode: 0 });
  await until(() => f.store.getEnvironment(env.id).state === 'completed');
  const result = f.store.getEnvironment(env.id).result;
  assert.ok(result.resultId);
  assert.equal(f.store.getEnvironment(env.id).sessionId, started.session.id);
  assert.equal(f.store.listEnvironmentResults(env.id).length, 1);
});

test('the runtime refuses clients that cannot prove the token, and never receives it', async t => {
  const f = fixture(t); const { runtime } = await f.boot();
  const exchange = messages => new Promise(resolvePromise => {
    const socket = net.connect(runtime.path); socket.setEncoding('utf8'); let text = '';
    socket.on('data', d => { text += d; if (text.includes('\n') && messages.length) socket.write(frame(messages.shift())); }); socket.on('close', () => resolvePromise(text));
    socket.on('connect', () => socket.write(frame({ id: 1, method: 'hello', params: { protocol: PROTOCOL, nonce: 'n'.repeat(48) } })));
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
  // The hook command is the same for every launch; the target and token travel in the agent's environment.
  const { env } = observer.proc.options;
  assert.equal(env.JOURNAL_HOOK_TARGET, target); assert.equal(env.JOURNAL_SESSION_ID, session.id); assert.match(env.JOURNAL_HOOK_TOKEN, /^[0-9a-f]{48}$/);
  const token = env.JOURNAL_HOOK_TOKEN;
  for (const event of Object.keys(settings.hooks)) assert.ok(!settings.hooks[event][0].hooks[0].command.includes(token), event);
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
  const token = observers.prepare({ id: 's1', provider: 'claude' }, { root: repo }).env.JOURNAL_HOOK_TOKEN;
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

test('the SLOTS_FULL code reaches the client with the unchanged message; hello reports the current protocol', async t => {
  const f = fixture(t); await f.boot(); const c = client(f, t);
  const hello = await c.connect();
  assert.equal(hello.protocol, PROTOCOL);
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
  assert.equal(hello.protocol, PROTOCOL);
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

// Hooks plan 4.7 and shutdown: final hook events that land after the process exited are read.
// A fixture CLI (never a provider) runs Journal's installed launcher through `sh -c` with a
// payload, about one second late (longer than the old 500 ms release, inside the drain grace).
// Claude registers through --settings; a Codex-style launch, whose ID only a hook can report,
// uses a fixture registration (Codex's own registration is Phase 2) with Codex's normalization.
const CODEX_ID = '01a0f661-908b-7193-8520-6ac6f3b44aeb';
function fixtureCli(root, { when, event, delay = 1 }) {
  const script = join(root, `fixture-${when}.cjs`);
  writeFileSync(script, `const { spawn } = require('node:child_process'); const fs = require('node:fs');
const a = process.argv; const claude = a.includes('--settings');
const command = claude ? JSON.parse(fs.readFileSync(a[a.indexOf('--settings') + 1], 'utf8')).hooks.Stop[0].hooks[0].command
  : JSON.parse(fs.readFileSync(process.env.JOURNAL_HOOK_TARGET.replace(/\\.events\\.jsonl$/, '.fixture.json'), 'utf8')).command;
const id = claude ? a[a.indexOf(a.includes('--resume') ? '--resume' : '--session-id') + 1] : ${JSON.stringify(CODEX_ID)};
const fire = done => { const hook = spawn('/bin/sh', ['-c', 'sleep ${delay}; ' + command], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] }); hook.unref();
  hook.stdin.end(JSON.stringify({ hook_event_name: claude ? 'Stop' : ${JSON.stringify(event)}, session_id: id, turn_id: 'turn-1', cwd: process.cwd(), prompt: 'PROMPT_TEXT', user_email: 'person@example.test' }), done); };
${when === 'exit' ? 'fire(() => process.exit(0));' : when === 'sigterm' ? "process.on('SIGTERM', () => fire(() => process.exit(0))); setInterval(() => {}, 1000);" : 'fire(() => {}); setInterval(() => {}, 1000);'}\n`);
  return script;
}
function cliSpawner(script) {
  const procs = [];
  const spawn = (executable, argv, options) => {
    const child = spawnChild(process.execPath, [script, ...argv], { cwd: options.cwd, env: options.env, stdio: 'ignore' });
    const proc = { pid: child.pid, child, argv, options, onData() {}, onExit(fn) { child.on('exit', (code, signal) => fn({ exitCode: code, signal })); }, write() {}, resize() {}, kill(signal) { try { child.kill(signal); } catch {} } };
    procs.push(proc); return proc;
  };
  return { spawn, procs };
}
async function hookRuntime(t, f, when, { event = 'SessionEnd', ...extra } = {}) {
  const { ADAPTERS } = await import('../src/runtime/adapters/index.mjs');
  const codex = { ...ADAPTERS.codex, register: ({ dir, session, command }) => { const file = join(dir, `${session.id}.fixture.json`); writeFileSync(file, JSON.stringify({ command })); return { settingsFile: null, files: [file] }; } };
  const fake = cliSpawner(fixtureCli(f.root, { when, event }));
  t.after(() => { for (const p of fake.procs) try { p.child.kill('SIGKILL'); } catch {} });
  const hookScript = fileURLToPath(new URL('../src/desktop/hook.mjs', import.meta.url));
  const { runtime } = await f.boot(fake, { hookScript, execPath: process.execPath, observerMs: 60_000, drainGraceMs: 2500, launcherTimeoutSeconds: 2, adapters: { ...ADAPTERS, codex }, ...extra });
  return { runtime, procs: fake.procs };
}

test('the observer drains a late final event after exit: Claude\'s ID is observed, the session stays ended, later lines are rejected', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t); const { runtime, procs } = await hookRuntime(t, f, 'exit');
  const c = client(f, t); await c.connect();
  const { session } = await c.call('start', { projectId: f.project.id, provider: 'claude', task: 'final event' });
  assert.equal(session.nativeIdSource, 'preassigned');
  const { env } = procs[0].options;
  assert.ok(env.JOURNAL_HOOK_TARGET && env.JOURNAL_HOOK_TOKEN, 'The launch carries its observer in the environment');
  await until(() => f.store.getSession(session.id).status === 'exited', 5000);
  // Read about a second after the exit: the hook's ID is seen; the Stop changes no state.
  await until(() => f.store.getSession(session.id).nativeIdSource === 'preassigned-observed', 5000);
  await until(() => !runtime.observers.sessions.has(session.id), 5000);
  const ended = f.store.getSession(session.id);
  assert.deepEqual([ended.status, ended.activity, ended.nativeId, ended.nativeIdConfirmed], ['exited', null, session.nativeId, true]);
  assert.ok(!f.store.listEvents(session.id).some(e => e.kind === 'turn-end'), 'A drained turn end never reopens or changes the session');
  assert.ok(!JSON.stringify(f.store.listEvents(session.id)).includes('PROMPT_TEXT'));
  // After the drain the observer is closed: this launch's late line is never read and its file goes.
  const late = { token: env.JOURNAL_HOOK_TOKEN, id: session.id, provider: 'claude', nativeId: session.nativeId, event: 'UserPromptSubmit', cwd: f.repo, at: Date.now() };
  appendFileSync(env.JOURNAL_HOOK_TARGET, `${JSON.stringify(late)}\n`); runtime.observers.poll();
  assert.equal((await import('node:fs')).existsSync(env.JOURNAL_HOOK_TARGET), false);
  assert.equal(f.store.getSession(session.id).status, 'exited');
  // Exact-ID resume is offered and used: a new launch, a new token; the old launch's lines are rejected there.
  const resumed = (await c.call('start', { projectId: f.project.id, provider: 'claude', resumeId: session.id })).session;
  assert.deepEqual(procs[1].argv.slice(0, 2), ['--resume', session.nativeId]);
  const next = procs[1].options.env; assert.notEqual(next.JOURNAL_HOOK_TOKEN, env.JOURNAL_HOOK_TOKEN);
  appendFileSync(next.JOURNAL_HOOK_TARGET, `${JSON.stringify({ ...late, id: resumed.id })}\n`); runtime.observers.poll();
  assert.ok(!f.store.listEvents(resumed.id).some(e => e.kind === 'prompt'), 'Another launch\'s token is rejected');
  await until(() => f.store.getSession(resumed.id).status === 'exited', 5000);
});

test('a native ID first reported by a drained SessionEnd is bound, confirmed and offered for exact resume', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t); const { runtime, procs } = await hookRuntime(t, f, 'exit');
  const c = client(f, t); await c.connect();
  const { session } = await c.call('start', { projectId: f.project.id, provider: 'codex', task: 'codex final event' });
  assert.deepEqual([session.nativeId, session.observation], [null, 'pending']);
  await until(() => f.store.getSession(session.id).status === 'exited', 5000);
  assert.equal(f.store.getSession(session.id).nativeId ?? null, null, 'Not known at the exit');
  await until(() => !runtime.observers.sessions.has(session.id), 6000);
  const ended = f.store.getSession(session.id);
  assert.deepEqual([ended.status, ended.nativeId, ended.nativeIdConfirmed, ended.nativeIdSource, ended.lastObserved?.fact], ['exited', CODEX_ID, true, 'hook', 'session-end']);
  await c.call('start', { projectId: f.project.id, provider: 'codex', resumeId: session.id });
  assert.deepEqual(procs[1].argv.slice(0, 2), ['resume', CODEX_ID]);
});

test('quit with "stop": shutdown drains final events before closing; the session stays stopped with its ID', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t); let exited = 0;
  const { runtime } = await hookRuntime(t, f, 'sigterm', { exit: () => { exited = Date.now(); } });
  const c = client(f, t); await c.connect();
  const { session } = await c.call('start', { projectId: f.project.id, provider: 'codex', task: 'stopped by quit' });
  await wait(300); // the fixture installs its SIGTERM handler
  const started = Date.now();
  await c.call('shutdown', { stopSessions: true });
  // While it drains, a relaunched app is told the runtime is closing and waits: it never launches over it.
  let launched = 0; const probe = new RuntimeClient({ dataDir: f.dataDir, launch: () => { launched++; return null; }, connectTimeoutMs: 400 }); t.after(() => probe.close());
  assert.deepEqual(await probe.attempt(), { closing: true });
  await assert.rejects(probe.connect(), /Could not start/); assert.equal(launched, 0);
  await until(() => exited, 15_000);
  assert.ok(exited - started < 5000 + 2500 + 1500, `Bounded: ${exited - started} ms`);
  assert.equal(runtime.observers.sessions.size, 0, 'Every observer closed');
  const { JournalStore } = await import('../src/core/store.mjs');
  const store = new JournalStore(join(f.dataDir, 'journal.sqlite')); t.after(() => store.close());
  const stopped = store.getSession(session.id);
  assert.deepEqual([stopped.status, stopped.nativeId, stopped.nativeIdConfirmed, stopped.nativeIdSource], ['stopped', CODEX_ID, true, 'hook']);
});

test('quit with "keep running": the desktop disconnects and observation goes on in the runtime', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t); const { runtime } = await hookRuntime(t, f, 'later', { event: 'UserPromptSubmit', observerMs: 50 });
  const c = client(f, t); await c.connect();
  const { session } = await c.call('start', { projectId: f.project.id, provider: 'codex', task: 'keeps running' });
  // The app quits without stopping its sessions: it only closes its connection (main.mjs, policy keep).
  await c.close({ shutdown: false });
  await until(() => f.store.getSession(session.id).observation === 'live', 6000);
  const live = f.store.getSession(session.id);
  assert.deepEqual([live.status, live.activity, live.nativeId], ['running', 'working', CODEX_ID]);
  assert.ok(runtime.observers.sessions.has(session.id), 'Its observer stays open');
});

// Phase 2: Codex's own registration end to end. A fixture `codex` reads Journal's `-c hooks.*`
// overrides from its argv (as Codex would), runs each event's command through the shell with a
// Codex-shaped payload, then exits. Fixture CLI only; native behaviour is in docs/NATIVE-VALIDATION.md.
function codexFixture(root) {
  const script = join(root, 'fixture-codex.cjs');
  writeFileSync(script, `const { spawnSync } = require('node:child_process');
const a = process.argv.slice(2); const hooks = {};
for (let i = 0; i < a.length - 1; i++) if (a[i] === '-c') { const m = /^hooks\\.([A-Za-z]+)=\\[\\{hooks=\\[\\{type="command",command=("(?:[^"\\\\\\\\]|\\\\\\\\.)*"),timeout=(\\d+)\\}\\]\\}\\]$/.exec(a[i + 1]); if (m) hooks[m[1]] = JSON.parse(m[2]); }
require('node:fs').writeFileSync(${JSON.stringify(join(root, 'codex-hooks.json'))}, JSON.stringify(Object.keys(hooks)));
const id = ${JSON.stringify(CODEX_ID)}; const cwd = process.cwd();
const fire = (event, extra = {}) => { if (hooks[event]) spawnSync('/bin/sh', ['-c', hooks[event]], { input: JSON.stringify({ hook_event_name: event, session_id: id, cwd, model: 'm', ...extra }), stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000 }); };
const steps = [
  ['SessionStart', { source: 'startup' }],
  ['UserPromptSubmit', { turn_id: 't1', prompt: 'PROMPT_TEXT' }],
  ['PermissionRequest', { turn_id: 't1', tool_name: 'Bash', tool_input: { command: 'rm x', description: 'remove' } }],
  ['PostToolUse', { turn_id: 't1', tool_name: 'Bash', tool_use_id: 'u1', tool_input: { command: 'rm x' }, tool_response: { exit_code: 0, output: 'TOOL_OUTPUT' } }],
  ['SubagentStart', { turn_id: 't1', agent_id: 'child-1', agent_type: 'worker' }],
  ['SubagentStop', { turn_id: 't1', agent_id: 'child-1', agent_type: 'worker' }],
  ['Stop', { turn_id: 't1', last_assistant_message: 'ASSISTANT_TEXT' }],
  ['UserPromptSubmit', { turn_id: 't2', prompt: 'PROMPT_TEXT' }],
  ['Interrupt', { turn_id: 't2' }],
  ['Stop', { turn_id: 't1' }],
  ['SessionEnd', { reason: 'other' }],
];
for (const [event, extra] of steps) fire(event, extra);
setTimeout(() => process.exit(0), 200);\n`);
  return script;
}

test('Codex registers Journal\'s hooks per launch and its events drive the session: identity, permission, turns, children, interrupt', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t); const fake = cliSpawner(codexFixture(f.root));
  t.after(() => { for (const p of fake.procs) try { p.child.kill('SIGKILL'); } catch {} });
  const hookScript = fileURLToPath(new URL('../src/desktop/hook.mjs', import.meta.url));
  const { runtime } = await f.boot(fake, { hookScript, execPath: process.execPath, observerMs: 50, launcherTimeoutSeconds: 2 });
  const c = client(f, t); await c.connect();
  const { session } = await c.call('start', { projectId: f.project.id, provider: 'codex', task: 'observe me', cliVersion: 'codex-cli 0.159.3' });
  assert.deepEqual([session.nativeId, session.observation], [null, 'pending']);
  const argv = fake.procs[0].argv; const values = argv.filter((_, i) => argv[i - 1] === '-c');
  assert.equal(values.length, 9, 'Every 0.159.3 hook event is registered');
  assert.ok(!argv.some(arg => /dangerously|notify|trusted_hash/.test(arg)));
  await until(() => f.store.getSession(session.id).status === 'exited', 8000);
  await until(() => !runtime.observers.sessions.has(session.id), 8000);
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'codex-hooks.json'), 'utf8')).sort(), ['Interrupt', 'PermissionRequest', 'PostToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit']);
  const ended = f.store.getSession(session.id);
  assert.deepEqual([ended.nativeId, ended.nativeIdConfirmed, ended.nativeIdSource, ended.identityMismatch ?? false], [CODEX_ID, true, 'hook', false], 'Bound from the first parent event; the child never rebinds it');
  const events = f.store.listEvents(session.id);
  assert.ok(events.some(e => e.kind === 'permission'), 'The approval wait was observed');
  const ends = events.filter(e => e.kind === 'turn-end').map(e => typeof e.body === 'string' ? JSON.parse(e.body) : e.body);
  assert.deepEqual(ends.filter(b => !b.late).map(b => [b.turn, b.outcome]), [['t1', 'completed'], ['t2', 'interrupted']], 'One outcome per turn; the late Stop(t1) never finishes t2');
  const text = JSON.stringify(events);
  for (const secret of ['PROMPT_TEXT', 'ASSISTANT_TEXT', 'TOOL_OUTPUT']) assert.ok(!text.includes(secret), secret);
  // Exact resume registers the same hooks again, with the bound ID.
  await c.call('start', { projectId: f.project.id, provider: 'codex', resumeId: session.id, cliVersion: 'codex-cli 0.159.3' });
  const resumeArgv = fake.procs[1].argv;
  assert.deepEqual(resumeArgv.slice(0, 2), ['resume', CODEX_ID]);
  assert.deepEqual(resumeArgv.filter((_, i) => resumeArgv[i - 1] === '-c'), values, 'Identical definitions: trusted once, trusted again');
});

test('Codex without hook support, or with hooks turned off, launches exactly as before and stays unobserved', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t); const fake = cliSpawner(codexFixture(f.root));
  t.after(() => { for (const p of fake.procs) try { p.child.kill('SIGKILL'); } catch {} });
  const hookScript = fileURLToPath(new URL('../src/desktop/hook.mjs', import.meta.url));
  await f.boot(fake, { hookScript, execPath: process.execPath, observerMs: 50, launcherTimeoutSeconds: 2 });
  const c = client(f, t); await c.connect();
  for (const [i, extra] of [{ cliVersion: 'codex-cli 0.120.0' }, { cliVersion: 'codex-cli 0.159.3', hooksEnabled: false }, {}].entries()) {
    const { session } = await c.call('start', { projectId: f.project.id, provider: 'codex', task: `plain ${i}`, ...extra });
    assert.equal(session.observation, 'unobserved', JSON.stringify(extra));
    assert.ok(!fake.procs[i].argv.includes('-c'), 'No overrides: Codex keeps its shared background server');
    assert.equal(fake.procs[i].options.env.JOURNAL_HOOK_TARGET, undefined);
    await until(() => f.store.getSession(session.id).status === 'exited', 8000);
  }
});

// Phase 3: Cursor's plugin (level 1) and Journal's entries in a fixture home's hooks.json (level 2).
// The fixture `agent` reads --plugin-dir's hooks/hooks.json and the home's .cursor/hooks.json and runs
// each matching command, as the CLI would. Fixture CLI and fixture home only.
const CURSOR_ID = '5b1f0d3e-8c4a-4e2b-9f6a-1c2d3e4f5a6b';
function cursorFixture(root, home) {
  const script = join(root, 'fixture-agent.cjs');
  writeFileSync(script, `const { spawnSync } = require('node:child_process'); const fs = require('node:fs'); const path = require('node:path');
const a = process.argv.slice(2); const commands = {};
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const plugin = a.includes('--plugin-dir') ? read(path.join(a[a.indexOf('--plugin-dir') + 1], 'hooks', 'hooks.json')) : null;
const user = read(${JSON.stringify(join(home, '.cursor', 'hooks.json'))});
for (const config of [plugin, user]) if (config && config.version === 1) for (const [event, list] of Object.entries(config.hooks || {})) for (const entry of list) (commands[event] ||= []).push(entry.command);
// Cursor gates its turn events on the user's (or project's) own file.
const gated = ['stop', 'afterAgentResponse', 'beforeSubmitPrompt'];
fs.writeFileSync(${JSON.stringify(join(root, 'cursor-hooks.json'))}, JSON.stringify(Object.keys(commands)));
const id = ${JSON.stringify(CURSOR_ID)}; const cwd = process.cwd();
const fire = (event, extra = {}) => { if (gated.includes(event) && !(user && user.hooks && user.hooks[event])) return;
  for (const command of commands[event] || []) spawnSync('/bin/sh', ['-c', command], { input: JSON.stringify({ hook_event_name: event, conversation_id: id, session_id: id, workspace_roots: [cwd], user_email: 'person@example.test', ...extra }), stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000 }); };
fire('sessionStart', { generation_id: id });
fire('afterShellExecution', { generation_id: 'g1', command: 'echo hi', output: 'TOOL_OUTPUT', duration: 12 });
fire('stop', { generation_id: 'g1', status: 'completed' });
fire('postToolUse', { generation_id: 'g2', tool_name: 'Shell', tool_input: { command: 'ls' } });
fire('stop', { generation_id: 'g2', status: 'aborted' });
fire('stop', { generation_id: 'g2', status: 'error' });
fire('stop', { generation_id: 'g1', status: 'completed' });
fire('sessionEnd', { generation_id: id, reason: 'completed', final_status: 'completed' });
setTimeout(() => process.exit(0), 200);\n`);
  return script;
}
async function cursorRuntime(t, f, home) {
  const fake = cliSpawner(cursorFixture(f.root, home));
  t.after(() => { for (const p of fake.procs) try { p.child.kill('SIGKILL'); } catch {} });
  const hookScript = fileURLToPath(new URL('../src/desktop/hook.mjs', import.meta.url));
  const cursor = { find: async () => ({ path: '/fixture/agent', cursor: true, version: '2026.10.01-e373342', supports: { resume: true, createChat: true, mode: true, login: true, pluginDir: true } }), createChat: async () => CURSOR_ID };
  const { runtime } = await f.boot(fake, { hookScript, execPath: process.execPath, observerMs: 50, launcherTimeoutSeconds: 2, home, cursor });
  return { runtime, fake };
}
const turnEnds = (f, id) => f.store.listEvents(id).filter(e => e.kind === 'turn-end').map(e => typeof e.body === 'string' ? JSON.parse(e.body) : e.body).filter(b => !b.late).map(b => [b.turn, b.outcome]);

test('Cursor level 1: the plugin reports tool activity and the end, never a turn end; nothing is written to the home', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t); const home = join(f.root, 'home'); mkdirSync(home);
  const { runtime, fake } = await cursorRuntime(t, f, home);
  const c = client(f, t); await c.connect();
  const { session } = await c.call('start', { projectId: f.project.id, provider: 'cursor', task: 'level one' });
  assert.deepEqual(session.observes, { turns: false, approvals: false });
  const argv = fake.procs[0].argv; assert.equal(argv[argv.indexOf('--plugin-dir') + 1], join(f.dataDir, 'hooks', 'cursor-plugin'));
  await until(() => f.store.getSession(session.id).status === 'exited', 8000);
  await until(() => !runtime.observers.sessions.has(session.id), 8000);
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'cursor-hooks.json'), 'utf8')).sort(), ['afterFileEdit', 'afterMCPExecution', 'afterShellExecution', 'postToolUse', 'postToolUseFailure', 'sessionEnd', 'sessionStart', 'subagentStop']);
  const ended = f.store.getSession(session.id);
  assert.deepEqual([ended.nativeId, ended.identityMismatch ?? false], [CURSOR_ID, false]);
  assert.deepEqual(turnEnds(f, session.id), [], 'No stop fires without the user\'s own entries');
  assert.equal((await import('node:fs')).existsSync(join(home, '.cursor')), false, 'Level 1 never writes the user\'s files');
  const text = JSON.stringify(f.store.listEvents(session.id));
  for (const secret of ['person@example.test', 'TOOL_OUTPUT']) assert.ok(!text.includes(secret), secret);
});

test('Cursor level 2: with Journal\'s reviewed entries, turns end, and an aborted+error pair is one interruption', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t); const home = join(f.root, 'home'); mkdirSync(home);
  const { runtime } = await cursorRuntime(t, f, home);
  const { planCursorInstall, applyCursorPlan } = await import('../src/core/cursor-hooks.mjs');
  const launcher = runtime.observers.launcher;
  const plan = planCursorInstall(home, runtime.observers.command('cursor'), launcher);
  assert.deepEqual(applyCursorPlan(home, plan), { applied: true });
  const c = client(f, t); await c.connect();
  const { session } = await c.call('start', { projectId: f.project.id, provider: 'cursor', task: 'level two' });
  assert.deepEqual(session.observes, { turns: true, approvals: false });
  await until(() => f.store.getSession(session.id).status === 'exited', 8000);
  await until(() => !runtime.observers.sessions.has(session.id), 8000);
  assert.deepEqual(turnEnds(f, session.id), [['g1', 'completed'], ['g2', 'interrupted']], 'One outcome per generation; the late stop for g1 changes nothing');
});


test('MCP stdio restart preserves mutation identity and never evicts the desktop connection', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t); const { runtime, fake } = await f.boot();
  const desktop = client(f, t); await desktop.connect();
  const run = await runtime.workers.startRun({ callerId: 'desktop', requestId: 'mcp-run', projectId: f.project.id, logicalBranch: 'main', goal: 'MCP restart fixture', provider: 'claude' });
  const launchEnv = fake.procs[0].options.env;
  const env = fixtureEnv({ root: f.root, bin: join(f.root, 'bin'), extra: { JOURNAL_TOOL_SOCKET: runtime.path, JOURNAL_TOOL_ID: launchEnv.JOURNAL_TOOL_ID, JOURNAL_TOOL_TOKEN: launchEnv.JOURNAL_TOOL_TOKEN } });
  const startServer = async () => {
    const child = spawnChild(process.execPath, [resolve('src/agent-tools/server.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const pending = new Map(); let sequence = 0, buffer = '', diagnostic = '';
    child.stderr.on('data', data => { diagnostic = (diagnostic + data).slice(-2000); });
    child.stdout.on('data', data => {
      buffer += data;
      while (buffer.includes('\n')) {
        const newline = buffer.indexOf('\n'); const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        const waiter = pending.get(message.id); if (!waiter) continue;
        pending.delete(message.id); clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
      }
    });
    const closed = new Promise(resolve => child.once('close', resolve));
    child.on('close', () => { for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(`MCP closed: ${diagnostic}`)); } pending.clear(); });
    const stop = async () => { child.kill('SIGTERM'); await closed; };
    t.after(stop);
    const rpc = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}; ${diagnostic}`)); }, 5000);
      pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    const initialized = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
    assert.equal(initialized.serverInfo.name, 'journal');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return { rpc, stop };
  };
  const first = await startServer();
  const tools = await first.rpc('tools/list'); assert.ok(tools.tools.some(tool => tool.name === 'create_task'));
  const args = { requestId: 'restart-request', title: 'Exactly one durable task' };
  const created = await first.rpc('tools/call', { name: 'create_task', arguments: args });
  assert.ok(!created.isError); const task = JSON.parse(created.content[0].text);
  await first.stop();
  const second = await startServer();
  const repeated = await second.rpc('tools/call', { name: 'create_task', arguments: args });
  assert.deepEqual(JSON.parse(repeated.content[0].text), task);
  const changed = await second.rpc('tools/call', { name: 'create_task', arguments: { ...args, title: 'Changed arguments' } });
  assert.equal(changed.isError, true); assert.equal(JSON.parse(changed.content[0].text).code, 'REQUEST_MISMATCH');
  assert.equal(f.store.getRun(run.id).tasks.length, 1);
  assert.equal((await desktop.call('ping')).runtimeId, runtime.runtimeId);
  await second.stop(); await runtime.capacity.close();
});

test('Claude observed turns flow through MCP reports into stopped result acceptance', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t); const { runtime, fake } = await f.boot();
  const run = await runtime.workers.startRun({ callerId: 'desktop', requestId: 'turn-run', projectId: f.project.id, logicalBranch: 'main', goal: 'Document the fixture', provider: 'claude' });
  const task = f.store.createTask({ callerId: 'desktop', requestId: 'turn-task', runId: run.id, title: 'Write report' });
  const attempt = f.store.requestWorker({ callerId: 'desktop', requestId: 'turn-worker', taskId: task.id, provider: 'claude' });
  await runtime.workers.reevaluate();
  await until(() => f.store.listAttempts(run.id)[0]?.presence === 'live', 10000);
  const session = f.store.getSession(f.store.listAttempts(run.id)[0].currentSessionId);
  const env = fake.procs[1].options.env;
  const worker = new ToolClient({ socket: runtime.path, credentialId: env.JOURNAL_TOOL_ID, token: env.JOURNAL_TOOL_TOKEN });
  t.after(() => worker.close());
  const prompt = () => runtime.manager.ingest(session.id, { event: 'UserPromptSubmit', nativeId: session.nativeId });
  prompt();
  const first = await worker.call('get_context');
  assert.equal(typeof first.turnId, 'string');
  assert.equal(first.attempt.turnId, first.turnId);
  runtime.manager.ingest(session.id, { event: 'UserPromptSubmit' });
  const unobserved = await worker.call('get_context');
  assert.equal(unobserved.turnId, null);
  assert.equal(unobserved.attempt.turnId, null);
  await assert.rejects(worker.call('report_result', { requestId: 'invalid-identity', turnId: first.turnId, status: 'done', summary: 'Unbound report' }), { code: 'STALE_TURN' });
  prompt();
  const rebound = await worker.call('get_context');
  first.turnId = rebound.turnId;
  await worker.call('report_result', { requestId: 'first-report', turnId: first.turnId, status: 'partial', summary: 'First draft' });
  prompt();
  const second = await worker.call('get_context');
  assert.notEqual(second.turnId, first.turnId);
  await assert.rejects(worker.call('report_result', { requestId: 'stale-report', turnId: first.turnId, status: 'done', summary: 'Old draft' }), { code: 'STALE_TURN' });
  writeFileSync(join(session.cwd, 'README.md'), 'Completed report\n');
  await worker.call('report_result', { requestId: 'final-report', turnId: second.turnId, status: 'done', summary: 'Completed documentation' });
  runtime.manager.ingest(session.id, { event: 'Stop', nativeId: session.nativeId });
  await runtime.workers.pending;
  assert.equal(runtime.manager.qualifyBoundary(session.id, 'capture').eligible, false, 'a local turn ID does not enable unqualified live capture');
  await runtime.workers.stop({ callerId: 'desktop', requestId: 'stop', runId: run.id, attemptId: attempt.id });
  await until(() => f.store.getRun(run.id).results.length === 1);
  await runtime.workers.pending;
  const captured = f.store.getRun(run.id);
  const result = captured.results[0];
  assert.equal(result.claim.summary, 'Completed documentation');
  assert.equal(result.turnId, second.turnId);
  assert.equal(captured.attempts[0].presence, 'paused');
  const preview = f.store.previewResult({ attemptId: attempt.id, resultId: result.id });
  assert.deepEqual(preview.hardGates.failures, ['RESULT_NOT_ACCEPTED']);
  f.store.acceptResult({ callerId: 'desktop', requestId: 'accept', attemptId: attempt.id, resultId: result.id, reason: 'Reviewed stopped result' });
  assert.equal(f.store.previewResult({ attemptId: attempt.id, resultId: result.id }).hardGates.pass, true);
  assert.equal(readFileSync(join(f.repo, 'README.md'), 'utf8'), 'Fixture\n', 'acceptance alone never applies');
  await runtime.capacity.close();
});
