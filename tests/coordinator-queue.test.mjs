import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkerManager } from '../src/runtime/workers.mjs';
test('a capacity-held coordinator stays durable and launches when capacity returns', async () => {
  let run = { id: 'run', state: 'creating', provider: 'claude', logicalBranch: 'main', projectId: 'project', goal: 'Fixture', coordinatorHistory: [] }; let held = true; let launched = 0;
  const store = { project: async () => ({ branch: 'main' }), createRun: async () => run, getRun: async () => run, activeRuns: async () => [run], setRunState: async (_id, state, patch) => { run = { ...run, ...patch, state }; return run; } };
  const manager = new WorkerManager({ store, terminals: { slots: { reserve: () => 'lease', release: () => {} }, startReserved: async () => { launched++; return { session: { id: 'session' } }; } } });
  manager.capacity = { coordinatorDecision: async () => ({ verdict: held ? 'hold' : 'admit', reasons: held ? ['MEMORY'] : [] }) };
  assert.equal((await manager.startRun({ provider: 'claude' })).state, 'creating'); assert.equal(launched, 0);
  held = false; await manager.launchQueuedCoordinators(); assert.equal(run.state, 'active'); assert.equal(launched, 1);
  await manager.launchQueuedCoordinators(); assert.equal(launched, 1);
});
test('recovery settles a stopped permission wait and allows interrupted sessions only with writer exclusion', async () => {
  let attempt = { id: 'attempt', runId: 'run', state: 'waiting_for_user', presence: 'lost', currentSessionId: 'session', launchId: 'launch', turnId: 'turn', environmentId: 'env' };
  let session = { id: 'session', runId: 'run', role: 'worker', attemptId: 'attempt', launchId: 'launch', status: 'interrupted', survivors: [] };
  let settled = null;
  const store = { activeRuns: async () => [{ id: 'run' }], getRun: async () => ({ id: 'run', attempts: [attempt] }), getSession: async () => session,
    setPresence: async (_id, presence) => { attempt = { ...attempt, presence }; },
    setAttemptState: async (_id, state) => { attempt = { ...attempt, state }; return attempt; },
    snapshotEnvironment: async () => ({ result: { resultId: 'result' } }), settleAttempt: async (_id, boundary) => { settled = boundary; attempt.state = 'result_available'; } };
  const manager = new WorkerManager({ store, terminals: { entry: () => null }, environments: { follow: async () => {} } });
  await manager.recover(); assert.equal(attempt.presence, 'paused'); assert.equal(attempt.state, 'result_available'); assert.equal(settled.outcome, 'interrupted');
  await manager.assertNoWriters(attempt);
  session = { ...session, survivors: null }; await assert.rejects(manager.assertNoWriters(attempt), { code: 'WRITERS_UNKNOWN' });
});
test('a coordinator waits when its pinned branch no longer matches the checkout', async () => {
  let run = { id: 'run', state: 'creating', provider: 'claude', projectId: 'project', logicalBranch: 'main' };
  const store = { project: async () => ({ branch: 'other' }), getRun: async () => run, setRunState: async (_id, state, patch) => { run = { ...run, ...patch, state }; } };
  const manager = new WorkerManager({ store, terminals: { slots: { reserve: () => { throw new Error('Must not reserve'); } } } });
  assert.deepEqual((await manager.launchCoordinator(run, 'claude')).admission.reasons, ['BRANCH_MOVED']);
  await assert.rejects(manager.launchCoordinator(run, 'claude', 'session'), { code: 'BRANCH_MOVED' });
});

test('coordinator resume returns the durable outcome before checking the now-active run', async () => {
  const outcome = { id: 'run', state: 'active', coordinatorSessionId: 'resumed' };
  const manager = new WorkerManager({ store: { runOperationOutcome: async (kind, input) => { assert.equal(kind, 'resume_coordinator'); assert.equal(input.requestId, 'same-request'); return { found: true, outcome }; }, getRun: async () => outcome } });
  assert.deepEqual(await manager.resumeCoordinator({ runId: 'run', callerId: 'desktop', requestId: 'same-request' }), outcome);
});

test('queued coordinators stop draining when shutdown begins', async () => {
  const runs = ['a', 'b'].map(id => ({ id, state: 'creating', provider: 'claude' }));
  const manager = new WorkerManager({ store: { activeRuns: async () => runs } });
  let continuing = true; const launched = [];
  manager.queueCoordinator = async run => { launched.push(run.id); continuing = false; };
  await manager.launchQueuedCoordinators(() => continuing);
  assert.deepEqual(launched, ['a']);
});

test('a coordinator waiting behind another launch does not start after shutdown', async () => {
  const run = { id: 'waiting', state: 'creating', provider: 'claude' };
  const manager = new WorkerManager({ store: { activeRuns: async () => [run], getRun: async () => run } });
  let release; manager.coordinatorLane = new Promise(resolve => { release = resolve; });
  let continuing = true; let launched = false;
  manager.launchCoordinator = async () => { launched = true; };
  const drain = manager.launchQueuedCoordinators(() => continuing);
  await Promise.resolve();
  assert.equal(manager.starts.has(run.id), true, 'request is waiting in the occupied coordinator lane');
  continuing = false; release(); await drain; await manager.close();
  assert.equal(launched, false);
  assert.equal(manager.starts.size, 0);
});
