import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { JournalStore } from '../src/core/store.mjs';
const { OutputBuffer, TerminalManager } = await import('../src/core/terminal.mjs').catch(() => ({}));

test('terminal runtime exists', () => assert.equal(typeof TerminalManager, 'function'));
test('output flood is bounded in bytes and discloses lost history', () => {
  const buffer = new OutputBuffer(1024);
  for (let i = 0; i < 1000; i++) buffer.append(`chunk ${i} \u05e2\u05d1\u05e8\u05d9\u05ea\n`);
  const snapshot = buffer.since(0);
  assert.ok(buffer.bytes <= 1024); assert.ok(snapshot.gap);
  assert.ok(snapshot.chunks.at(-1).data.includes('999'));
});
test('large unicode chunks are bounded without splitting surrogate pairs', () => {
  const buffer = new OutputBuffer(512); buffer.append('😀'.repeat(10000));
  assert.ok(buffer.bytes <= 512); const data = buffer.since(0).chunks.map(c => c.data).join('');
  assert.ok(!data.includes('\ufffd'));
  assert.equal(data, new TextDecoder().decode(new TextEncoder().encode(data)));
});
test('incremental output reconnect uses sequence, not duplicate prompt input', () => {
  const buffer = new OutputBuffer(1024); buffer.append('first');
  const first = buffer.since(0); buffer.append('second');
  assert.equal(buffer.since(first.lastSequence).chunks.map(c => c.data).join(''), 'second');
  assert.equal(buffer.since(first.lastSequence).gap, false);
});
test('input dimensions and maximum size are validated before reaching native PTY', () => {
  const manager = new TerminalManager({ store: {}, spawn: () => {} });
  assert.throws(() => manager.write('not-owned', 'hello'), /active|owned/);
  assert.throws(() => manager.resize('not-owned', 0, 20), /size/);
});

function runtime(t) {
  const root = mkdtempSync(resolve(process.env.JOURNAL_TEST_TMP ?? tmpdir(), 'terminal-'));
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'pipe' });
  const store = new JournalStore(':memory:'); const project = store.openProject(root); const callbacks = {}; const inputs = []; const launches = [];
  const manager = new TerminalManager({ store, spawn: (executable, argv) => {
    launches.push({ executable, argv });
    return { onData: f => { callbacks.data = f; }, onExit: f => { callbacks.exit = f; }, write: data => inputs.push(data), resize() {}, kill() {} };
  }});
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, project, manager, callbacks, inputs, launches };
}

test('shutdown cannot write late native callbacks into a closed database', async t => {
  const f = runtime(t); const result = await f.manager.start({ projectId: f.project.id, provider: 'claude', task: 'Initial task' });
  await f.manager.dispose(); f.store.close();
  assert.doesNotThrow(() => f.callbacks.data('late output'));
  assert.doesNotThrow(() => f.callbacks.exit({ exitCode: 0 }));
});

test('resume refreshes context without replaying the previous initial task', async t => {
  const f = runtime(t); const task = 'INITIAL_UNIQUE_TASK';
  const started = await f.manager.start({ projectId: f.project.id, provider: 'claude', task });
  f.callbacks.exit({ exitCode: 0 });
  await f.manager.start({ projectId: f.project.id, provider: 'claude', resumeId: started.session.id });
  assert.ok(!f.launches[1].argv.join(' ').includes(task));
  assert.deepEqual(f.launches[1].argv, ['--resume', started.session.nativeId]);
});

test('delivery receipts retain the full literal launch prompt, including resume notices and task', async t => {
  const f = runtime(t);
  const memory = f.store.proposeMemory(f.project.id, { statement: 'Docker tests require an engine', category: 'constraint', scope: 'branch', source: { kind: 'user', note: 'Explicit fixture decision' } });
  f.store.setMemoryStatus(memory.id, 'active');
  const started = await f.manager.start({ projectId: f.project.id, provider: 'claude', task: 'Docker tests' });
  assert.equal(started.receipt.launchPrompt, f.launches[0].argv.at(-1));
  f.callbacks.exit({ exitCode: 0 });
  const resumed = await f.manager.start({ projectId: f.project.id, provider: 'claude', resumeId: started.session.id });
  assert.equal(resumed.receipt.launchPrompt, f.launches[1].argv.at(-1));
  assert.match(resumed.receipt.launchPrompt, /No previous task is being repeated/);
});

function approvedRule(f, statement = 'Docker tests require an engine') {
  const memory = f.store.proposeMemory(f.project.id, { statement, category: 'constraint', scope: 'branch', source: { kind: 'user', note: 'Explicit fixture decision' } });
  f.store.setMemoryStatus(memory.id, 'active'); return memory;
}

test('a chunked native Codex banner supplies only a hint until exact-ID confirmation', async t => {
  const f = runtime(t); const nativeId = '01a0f661-908b-7193-8520-6ac6f3b44aeb';
  const first = await f.manager.start({ projectId: f.project.id, provider: 'codex', task: 'Fixture task' });
  f.callbacks.data('To continue this session, run:\r\n  \x1b[32mcodex res');
  f.callbacks.data(`ume ${nativeId.slice(0, 20)}`);
  assert.equal(f.store.getSession(first.session.id).nativeId, null);
  f.callbacks.data(`${nativeId.slice(20)}\x1b[0m\r\n`);
  assert.equal(f.store.getSession(first.session.id).nativeId, nativeId);
  assert.equal(f.store.getSession(first.session.id).nativeIdConfirmed, false);
  f.callbacks.exit({ exitCode: 0 });
  await assert.rejects(f.manager.start({ projectId: f.project.id, provider: 'codex', resumeId: first.session.id }), /Confirm the exact/);
  await f.manager.confirmNativeId(first.session.id, nativeId);
  const resumed = await f.manager.start({ projectId: f.project.id, provider: 'codex', resumeId: first.session.id });
  assert.equal(resumed.session.nativeId, nativeId);
  assert.deepEqual(f.launches[1].argv, ['resume', nativeId]);
});

test('withdrawal names the claim and revision that the native agent actually received', async t => {
  const f = runtime(t); const memory = approvedRule(f);
  const first = await f.manager.start({ projectId: f.project.id, provider: 'claude', task: 'Docker tests' });
  assert.ok(first.receipt.launchPrompt.includes(`${memory.id} r1`));
  f.callbacks.exit({ exitCode: 0 }); f.store.setMemoryStatus(memory.id, 'archived');
  const resumed = await f.manager.start({ projectId: f.project.id, provider: 'claude', resumeId: first.session.id });
  assert.ok(resumed.receipt.launchPrompt.includes(`${memory.id} r1`), 'Withdrawal must name the previously delivered identity');
});

test('resuming an ancestor reconciles the latest delivery in the same native conversation', async t => {
  const f = runtime(t);
  const first = await f.manager.start({ projectId: f.project.id, provider: 'claude', task: 'Original empty task' });
  f.callbacks.exit({ exitCode: 0 }); const memory = approvedRule(f);
  const second = await f.manager.start({ projectId: f.project.id, provider: 'claude', resumeId: first.session.id, task: 'Docker tests' });
  assert.equal(second.session.nativeId, first.session.nativeId);
  assert.ok(second.receipt.launchPrompt.includes(memory.statement));
  f.callbacks.exit({ exitCode: 0 }); f.store.setMemoryStatus(memory.id, 'archived');
  const resumed = await f.manager.start({ projectId: f.project.id, provider: 'claude', resumeId: first.session.id });
  assert.ok(resumed.receipt.launchPrompt.includes(`${memory.id} r1`), 'Later native context must be invalidated even when selecting the oldest row');
  assert.equal(resumed.receipt.query, 'Docker tests');
  assert.ok(!resumed.receipt.launchPrompt.includes('Task:\nDocker tests'));
});

test('latest native receipt excludes failed launches and different projects or providers', async t => {
  const f = runtime(t); const first = await f.manager.start({ projectId: f.project.id, provider: 'claude', task: 'First task' });
  f.callbacks.exit({ exitCode: 0 }); const spawn = f.manager.spawn;
  f.manager.spawn = () => { throw new Error('Native spawn failed'); };
  await assert.rejects(f.manager.start({ projectId: f.project.id, provider: 'claude', resumeId: first.session.id, task: 'Failed later task' }));
  f.manager.spawn = spawn;
  const latest = f.store.latestNativeReceipt(f.project.id, 'claude', first.session.nativeId);
  assert.equal(latest.id, first.receipt.id);
  assert.equal(f.store.latestNativeReceipt(f.project.id, 'codex', first.session.nativeId), null);
  assert.equal(f.store.latestNativeReceipt('another-project', 'claude', first.session.nativeId), null);
});

test('a failed first launch cannot supply historical task or claim exclusions on resume', async t => {
  const f = runtime(t); const memory = approvedRule(f); const spawn = f.manager.spawn;
  f.manager.spawn = () => { throw new Error('Native spawn failed'); };
  await assert.rejects(f.manager.start({ projectId: f.project.id, provider: 'codex', task: 'Docker tests never delivered' }));
  const failed = f.store.listSessions(f.project.id)[0];
  await f.manager.confirmNativeId(failed.id, 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb');
  f.store.setMemoryStatus(memory.id, 'archived'); f.manager.spawn = spawn;
  const resumed = await f.manager.start({ projectId: f.project.id, provider: 'codex', resumeId: failed.id });
  assert.equal(resumed.receipt.query, '');
  assert.equal(resumed.receipt.launchPrompt, '');
});

test('spawn failure records failed session and receipt rather than a successful delivery', async t => {
  const f = runtime(t); f.manager.spawn = () => { throw new Error('fixture launch failure'); };
  await assert.rejects(async () => f.manager.start({ projectId: f.project.id, provider: 'claude', task: 'test' }), /Could not start/);
  assert.equal(f.store.listSessions(f.project.id)[0].status, 'failed');
  assert.equal(f.store.listReceipts(f.project.id)[0].state, 'failed');
});

test('a foreign hook UUID cannot silently replace the native resume identity', async t => {
  const f = runtime(t); const started = await f.manager.start({ projectId: f.project.id, provider: 'claude' });
  const nativeId = started.session.nativeId;
  f.manager.observe(started.session.id, 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', 'waiting');
  assert.equal(f.manager.active.session.nativeId, nativeId);
  assert.equal(f.manager.active.session.nativeIdConfirmed, false);
  f.manager.observe(started.session.id, nativeId, 'running');
  assert.equal(f.manager.active.session.nativeIdConfirmed, false);
  f.callbacks.exit({ exitCode: 0 });
  await assert.rejects(f.manager.start({ projectId: f.project.id, provider: 'claude', resumeId: started.session.id }), /Confirm the exact/);
});

test('display credit stays bounded during flood while interrupts still reach the process', async t => {
  const f = runtime(t); const started = await f.manager.start({ projectId: f.project.id, provider: 'claude' });
  f.manager.attach(started.session.id); const events = []; f.manager.on('event', e => events.push(e));
  f.callbacks.data('line\n'.repeat(200000)); await new Promise(setImmediate);
  assert.ok(events.filter(e => e.type === 'output').reduce((sum, e) => sum + Buffer.byteLength(e.data), 0) <= 65536);
  assert.ok(f.manager.last.buffer.bytes <= 256 * 1024);
  assert.ok(events.some(e => e.type === 'gap'));
  f.manager.interrupt(started.session.id); assert.equal(f.inputs.at(-1), '\x03');
  assert.throws(() => f.manager.write('another-session', 'no'), /owned/);
});
