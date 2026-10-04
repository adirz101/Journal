import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

async function load(t) {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const dir = mkdtempSync(resolve('.cache/tmp', 'scheduler-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = readFileSync(new URL('../src/ui/previewScheduler.ts', import.meta.url), 'utf8');
  writeFileSync(join(dir, 'previewScheduler.mjs'), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
  return import(pathToFileURL(join(dir, 'previewScheduler.mjs')).href);
}

// A scheduler on mock timers whose requests stay pending until the test answers them.
async function harness(t) {
  const { createPreviewScheduler } = await load(t);
  mock.timers.enable({ apis: ['setTimeout'] }); t.after(() => mock.timers.reset());
  const requests = []; const applied = [];
  const scheduler = createPreviewScheduler({
    debounceMs: 250, idleMs: 1000,
    timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) },
    request: (kind, input) => new Promise((resolveRequest, reject) => requests.push({ kind, input, resolve: resolveRequest, reject })),
    onResult: outcome => applied.push(outcome),
  });
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const tick = async ms => { mock.timers.tick(ms); await settle(); };
  return { scheduler, requests, applied, tick, settle };
}

test('three keystrokes inside 250 ms send one selection request', async t => {
  const { scheduler, requests, tick } = await harness(t);
  scheduler.update('w'); await tick(100); scheduler.update('wo'); await tick(100); scheduler.update('wor');
  await tick(249); assert.equal(requests.length, 0);
  await tick(1);
  assert.deepEqual(requests.map(r => [r.kind, r.input]), [['selection', 'wor']]);
  // A change while that request is in flight sends exactly one more, for the newest text, after the reply.
  scheduler.update('work'); await tick(250); scheduler.update('workt'); await tick(250);
  assert.equal(requests.length, 1);
  requests[0].resolve('reply-wor'); await tick(0);
  assert.deepEqual(requests.map(r => r.input), ['wor', 'workt']);
});

test('a stale reply is dropped', async t => {
  const { scheduler, requests, applied, tick } = await harness(t);
  scheduler.update('payment'); await tick(250);
  scheduler.update('payment retries');
  requests[0].resolve('old'); await tick(0);
  assert.deepEqual(applied, [], 'the reply for older text is never applied');
  await tick(250);
  requests[1].resolve('new'); await tick(0);
  assert.deepEqual(applied.map(a => [a.kind, a.value]), [['selection', 'new']]);
});

test('the full check runs after 1 s idle and a late one never overwrites newer typing', async t => {
  const { scheduler, requests, applied, tick } = await harness(t);
  scheduler.update('worktree'); await tick(250);
  requests[0].resolve('selection-1'); await tick(0);
  await tick(749); assert.equal(requests.length, 1);
  await tick(1);
  assert.deepEqual(requests.map(r => r.kind), ['selection', 'full']);
  // For the same ticket, the full check wins over a selection reply, whatever the order.
  requests[1].resolve('full-1'); await tick(0);
  assert.deepEqual(applied.map(a => a.value), ['selection-1', 'full-1']);
  // A full check still in flight when the user types again is dropped.
  scheduler.update('worktree removal'); await tick(250);
  requests.at(-1).resolve('selection-2'); await tick(750);
  const full2 = requests.at(-1); assert.deepEqual([full2.kind, full2.input], ['full', 'worktree removal']);
  scheduler.update('worktree removal refuses');
  full2.resolve('full-2'); await tick(0);
  assert.ok(!applied.some(a => a.value === 'full-2'));
  // The newest text gets its own selection preview and full check.
  await tick(250);
  assert.deepEqual([requests.at(-1).kind, requests.at(-1).input], ['selection', 'worktree removal refuses']);
  requests.at(-1).resolve('selection-3'); await tick(750);
  assert.deepEqual([requests.at(-1).kind, requests.at(-1).input], ['full', 'worktree removal refuses']);
  requests.at(-1).resolve('full-3'); await tick(0);
  assert.deepEqual(applied.map(a => a.value), ['selection-1', 'full-1', 'selection-2', 'selection-3', 'full-3']);
  // A selection reply that arrives after the full check for the same text is dropped.
  scheduler.update('x'); await tick(250); await tick(750);
  const [sel, full] = requests.slice(-2);
  assert.deepEqual([sel.kind, full.kind], ['selection', 'full']);
  full.resolve('full-x'); await tick(0); sel.resolve('selection-x'); await tick(0);
  assert.equal(applied.at(-1).value, 'full-x');
});

test('leave-out requests immediately', async t => {
  const { scheduler, requests, tick } = await harness(t);
  scheduler.update({ disabled: [] }); await tick(250);
  requests[0].resolve('first'); await tick(0);
  scheduler.update({ disabled: ['note-1'] }, { immediate: true }); await tick(0);
  assert.deepEqual(requests.map(r => [r.kind, r.input.disabled]), [['selection', []], ['selection', ['note-1']]]);
  // Then the idle check as usual.
  requests[1].resolve('second'); await tick(1000);
  assert.equal(requests.at(-1).kind, 'full');
});

test('errors stay in the preview', async t => {
  const { scheduler, requests, applied, tick } = await harness(t);
  scheduler.update('token sk-live-1234'); await tick(250);
  requests[0].reject(new Error('This looks like a credential')); await tick(0);
  assert.deepEqual(applied, [{ kind: 'selection', ticket: 1, error: 'This looks like a credential' }]);
  // flush() runs the full check now and returns its result.
  scheduler.update('fine task'); const flushed = scheduler.flush(); await tick(0);
  assert.equal(requests.at(-1).kind, 'full'); requests.at(-1).resolve('receipt'); await tick(0);
  assert.equal((await flushed).value, 'receipt');
  // reset() drops everything in flight.
  scheduler.update('other project'); await tick(250); scheduler.reset();
  requests.at(-1).resolve('late'); await tick(0);
  assert.ok(!applied.some(a => a.value === 'late'));
  // With no input (after a reset or dispose), flush() resolves to null and sends nothing.
  const before = requests.length;
  assert.equal(await scheduler.flush(), null);
  assert.equal(requests.length, before);
});

test('a request that never answers times out, and previews continue', async t => {
  const { scheduler, requests, applied, tick } = await harness(t);
  scheduler.update('stuck'); await tick(1000);
  assert.deepEqual(requests.map(r => r.kind), ['selection', 'full']);
  requests[0].resolve('selection'); await tick(0);
  // The full check never answers: after 20 s it settles as an error instead of blocking later checks.
  await tick(19_999); assert.notEqual(applied.at(-1).error, 'timed out'); await tick(1);
  assert.equal(applied.at(-1).error, 'timed out');
  scheduler.update('stuck again'); await tick(1000);
  assert.deepEqual(requests.slice(-2).map(r => [r.kind, r.input]), [['selection', 'stuck again'], ['full', 'stuck again']]);
  // A failed full check does not hide a later selection reply for the same input.
  requests.at(-1).reject(new Error('no')); await tick(0);
  requests.at(-2).resolve('late selection'); await tick(0);
  assert.equal(applied.at(-1).value, 'late selection');
});
