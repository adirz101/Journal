import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { JournalStore } from '../src/core/store.mjs';
import { removeLater } from './support/cleanup.mjs';
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
  const manager = new TerminalManager({ store: {}, spawn: () => {}, trackMs: 0 });
  assert.throws(() => manager.write('not-owned', 'hello'), /active|owned/);
  assert.throws(() => manager.resize('not-owned', 0, 20), /size/);
});

function runtime(t) {
  const root = mkdtempSync(resolve(process.env.JOURNAL_TEST_TMP ?? tmpdir(), 'terminal-'));
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'pipe' });
  const store = new JournalStore(':memory:'); const project = store.openProject(root); const callbacks = {}; const inputs = []; const launches = [];
  const manager = new TerminalManager({ store, trackMs: 0, identify: () => null, table: () => null, spawn: (executable, argv) => {
    launches.push({ executable, argv });
    return { onData: f => { callbacks.data = f; }, onExit: f => { callbacks.exit = f; }, write: data => inputs.push(data), resize() {}, kill() {} };
  }});
  t.after(() => { store.close(); removeLater(root); });
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
  await assert.rejects(f.manager.start({ projectId: f.project.id, provider: 'codex', resumeId: first.session.id }), /Confirm the conversation ID before continuing/);
  await f.manager.confirmNativeId(first.session.id, nativeId);
  const resumed = await f.manager.start({ projectId: f.project.id, provider: 'codex', resumeId: first.session.id });
  assert.equal(resumed.session.nativeId, nativeId);
  assert.deepEqual(f.launches[1].argv, ['resume', nativeId]);
});
test('a later incomplete Codex banner clears a stored unconfirmed hint across callbacks', async t => {
  const f = runtime(t); const nativeId = '01a0f661-908b-7193-8520-6ac6f3b44aeb';
  const first = await f.manager.start({ projectId: f.project.id, provider: 'codex' });
  f.callbacks.data(`To continue this session, run codex resume ${nativeId}\n`);
  assert.equal(f.store.getSession(first.session.id).nativeId, nativeId);
  f.callbacks.data('To continue this session, run:\n  codex resume ');
  assert.equal(f.store.getSession(first.session.id).nativeId, null);
  assert.equal(f.store.getSession(first.session.id).nativeIdConfirmed, false);
  f.callbacks.exit({ exitCode: 0 });
  await assert.rejects(f.manager.start({ projectId: f.project.id, provider: 'codex', resumeId: first.session.id }), /Confirm the conversation ID before continuing/);
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
  const errors = []; f.manager.on('event', e => { if (e.type === 'error') errors.push(e); });
  assert.equal(started.session.identityMismatch, false);
  f.manager.observe(started.session.id, 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', 'waiting');
  assert.deepEqual(errors.map(e => [e.message, e.code]), [['Native session identity changed. Stop the terminal and confirm its conversation ID before continuing.', (await import('../src/core/terminal.mjs')).IDENTITY_CHANGED]]);
  assert.equal(f.store.getSession(started.session.id).identityMismatch, true);
  assert.equal(f.manager.entry(started.session.id).session.nativeId, nativeId);
  assert.equal(f.manager.entry(started.session.id).session.nativeIdConfirmed, false);
  f.manager.observe(started.session.id, nativeId, 'running');
  assert.equal(f.manager.entry(started.session.id).session.nativeIdConfirmed, false);
  assert.equal(f.manager.entry(started.session.id).session.nativeIdSource, 'preassigned', 'A matching hook after a mismatch does not restore confidence');
  f.callbacks.exit({ exitCode: 0 });
  assert.equal(f.store.getSession(started.session.id).identityMismatch, true);
  await assert.rejects(f.manager.start({ projectId: f.project.id, provider: 'claude', resumeId: started.session.id }), /Confirm the conversation ID before continuing/);
  await f.manager.confirmNativeId(started.session.id, nativeId);
  for (const session of [f.store.getSession(started.session.id), f.manager.entry(started.session.id).session]) {
    assert.equal(session.identityMismatch, false); assert.equal(session.nativeIdSource, 'user');
  }
});

test('display credit stays bounded during flood while interrupts still reach the process', async t => {
  const f = runtime(t); const started = await f.manager.start({ projectId: f.project.id, provider: 'claude' });
  f.manager.attach(started.session.id); const events = []; f.manager.on('event', e => events.push(e));
  f.callbacks.data('line\n'.repeat(200000)); await new Promise(setImmediate);
  assert.ok(events.filter(e => e.type === 'output').reduce((sum, e) => sum + Buffer.byteLength(e.data), 0) <= 65536);
  assert.ok(f.manager.entry(started.session.id).buffer.bytes <= 256 * 1024);
  assert.ok(events.some(e => e.type === 'gap'));
  f.manager.interrupt(started.session.id); assert.equal(f.inputs.at(-1), '\x03');
  assert.throws(() => f.manager.write('another-session', 'no'), /owned/);
});

test('a launch that spawned before failing records uncertain delivery, not failed', async t => {
  const f = runtime(t); const save = f.store.saveSession.bind(f.store); let calls = 0;
  f.store.saveSession = session => { if (session.status === 'running' && ++calls === 1) throw new Error('disk full'); return save(session); };
  await assert.rejects(f.manager.start({ projectId: f.project.id, provider: 'claude', task: 'spawned' }), /Could not start/);
  assert.equal(f.launches.length, 1);
  assert.equal(f.store.listReceipts(f.project.id)[0].state, 'uncertain');
  await assert.rejects(f.manager.start({ projectId: f.project.id, provider: 'bogus', task: 'x' }), /Unknown agent provider/);
  assert.equal(f.store.listSessions(f.project.id).length, 1, 'An invalid provider saves nothing');
});

test('output keeps ANSI sequences, CRLF and multi-byte text intact across chunk boundaries', () => {
  const buffer = new OutputBuffer(64 * 1024);
  const text = '\x1b[31mRED\x1b[0m \u6f22\u5b57 \u{1F600} \u05e2\u05d1\r\n'.repeat(2000);
  buffer.append(text);
  const joined = buffer.since(0).chunks.map(c => c.data).join('');
  assert.ok(text.endsWith(joined), 'Only whole older chunks are dropped');
  assert.ok(buffer.since(0).chunks.every(c => Buffer.byteLength(c.data) <= 8192));
  assert.ok(!joined.includes('\ufffd'));
});

test('an approved tool ends the waiting state when it completes', async t => {
  const f = runtime(t);
  const { session } = await f.manager.start({ projectId: f.project.id, provider: 'claude', task: 'x' });
  f.manager.ingest(session.id, { event: 'PermissionRequest', nativeId: session.nativeId, tool: 'Bash' });
  assert.equal(f.store.getSession(session.id).status, 'waiting');
  f.manager.ingest(session.id, { event: 'PostToolUse', nativeId: session.nativeId, tool: 'Bash', toolUseId: 'approved-1' });
  const after = f.store.getSession(session.id);
  assert.equal(after.status, 'running');
  assert.equal(after.activity, 'working');
});

// Hook-order scenarios for the approval prompt: only its own tool may clear it.
async function hooked(t) {
  const f = runtime(t);
  const { session } = await f.manager.start({ projectId: f.project.id, provider: 'claude', task: 'x' });
  const send = (event, extra = {}) => f.manager.ingest(session.id, { event, nativeId: session.nativeId, ...extra });
  const state = () => { const s = f.store.getSession(session.id); return `${s.status}/${s.activity}`; };
  const write = data => f.manager.write(session.id, data);
  return { send, state, write, f, session };
}

test('the expected hook order (PreToolUse before an id-less PermissionRequest) clears on that tool completing — to verify natively', async t => {
  const { send, state } = await hooked(t);
  send('PreToolUse', { tool: 'Bash', toolUseId: 'b1', command: 'npm test' });
  send('PermissionRequest', { tool: 'Bash' });
  assert.equal(state(), 'waiting/permission');
  send('PostToolUse', { tool: 'Bash', toolUseId: 'b1' });
  assert.equal(state(), 'running/working');
});

test('a sibling tool finishing does not hide an open approval', async t => {
  const { send, state } = await hooked(t);
  send('PreToolUse', { tool: 'Read', toolUseId: 'r1' });
  send('PreToolUse', { tool: 'Bash', toolUseId: 'b1', command: 'ls' });
  send('PermissionRequest', { tool: 'Bash' });
  send('PostToolUse', { tool: 'Read', toolUseId: 'r1' });
  assert.equal(state(), 'waiting/permission');
  send('PostToolUse', { tool: 'Bash', toolUseId: 'b1' });
  assert.equal(state(), 'running/working');
});

test('a PermissionRequest carrying its tool id is cleared only by that tool', async t => {
  const { send, state } = await hooked(t);
  send('PreToolUse', { tool: 'Bash', toolUseId: 'b1', command: 'a' });
  send('PreToolUse', { tool: 'Bash', toolUseId: 'b2', command: 'b' });
  send('PermissionRequest', { tool: 'Bash', toolUseId: 'b2' });
  send('PostToolUse', { tool: 'Bash', toolUseId: 'b1' });
  assert.equal(state(), 'waiting/permission');
  send('PostToolUse', { tool: 'Bash', toolUseId: 'b2' });
  assert.equal(state(), 'running/working');
});

test('an ambiguous request clears only when the last tool of its kind completes', async t => {
  const { send, state } = await hooked(t);
  send('PreToolUse', { tool: 'Bash', toolUseId: 'b1', command: 'a' });
  send('PreToolUse', { tool: 'Bash', toolUseId: 'b2', command: 'b' });
  send('PermissionRequest', { tool: 'Bash' });
  send('PostToolUse', { tool: 'Bash', toolUseId: 'b1' });
  assert.equal(state(), 'waiting/permission');
  send('PostToolUse', { tool: 'Bash', toolUseId: 'b2' });
  assert.equal(state(), 'running/working');
});

test('a sibling tool starting keeps the approval unless the user answered the prompt', async t => {
  const { send, state } = await hooked(t);
  send('PreToolUse', { tool: 'Bash', toolUseId: 'b1', command: 'ls' });
  send('PermissionRequest', { tool: 'Bash' });
  send('PreToolUse', { tool: 'Grep', toolUseId: 'g1' });
  assert.equal(state(), 'waiting/permission');
});

test('deny with feedback: the typed answer clears the only open approval', async t => {
  const { send, state, write } = await hooked(t);
  send('PreToolUse', { tool: 'Bash', toolUseId: 'b1', command: 'grep -r x .' });
  send('PermissionRequest', { tool: 'Bash' });
  write('3'); write('use rg instead\r');
  assert.equal(state(), 'running/working');
  send('PreToolUse', { tool: 'Grep', toolUseId: 'g1' });
  assert.equal(state(), 'running/working');
});

test('arrow keys and ordinary typing do not count as answering the prompt', async t => {
  const { send, state, write } = await hooked(t);
  send('PreToolUse', { tool: 'Bash', toolUseId: 'b1', command: 'ls' });
  send('PermissionRequest', { tool: 'Bash' });
  write('\x1b[B'); write('abc');
  send('PreToolUse', { tool: 'Grep', toolUseId: 'g1' });
  assert.equal(state(), 'waiting/permission');
});

test('approving with a digit clears the only open approval; a sibling completion keeps it clear', async t => {
  const { send, state, write } = await hooked(t);
  send('PreToolUse', { tool: 'Read', toolUseId: 'r1' });
  send('PreToolUse', { tool: 'Bash', toolUseId: 'b1', command: 'ls' });
  send('PermissionRequest', { tool: 'Bash' });
  write('1');
  assert.equal(state(), 'running/working');
  send('PostToolUse', { tool: 'Read', toolUseId: 'r1' });
  assert.equal(state(), 'running/working');
});

test('a lone Esc answers (denies) a prompt; a new request resets an unsettled answer', async t => {
  const { send, state, write } = await hooked(t);
  send('PermissionRequest', { tool: 'Bash' });
  send('PermissionRequest', { tool: 'Edit' });
  // Two prompts are open (Bash, Edit): the answer waits for a tool event, and a new request discards it.
  write('\x1b');
  send('PermissionRequest', { tool: 'Write' });
  send('PreToolUse', { tool: 'Grep', toolUseId: 'g1' });
  assert.equal(state(), 'waiting/permission');
  // Each prompt needs its own answer; the last one settles at once.
  write('\x1b'); send('PreToolUse', { tool: 'Grep', toolUseId: 'g2' });
  write('\x1b'); send('PreToolUse', { tool: 'Grep', toolUseId: 'g3' });
  assert.equal(state(), 'waiting/permission');
  // Esc at the last prompt ends Claude's turn: back at its input box.
  write('\x1b');
  assert.equal(state(), 'running/idle');
});

test('an auto-approved sibling failing does not hide an open approval', async t => {
  const { send, state } = await hooked(t);
  send('PreToolUse', { tool: 'Edit', toolUseId: 'e1', filePath: 'a.txt' });
  send('PreToolUse', { tool: 'Bash', toolUseId: 'b1', command: 'ls' });
  send('PermissionRequest', { tool: 'Bash' });
  send('PostToolUseFailure', { tool: 'Edit', toolUseId: 'e1' });
  assert.equal(state(), 'waiting/permission');
});

test('turn boundaries reset approval tracking and unknown completions are harmless', async t => {
  const { send, state } = await hooked(t);
  send('PreToolUse', { tool: 'Bash', toolUseId: 'b1', command: 'ls' });
  send('PermissionRequest', { tool: 'Bash' });
  send('Stop');
  send('PostToolUse', { tool: 'Bash', toolUseId: 'ghost' });
  assert.equal(state(), 'running/idle');
  send('PermissionRequest', { tool: 'Bash' });
  send('UserPromptSubmit');
  send('PostToolUse', { tool: 'Bash', toolUseId: 'ghost2' });
  assert.equal(state(), 'running/working');
});

test('two open prompts need two answers; one answer settles one prompt', async t => {
  const { send, state, write } = await hooked(t);
  send('PreToolUse', { tool: 'Bash', toolUseId: 'a1', command: 'a' });
  send('PreToolUse', { tool: 'Bash', toolUseId: 'b1', command: 'b' });
  send('PermissionRequest', { tool: 'Bash', toolUseId: 'a1' });
  send('PermissionRequest', { tool: 'Bash', toolUseId: 'b1' });
  write('1');
  send('PostToolUse', { tool: 'Bash', toolUseId: 'a1' });
  assert.equal(state(), 'waiting/permission');
  write('1');
  send('PostToolUse', { tool: 'Bash', toolUseId: 'b1' });
  assert.equal(state(), 'running/working');
});

test('which input counts as answering the prompt', async t => {
  for (const [data, after] of [['\r\n', 'running/working'], ['\x1bb', 'waiting/permission'], ['\x1b[200~ok\r\x1b[201~', 'waiting/permission'], ['\x03', 'running/idle']]) {
    const { send, state, write } = await hooked(t);
    send('PermissionRequest', { tool: 'Bash' });
    write(data);
    assert.equal(state(), after, JSON.stringify(data));
    send('PreToolUse', { tool: 'Grep', toolUseId: 'g1' });
    assert.equal(state(), after === 'waiting/permission' ? after : 'running/working', JSON.stringify(data));
  }
});

test('exit releases the tracked tools, commands and prompts', async t => {
  const { send, f, session } = await hooked(t);
  send('PreToolUse', { tool: 'Bash', toolUseId: 'b1', command: 'ls' });
  send('PermissionRequest', { tool: 'Bash' });
  const entry = f.manager.entries.get(session.id);
  f.callbacks.exit({ exitCode: 0 });
  assert.equal(entry.tools.size, 0); assert.equal(entry.commands.size, 0);
  assert.deepEqual(entry.pending, []); assert.equal(entry.answered, false);
});

test("Journal's Interrupt counts as answering the prompt, like a typed Ctrl+C", async t => {
  const { send, state, f, session } = await hooked(t);
  send('PermissionRequest', { tool: 'Bash' });
  send('PreToolUse', { tool: 'Grep', toolUseId: 'g1' });
  assert.equal(state(), 'waiting/permission');
  f.manager.interrupt(session.id);
  assert.equal(state(), 'running/idle', 'Ctrl+C at the only prompt returns Claude to its input box');
  send('PreToolUse', { tool: 'Grep', toolUseId: 'g2' });
  assert.equal(state(), 'running/working', 'A following tool event restores Working');
});

test('answering the only open prompt shows Working at once, before any tool event', async t => {
  for (const keys of [['1'], ['3', 'use rg instead\r'], ['\r']]) {
    const { send, state, write, f, session } = await hooked(t);
    send('PreToolUse', { tool: 'Bash', toolUseId: 'b1', command: 'sleep 600' });
    send('PermissionRequest', { tool: 'Bash' });
    for (const key of keys) write(key);
    assert.equal(state(), 'running/working', JSON.stringify(keys));
    const entry = f.manager.entries.get(session.id);
    assert.deepEqual(entry.pending, []); assert.equal(entry.answered, false);
  }
});

test('Esc or Ctrl+C at the only open prompt shows Your turn at once', async t => {
  for (const keys of [['\x1b'], ['\x03']]) {
    const { send, state, write, f, session } = await hooked(t);
    send('PreToolUse', { tool: 'Bash', toolUseId: 'b1', command: 'sleep 600' });
    send('PermissionRequest', { tool: 'Bash' });
    for (const key of keys) write(key);
    assert.equal(state(), 'running/idle', JSON.stringify(keys));
    const entry = f.manager.entries.get(session.id);
    assert.deepEqual(entry.pending, []); assert.equal(entry.answered, false);
    // The rejected tool reports its failure; that is not new work.
    send('PostToolUseFailure', { tool: 'Bash', toolUseId: 'b1' });
    assert.equal(state(), 'running/idle', JSON.stringify(keys));
  }
});

test('with two open prompts one answer waits for a tool event to settle one of them', async t => {
  const { send, state, write } = await hooked(t);
  send('PermissionRequest', { tool: 'Bash' });
  send('PermissionRequest', { tool: 'Edit' });
  write('1');
  assert.equal(state(), 'waiting/permission');
  send('PreToolUse', { tool: 'Grep', toolUseId: 'g1' });
  assert.equal(state(), 'waiting/permission');
  write('1');
  assert.equal(state(), 'running/working');
});

test('at most 100 open prompts are tracked; the oldest are dropped', async t => {
  const { send, f, session } = await hooked(t);
  for (let i = 0; i < 105; i++) send('PermissionRequest', { tool: 'Bash', toolUseId: `b${i}` });
  const { pending } = f.manager.entries.get(session.id);
  assert.equal(pending.length, 100);
  assert.equal(pending[0].toolUseId, 'b5'); assert.equal(pending[99].toolUseId, 'b104');
});

test('an answer is consumed by the prompt its tool resolved', async t => {
  const { send, state, write } = await hooked(t);
  send('PreToolUse', { tool: 'Bash', toolUseId: 'a1', command: 'a' });
  send('PreToolUse', { tool: 'Bash', toolUseId: 'b1', command: 'b' });
  send('PermissionRequest', { tool: 'Bash', toolUseId: 'a1' });
  send('PermissionRequest', { tool: 'Bash', toolUseId: 'b1' });
  write('1');
  send('PostToolUse', { tool: 'Bash', toolUseId: 'a1' });
  send('PreToolUse', { tool: 'Grep', toolUseId: 'g1' });
  assert.equal(state(), 'waiting/permission');
});

// Phase 2: stable slots and error codes.
// Each start gets its own fake PTY so tests can end one session at a time.
function multi(t) {
  const f = runtime(t); const procs = [];
  f.manager.spawn = () => {
    const proc = { callbacks: {}, onData(fn) { this.callbacks.data = fn; }, onExit(fn) { this.callbacks.exit = fn; }, write() {}, resize() {}, kill() {} };
    procs.push(proc); return proc;
  };
  const start = (provider = 'claude', extra = {}) => f.manager.start({ projectId: f.project.id, provider, task: 'x', ...extra }).then(r => r.session);
  return { ...f, procs, start };
}

test('slots: lowest free slot, kept across stops of others', async t => {
  const f = multi(t);
  const a = await f.start(); const b = await f.start(); const c = await f.start();
  assert.deepEqual([a.slot, b.slot, c.slot], [1, 2, 3]);
  f.procs[1].callbacks.exit({ exitCode: 0 });
  assert.equal(f.manager.entry(b.id).session.slot, null);
  assert.equal(f.store.getSession(b.id).slot, null);
  const d = await f.start();
  assert.equal(d.slot, 2);
  assert.equal(f.manager.entry(a.id).session.slot, 1);
  assert.deepEqual(f.manager.list().filter(s => s.slot).map(s => s.slot).sort(), [1, 2, 3]);
});

test('concurrent starts never share a slot; a fifth is refused with SLOTS_FULL', async t => {
  const f = multi(t);
  const sessions = await Promise.all([1, 2, 3, 4].map(() => f.start()));
  assert.deepEqual(sessions.map(s => s.slot).sort(), [1, 2, 3, 4]);
  await assert.rejects(f.start(), error => error.code === 'SLOTS_FULL' && /up to 4 sessions/.test(error.message));
});

test('a failed launch frees its reserved slot', async t => {
  const f = multi(t); const spawn = f.manager.spawn;
  f.manager.spawn = () => { throw new Error('fixture launch failure'); };
  await assert.rejects(f.start(), error => error.code === 'START_FAILED' && /Could not start/.test(error.message));
  const failed = f.store.listSessions(f.project.id)[0];
  assert.equal(failed.status, 'failed'); assert.equal(failed.slot, null);
  f.manager.spawn = spawn;
  assert.equal((await f.start()).slot, 1);
});

test('a missing executable gives PROVIDER_MISSING', async t => {
  const f = multi(t);
  f.manager.spawn = () => { throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }); };
  await assert.rejects(f.start(), error => error.code === 'PROVIDER_MISSING' && /Could not start/.test(error.message));
});

test('a start whose process is already running counts once toward capacity', async t => {
  const f = multi(t);
  await f.start(); await f.start();
  // Hold the third launch after its process started (its entry exists) and before it settles.
  let release; const held = new Promise(resolve => { release = resolve; });
  const update = f.store.updateReceiptState.bind(f.store); let first = true;
  f.store.updateReceiptState = async (...args) => { if (first) { first = false; await held; } return update(...args); };
  const third = f.start();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.procs.length, 3);
  const fourth = await f.start();
  release();
  assert.deepEqual([(await third).slot, fourth.slot].sort(), [3, 4]);
  await assert.rejects(f.start(), error => error.code === 'SLOTS_FULL');
});

test('ENOENT after the process started is START_FAILED, not PROVIDER_MISSING', async t => {
  const f = multi(t);
  const update = f.store.updateReceiptState.bind(f.store); let first = true;
  f.store.updateReceiptState = (...args) => { if (first) { first = false; throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }); } return update(...args); };
  await assert.rejects(f.start(), error => error.code === 'START_FAILED');
  assert.equal(f.procs.length, 1);
});

test('shutting down during a launch says so, without blaming the CLI', async t => {
  const f = multi(t);
  const save = f.store.saveSession.bind(f.store); let first = true;
  f.store.saveSession = session => { if (first) { first = false; void f.manager.dispose({ stopSessions: false }); } return save(session); };
  await assert.rejects(f.start(), error => error.code === 'SHUTTING_DOWN' && error.message === 'Journal is shutting down');
  assert.equal(f.procs.length, 0);
});

test('recovered sessions have no slot', async t => {
  const f = multi(t);
  const now = new Date().toISOString();
  f.store.saveSession({ id: 'foreign', projectId: f.project.id, provider: 'claude', nativeId: null, title: 'old', status: 'running', slot: 2, runtimeId: 'another-runtime', createdAt: now, lastActivityAt: now,
    pending: { tool: 'Bash', command: 'ls', path: null, at: now } });
  const [recovered] = await f.manager.recover();
  assert.equal(recovered.slot, null); assert.equal(recovered.pending, null);
  assert.equal(f.store.getSession('foreign').slot, null);
  assert.equal(f.store.getSession('foreign').pending, null);
});

test('error codes: SLOTS_FULL, ID_UNCONFIRMED, CONVERSATION_OPEN, NOT_LIVE and SHUTTING_DOWN', async t => {
  const { ERROR_CODES } = await import('../src/core/terminal.mjs');
  assert.deepEqual(Object.keys(ERROR_CODES), ['SLOTS_FULL', 'SHUTTING_DOWN', 'PROVIDER_MISSING', 'PROVIDER_UNSUPPORTED', 'ID_UNCONFIRMED', 'CONVERSATION_OPEN', 'ORPHAN_RUNNING', 'START_FAILED', 'NOT_LIVE']);
  assert.ok(Object.isFrozen(ERROR_CODES));
  const f = multi(t);
  const codex = await f.start('codex');
  f.procs[0].callbacks.exit({ exitCode: 0 });
  await assert.rejects(f.start('codex', { resumeId: codex.id }), error => error.code === 'ID_UNCONFIRMED' && /Confirm the conversation ID/.test(error.message));
  assert.throws(() => f.manager.write(codex.id, 'x'), error => error.code === 'NOT_LIVE' && /not active or owned/.test(error.message));
  const claude = await f.start();
  f.procs[1].callbacks.exit({ exitCode: 0 });
  const resumed = await f.start('claude', { resumeId: claude.id });
  await assert.rejects(f.start('claude', { resumeId: claude.id }), error => error.code === 'CONVERSATION_OPEN');
  assert.equal(resumed.slot, 1);
  for (let i = 0; i < 3; i++) await f.start();
  await assert.rejects(f.start(), error => error.code === 'SLOTS_FULL');
  await f.manager.dispose({ stopSessions: false });
  await assert.rejects(f.start(), error => error.code === 'SHUTTING_DOWN');
});

test('cursor errors carry PROVIDER_MISSING and PROVIDER_UNSUPPORTED', async t => {
  const f = multi(t);
  f.manager.cursor = { find: async () => null, createChat: async () => null };
  await assert.rejects(f.start('cursor'), error => error.code === 'PROVIDER_MISSING' && /Cursor CLI is not installed/.test(error.message));
  f.manager.cursor = { find: async () => ({ path: '/bin/agent', cursor: true, supports: { resume: false, createChat: true } }), createChat: async () => null };
  await assert.rejects(f.start('cursor'), error => error.code === 'PROVIDER_UNSUPPORTED');
});

test('nativeIdSource transitions', async t => {
  const f = multi(t); const codexId = '01a0f661-908b-7193-8520-6ac6f3b44aeb'; const cursorId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const claude = await f.start();
  assert.equal(claude.nativeIdSource, 'preassigned');
  f.manager.ingest(claude.id, { event: 'SessionStart', nativeId: claude.nativeId });
  assert.equal(f.store.getSession(claude.id).nativeIdSource, 'preassigned-observed');
  f.procs[0].callbacks.exit({ exitCode: 0 });
  const resumed = await f.start('claude', { resumeId: claude.id });
  assert.equal(resumed.nativeIdSource, 'preassigned-observed', 'Resume copies the source of the prior ID');
  const codex = await f.start('codex');
  assert.equal(codex.nativeIdSource, null);
  f.procs[2].callbacks.data(`To continue this session, run codex resume ${codexId}\n`);
  assert.equal(f.store.getSession(codex.id).nativeIdSource, 'exit-banner');
  f.procs[2].callbacks.data('To continue this session, run:\n  codex resume ');
  assert.equal(f.store.getSession(codex.id).nativeIdSource, null, 'A cleared hint has no source');
  f.procs[2].callbacks.data(`To continue this session, run codex resume ${codexId}\n`);
  f.procs[2].callbacks.exit({ exitCode: 0 });
  await f.manager.confirmNativeId(codex.id, codexId);
  assert.equal(f.store.getSession(codex.id).nativeIdSource, 'user');
  f.manager.cursor = { find: async () => ({ path: '/bin/agent', cursor: true, supports: { resume: true, createChat: true, mode: true } }), createChat: async () => cursorId };
  const cursor = await f.start('cursor');
  assert.equal(cursor.nativeIdSource, 'create-chat'); assert.equal(cursor.identityMismatch, false);
});

// Phase 2: output activity. Mocked clock; enabled after start so launch runs on real timers.
async function outputting(t, provider = 'codex') {
  const f = multi(t); const session = await f.start(provider);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const events = []; f.manager.on('event', e => { if (e.type === 'activity') events.push(e); });
  const data = text => f.procs[0].callbacks.data(text);
  const latest = () => f.manager.entry(session.id).session.lastOutputAt;
  return { ...f, session, events, data, latest };
}

test('a flood of output emits one activity event per throttle window', async t => {
  const f = await outputting(t);
  assert.equal(f.session.lastOutputAt, null);
  for (let i = 0; i < 1000; i++) f.data('x');
  assert.equal(f.events.length, 1);
  assert.deepEqual(f.events[0], { type: 'activity', sessionId: f.session.id, lastOutputAt: f.latest() });
  for (let i = 0; i < 5; i++) { t.mock.timers.tick(999); f.data('y'); }
  assert.equal(f.events.length, 1, 'Still inside the first throttle window');
  t.mock.timers.tick(5);
  assert.equal(f.events.length, 2, 'The trailing heartbeat fires once');
  assert.equal(f.events[1].lastOutputAt, f.latest());
  assert.equal(Date.parse(f.events[1].lastOutputAt), Date.parse(f.events[0].lastOutputAt) + 4995);
  t.mock.timers.tick(60_000);
  assert.equal(f.events.length, 2, 'No output, no further events');
});

test('output after ten seconds of quiet emits at once', async t => {
  const f = await outputting(t);
  f.data('first'); t.mock.timers.tick(11_000);
  assert.equal(f.events.length, 1);
  f.data('again');
  assert.equal(f.events.length, 2);
  assert.equal(f.events[1].lastOutputAt, f.latest());
});

test('echo and resize repaint do not count as output', async t => {
  const f = await outputting(t);
  f.data('before'); const first = f.latest();
  t.mock.timers.tick(20_000);
  f.manager.write(f.session.id, 'a'); t.mock.timers.tick(299); f.data('a');
  assert.equal(f.latest(), first, 'Echo within 300 ms is not activity');
  t.mock.timers.tick(20_000);
  f.manager.resize(f.session.id, 120, 40); t.mock.timers.tick(299); f.data('repaint');
  assert.equal(f.latest(), first, 'A resize repaint is not activity');
  t.mock.timers.tick(2); f.data('real output');
  assert.notEqual(f.latest(), first);
  assert.equal(f.events.length, 2);
});

test('a resize to the current size is not a repaint window', async t => {
  const f = await outputting(t);
  f.data('before'); const first = f.latest();
  t.mock.timers.tick(20_000);
  // The PTY starts at 100x30: the same size changes nothing, so output right after it counts.
  f.manager.resize(f.session.id, 100, 30); t.mock.timers.tick(10); f.data('output');
  assert.notEqual(f.latest(), first);
  const second = f.latest(); t.mock.timers.tick(20_000);
  f.manager.resize(f.session.id, 120, 40); t.mock.timers.tick(10); f.data('repaint');
  assert.equal(f.latest(), second, 'A changed size is a repaint');
  t.mock.timers.tick(20_000);
  f.manager.resize(f.session.id, 120, 40); t.mock.timers.tick(10); f.data('more output');
  assert.notEqual(f.latest(), second, 'Repeating the size is not');
});

test('Claude sessions record lastOutputAt but emit no activity events', async t => {
  const f = await outputting(t, 'claude');
  f.data('hello'); t.mock.timers.tick(20_000); f.data('again'); t.mock.timers.tick(20_000);
  assert.ok(f.latest()); assert.equal(f.events.length, 0);
});

test('lastOutputAt is persisted with the five-second metadata save', async t => {
  const f = await outputting(t);
  f.data('one'); t.mock.timers.tick(5001); f.data('two');
  assert.ok(f.latest());
  assert.equal(f.store.getSession(f.session.id).lastOutputAt, f.latest());
});

test('exit clears the pending heartbeat', async t => {
  const f = await outputting(t);
  f.data('one'); t.mock.timers.tick(100); f.data('two');
  assert.ok(f.manager.entry(f.session.id).activityTimer);
  f.procs[0].callbacks.exit({ exitCode: 0 });
  assert.equal(f.manager.entry(f.session.id).activityTimer, null);
  t.mock.timers.tick(10_000);
  assert.equal(f.events.length, 1);
});

// Phase 2: what an open Claude permission prompt asks, redacted and bounded.
const pendingOf = h => { const { pending } = h.f.store.getSession(h.session.id); return pending && { tool: pending.tool, command: pending.command, path: pending.path, ...('inferred' in pending ? { inferred: pending.inferred } : {}) }; };

test('a PermissionRequest with a command sets a redacted pending snapshot', async t => {
  const h = await hooked(t); const statuses = []; h.f.manager.on('event', e => { if (e.type === 'status') statuses.push(e.session); });
  assert.equal(h.session.pending, null);
  h.send('PermissionRequest', { tool: 'Bash', toolUseId: 'b1', command: 'TOKEN=abc123456 npm publish' });
  assert.deepEqual(pendingOf(h), { tool: 'Bash', command: 'TOKEN=[redacted] npm publish', path: null });
  assert.ok(!Number.isNaN(Date.parse(h.f.store.getSession(h.session.id).pending.at)));
  assert.equal(statuses.length, 1, 'One status event carries both the state and the detail');
  assert.equal(statuses[0].status, 'waiting'); assert.equal(statuses[0].pending.command, 'TOKEN=[redacted] npm publish');
  h.send('PostToolUse', { tool: 'Bash', toolUseId: 'b1' });
  assert.equal(h.f.store.getSession(h.session.id).pending, null);
  assert.equal(statuses.at(-1).pending, null);
});

test('pending is inferred from the in-flight tool when the request has no command', async t => {
  const h = await hooked(t);
  h.send('PreToolUse', { tool: 'Bash', toolUseId: 'b1', command: 'npm test' });
  h.send('PermissionRequest', { tool: 'Bash', command: '' });
  assert.deepEqual(pendingOf(h), { tool: 'Bash', command: 'npm test', path: null, inferred: true });
});

test('pending path is workspace-relative and null outside it', async t => {
  const h = await hooked(t);
  h.send('PermissionRequest', { tool: 'Write', toolUseId: 'w1', filePath: join(h.session.cwd, 'src', 'a.mjs') });
  assert.deepEqual(pendingOf(h), { tool: 'Write', command: null, path: 'src/a.mjs' });
  h.send('Stop');
  h.send('PermissionRequest', { tool: 'Write', toolUseId: 'w2', filePath: resolve(h.session.cwd, '..', 'elsewhere.txt') });
  assert.deepEqual(pendingOf(h), { tool: 'Write', command: null, path: null });
  h.send('Stop');
  h.send('PermissionRequest', { tool: 'Write', toolUseId: 'w3', filePath: '' });
  assert.deepEqual(pendingOf(h), { tool: 'Write', command: null, path: null });
});

test('pending clears on settlement, Stop, UserPromptSubmit, an answer key, SessionStart and exit', async t => {
  const cases = {
    'tool completion': h => h.send('PostToolUse', { tool: 'Bash', toolUseId: 'b1' }),
    'Stop': h => h.send('Stop'),
    'UserPromptSubmit': h => h.send('UserPromptSubmit'),
    'SessionStart': h => h.send('SessionStart'),
    'answer key': h => h.write('1'),
    'Esc': h => h.write('\x1b'),
    'exit': h => h.f.callbacks.exit({ exitCode: 0 }),
  };
  for (const [name, settle] of Object.entries(cases)) {
    const h = await hooked(t);
    h.send('PreToolUse', { tool: 'Bash', toolUseId: 'b1', command: 'rm -rf build' });
    h.send('PermissionRequest', { tool: 'Bash', toolUseId: 'b1', command: 'rm -rf build' });
    assert.equal(pendingOf(h).command, 'rm -rf build', name);
    settle(h);
    assert.equal(h.f.store.getSession(h.session.id).pending, null, name);
    assert.equal(h.f.manager.entry(h.session.id).session.pending, null, name);
  }
});

test('with two open prompts pending shows the oldest, then the next', async t => {
  const h = await hooked(t);
  h.send('PermissionRequest', { tool: 'Bash', command: 'first' });
  h.send('PermissionRequest', { tool: 'Edit', filePath: join(h.session.cwd, 'b.txt') });
  assert.equal(pendingOf(h).command, 'first');
  h.write('1'); h.send('PreToolUse', { tool: 'Grep', toolUseId: 'g1' });
  assert.deepEqual(pendingOf(h), { tool: 'Edit', command: null, path: 'b.txt' }, 'PreToolUse settlement moves to the next prompt');
  assert.equal(h.state(), 'waiting/permission');
  h.write('1');
  assert.equal(pendingOf(h), null);
});

test('the permission timeline event carries tool, command, path and toolUseId', async t => {
  const h = await hooked(t);
  h.send('PermissionRequest', { tool: 'Bash', toolUseId: 'b9', command: 'API_KEY=abcd1234 rm x' });
  h.send('PermissionRequest', { tool: 'Write', toolUseId: 'w9', filePath: join(h.session.cwd, 'c.txt') });
  const bodies = h.f.store.listEvents(h.session.id).filter(e => e.kind === 'permission').map(e => e.body);
  assert.deepEqual(bodies, [{ tool: 'Bash', command: 'API_KEY=[redacted] rm x', path: null, toolUseId: 'b9' }, { tool: 'Write', command: null, path: 'c.txt', toolUseId: 'w9' }]);
});

test('Esc or Ctrl+C while working shows Your turn; a later tool event restores Working', async t => {
  for (const key of ['\x1b', '\x03']) {
    const { send, state, write } = await hooked(t);
    send('UserPromptSubmit');
    send('PreToolUse', { tool: 'Bash', toolUseId: 'b1', command: 'sleep 600' });
    assert.equal(state(), 'running/working');
    write(key);
    assert.equal(state(), 'running/idle', JSON.stringify(key));
    // The interrupted command reports its end; that is not new work.
    send('PostToolUseFailure', { tool: 'Bash', toolUseId: 'b1', interrupted: true });
    assert.equal(state(), 'running/idle', JSON.stringify(key));
    // If the key did not end the turn (it closed a menu), the next tool event says so.
    send('PreToolUse', { tool: 'Read', toolUseId: 'r1' });
    assert.equal(state(), 'running/working', JSON.stringify(key));
    write(key); assert.equal(state(), 'running/idle');
    send('PostToolUse', { tool: 'Read', toolUseId: 'r1' });
    assert.equal(state(), 'running/working', 'A completed tool also restores Working');
  }
});

test('Esc or Ctrl+C after typing during the turn leaves Working (it may close a menu or leave vim insert mode)', async t => {
  for (const [typed, key] of [['abc', '\x1b'], ['/co', '\x1b'], ['x', '\x03'], ['\x1b[200~pasted\x1b[201~', '\x1b']]) {
    const { send, state, write } = await hooked(t);
    write('typed before the turn');
    send('UserPromptSubmit');
    write(typed);
    write(key);
    assert.equal(state(), 'running/working', JSON.stringify([typed, key]));
    // A new turn starts clean: only typing since the turn began counts.
    send('Stop'); send('UserPromptSubmit');
    write('\x1b[A'); write(key);
    assert.equal(state(), 'running/idle', JSON.stringify([typed, key]));
  }
});

test('arrow keys and Alt+letter while working do not change state', async t => {
  const { send, state, write } = await hooked(t);
  send('UserPromptSubmit');
  for (const key of ['\x1b[A', '\x1bb', 'abc', '\x1b\x1b']) { write(key); assert.equal(state(), 'running/working', JSON.stringify(key)); }
});

test('Esc while idle or for Codex changes nothing', async t => {
  const { send, state, write } = await hooked(t);
  send('Stop'); write('\x1b'); assert.equal(state(), 'running/idle');
  const f = multi(t); const codex = await f.start('codex');
  f.manager.write(codex.id, '\x03');
  assert.equal(f.store.getSession(codex.id).status, 'running'); assert.equal(f.store.getSession(codex.id).activity, null);
});

test('start stores the CLI version main detected and persists it; resume records the version at resume time', async t => {
  const f = runtime(t);
  const started = await f.manager.start({ projectId: f.project.id, provider: 'claude', task: 'Version task', cliVersion: '2.1.0 (Claude Code)' });
  assert.equal(started.session.cliVersion, '2.1.0 (Claude Code)');
  assert.equal(f.store.getSession(started.session.id).cliVersion, '2.1.0 (Claude Code)', 'kept in the stored session body');
  f.callbacks.exit({ exitCode: 0 });
  const resumed = await f.manager.start({ projectId: f.project.id, provider: 'claude', resumeId: started.session.id, cliVersion: '2.2.0 (Claude Code)' });
  assert.equal(resumed.session.cliVersion, '2.2.0 (Claude Code)');
});

test('a missing or non-string CLI version becomes null, and a long one is cut to 64 characters', async t => {
  const f = runtime(t);
  assert.equal((await f.manager.start({ projectId: f.project.id, provider: 'codex', task: 'a' })).session.cliVersion, null);
  assert.equal((await f.manager.start({ projectId: f.project.id, provider: 'codex', task: 'b', cliVersion: { evil: true } })).session.cliVersion, null);
  assert.equal((await f.manager.start({ projectId: f.project.id, provider: 'codex', task: 'c', cliVersion: 'x'.repeat(200) })).session.cliVersion.length, 64);
});
