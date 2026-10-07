import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { JournalStore } from '../src/core/store.mjs';
import { removeLater } from './support/cleanup.mjs';
const req = (requestId, args = {}) => ({ callerId: 'coordinator:fixture', requestId, ...args });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'journal-workflows-'));
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(root, 'file'), 'base\n'); git(['add', '.']); git(['commit', '-qm', 'base']);
  mkdirSync(join(root, 'data')); const store = new JournalStore(join(root, 'data', 'journal.sqlite')); const project = store.openProject(root);
  const run = store.createRun(req('run', { projectId: project.id, logicalBranch: 'main', goal: 'Fixture' }));
  t.after(() => { store.close(); removeLater(root); }); return { root, git, store, run };
}
test('variants pin one base, deduplicate batch creation, and cannot select a running loser', t => {
  const { store, run, git, root } = fixture(t);
  const task = store.createTask(req('task', { runId: run.id, title: 'Alternatives', variants: 2 }));
  const input = req('batch', { taskId: task.id, provider: 'claude' });
  const attempts = store.requestWorkers(input); assert.equal(attempts.length, 2);
  writeFileSync(join(root, 'next'), 'later'); git(['add', 'next']); git(['commit', '-qm', 'later']);
  assert.notEqual(attempts[0].baseCommit, git(['rev-parse', 'HEAD']));
  assert.equal(attempts[0].baseCommit, attempts[1].baseCommit);
  assert.deepEqual(store.requestWorkers(input), attempts);
  assert.throws(() => store.requestWorker(req('third', { taskId: task.id, provider: 'codex' })), { code: 'VARIANT_LIMIT' });
  assert.throws(() => store.chooseResult(req('choose', { attemptId: attempts[0].id, resultId: 'missing' })), { code: 'RESULT_CHANGED' });
});
test('coordinator policy may tighten but cannot loosen; user policy changes expire pending approvals', t => {
  const { store, run } = fixture(t);
  const tight = store.setRunPolicy(req('tight', { runId: run.id, policy: { integration: 'ask', caps: { maxConcurrentWorkers: 1 } } }));
  assert.equal(tight.policy.version, 2);
  assert.throws(() => store.setRunPolicy(req('loosen', { runId: run.id, policy: { integration: 'coordinator-managed' } })), { code: 'USER_REQUIRED' });
  assert.equal(store.setRunPolicy(req('reclaim', { runId: run.id, policy: { idleReclamation: true } })).policy.idleReclamation, false);
  const user = store.setRunPolicy({ ...req('user', { runId: run.id, policy: { integration: 'coordinator-managed' } }), callerId: 'desktop' });
  assert.equal(user.policy.version, 4);
});
test('whole-run review pins the requested branch commit and rejects a verdict for another subject', t => {
  const { store, run, git } = fixture(t);
  const task = store.createTask(req('review', { runId: run.id, kind: 'review', title: 'Review', subjectBranch: 'main' }));
  assert.equal(task.subjectBranchHead, git(['rev-parse', 'HEAD']));
  const worker = store.requestWorker(req('worker', { taskId: task.id, provider: 'claude' }));
  assert.equal(worker.mode, 'review'); assert.equal(worker.baseCommit, task.subjectBranchHead);
  store.admitAttempt(worker.id, { launchId: 'launch' }); store.setAttemptState(worker.id, 'working', { launchId: 'launch', turnId: 'turn' });
  const report = req('report', { attemptId: worker.id, kind: 'result', launchId: 'launch', turnId: 'turn', status: 'done', summary: 'Reviewed', review: { subjectBranchHead: 'bad', verdict: 'pass', findings: [] } });
  assert.throws(() => store.reportWorker(report), { code: 'REVIEW_SUBJECT_CHANGED' });
  const saved = store.reportWorker({ ...report, review: { ...report.review, subjectBranchHead: task.subjectBranchHead } });
  assert.equal(saved.reports.result.review.verdict, 'pass');
  assert.equal(saved.reports.result.testsClaimed.length, 0);
});
test('digests are byte bounded, coalesced, and advance their event cursor only on a matching receipt', t => {
  const { store, run } = fixture(t);
  store.setRunState(run.id, 'starting', { coordinatorSessionId: 'session', coordinatorLaunchId: 'launch' });
  for (let i = 0; i < 50; i++) store.createTask(req(`task-${i}`, { runId: run.id, title: `Task ${i} ${'x'.repeat(100)}` }));
  const first = store.makeRunDigest(run.id, 10000); assert.ok(Buffer.byteLength(first.text) <= 2048); assert.ok(first.omitted > 0);
  assert.equal(store.makeRunDigest(run.id, 11000), null);
  assert.equal(store.getRun(run.id).digest.acknowledgedCursor, 0);
  const target = { runId: run.id, recipient: 'coordinator', sessionId: 'session', launchId: 'launch' };
  const inbox = store.getInbox(target);
  store.ackMessage(req('ack', { ...target, messageId: first.id, receiptId: inbox.receiptId }));
  assert.equal(store.getRun(run.id).digest.acknowledgedCursor, first.eventCursor);
});
test('a coordinator can finish during its active final turn once all work is reconciled', t => {
  const { store, run } = fixture(t);
  store.setRunState(run.id, 'starting'); store.setRunState(run.id, 'active');
  assert.equal(store.finishRun(req('finish', { runId: run.id, reason: 'All work reconciled' })).state, 'finished');
});
test('resume receipts remain replayable after runtime-derived session metadata changes', t => {
  const { store, run } = fixture(t);
  const task = store.createTask(req('task', { runId: run.id, title: 'Work' }));
  const attempt = store.requestWorker(req('worker', { taskId: task.id, provider: 'claude' }));
  store.admitAttempt(attempt.id, { launchId: 'launch' });
  store.setAttemptState(attempt.id, 'working', { launchId: 'launch', currentSessionId: 'old-session' });
  store.setAttemptState(attempt.id, 'idle', { launchId: 'launch', presence: 'paused' });
  const input = req('resume', { runId: run.id, attemptId: attempt.id });
  const first = store.requestResume({ ...input, sessionId: 'old-session' });
  store.setAttemptState(attempt.id, 'idle', { launchId: 'launch', currentSessionId: 'new-session' });
  assert.deepEqual(store.runOperationOutcome('resume_worker', input), { found: true, outcome: first });
  assert.deepEqual(store.requestResume({ ...input, sessionId: 'new-session' }), first);
  assert.throws(() => store.runOperationOutcome('retry_worker', input), { code: 'REQUEST_MISMATCH' });
});
test('retry refuses live workers and queued resumes; retired attempts cannot be admitted', t => {
  const { store, run } = fixture(t);
  const task = store.createTask(req('task', { runId: run.id, title: 'Work' }));
  const attempt = store.requestWorker(req('worker', { taskId: task.id, provider: 'claude' }));
  store.admitAttempt(attempt.id, { launchId: 'launch' });
  store.setAttemptState(attempt.id, 'working', { launchId: 'launch', currentSessionId: 'session', presence: 'live' });
  store.setAttemptState(attempt.id, 'idle', { launchId: 'launch' });
  assert.throws(() => store.retryWorker(req('retry-live', { attemptId: attempt.id, from: 'base', reason: 'Retry' })), { code: 'ACTIVE_ATTEMPT' });
  store.setPresence(attempt.id, 'paused', { launchId: 'launch' });
  store.requestResume(req('resume', { attemptId: attempt.id, sessionId: 'session' }));
  assert.throws(() => store.retryWorker(req('retry-queued', { attemptId: attempt.id, from: 'base', reason: 'Retry' })), { code: 'ACTIVE_ATTEMPT' });
  store.setAttemptState(attempt.id, 'retired', { launchId: 'launch' });
  assert.equal(store.queuedAttempts().length, 0);
  assert.throws(() => store.admitAttempt(attempt.id, { launchId: 'replacement' }), { code: 'INVALID_STATE' });
});
test('coalescing an unread digest retains its unacknowledged event range', t => {
  const { store, run } = fixture(t);
  store.setRunState(run.id, 'starting', { coordinatorSessionId: 'session', coordinatorLaunchId: 'launch' });
  store.createTask(req('first-task', { runId: run.id, title: 'First event' }));
  const first = store.makeRunDigest(run.id, 10000);
  store.createTask(req('second-task', { runId: run.id, title: 'Second event' }));
  const second = store.makeRunDigest(run.id, 20000);
  assert.match(second.text, /First event/); assert.match(second.text, /Second event/); assert.match(second.text, /after 0/);
  assert.equal(store.getRun(run.id).messages.find(message => message.id === first.id).state, 'cancelled');
});
test('new workers can reconstruct recorded run decisions', t => {
  const { store, run } = fixture(t);
  store.recordDecision(req('decision', { runId: run.id, summary: 'Use the existing storage layer' }));
  assert.equal(store.getRun(run.id).decisions[0].summary, 'Use the existing storage layer');
});
test('worker batches preserve blocked inline tasks and continue other items without duplicates', t => {
  const { store, run } = fixture(t);
  const dependency = store.createTask(req('dependency', { runId: run.id, title: 'First' }));
  const input = req('batch', { runId: run.id, items: [
    { task: { title: 'Blocked', dependencies: [dependency.id] }, provider: 'claude' },
    { task: { title: 'Independent' }, provider: 'codex' },
  ] });
  const outcomes = store.requestWorkers(input);
  assert.equal(outcomes[0].refused, 'TASK_BLOCKED'); assert.equal(store.listTasks(run.id).find(task => task.id === outcomes[0].taskId).state, 'blocked');
  assert.equal(outcomes[1].state, 'requested'); assert.deepEqual(store.requestWorkers(input), outcomes); assert.equal(store.listAttempts(run.id).length, 1);
});
test('soft worker timeouts send bounded reminders without stopping or declaring completion', t => {
  const { store, run } = fixture(t);
  store.setRunState(run.id, 'starting', { coordinatorSessionId: 'coordinator', coordinatorLaunchId: 'coordinator-launch' });
  const task = store.createTask(req('timed-task', { runId: run.id, title: 'Timed work' }));
  const attempt = store.requestWorker(req('timed-worker', { taskId: task.id, provider: 'claude', model: 'fixture-model', timeoutMinutes: 1, attachments: [{ path: 'file' }] }));
  store.admitAttempt(attempt.id, { launchId: 'launch' }); store.setAttemptState(attempt.id, 'working', { launchId: 'launch', presence: 'live', currentSessionId: 'worker', startedAt: new Date(0).toISOString() });
  assert.equal(store.remindWorkers(60001), 1); assert.equal(store.remindWorkers(60002), 0); assert.equal(store.remindWorkers(120001), 1);
  const saved = store.getRun(run.id); assert.equal(saved.attempts[0].state, 'working'); assert.equal(saved.messages.length, 2); assert.equal(saved.attempts[0].model, 'fixture-model');
});
test('an exact stopped-worker result can be reviewed, approved once and integrated with durable provenance', { skip: process.platform === 'win32' }, async t => {
  const { store, run, root, git } = fixture(t);
  const task = store.createTask(req('work', { runId: run.id, title: 'Change the file' }));
  const attempt = store.requestWorker(req('worker', { taskId: task.id, provider: 'claude' }));
  const env = await store.createEnvironment({ projectId: run.projectId, logicalBranch: 'main', attemptId: attempt.id });
  store.admitAttempt(attempt.id, { launchId: 'launch' });
  store.setAttemptState(attempt.id, 'working', { launchId: 'launch', turnId: 'turn', environmentId: env.id, presence: 'paused' });
  const session = { id: 'worker-session', projectId: run.projectId, provider: 'claude', status: 'running', workspaceId: env.id, environmentId: env.id, survivors: [], createdAt: new Date().toISOString() };
  store.saveSession(session); store.attachEnvironmentSession(env.id, session.id); store.syncEnvironment(session);
  writeFileSync(join(env.details.path, 'file'), 'worker result\n');
  store.saveSession({ ...session, status: 'stopped' }); store.syncEnvironment({ ...session, status: 'stopped' });
  const captured = store.snapshotEnvironment(env.id, { attemptId: attempt.id, launchId: 'launch', turnId: 'turn' });
  store.reportWorker(req('report', { attemptId: attempt.id, kind: 'result', launchId: 'launch', turnId: 'turn', status: 'done', summary: 'Changed the file' }));
  store.settleAttempt(attempt.id, { launchId: 'launch', turnId: 'turn', resultId: captured.result.resultId, captureVerified: true });
  const review = store.createTask(req('review', { runId: run.id, title: 'Review current result', kind: 'review', subjectResultId: captured.result.resultId }));
  assert.equal(review.subjectTreeOid, captured.result.tree);
  store.setRunPolicy({ ...req('ask-policy', { runId: run.id, policy: { integration: 'ask' } }), callerId: 'desktop' });
  const preview = store.previewResult({ attemptId: attempt.id, resultId: captured.result.resultId });
  assert.equal(preview.hardGates.pass, true);
  const pending = store.applyResult(req('apply', { attemptId: attempt.id, resultId: captured.result.resultId, expect: preview.expect }));
  assert.equal(pending.approvalRequired, true);
  const applied = store.decideApproval({ callerId: 'desktop', requestId: 'allow', approvalId: pending.approval.id, decision: 'approved' });
  assert.equal(applied.applied, true); assert.equal(git(['show', 'main:file']), 'worker result');
  assert.deepEqual(store.decideApproval({ callerId: 'desktop', requestId: 'allow', approvalId: pending.approval.id, decision: 'approved' }), applied);
  assert.equal(store.getRun(run.id).results.find(result => result.id === captured.result.resultId).integrations.length, 1);
});
test('a whole-run review verdict remains a claim and becomes stale when its pinned branch moves', { skip: process.platform === 'win32' }, async t => {
  const { store, run, root, git } = fixture(t);
  const task = store.createTask(req('review', { runId: run.id, title: 'Review branch', kind: 'review', subjectBranch: 'main' }));
  const attempt = store.requestWorker(req('reviewer', { taskId: task.id, provider: 'claude' }));
  const env = await store.createEnvironment({ projectId: run.projectId, logicalBranch: 'main', baseCommit: task.subjectBranchHead, attemptId: attempt.id });
  store.admitAttempt(attempt.id, { launchId: 'review-launch' });
  store.setAttemptState(attempt.id, 'working', { launchId: 'review-launch', turnId: 'turn', environmentId: env.id, presence: 'paused' });
  const captured = store.snapshotEnvironment(env.id, { attemptId: attempt.id, launchId: 'review-launch', turnId: 'turn' });
  store.reportWorker(req('review-report', { attemptId: attempt.id, kind: 'result', launchId: 'review-launch', turnId: 'turn', status: 'done', summary: 'Reviewed branch', review: { subjectBranchHead: task.subjectBranchHead, verdict: 'pass', findings: [] } }));
  store.settleAttempt(attempt.id, { launchId: 'review-launch', turnId: 'turn', resultId: captured.result.resultId, captureVerified: true });
  let result = store.getRun(run.id).results.find(result => result.id === captured.result.resultId);
  assert.equal(result.claim.review.verdict, 'pass'); assert.equal(result.reviewFreshness, 'current'); assert.notEqual(result.testsVerified, 'passed');
  writeFileSync(join(root, 'later'), 'later'); git(['add', 'later']); git(['commit', '-qm', 'later']);
  result = store.getRun(run.id).results.find(result => result.id === captured.result.resultId);
  assert.equal(result.reviewFreshness, 'stale'); assert.equal(result.claim.review.subjectBranchHead, task.subjectBranchHead);
});

test('restart discovers a worker session saved before its attempt attachment and a coordinator before run attachment', t => {
  const { store, run } = fixture(t);
  const task = store.createTask(req('crash-task', { runId: run.id, title: 'Survive launch' }));
  const attempt = store.requestWorker(req('crash-worker', { taskId: task.id, provider: 'claude' }));
  store.admitAttempt(attempt.id, { launchId: 'worker-launch' });
  const session = { id: 'found-worker', projectId: run.projectId, provider: 'claude', role: 'worker', runId: run.id, attemptId: attempt.id, launchId: 'worker-launch', status: 'interrupted', survivors: [], turnId: 'turn', createdAt: new Date().toISOString() };
  store.saveSession(session);
  store.setRunState(run.id, 'starting', { coordinatorLaunchId: 'coordinator-launch' });
  store.saveSession({ ...session, id: 'found-coordinator', role: 'coordinator', attemptId: null, launchId: 'coordinator-launch' });
  store.recoverOrchestration();
  const saved = store.getRun(run.id);
  assert.equal(saved.coordinatorSessionId, 'found-coordinator'); assert.deepEqual(saved.coordinatorHistory, ['found-coordinator']); assert.equal(saved.state, 'detached');
  assert.equal(saved.attempts[0].currentSessionId, 'found-worker'); assert.equal(saved.attempts[0].state, 'working'); assert.equal(saved.attempts[0].presence, 'paused');
  store.recoverOrchestration(); assert.deepEqual(store.getRun(run.id).attempts[0].sessionIds, ['found-worker']);
});

for (const seam of ['afterTakeInMerge', 'afterTakeInBase', 'afterTakeInComplete']) test(`take-in reconciles ${seam} without repeating folder mutation or notifications`, { skip: process.platform === 'win32' }, async t => {
  const { store, run, root, git } = fixture(t);
  const task = store.createTask(req('task', { runId: run.id, title: 'Take in changes' })); const attempt = store.requestWorker(req('worker', { taskId: task.id, provider: 'claude' }));
  const env = await store.createEnvironment({ projectId: run.projectId, logicalBranch: 'main', attemptId: attempt.id });
  store.admitAttempt(attempt.id, { launchId: 'launch' }); store.setAttemptState(attempt.id, 'working', { launchId: 'launch', turnId: 'turn', environmentId: env.id, presence: 'paused' });
  const session = { id: 'worker', projectId: run.projectId, status: 'stopped', workspaceId: env.id, environmentId: env.id, survivors: [], createdAt: new Date().toISOString() }; store.saveSession(session); store.attachEnvironmentSession(env.id, session.id); store.syncEnvironment(session);
  const captured = store.snapshotEnvironment(env.id, { attemptId: attempt.id, launchId: 'launch', turnId: 'turn' }); store.settleAttempt(attempt.id, { launchId: 'launch', turnId: 'turn', resultId: captured.result.resultId, captureVerified: true });
  writeFileSync(join(root, 'branch-change'), 'from branch'); git(['add', 'branch-change']); git(['commit', '-qm', 'branch advanced']);
  let hits = 0; store.environments.hooks[seam] = () => { hits++; throw new Error('fixture power loss'); };
  const input = req('take', { runId: run.id, attemptId: attempt.id });
  assert.throws(() => store.takeInWorker(input), /fixture power loss/); assert.equal(hits, 1);
  delete store.environments.hooks[seam];
  const outcome = store.takeInWorker(input); assert.deepEqual(outcome.conflicts, []);
  assert.equal(store.getRun(run.id).attempts[0].currentResultId, null); assert.equal(store.getRun(run.id).attempts[0].state, 'waiting_for_coordinator');
  const { readFileSync } = await import('node:fs'); assert.equal(readFileSync(join(env.details.path, 'branch-change'), 'utf8'), 'from branch');
  assert.deepEqual(store.takeInWorker(input), outcome); assert.equal(store.getRun(run.id).messages.filter(message => message.kind === 'resolve_conflict').length, 1);
});

test('a check interrupted by runtime restart remains unknown and cannot be replayed as successful evidence', { skip: process.platform === 'win32' }, async t => {
  const { store, run } = fixture(t); const task = store.createTask(req('task', { runId: run.id, title: 'Checks' })); const attempt = store.requestWorker(req('worker', { taskId: task.id, provider: 'claude' }));
  const env = await store.createEnvironment({ projectId: run.projectId, logicalBranch: 'main', attemptId: attempt.id });
  store.admitAttempt(attempt.id, { launchId: 'launch' }); store.setAttemptState(attempt.id, 'working', { launchId: 'launch', turnId: 'turn', environmentId: env.id });
  const captured = store.snapshotEnvironment(env.id, { attemptId: attempt.id, launchId: 'launch', turnId: 'turn' });
  const result = store.recordResult({ environmentId: env.id, resultId: captured.result.resultId, attemptId: attempt.id, launchId: 'launch', turnId: 'turn' });
  const input = req('verify', { runId: run.id, resultId: result.id, command: ['npm', 'test'] }); const operation = store.prepareRunOperation('verify_result', input, run.id);
  store.recordResultCheck(result.id, { id: 'check', operationId: operation.id, resultId: result.id, treeOid: result.treeOid, command: input.command, state: 'running', exit: null, provenance: 'isolated-verification' });
  store.recoverOrchestration(); const saved = store.getRun(run.id).results[0]; assert.equal(saved.checks[0].state, 'interrupted'); assert.notEqual(saved.testsVerified, 'passed');
  assert.throws(() => store.prepareRunOperation('verify_result', input, run.id), { code: 'CHECK_INTERRUPTED' });
});

test('review fix and recheck keep old verdicts historical and memory proposals tied to their exact result', { skip: process.platform === 'win32' }, async t => {
  const { store, run } = fixture(t);
  const start = async (title, extra = {}) => {
    const task = store.createTask(req(title, { runId: run.id, title, ...extra })); const attempt = store.requestWorker(req(title + '-worker', { taskId: task.id, provider: 'claude' }));
    const env = await store.createEnvironment({ projectId: run.projectId, logicalBranch: 'main', attemptId: attempt.id, baseCommit: attempt.baseCommit });
    store.admitAttempt(attempt.id, { launchId: title }); store.setAttemptState(attempt.id, 'working', { launchId: title, turnId: '1', environmentId: env.id, presence: 'paused' });
    const session = { id: title, projectId: run.projectId, status: 'stopped', workspaceId: env.id, environmentId: env.id, survivors: [], createdAt: new Date().toISOString() }; store.saveSession(session); store.attachEnvironmentSession(env.id, session.id); store.syncEnvironment(session);
    return { task, attempt, env, launchId: title };
  };
  const report = (worker, turnId, extra = {}) => {
    const capture = store.snapshotEnvironment(worker.env.id, { attemptId: worker.attempt.id, launchId: worker.launchId, turnId });
    store.reportWorker(req(worker.launchId + turnId, { attemptId: worker.attempt.id, launchId: worker.launchId, turnId, kind: 'result', status: 'done', summary: 'Fixture result', ...extra }));
    store.settleAttempt(worker.attempt.id, { launchId: worker.launchId, turnId, resultId: capture.result.resultId, captureVerified: true }); return capture.result;
  };
  const owner = await start('owner'); writeFileSync(join(owner.env.details.path, 'file'), 'version A');
  const a = report(owner, '1', { memoryProposals: [{ statement: 'Fixture convention', category: 'convention', scope: 'branch' }] });
  const reviewer = await start('review', { kind: 'review', subjectResultId: a.resultId });
  const verdict = report(reviewer, '1', { review: { subjectResultId: a.resultId, subjectTreeOid: a.tree, verdict: 'changes_requested', findings: [{ file: 'file', severity: 'important', text: 'Use version B' }] } });
  store.setAttemptState(owner.attempt.id, 'working', { launchId: owner.launchId, turnId: '2' }); writeFileSync(join(owner.env.details.path, 'file'), 'version B'); const b = report(owner, '2');
  assert.notEqual(a.resultId, b.resultId); assert.equal(store.getRun(run.id).results.find(result => result.id === verdict.resultId).reviewFreshness, 'stale');
  store.takeInWorker(req('recheck', { runId: run.id, attemptId: reviewer.attempt.id, subjectResultId: b.resultId }));
  const subject = store.getRun(run.id).tasks.find(task => task.id === reviewer.task.id); assert.equal(subject.subjectResultId, b.resultId);
  store.setAttemptState(reviewer.attempt.id, 'working', { launchId: reviewer.launchId, turnId: '2' });
  const checked = report(reviewer, '2', { review: { subjectResultId: b.resultId, subjectTreeOid: b.tree, verdict: 'pass', findings: [] } });
  const results = store.getRun(run.id).results; assert.equal(results.find(result => result.id === checked.resultId).reviewFreshness, 'current'); assert.equal(results.find(result => result.id === verdict.resultId).claim.review.verdict, 'changes_requested');
  const memoryId = results.find(result => result.id === a.resultId).memoryCandidates[0]; const memory = store.getMemory(memoryId); assert.equal(memory.status, 'candidate'); assert.equal(memory.origin.resultId, a.resultId); assert.equal(memory.origin.applied, false);
  store.setMemoryStatus(memoryId, 'active'); assert.equal(store.getMemory(memoryId).origin.resultId, a.resultId); assert.equal(store.getMemory(memoryId).origin.applied, false);
});

test('run goals, tasks, decisions and external intents do not persist credential-looking text', t => {
  const { store, run } = fixture(t);
  // Synthetic input, never an account credential. Build it at runtime so source
  // secret scanners do not mistake this redaction fixture for a leaked key.
  const canary = ['sk', 'proj', 'fixtureCanaryOnlyNotARealSecret123456789'].join('-');
  const created = store.createRun(req('private-run', { projectId: run.projectId, logicalBranch: 'main', goal: `Use ${canary}` }));
  store.createTask(req('private-task', { runId: created.id, title: 'Fixture', goal: canary, acceptance: [canary], scope: { paths: [], areas: [canary] } }));
  store.recordDecision(req('private-decision', { runId: created.id, summary: canary }));
  const input = req('private-check', { runId: created.id, resultId: 'fixture', command: ['node', '-e', canary] }); store.prepareRunOperation('verify_result', input, created.id);
  for (const table of ['runs', 'tasks', 'run_events', 'orchestration_operations']) assert.equal(store.db.prepare(`SELECT body FROM ${table}`).all().some(row => row.body.includes(canary)), false, table);
  assert.throws(() => store.prepareRunOperation('verify_result', { ...input, command: ['node', '-e', canary + 'different'] }, created.id), { code: 'REQUEST_MISMATCH' });
});

test('new runs have no worker ceiling and legacy limits do not make unrelated policy updates require permission', t => {
  const { store, run } = fixture(t);
  assert.equal(run.policy.caps.maxConcurrentWorkers, null);
  const legacy = { ...run, policy: { ...run.policy, caps: { maxConcurrentWorkers: 1 }, idleReclamation: true } };
  store.db.prepare('UPDATE runs SET body=? WHERE id=?').run(JSON.stringify(legacy), run.id);
  const tightened = store.setRunPolicy(req('tighten-with-legacy', { runId: run.id, policy: { integration: 'ask' } }));
  assert.equal(tightened.policy.integration, 'ask');
  assert.equal(tightened.policy.idleReclamation, false);
  assert.equal(tightened.policy.caps.maxConcurrentWorkers, null);
});
