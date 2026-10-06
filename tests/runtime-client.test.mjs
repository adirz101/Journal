import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeClient } from '../src/desktop/runtime-client.mjs';
import { buildId } from '../src/runtime/protocol.mjs';
import { removeLater } from './support/cleanup.mjs';

const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(check, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await wait(10); }
  throw new Error('Timed out waiting for condition');
}
const fakeSocket = () => Object.assign(new EventEmitter(), { write() {}, end() {}, destroy() {} });
// A client whose pauses between reconnect attempts never end on their own: only
// retryNow() (or close) wakes them, so a test sees exactly what the retry did.
function client(t, options = {}) {
  const dataDir = mkdtempSync(resolve(process.env.JOURNAL_TEST_TMP ?? tmpdir(), 'rtc-'));
  const pauses = [];
  const c = new RuntimeClient({ dataDir, launch: () => null, connectTimeoutMs: 30, delay: ms => { pauses.push(ms); return new Promise(() => {}); }, ...options });
  t.after(async () => { await c.close(); removeLater(dataDir); });
  return { c, pauses };
}

test('retryNow wakes a waiting reconnect and emits reconnected once', async t => {
  const { c, pauses } = client(t);
  let ready = false; const socket = fakeSocket(); const hello = { runtimeId: 'r', build: buildId(), protocol: 4, live: 0, recovery: null };
  c.attempt = async () => ready ? { socket, hello } : null;
  const events = []; c.on('reconnected', value => events.push(value));
  const loop = c.reconnect();
  assert.equal(c.reconnect(), loop, 'one reconnect loop at a time');
  await until(() => pauses.length === 1 && c.wake);
  ready = true;
  assert.equal(c.retryNow(), true);
  c.retryNow(); // a second click while the first retry runs starts nothing new
  await loop;
  assert.deepEqual(events, [hello]);
  assert.equal(c.socket, socket); assert.equal(pauses.length, 1, 'no further pause after connecting');
  assert.equal(c.retryNow(), false, 'nothing to retry while connected');
  // A later disconnect reconnects once more.
  const next = new Promise(r => c.once('reconnected', r));
  socket.emit('close');
  assert.equal(await next, hello);
  assert.equal(events.length, 2);
});

test('retryNow after failed launches again', async t => {
  let launches = 0; const failures = [];
  const { c } = client(t, { launch: () => { launches++; return null; } });
  c.attempt = async () => null;
  c.on('failed', message => failures.push(message));
  for (let i = 0; i < 4; i++) await assert.rejects(c.connect());
  assert.equal(launches, 3); assert.ok(failures.length >= 1, 'the three-launch stop was reported');
  assert.equal(c.retryNow(), true);
  await until(() => launches === 4);
  await until(() => c.wake); // the loop is waiting again, without launching more
  assert.equal(launches, 4);
});

test('retryNow during a connect attempt launches without waiting for its deadline', async t => {
  let launches = 0;
  const { c } = client(t, { launch: () => { launches++; return null; }, connectTimeoutMs: 5000 });
  c.attempt = async () => null; c.launches = 3; // after the three-launch stop
  const connecting = c.connect().catch(() => {});
  await wait(20); assert.equal(launches, 0);
  c.retryNow();
  await until(() => launches === 1, 1000);
  await c.close(); await connecting;
});

test('retryNow also wakes the protocol-mismatch wait and reports a remaining mismatch again', async t => {
  const { c, pauses } = client(t);
  const warnings = []; c.on('warning', message => warnings.push(message));
  c.attempt = async () => ({ mismatch: 3 });
  void c.reconnect();
  await until(() => pauses.length === 1);
  assert.equal(pauses[0], 30000); assert.equal(warnings.length, 1);
  c.retryNow();
  await until(() => pauses.length === 2);
  assert.equal(warnings.length, 2);
});

test('a retry asked for during a connect that then succeeds is not left for the next connect', async t => {
  let launches = 0; let ready = false;
  const { c } = client(t, { launch: () => { launches++; return { alive: () => true }; }, connectTimeoutMs: 5000 });
  c.attempt = async () => ready ? { socket: fakeSocket(), hello: { runtimeId: 'r', build: buildId(), live: 0 } } : null;
  const connecting = c.connect();
  await until(() => launches === 1);
  c.retryNow(); ready = true; // the retry's launch is not needed: the runtime answers first
  await connecting;
  assert.equal(c.retry, false);
  // Disconnected again with the runtime still starting (alive): a new connect launches nothing.
  c.socket = null; ready = false; c.launches = 0;
  const again = c.connect().catch(() => {});
  await wait(60); ready = true; await again;
  assert.equal(launches, 1);
});

test('a woken pause clears its timer, and the default pause never holds the process open', async t => {
  const signals = [];
  const { c } = client(t, { delay: (ms, signal) => { signals.push(signal); return new Promise(() => {}); } });
  c.attempt = async () => null;
  void c.reconnect();
  await until(() => signals.length === 1 && c.wake);
  assert.equal(signals[0].aborted, false);
  c.retryNow();
  assert.equal(signals[0].aborted, true, 'the pause was told to stop its timer');
  // The default pause: unref'd and cleared on abort.
  const timers = []; const cleared = [];
  const realSet = globalThis.setTimeout; const realClear = globalThis.clearTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...rest) => { const timer = realSet(fn, ms, ...rest); if (ms === 60_000) timers.push(timer); return timer; });
  t.mock.method(globalThis, 'clearTimeout', timer => { cleared.push(timer); realClear(timer); });
  const plain = new RuntimeClient({ dataDir: tmpdir(), launch: () => null });
  const pause = plain.pause(60_000);
  assert.equal(timers.length, 1); assert.equal(timers[0].hasRef(), false, 'unref\'d');
  plain.wake(); await pause;
  assert.ok(cleared.includes(timers[0]), 'no timer left after a wake');
});

test('the build-mismatch warning belongs to the current connection', async t => {
  const { c } = client(t);
  const socket = fakeSocket();
  c.adopt({ socket, hello: { runtimeId: 'r', build: 'other', live: 1 } });
  assert.match(c.warning, /another version of Journal/);
  c.socket = null; c.adopt({ socket: fakeSocket(), hello: { runtimeId: 'r', build: buildId(), live: 0 } });
  assert.equal(c.warning, null);
});

// A fake runtime connection that answers list and records every request.
function runtimeOf(c, { build = 'other', sessions = [] } = {}) {
  const requests = []; const socket = fakeSocket();
  socket.write = data => { for (const line of String(data).split('\n').filter(Boolean)) { const message = JSON.parse(line); requests.push(message);
    queueMicrotask(() => c.receive({ id: message.id, value: message.method === 'list' ? sessions : { stopping: 0 } })); } };
  c.adopt({ socket, hello: { runtimeId: 'r', build, live: sessions.length } });
  return { requests, socket, setSessions: next => { sessions = next; } };
}

test('another build\'s runtime is replaced only once it holds no running session, stopping nothing', async t => {
  const { c } = client(t); const switching = [];
  c.on('switching', () => switching.push(true));
  const r = runtimeOf(c, { sessions: [{ id: 'a', status: 'running' }, { id: 'b', status: 'exited' }] });
  assert.equal(c.otherBuild, true);
  assert.equal(await c.switchIfIdle(), false, 'A running session keeps it');
  for (const status of ['starting', 'waiting', 'stopping', 'orphaned']) { r.setSessions([{ id: 'a', status }]); assert.equal(await c.switchIfIdle(), false, status); }
  assert.ok(!r.requests.some(m => m.method === 'shutdown'));
  r.setSessions([{ id: 'a', status: 'exited' }, { id: 'b', status: 'interrupted' }, { id: 'c', status: 'stopped' }]);
  assert.equal(await c.switchIfIdle(), true);
  assert.deepEqual(r.requests.filter(m => m.method === 'shutdown').map(m => m.params), [{ stopSessions: false }]);
  assert.deepEqual([switching.length, c.switching], [1, true]);
  assert.equal(await c.switchIfIdle(), false, 'Once');
});

test('Switch now stops the other build\'s sessions; this build\'s runtime is never switched', async t => {
  const { c } = client(t);
  const r = runtimeOf(c, { sessions: [{ id: 'a', status: 'running' }] });
  assert.equal(await c.switchNow(), true);
  assert.deepEqual(r.requests.filter(m => m.method === 'shutdown').map(m => m.params), [{ stopSessions: true }]);
  const { c: same } = client(t);
  const own = runtimeOf(same, { build: buildId(), sessions: [] });
  assert.deepEqual([same.otherBuild, same.warning, await same.switchIfIdle(), await same.switchNow()], [false, null, false, false]);
  assert.equal(own.requests.length, 0);
  // A new connection clears the switch in progress.
  same.socket = null; same.adopt({ socket: fakeSocket(), hello: { runtimeId: 'r2', build: buildId(), live: 0 } }); assert.equal(same.switching, false);
});
