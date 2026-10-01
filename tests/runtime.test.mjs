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
  t.after(async () => { for (const r of runtimes) { r.server.close(); r.manager.disposed = true; clearInterval(r.manager.tracker); } store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, repo, dataDir, store, project, boot };
}

function client(f, t, launch = () => {}) {
  const c = new RuntimeClient({ dataDir: f.dataDir, launch, connectTimeoutMs: 2000 });
  t.after(() => c.close()); return c;
}

test('the runtime refuses clients without its token', async t => {
  const f = fixture(t); const { runtime } = await f.boot();
  const reply = await new Promise(resolvePromise => {
    const socket = net.connect(runtime.path); socket.setEncoding('utf8'); let text = '';
    socket.on('data', d => { text += d; }); socket.on('close', () => resolvePromise(text));
    socket.on('connect', () => socket.write(frame({ id: 1, method: 'hello', params: { token: 'wrong', protocol: 1 } })));
  });
  assert.match(reply, /Unauthorized/);
  const info = JSON.parse(readFileSync(join(f.dataDir, 'runtime.json'), 'utf8'));
  assert.equal(info.runtimeId, runtime.runtimeId);
  if (process.platform !== 'win32') assert.equal((await import('node:fs')).statSync(join(f.dataDir, 'runtime.json')).mode & 0o777, 0o600);
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
  first.runtime.server.close(); first.runtime.manager.disposed = true; await wait(50);
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
  await until(() => processIdentity(child.pid));
  const identity = processIdentity(child.pid);
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
  const token = settings.hooks.Stop[0].hooks[0].command.match(/'([0-9a-f]{48})'/)[1];
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
});

test('a session cannot be closed while live, and closing hides it from the project list', async t => {
  const f = fixture(t); const { fake } = await f.boot(); const c = client(f, t); await c.connect();
  const { session } = await c.call('start', { projectId: f.project.id, provider: 'claude', task: 'close me' });
  assert.throws(() => f.store.archiveSession(session.id), /Stop the session/);
  await assert.rejects(c.call('release', { id: session.id }), /Stop the session/);
  fake.procs[0].exit({ exitCode: 0 });
  await until(() => f.store.getSession(session.id).status === 'exited');
  await c.call('release', { id: session.id }); f.store.archiveSession(session.id);
  assert.equal(f.store.listSessions(f.project.id).length, 0);
  assert.equal(f.store.listSessions(f.project.id, true).length, 1);
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
