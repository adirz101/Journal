import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContinuationManager } from '../src/runtime/continuation.mjs';
test('continuation is neutral unless specifically validated and never answers a permission hook', async () => {
  let validated = false; let writes = 0;
  const entry = { launchId: 'launch', currentTurn: 'turn', lastStopInvocation: { id: 'hook', turnId: 'turn' }, session: { provider: 'claude' } };
  const manager = new ContinuationManager({ store: { getRun: async () => { writes++; return {}; } }, terminals: { entry: () => entry, adapter: () => ({ continuation: { validated, format: 'claude-stop-block' } }) } });
  const grant = manager.issue({ sessionId: 'session', launchId: 'launch', runId: 'run', role: 'coordinator' });
  assert.deepEqual(await manager.request(grant.id, { event: 'Stop', invocationId: 'hook' }), {}); validated = true;
  assert.deepEqual(await manager.request(grant.id, { event: 'PermissionRequest', turnId: 'turn' }), {}); assert.equal(writes, 0);
  entry.exited = true; await assert.rejects(manager.request(grant.id, { event: 'Stop', invocationId: 'hook' }), { code: 'STALE_LAUNCH' });
});
test('a validated Stop submits one correlated message, suppresses repeated hooks, and does not acknowledge it', async () => {
  const states = []; const manager = new ContinuationManager({ store: { getRun: async () => ({ id: 'run', messages: [{ id: 'message', recipient: 'coordinator', state: 'queued', text: 'Fixture follow-up' }] }), reserveMessage: async () => ({ delivery: { id: 'receipt' } }), deliveryAllowed: async () => true, recordMessageDelivery: async (_id, outcome) => states.push(outcome.state) },
    terminals: { entry: () => ({ launchId: 'launch', currentTurn: 'turn', lastStopInvocation: { id: 'hook', turnId: 'turn' }, session: { provider: 'claude' } }), adapter: () => ({ continuation: { validated: true, format: 'claude-stop-block' } }), qualifyBoundary: () => ({ eligible: true, launchId: 'launch', sessionId: 'session' }), validateBoundary: () => ({ eligible: true }) } });
  const grant = manager.issue({ sessionId: 'session', launchId: 'launch', runId: 'run', role: 'coordinator' });
  const response = await manager.request(grant.id, { event: 'Stop', invocationId: 'hook' }); assert.equal(response.decision, 'block'); assert.match(response.reason, /receipt/); assert.deepEqual(states, ['submitted']);
  assert.deepEqual(await manager.request(grant.id, { event: 'Stop', invocationId: 'hook' }), {}); assert.deepEqual(states, ['submitted']);
});
test('continuation requires the exact observed Stop invocation', async () => {
  const entry = { launchId: 'launch', currentTurn: 'turn', lastStopInvocation: { id: 'observed', turnId: 'turn' }, session: { provider: 'claude' } };
  let reads = 0;
  const manager = new ContinuationManager({ store: { getRun: async () => { reads++; return { paused: true }; } }, terminals: { entry: () => entry, adapter: () => ({ continuation: { validated: true, format: 'claude-stop-block' } }), qualifyBoundary: () => ({ eligible: true }) } });
  const grant = manager.issue({ sessionId: 'session', launchId: 'launch', runId: 'run' });
  await manager.request(grant.id, { event: 'Stop', invocationId: 'old' }); assert.equal(reads, 0);
  await manager.request(grant.id, { event: 'Stop', invocationId: 'observed' }); assert.equal(reads, 1);
});
test('continuation output rejects extra permission fields and oversized responses', async () => {
  const { continuationResponse } = await import('../src/runtime/continuation-response.mjs');
  assert.deepEqual(continuationResponse({ decision: 'block', reason: 'message' }), { decision: 'block', reason: 'message' });
  for (const value of [{ decision: 'allow', reason: 'message' }, { decision: 'block', reason: 'message', permissionDecision: 'allow' }, { decision: 'block', reason: 'x'.repeat(12001) }, {}]) assert.equal(continuationResponse(value), null);
});
