import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProcessRunner } from '../src/desktop/processes.mjs';

// A fake pseudo-terminal spawn: each call returns a controllable process.
function fake() {
  const events = []; const procs = []; const pending = [];
  const runner = new ProcessRunner(event => events.push(event), (file, args) => new Promise(resolve => {
    const proc = { file, args, pid: undefined, writes: [], onData(cb) { this.data = cb; }, onExit(cb) { this.exit = cb; }, write(d) { this.writes.push(d); }, resize() {}, kill() { this.killed = true; } };
    procs.push(proc); pending.push(() => resolve(proc));
  }));
  const spawned = () => { while (pending.length) pending.shift()(); };
  return { runner, events, procs, spawned };
}

test('one run per provider and kind', async () => {
  const { runner, spawned } = fake();
  const claude = runner.start({ provider: 'claude', kind: 'login' }, { file: 'claude', args: ['auth', 'login'] });
  const cursor = runner.start({ provider: 'cursor', kind: 'install' }, { file: 'bash', args: [] });
  const codex = runner.start({ provider: 'codex', kind: 'login' }, { file: 'codex', args: ['login'] });
  await assert.rejects(runner.start({ provider: 'claude', kind: 'login' }, { file: 'claude', args: [] }), /already running/, 'A double click starts one process');
  spawned();
  const ids = await Promise.all([claude, cursor, codex]);
  assert.equal(new Set(ids.map(r => r.id)).size, 3);
  for (const bad of [null, 'login', { provider: 'claude' }, { provider: 'other', kind: 'login' }, { provider: 'claude', kind: 'update' }]) await assert.rejects(runner.start(bad, { file: 'x', args: [] }), /Invalid process/);
  // A failed start frees its slot.
  const failing = new ProcessRunner(() => {}, async () => { throw new Error('spawn failed'); });
  await assert.rejects(failing.start({ provider: 'cursor', kind: 'install' }, { file: 'x', args: [] }), /spawn failed/);
  assert.deepEqual(failing.running(), []);
});

test('process-exit carries provider and kind', async () => {
  const { runner, events, procs, spawned } = fake();
  const started = runner.start({ provider: 'codex', kind: 'login' }, { file: 'codex', args: ['login'] }); spawned(); const { id } = await started;
  procs[0].data('hello ');
  procs[0].exit({ exitCode: 0 });
  assert.deepEqual(events.at(-1), { type: 'process-exit', id, provider: 'codex', kind: 'login', code: 0 });
  assert.equal(runner.snapshot(id).done, true);
  // The slot is free again once the run ends.
  const again = runner.start({ provider: 'codex', kind: 'login' }, { file: 'codex', args: ['login'] }); spawned(); await again;
});

test('running lists provider and kind', async () => {
  const { runner, procs, spawned } = fake();
  const a = runner.start({ provider: 'claude', kind: 'install' }, { file: 'bash', args: [] });
  const b = runner.start({ provider: 'codex', kind: 'login' }, { file: 'codex', args: [] }); spawned(); await Promise.all([a, b]);
  assert.deepEqual(runner.running(), [{ provider: 'claude', kind: 'install' }, { provider: 'codex', kind: 'login' }]);
  procs[0].exit({ exitCode: 1 });
  assert.deepEqual(runner.running(), [{ provider: 'codex', kind: 'login' }]);
});

test('catch-up snapshots and no input after exit', async () => {
  const { runner, events, procs, spawned } = fake();
  const started = runner.start({ provider: 'cursor', kind: 'login' }, { file: 'x', args: [] }); spawned(); const { id } = await started;
  procs[0].data('hello '); procs[0].data('world');
  assert.deepEqual(runner.snapshot(id), { data: 'hello world', length: 11, done: false, code: null });
  assert.deepEqual(events.map(e => e.offset), [0, 6]);
  runner.write(id, 'y'); assert.deepEqual(procs[0].writes, ['y']);
  procs[0].exit({ exitCode: 0 });
  assert.throws(() => runner.write(id, 'late'), /finished/);
  runner.stop(id); assert.equal(procs[0].killed, undefined, 'A finished process is not signalled');
});
