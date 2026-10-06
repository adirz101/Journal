import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { JournalStore } from '../src/core/store.mjs';
import { STORE_METHODS } from '../src/core/store-methods.mjs';
import { removeLater } from './support/cleanup.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'orchestration-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  const path = join(root, 'journal.sqlite'); const stores = [];
  const open = () => { const store = new JournalStore(path); stores.push(store); return store; };
  const store = open(); const project = store.openProject(root);
  t.after(() => { for (const s of stores) s.close(); removeLater(root); });
  return { store, project, open };
}
const request = (requestId, args = {}) => ({ callerId: 'fixture-coordinator', requestId, ...args });

test('durable messages use addressed pull receipts and never replay uncertain staged input', t => {
  const f = fixture(t); const run = f.store.createRun(request('run', { projectId: f.project.id, goal: 'fixture', logicalBranch: 'main' }));
  f.store.setRunState(run.id, 'starting', { coordinatorSessionId: 'session', coordinatorLaunchId: 'launch' });
  const input = request('message', { runId: run.id, recipient: 'coordinator', kind: 'instruction', text: 'Check the result' });
  const message = f.store.sendMessage(input);
  assert.equal(f.open().sendMessage(input).id, message.id);
  const target = { runId: run.id, recipient: 'coordinator', sessionId: 'session', launchId: 'launch' };
  assert.throws(() => f.store.getInbox({ ...target, launchId: 'old' }), { code: 'STALE_LAUNCH' });
  assert.throws(() => f.store.ackMessage(request('fake-ack', { ...target, messageId: message.id, receiptId: 'invented' })), { code: 'RECEIPT_MISMATCH' });
  const inbox = f.store.getInbox(target);
  assert.equal(inbox.messages[0].id, message.id);
  assert.equal(f.store.ackMessage(request('ack', { ...target, messageId: message.id, receiptId: inbox.receiptId })).state, 'acknowledged');
  const second = f.store.sendMessage({ ...input, requestId: 'second' });
  const delivery = f.store.reserveMessage(second.id, { ...target, inputGeneration: 0, observationGeneration: 1 });
  f.store.recordMessageDelivery(second.id, { deliveryId: delivery.delivery.id, state: 'staged' });
  f.open().recoverMessages();
  const recovered = f.store.getRun(run.id).messages.find(item => item.id === second.id);
  assert.equal(recovered.state, 'uncertain');
  assert.throws(() => f.store.reserveMessage(second.id, target), { code: 'INPUT_UNCERTAIN' });
  assert.throws(() => f.store.resendMessage(request('resend', { messageId: second.id })), { code: 'INPUT_UNCERTAIN' });
  f.store.resolveMessageInput(second.id, { launchId: 'launch', resolvedBy: 'user' });
  assert.equal(f.store.resendMessage(request('resend', { messageId: second.id })).state, 'queued');
  assert.notEqual(f.store.reserveMessage(second.id, target).delivery.id, delivery.delivery.id);
});

test('cancel during staging withholds submission; pulled receipt cannot cross recipient launches', t => {
  const f = fixture(t); const run = f.store.createRun(request('run', { projectId: f.project.id, goal: 'fixture', logicalBranch: 'main' }));
  f.store.setRunState(run.id, 'starting', { coordinatorSessionId: 'session', coordinatorLaunchId: 'one' });
  const target = { runId: run.id, recipient: 'coordinator', sessionId: 'session', launchId: 'one' };
  const m = f.store.sendMessage(request('send', { ...target, kind: 'instruction', text: 'Hello\u001b[2J' }));
  assert.ok(!m.text.includes('\u001b'));
  const pulled = f.store.getInbox(target);
  const delivery = f.store.reserveMessage(m.id, target);
  f.store.cancelMessage(request('cancel', { messageId: m.id }));
  assert.equal(f.store.deliveryAllowed(m.id, delivery.delivery.id), false);
  f.store.recordMessageDelivery(m.id, { deliveryId: delivery.delivery.id, state: 'uncertain' });
  f.store.setRunState(run.id, 'starting', { coordinatorSessionId: 'new-session', coordinatorLaunchId: 'two' });
  assert.throws(() => f.store.ackMessage(request('late', { ...target, messageId: m.id, receiptId: pulled.receiptId })), { code: 'STALE_LAUNCH' });
});

test('run/task/attempt requests survive restart, deduplicate durably and reject changed arguments', t => {
  const f = fixture(t);
  const input = request('run', { projectId: f.project.id, goal: 'Build a fixture', logicalBranch: 'main' });
  const run = f.store.createRun(input);
  const reopened = f.open();
  assert.deepEqual(reopened.createRun(input), run);
  assert.throws(() => reopened.createRun({ ...input, goal: 'different' }), { code: 'REQUEST_MISMATCH' });
  const task = reopened.createTask(request('task', { runId: run.id, title: 'Backend' }));
  const attempt = reopened.requestWorker(request('worker', { taskId: task.id, provider: 'claude' }));
  assert.equal(attempt.state, 'requested');
  assert.equal(reopened.getRun(run.id).attempts.length, 1);
  assert.equal(reopened.requestWorker(request('worker', { taskId: task.id, provider: 'claude' })).id, attempt.id);
  assert.throws(() => reopened.requestWorker(request('other-worker', { taskId: task.id, provider: 'claude' })), { code: 'ACTIVE_ATTEMPT' });
  assert.equal(reopened.runEvents(run.id).filter(event => event.kind === 'worker.requested').length, 1);
  for (const name of ['createRun', 'getRun', 'listRuns', 'createTask', 'requestWorker', 'listTasks', 'listAttempts', 'runEvents']) assert.ok(STORE_METHODS.includes(name), name);
});

test('blocked tasks have no attempt and removing their dependency does not start a worker', t => {
  const f = fixture(t); const run = f.store.createRun(request('run', { projectId: f.project.id, goal: 'fixture', logicalBranch: 'main' }));
  const a = f.store.createTask(request('a', { runId: run.id, title: 'A' }));
  const b = f.store.createTask(request('b', { runId: run.id, title: 'B', dependencies: [a.id] }));
  assert.equal(b.state, 'blocked');
  assert.throws(() => f.store.requestWorker(request('blocked', { taskId: b.id, provider: 'claude' })), { code: 'TASK_BLOCKED' });
  assert.throws(() => f.store.addDependency(request('cycle', { taskId: a.id, dependsOn: b.id })), { code: 'DEPENDENCY_CYCLE' });
  f.store.removeDependency(request('remove', { taskId: b.id, dependsOn: a.id }));
  assert.equal(f.store.listTasks(run.id).find(task => task.id === b.id).state, 'pending');
  assert.deepEqual(f.store.listAttempts(run.id), []);
  assert.equal(f.store.runEvents(run.id).filter(event => event.kind === 'task.unblocked').length, 1);
});

test('presence and work state are independent and a stale launch cannot change an attempt', t => {
  const f = fixture(t); const run = f.store.createRun(request('run', { projectId: f.project.id, goal: 'fixture', logicalBranch: 'main' }));
  const task = f.store.createTask(request('task', { runId: run.id, title: 'worker' }));
  const attempt = f.store.requestWorker(request('worker', { taskId: task.id, provider: 'claude' }));
  f.store.setAttemptState(attempt.id, 'starting', { launchId: 'launch-one' });
  f.store.setAttemptState(attempt.id, 'working', { launchId: 'launch-one' });
  f.store.setPresence(attempt.id, 'paused', { launchId: 'launch-one' });
  assert.equal(f.store.listAttempts(run.id)[0].state, 'working');
  assert.throws(() => f.store.setAttemptState(attempt.id, 'idle', { launchId: 'old-launch' }), { code: 'STALE_LAUNCH' });
  assert.throws(() => f.store.setAttemptState(attempt.id, 'integrated', { launchId: 'launch-one' }), { code: 'INVALID_STATE' });
  assert.throws(() => f.store.addDependency(request('late-dependency', { taskId: task.id, dependsOn: task.id })), { code: 'ACTIVE_ATTEMPT' });
});

test('a question during work settles only after the turn, and a previous turn report never makes the next ready', t => {
  const f = fixture(t); const run = f.store.createRun(request('run', { projectId: f.project.id, goal: 'fixture', logicalBranch: 'main' }));
  const task = f.store.createTask(request('task', { runId: run.id, title: 'worker' }));
  const attempt = f.store.requestWorker(request('worker', { taskId: task.id, provider: 'claude' }));
  f.store.setAttemptState(attempt.id, 'starting', { launchId: 'launch' });
  f.store.setAttemptState(attempt.id, 'working', { launchId: 'launch', turnId: 'one' });
  f.store.reportWorker(request('ask', { attemptId: attempt.id, launchId: 'launch', turnId: 'one', kind: 'ask', summary: 'Which database?' }));
  assert.equal(f.store.listAttempts(run.id)[0].state, 'working');
  assert.equal(f.store.settleAttempt(attempt.id, { launchId: 'launch', turnId: 'one', approvalOpen: true }).state, 'working');
  assert.equal(f.store.settleAttempt(attempt.id, { launchId: 'launch', turnId: 'one' }).state, 'waiting_for_coordinator');
  f.store.setAttemptState(attempt.id, 'working', { launchId: 'launch', turnId: 'two' });
  f.store.reportWorker(request('done', { attemptId: attempt.id, launchId: 'launch', turnId: 'two', kind: 'result', status: 'done', summary: 'No change needed' }));
  assert.equal(f.store.settleAttempt(attempt.id, { launchId: 'launch', turnId: 'two', captureVerified: true }).state, 'ready');
  f.store.setAttemptState(attempt.id, 'working', { launchId: 'launch', turnId: 'three' });
  assert.equal(f.store.settleAttempt(attempt.id, { launchId: 'launch', turnId: 'three' }).state, 'idle');
  assert.throws(() => f.store.reportWorker(request('late', { attemptId: attempt.id, launchId: 'launch', turnId: 'two', kind: 'result', status: 'done', summary: 'old' })), { code: 'STALE_TURN' });
});

test('admission persists intent, retries only proven resource failures and fences stale launches', t => {
  const f = fixture(t); const run = f.store.createRun(request('run', { projectId: f.project.id, goal: 'fixture', logicalBranch: 'main' }));
  const task = f.store.createTask(request('task', { runId: run.id, title: 'worker' }));
  const attempt = f.store.requestWorker(request('worker', { taskId: task.id, provider: 'claude' }));
  f.store.queueAttempt(attempt.id, { reasons: ['GLOBAL_CAP'] });
  assert.equal(f.open().queuedAttempts()[0].admission.reasons[0], 'GLOBAL_CAP');
  f.store.admitAttempt(attempt.id, { launchId: 'one', slot: 1 });
  assert.throws(() => f.store.admitAttempt(attempt.id, { launchId: 'duplicate', slot: 2 }), { code: 'INVALID_STATE' });
  f.store.failAttemptLaunch(attempt.id, { launchId: 'one', code: 'ENOMEM', noProcess: true, at: 1000 });
  assert.equal(f.store.queuedAttempts()[0].admission.backoffUntil, 16000);
  assert.throws(() => f.store.admitAttempt(attempt.id, { launchId: 'two', slot: 1, at: 1001 }), { code: 'BACKOFF' });
  f.store.admitAttempt(attempt.id, { launchId: 'two', slot: 1, at: 16001 });
  assert.throws(() => f.store.failAttemptLaunch(attempt.id, { launchId: 'one', code: 'ENOMEM', noProcess: true }), { code: 'STALE_LAUNCH' });
  f.store.failAttemptLaunch(attempt.id, { launchId: 'two', code: 'ENOMEM', noProcess: false });
  assert.equal(f.store.queuedAttempts().length, 0);
  assert.equal(f.store.listAttempts(run.id)[0].state, 'launch_failed');
});

test('recovery never replays an unresolved start and pause holds durable requests', t => {
  const f = fixture(t); const run = f.store.createRun(request('run', { projectId: f.project.id, goal: 'fixture', logicalBranch: 'main' }));
  const task = f.store.createTask(request('task', { runId: run.id, title: 'worker' }));
  const attempt = f.store.requestWorker(request('worker', { taskId: task.id, provider: 'claude' }));
  f.store.pauseRun(request('pause', { runId: run.id, paused: true }));
  assert.throws(() => f.store.admitAttempt(attempt.id, { launchId: 'one' }), { code: 'RUN_PAUSED' });
  f.store.pauseRun(request('unpause', { runId: run.id, paused: false }));
  f.store.admitAttempt(attempt.id, { launchId: 'one' });
  f.open().recoverOrchestration();
  assert.equal(f.store.queuedAttempts().length, 0);
  assert.equal(f.store.listAttempts(run.id)[0].admission.reasons[0], 'START_UNCERTAIN');
});

test('project data deletion removes orchestration records without violating foreign keys', t => {
  const f = fixture(t); f.store.createRun(request('run', { projectId: f.project.id, goal: 'fixture', logicalBranch: 'main' }));
  assert.equal(f.store.removeProject(f.project.id, { deleteData: true }).deletedData, true);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM runs').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM orchestration_operations').get().n, 0);
});

test('task cancellation does not kill live workers and finishing requires a reconciled run', t => {
  const f = fixture(t); const run = f.store.createRun(request('run', { projectId: f.project.id, goal: 'fixture', logicalBranch: 'main' }));
  const task = f.store.createTask(request('task', { runId: run.id, title: 'worker' }));
  const attempt = f.store.requestWorker(request('worker', { taskId: task.id, provider: 'claude' }));
  f.store.updateTask(request('update', { taskId: task.id, priority: 4 }));
  assert.equal(f.store.queuedAttempts()[0].priority, 4);
  f.store.admitAttempt(attempt.id, { launchId: 'launch' });
  assert.throws(() => f.store.cancelTask(request('cancel-live', { taskId: task.id })), { code: 'ACTIVE_ATTEMPT' });
  assert.throws(() => f.store.finishRun(request('finish', { runId: run.id, reason: 'Finished' })), { code: 'ACTIVE_ATTEMPT' });
  f.store.failAttemptLaunch(attempt.id, { launchId: 'launch', noProcess: true, code: 'PROVIDER_MISSING' });
  f.store.setAttemptState(attempt.id, 'retired', { launchId: 'launch' });
  f.store.cancelTask(request('cancel', { taskId: task.id }));
  f.store.setRunState(run.id, 'detached');
  assert.equal(f.store.finishRun(request('finish', { runId: run.id, reason: 'Finished' })).state, 'finished');
});

test('retry retires only settled attempts and preserves immutable history and provenance', t => {
  const f = fixture(t); const run = f.store.createRun(request('run', { projectId: f.project.id, goal: 'fixture', logicalBranch: 'main' }));
  const task = f.store.createTask(request('task', { runId: run.id, title: 'worker' }));
  const attempt = f.store.requestWorker(request('worker', { taskId: task.id, provider: 'claude' }));
  f.store.setAttemptState(attempt.id, 'starting', { launchId: 'launch' }); f.store.setAttemptState(attempt.id, 'working', { launchId: 'launch' });
  assert.throws(() => f.store.retryWorker(request('retry', { attemptId: attempt.id, provider: 'codex', from: 'base', reason: 'Try a different approach' })), { code: 'INVALID_STATE' });
  f.store.setAttemptState(attempt.id, 'idle', { launchId: 'launch' });
  const input = request('retry', { attemptId: attempt.id, provider: 'codex', from: 'base', reason: 'Try a different approach' });
  const retried = f.store.retryWorker(input);
  assert.equal(retried.retryOf, attempt.id); assert.equal(retried.provider, 'codex'); assert.equal(retried.state, 'requested');
  assert.equal(f.store.listAttempts(run.id)[0].state, 'retired'); assert.equal(f.open().retryWorker(input).id, retried.id);
});

test('resume queue preserves work state while reserving a fresh fenced launch', t => {
  const f = fixture(t); const run = f.store.createRun(request('run', { projectId: f.project.id, goal: 'fixture', logicalBranch: 'main' }));
  const task = f.store.createTask(request('task', { runId: run.id, title: 'worker' })); const a = f.store.requestWorker(request('worker', { taskId: task.id, provider: 'claude' }));
  f.store.setAttemptState(a.id, 'starting', { launchId: 'old' }); f.store.setAttemptState(a.id, 'working', { launchId: 'old', currentSessionId: 'session' }); f.store.setAttemptState(a.id, 'idle', { launchId: 'old' });
  f.store.requestResume(request('resume', { attemptId: a.id, sessionId: 'session' }));
  assert.equal(f.store.queuedAttempts()[0].state, 'idle');
  f.store.admitAttempt(a.id, { launchId: 'new', slot: 1 });
  assert.equal(f.store.listAttempts(run.id)[0].state, 'idle');
  assert.equal(f.store.listAttempts(run.id)[0].launchId, 'new');
  assert.throws(() => f.store.setPresence(a.id, 'live', { launchId: 'old' }), { code: 'STALE_LAUNCH' });
});
