import { test } from 'node:test';
import assert from 'node:assert/strict';
const { ToolRouter } = await import('../src/runtime/tool-router.mjs').catch(() => ({}));

test('tool credentials are per launch, role scoped and revoked when the session ends', async () => {
  const bindings = new Map([['session', { launchId: 'launch', exited: false }]]);
  const store = { getRun: async id => ({ id, tasks: [{ id: 'task' }], attempts: [{ id: 'own', runId: id }, { id: 'other', runId: id }] }), reportWorker: async input => input };
  const router = new ToolRouter({ store, terminals: { entry: id => bindings.get(id) }, workers: {} });
  const grant = router.issue({ sessionId: 'session', launchId: 'launch', role: 'worker', runId: 'run', attemptId: 'own' });
  const role = router.authenticate(grant.id); assert.equal(role.token, grant.token);
  const invoke = (tool, args = {}) => router.call(grant.id, { tool, args });
  await assert.rejects(invoke('create_worker', { taskId: 'task' }), { code: 'FORBIDDEN' });
  await assert.rejects(invoke('report_result', { runId: 'another' }), { code: 'NOT_FOUND' });
  await assert.rejects(invoke('report_result', { attemptId: 'other' }), { code: 'NOT_FOUND' });
  const value = await invoke('report_result', { requestId: 'one', turnId: 'turn', status: 'done', summary: 'claim', callerId: 'forged', launchId: 'forged' });
  assert.equal(value.callerId, 'worker:own'); assert.equal(value.launchId, 'launch'); assert.equal(value.attemptId, 'own');
  bindings.get('session').exited = true;
  await assert.rejects(invoke('inbox'), { code: 'STALE_LAUNCH' });
  router.revoke(grant.id); assert.equal(router.authenticate(grant.id), null);
});

test('coordinator cannot name foreign IDs or call desktop-only operations', async () => {
  const router = new ToolRouter({ store: { getRun: async () => ({ tasks: [], attempts: [], messages: [] }) }, terminals: { entry: () => ({ launchId: 'launch', exited: false }) }, workers: {} });
  const grant = router.issue({ sessionId: 'session', launchId: 'launch', role: 'coordinator', runId: 'run' });
  await assert.rejects(router.call(grant.id, { tool: 'get_worker', args: { attemptId: 'foreign' } }), { code: 'NOT_FOUND' });
  await assert.rejects(router.call(grant.id, { tool: 'approve', args: {} }), { code: 'FORBIDDEN' });
  await assert.rejects(router.call(grant.id, { tool: 'write', args: {} }), { code: 'FORBIDDEN' });
  await assert.rejects(router.call(grant.id, { tool: 'get_run', args: [] }), { code: 'INVALID_INPUT' });
});
