import { randomUUID } from 'node:crypto';
import { workerBrief, coordinatorBrief } from '../core/orchestration/prompts.mjs';
import { refuse } from '../core/orchestration/model.mjs';

export class WorkerManager {
  constructor({ store, terminals, environments, inspectProvider = async () => ({}), log = () => {} }) { Object.assign(this, { store, terminals, environments, inspectProvider, log }); this.pending = Promise.resolve(); this.starts = new Map(); this.coordinatorLane = Promise.resolve(); }
  reevaluate() { return this.capacity?.reevaluate(); }
  async startRun(input) {
    const created = await this.store.createRun(input); const run = await this.store.getRun(created.id);
    if (this.starts.has(run.id)) return this.starts.get(run.id);
    if (run.state !== 'creating') return this.store.getRun(run.id);
    const pending = this.queueCoordinator(run, run.provider ?? input.provider).finally(() => this.starts.delete(run.id)); this.starts.set(run.id, pending); return pending;
  }
  async resumeCoordinator(input) {
    const previous = await this.store.runOperationOutcome('resume_coordinator', input); if (previous.found) return previous.outcome;
    const run = await this.store.getRun(input.runId);
    if (this.starts.has(run.id)) return this.starts.get(run.id);
    if (run.state !== 'detached' || !run.coordinatorSessionId) refuse('INVALID_STATE', 'Only a detached coordinator can continue');
    const session = await this.store.getSession(run.coordinatorSessionId);
    await this.assertNoWriters({ currentSessionId: session.id });
    if (!session.nativeIdConfirmed) refuse('ID_UNCONFIRMED', 'Confirm the exact conversation before continuing');
    const operation = await this.store.prepareRunOperation('resume_coordinator', input, run.id);
    if (operation.phase === 'done') return operation.outcome;
    if (operation.existing) refuse('OPERATION_PENDING', 'The previous coordinator launch is being reconciled');
    const pending = this.queueCoordinator(run, session.provider, session.id, operation.id).then(outcome => this.store.finishRunOperation(operation.id, outcome)).finally(() => this.starts.delete(run.id)); this.starts.set(run.id, pending); return pending;
  }
  queueCoordinator(run, provider, resumeId = null, operationId = null) {
    const operation = this.coordinatorLane.then(() => this.launchCoordinator(run, provider, resumeId, operationId));
    this.coordinatorLane = operation.catch(() => {}); return operation;
  }
  async launchQueuedCoordinators() {
    for (const run of await this.store.activeRuns()) {
      if (run.state !== 'creating' || run.paused || this.starts.has(run.id)) continue;
      const operation = this.queueCoordinator(run, run.provider).finally(() => this.starts.delete(run.id));
      this.starts.set(run.id, operation);
      try { await operation; } catch (error) { this.log(`coordinator launch: ${error.message}`); }
    }
  }
  async launchCoordinator(run, provider, resumeId = null, operationId = null) {
    if (!['claude', 'codex'].includes(provider)) refuse('UNSUPPORTED_PROVIDER', 'Choose Claude Code or Codex as coordinator');
    const project = await this.store.project(run.projectId);
    if (project.branch !== run.logicalBranch) {
      if (resumeId) refuse('BRANCH_MOVED', 'Return the project checkout to the run branch before continuing its coordinator');
      if (run.admission?.reasons?.[0] !== 'BRANCH_MOVED') await this.store.setRunState(run.id, 'creating', { admission: { phase: 'held', reasons: ['BRANCH_MOVED'] } });
      return this.store.getRun(run.id);
    }
    const decision = await this.capacity?.coordinatorDecision(run.id);
    if (decision?.verdict === 'hold') {
      if (resumeId) refuse('CAPACITY_HELD', `Coordinator launch is waiting: ${decision.reasons.join(', ')}`);
      if (JSON.stringify(run.admission?.reasons) !== JSON.stringify(decision.reasons)) await this.store.setRunState(run.id, 'creating', { admission: { phase: 'held', reasons: decision.reasons } });
      return this.store.getRun(run.id);
    }
    const lease = this.terminals.slots.reserve(run.id); if (!lease) refuse('SLOTS_FULL', 'No session slot is available for a coordinator');
    const launchId = randomUUID();
    try {
      const detected = await this.inspectProvider(provider);
      await this.store.setRunState(run.id, 'starting', { coordinatorLaunchId: launchId, coordinatorOperationId: operationId, admission: { phase: 'starting', reasons: [] } });
      const started = await this.terminals.startReserved({ projectId: run.projectId, provider, cliVersion: detected.version, hooksEnabled: detected.supports?.hooks, ...(resumeId ? { resumeId } : { task: coordinatorBrief(run) }), orchestration: { journalToolsAllowed: run.journalToolsAllowed, role: 'coordinator', runId: run.id, launchId, title: run.goal.split('\n')[0].slice(0, 200) } }, lease);
      await this.store.setRunState(run.id, 'active', { coordinatorSessionId: started.session.id, coordinatorHistory: [...run.coordinatorHistory, started.session.id] });
      return this.store.getRun(run.id);
    } catch (error) {
      await this.store.setRunState(run.id, 'detached', { attention: { code: error.code ?? 'LAUNCH_FAILED', reason: error.message } }); throw error;
    } finally { this.terminals.slots.release(lease); }
  }
  async launchAdmitted(attempt, lease) {
    const run = await this.store.getRun(attempt.runId); const task = run.tasks.find(task => task.id === attempt.taskId);
    if (!task || run.paused) throw Object.assign(new Error('The launch request is no longer runnable'), { code: 'RUN_PAUSED', noProcess: true });
    const resumeId = attempt.admission?.resumeSessionId;
    if (resumeId || attempt.handoffFrom) await this.assertNoWriters(attempt);
    const source = attempt.sourceResultId ? await this.store.getResult(attempt.sourceResultId) : null;
    let environment;
    try { environment = attempt.environmentId ? await this.store.getEnvironment(attempt.environmentId) : await this.store.createEnvironment({ projectId: run.projectId, logicalBranch: run.logicalBranch, task: task.title, attemptId: attempt.id, baseCommit: source?.resultCommit ?? attempt.baseCommit }); } catch (error) { if (error.code === 'NO_PORTS') error.noProcess = true; throw error; }
    await this.store.setAttemptState(attempt.id, attempt.state, { launchId: attempt.launchId, environmentId: environment.id });
    const detected = await this.inspectProvider(attempt.provider);
    const started = await this.terminals.startReserved({ projectId: run.projectId, workspaceId: environment.id, provider: attempt.provider, model: attempt.model, references: (attempt.attachments ?? []).map(item => ({ ...item, rootKey: environment.id, projectId: run.projectId })), cliVersion: detected.version, hooksEnabled: detected.supports?.hooks, research: ['research', 'review'].includes(attempt.mode),
      ...(resumeId ? { resumeId } : { task: workerBrief(run, task, attempt) }), orchestration: { journalToolsAllowed: run.journalToolsAllowed, role: 'worker', taskId: task.id, runId: run.id, attemptId: attempt.id, launchId: attempt.launchId, title: task.title } }, lease);
    await this.store.attachEnvironmentSession(environment.id, started.session.id);
    return this.store.setAttemptState(attempt.id, 'working', { launchId: attempt.launchId, currentSessionId: started.session.id, sessionIds: [...attempt.sessionIds, started.session.id], presence: 'live', startedAt: new Date().toISOString(), timeoutReminders: [], admission: { ...attempt.admission, phase: 'started', resumeSessionId: null } });
  }
  async assertNoWriters(attempt) {
    if (attempt.handoffFrom && !attempt.currentSessionId) { const run = await this.store.getRun(attempt.runId); const previous = run.attempts.find(row => row.id === attempt.handoffFrom); if (!previous) refuse('WRITERS_UNKNOWN', 'The prior writer record is unavailable'); return this.assertNoWriters(previous); }
    const id = attempt.admission?.resumeSessionId ?? attempt.currentSessionId;
    if (!id && !attempt.handoffFrom) refuse('WRITERS_UNKNOWN', 'No settled writer record exists for this environment');
    const prior = id ? await this.store.getSession(id) : null;
    const entry = id ? this.terminals.entry(id) : null;
    if (!prior || !['exited', 'stopped', 'failed', 'interrupted'].includes(prior.status) || !Array.isArray(prior.survivors) || prior.survivors.length || entry?.scanPending || (entry && !entry.exited)) refuse('WRITERS_UNKNOWN', 'The previous provider and its child processes must be verified ended first');
  }
  async find(input) { const run = await this.store.getRun(input.runId); const attempt = run.attempts.find(row => row.id === input.attemptId); if (!attempt) refuse('NOT_FOUND', 'Unknown worker'); return attempt; }
  async resume(input) {
    const previous = await this.store.runOperationOutcome('resume_worker', input); if (previous.found) return previous.outcome;
    const attempt = await this.find(input); await this.assertNoWriters(attempt);
    const session = await this.store.getSession(attempt.currentSessionId);
    if (!session.nativeIdConfirmed) refuse('ID_UNCONFIRMED', 'Confirm the exact conversation ID before resuming');
    const queued = await this.store.requestResume({ ...input, sessionId: session.id }); void this.reevaluate(); return queued;
  }
  async retry(input) {
    const previous = await this.store.runOperationOutcome('retry_worker', input); if (previous.found) return previous.outcome;
    const attempt = await this.find(input);
    if (input.from === 'environment') await this.assertNoWriters(attempt);
    const next = await this.store.retryWorker({ ...input, writersExcluded: input.from === 'environment' }); void this.reevaluate(); return next;
  }
  async stop(input) {
    const attempt = await this.find(input);
    const operation = await this.store.prepareRunOperation('stop_worker', input, attempt.runId);
    if (operation.phase === 'done') return operation.outcome;
    if (operation.existing) {
      const session = await this.store.getSession(attempt.currentSessionId);
      if (['stopped', 'exited', 'failed'].includes(session.status)) return this.store.finishRunOperation(operation.id, session);
      refuse('OPERATION_PENDING', 'The previous Stop is still being reconciled');
    }
    if (!attempt.currentSessionId) refuse('INVALID_STATE', 'This worker has no running session');
    const stopped = await this.terminals.stop(attempt.currentSessionId); await this.pending; return this.store.finishRunOperation(operation.id, stopped);
  }
  async snapshot(input) {
    const attempt = await this.find(input); let boundary = null;
    if (attempt.presence === 'live') { boundary = this.terminals.qualifyBoundary(attempt.currentSessionId, 'capture'); if (!boundary.eligible) refuse(boundary.reason, 'This worker does not have a qualified capture boundary'); }
    else await this.assertNoWriters(attempt);
    const env = await this.store.snapshotEnvironment(attempt.environmentId, { attemptId: attempt.id, launchId: attempt.launchId, turnId: attempt.turnId });
    if (boundary && !this.terminals.validateBoundary(boundary).eligible) refuse('BOUNDARY_CHANGED', 'The worker changed during capture; retry at a qualified boundary');
    if (attempt.state === 'working') return this.store.settleAttempt(attempt.id, { launchId: attempt.launchId, turnId: attempt.turnId, resultId: env.result.resultId, captureVerified: true });
    return this.store.recordResult({ environmentId: env.id, resultId: env.result.resultId, attemptId: attempt.id, launchId: attempt.launchId, turnId: attempt.turnId });
  }
  async takeIn(input) { const attempt = await this.find(input); await this.assertNoWriters(attempt); return this.store.takeInWorker(input); }
  async recover() {
    for (const run of await this.store.activeRuns()) {
      const current = await this.store.getRun(run.id);
      const ids = new Set([current.coordinatorSessionId, ...current.attempts.map(attempt => attempt.currentSessionId)].filter(Boolean));
      for (const id of ids) { try { await this.sync(await this.store.getSession(id)); } catch (error) { this.log(`worker recovery: ${error.message}`); } }
    }
  }
  follow(session) {
    if (!session.runId) return this.pending;
    this.pending = this.pending.then(() => this.sync(session)).catch(error => this.log(`worker sync: ${error.message}`)); return this.pending;
  }
  async sync(session) {
    const run = await this.store.getRun(session.runId); const live = ['starting', 'running', 'waiting', 'stopping'].includes(session.status);
    if (session.role === 'coordinator') {
      if (run.coordinatorSessionId !== session.id || run.state === 'finished') return;
      const state = !live ? 'detached' : session.pending ? 'waiting_for_user' : session.activity === 'idle' ? 'idle' : 'active';
      if (state !== run.state && run.state !== 'starting') await this.store.setRunState(run.id, state);
      return;
    }
    let attempt = run.attempts.find(item => item.id === session.attemptId);
    if (!attempt || attempt.launchId !== session.launchId || attempt.currentSessionId !== session.id) return;
    if (['done', 'retired', 'superseded', 'abandoned', 'cancelled'].includes(attempt.state)) {
      if (!live) await this.store.setPresence(attempt.id, session.status === 'orphaned' || !Array.isArray(session.survivors) || session.survivors.length ? 'lost' : 'paused', { launchId: attempt.launchId });
      return;
    }
    // An explicitly unknown turn revokes the previous report fence, including
    // while idle or waiting for permission. Missing legacy metadata is not a new turn.
    if (Object.hasOwn(session, 'turnId') && session.turnId !== attempt.turnId) {
      attempt = await this.store.setAttemptState(attempt.id, attempt.state, { launchId: attempt.launchId, turnId: session.turnId });
    }
    if (!live) {
      await this.store.setPresence(attempt.id, session.status === 'orphaned' || !Array.isArray(session.survivors) || session.survivors.length ? 'lost' : 'paused', { launchId: attempt.launchId });
      if (session.status === 'orphaned' || !Array.isArray(session.survivors) || session.survivors.length) return;
      if (attempt.state === 'waiting_for_user') attempt = await this.store.setAttemptState(attempt.id, 'working', { launchId: attempt.launchId });
      await this.environments.follow(session);
      const env = await this.store.snapshotEnvironment(attempt.environmentId, { attemptId: attempt.id, launchId: attempt.launchId, turnId: attempt.turnId });
      if (env.result && attempt.state === 'working') await this.store.settleAttempt(attempt.id, { launchId: attempt.launchId, turnId: attempt.turnId, resultId: env.result.resultId, outcome: 'interrupted' });
      return;
    }
    if (session.pending && attempt.state === 'working') return this.store.setAttemptState(attempt.id, 'waiting_for_user', { launchId: attempt.launchId });
    if (session.activity === 'working' && !['starting', 'integrating'].includes(attempt.state)) {
      return this.store.setAttemptState(attempt.id, 'working', { launchId: attempt.launchId, turnId: session.turnId ?? attempt.turnId });
    }
    if (session.activity === 'idle' && attempt.state === 'working') {
      const boundary = this.terminals.qualifyBoundary(session.id, 'capture');
      if (!boundary.eligible) return; // An observed Stop alone cannot prove absence of other writers.
      const env = await this.store.snapshotEnvironment(attempt.environmentId, { attemptId: attempt.id, launchId: attempt.launchId, turnId: attempt.turnId, captureGeneration: boundary.observationGeneration });
      if (!this.terminals.validateBoundary(boundary).eligible) return;
      return this.store.settleAttempt(attempt.id, { ...boundary, resultId: env.result?.resultId, captureVerified: true });
    }
  }
  async close() { await this.pending; await this.coordinatorLane; }
}
