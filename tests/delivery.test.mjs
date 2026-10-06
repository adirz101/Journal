import { test } from 'node:test';
import assert from 'node:assert/strict';
const { DeliveryManager } = await import('../src/runtime/delivery.mjs').catch(() => ({}));

function fixture() {
  const writes = []; const records = []; let valid = true; let allowed = true;
  const message = { id: 'message', runId: 'run', recipient: 'worker', text: 'Follow up', kind: 'instruction', target: { sessionId: 'session', launchId: 'launch' } };
  const store = {
    reserveMessage: async () => ({ ...message, delivery: { id: 'delivery' } }),
    deliveryAllowed: async () => allowed,
    recordMessageDelivery: async (id, value) => records.push(value.state),
  };
  const terminals = {
    qualifyBoundary: () => ({ eligible: valid, sessionId: 'session', launchId: 'launch' }),
    validateBoundary: () => ({ eligible: valid }),
    stageAutomatic: () => { writes.push('paste'); },
    submitAutomatic: () => { writes.push('enter'); },
    uncertainInput: () => writes.push('uncertain'),
  };
  return { message, store, terminals, records, writes, invalidate: () => { valid = false; }, cancel: () => { allowed = false; } };
}

test('a human handoff between paste and submit never sends an automatic Enter', async () => {
  const f = fixture(); f.store.recordMessageDelivery = async (id, value) => { f.records.push(value.state); if (value.state === 'staged') f.invalidate(); };
  const manager = new DeliveryManager(f); await manager.deliver(f.message);
  assert.deepEqual(f.writes, ['paste', 'uncertain']); assert.deepEqual(f.records, ['staged', 'uncertain']);
});
test('a cancelled durable reservation is checked before the first write', async () => {
  const f = fixture(); f.cancel(); const manager = new DeliveryManager(f); await manager.deliver(f.message);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.records, ['queued']);
});
test('a partial paste error is uncertain and never gets an automatic retry or Enter', async () => {
  const f = fixture(); f.terminals.stageAutomatic = () => { f.writes.push('partial'); throw new Error('pty failed'); };
  const manager = new DeliveryManager(f); await manager.deliver(f.message);
  assert.deepEqual(f.writes, ['partial', 'uncertain']); assert.deepEqual(f.records, ['uncertain']);
});
test('successful submission is transport evidence, not acknowledgment', async () => {
  const f = fixture(); const manager = new DeliveryManager(f); await manager.deliver(f.message);
  assert.deepEqual(f.writes, ['paste', 'enter']); assert.deepEqual(f.records, ['staged', 'submitted']);
});
