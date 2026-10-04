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
