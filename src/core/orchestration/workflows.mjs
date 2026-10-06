import { createHash } from 'node:crypto';
import { git } from '../project.mjs';
import { text, choice, relativePath, redact } from '../validation.mjs';
import { refuse, TERMINAL_ATTEMPTS } from './model.mjs';

export const subrequest = (requestId, suffix) => createHash('sha256').update(`${requestId}:${suffix}`).digest('hex');
export function branchHead(store, run, branch = run.logicalBranch) {
  text(branch, 'branch', 200); if (branch !== run.logicalBranch) refuse('WRONG_BRANCH', 'Select this run\'s branch');
  return git(store.project(run.projectId).root, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]).trim();
}
export function reviewSubject(model, run, input) {
  if (input.kind !== 'review') return {};
  if (input.subjectBranch) return { subjectBranch: run.logicalBranch, subjectBranchHead: branchHead(model.store, run, input.subjectBranch) };
  if (!input.subjectResultId) refuse('REVIEW_SUBJECT_REQUIRED', 'Select an exact result or the integrated branch to review');
  const result = model.row('results', input.subjectResultId);
  const attempt = model.row('attempts', result.attemptId);
  if (attempt.runId !== run.id) refuse('NOT_FOUND', 'Unknown review subject');
  return { subjectTaskId: attempt.taskId, subjectAttemptId: attempt.id, subjectResultId: result.id, subjectTreeOid: result.treeOid, subjectCommit: result.resultCommit };
}
const list = (value, field, max = 30) => { if (!Array.isArray(value ?? []) || (value?.length ?? 0) > max) refuse('INVALID_INPUT', `Invalid ${field}`); return value ?? []; };
export function resultClaim(input, task) {
  const result = {
    testsClaimed: list(input.testsClaimed, 'tests').map(item => ({ command: redact(text(item.command, 'command', 2000)), outcome: choice(item.outcome, ['passed', 'failed', 'not-run', 'unknown'], 'test outcome') })),
    blockers: list(input.blockers, 'blockers').map(item => redact(text(item, 'blocker', 1000))),
    dependenciesDiscovered: list(input.dependenciesDiscovered, 'dependencies').map(item => redact(text(item, 'dependency', 1000))),
    memoryProposals: list(input.memoryProposals, 'memory proposals', 10).map(item => ({ statement: redact(text(item.statement, 'statement', 2000)), category: choice(item.category, ['decision', 'constraint', 'convention', 'lesson', 'issue'], 'category'), scope: choice(item.scope, ['checkout', 'branch'], 'scope'), area: relativePath(item.area ?? '', true) })),
    needsFollowUp: input.needsFollowUp === true,
  };
  if (input.review) {
    if (task.kind !== 'review') refuse('INVALID_INPUT', 'Only a review task can submit a review verdict');
    for (const key of ['subjectResultId', 'subjectTreeOid', 'subjectBranchHead']) if ((input.review[key] ?? null) !== (task[key] ?? null)) refuse('REVIEW_SUBJECT_CHANGED', 'The verdict must name the exact pinned review subject');
    result.review = { subjectResultId: task.subjectResultId ?? null, subjectTreeOid: task.subjectTreeOid ?? null, subjectBranchHead: task.subjectBranchHead ?? null,
      verdict: choice(input.review.verdict, ['pass', 'changes_requested', 'blocked'], 'verdict'), findings: list(input.review.findings, 'findings', 100).map(item => ({ file: relativePath(item.file), ...(Number.isSafeInteger(item.line) && item.line > 0 ? { line: item.line } : {}), severity: choice(item.severity, ['critical', 'important', 'minor', 'info'], 'severity'), text: redact(text(item.text, 'finding', 2000)) })) };
  }
  return result;
}

export class Workflows {
  constructor(model) { this.model = model; this.db = model.db; }
  policy(input) {
    return this.model.operation('set_policy', input, input.runId, () => {
      const run = this.model.row('runs', input.runId); const patch = input.policy ?? {}; const old = run.policy;
      const next = { ...old, ...patch, caps: { ...old.caps, ...patch.caps }, guards: { ...old.guards, ...patch.guards }, version: old.version + 1 };
      choice(next.integration, ['ask', 'coordinator-managed'], 'integration mode');
      if (!Number.isInteger(next.caps.maxConcurrentWorkers) || next.caps.maxConcurrentWorkers < 1 || next.caps.maxConcurrentWorkers > 16 || typeof next.idleReclamation !== 'boolean') refuse('INVALID_INPUT', 'Invalid capacity policy');
      const rank = { allow: 0, ask: 1, refuse: 2 };
      for (const [key, value] of Object.entries(next.guards)) { if (!Object.hasOwn(old.guards, key)) refuse('INVALID_INPUT', 'Unknown policy guard'); choice(value, Object.keys(rank), 'guard'); }
      const loosening = (old.integration === 'ask' && next.integration !== 'ask') || next.caps.maxConcurrentWorkers > old.caps.maxConcurrentWorkers || (!old.idleReclamation && next.idleReclamation) || Object.keys(old.guards).some(key => rank[next.guards[key]] < rank[old.guards[key]]);
      if (loosening && input.callerId !== 'desktop') refuse('USER_REQUIRED', 'Only the user may loosen run policy');
      for (const row of this.db.prepare("SELECT body FROM approvals WHERE run_id=? AND state IN ('pending','approved')").all(run.id)) this.model.gates.saveApproval(JSON.parse(row.body), 'expired', { reason: 'Policy changed' });
      this.model.event(run.id, 'policy.changed', { previousVersion: old.version, version: next.version, callerId: input.callerId });
      return this.model.setRunState(run.id, run.state, { policy: next });
    });
  }
  approval(input) {
    return this.model.operation('request_approval', input, input.runId, () => {
      const run = this.model.row('runs', input.runId); if (run.state === 'finished') refuse('INVALID_STATE', 'The run has finished');
      const approval = { id: subrequest(input.callerId, input.requestId), runId: run.id, kind: 'decision', state: 'pending', summary: redact(text(input.summary, 'decision', 2000)), createdAt: new Date().toISOString(), guards: [] };
      this.db.prepare('INSERT INTO approvals VALUES(?,?,?,?)').run(approval.id, run.id, approval.state, JSON.stringify(approval)); this.model.event(run.id, 'approval.requested', { approvalId: approval.id, summary: approval.summary }); return approval;
    });
  }
  requestMany(input) {
    if (input.items) {
      if (!Array.isArray(input.items) || !input.items.length || input.items.length > 20) refuse('INVALID_INPUT', 'Request between one and twenty workers');
      this.model.row('runs', input.runId);
      return this.model.operation('create_worker_batch', input, input.runId, () => input.items.map((item, index) => {
        let taskId = item.taskId;
        try {
          if (!taskId) taskId = this.model.createTask({ ...item.task, runId: input.runId, callerId: input.callerId, requestId: subrequest(input.requestId, `task:${index}`) }).id;
          if (this.model.row('tasks', taskId).runId !== input.runId) refuse('NOT_FOUND', 'Unknown task');
          return this.model.requestWorker({ ...item, taskId, runId: input.runId, callerId: input.callerId, requestId: subrequest(input.requestId, `worker:${index}`) });
        } catch (error) { return { taskId: taskId ?? null, refused: error.code ?? 'INVALID_INPUT', reason: String(error.message).slice(0, 1000) }; }
      }));
    }
    const task = this.model.row('tasks', input.taskId);
    return this.model.operation('create_workers', input, task.runId, () => {
      const count = task.variants || 1;
      if (this.model.activeAttempts(task.id).length) refuse('ACTIVE_ATTEMPT', 'This task already has requested attempts');
      return Array.from({ length: count }, (_, index) => this.model.requestWorker({ callerId: input.callerId, requestId: subrequest(input.requestId, index), taskId: task.id, provider: input.providers?.[index] ?? input.provider, mode: input.mode }));
    });
  }
  choose(input) {
    const attempt = this.model.row('attempts', input.attemptId);
    return this.model.operation('choose_result', input, attempt.runId, () => {
      const current = this.model.row('attempts', attempt.id); const task = this.model.row('tasks', current.taskId);
      if (!task.variants || current.currentResultId !== input.resultId || !['ready', 'result_available'].includes(current.state)) refuse('RESULT_CHANGED', 'Choose a current, settled variant result');
      const others = this.model.activeAttempts(task.id).filter(row => row.id !== current.id);
      if (others.some(row => row.presence !== 'paused' || ['starting', 'working', 'waiting_for_user', 'integrating'].includes(row.state) || ['resuming', 'resume_queued'].includes(row.admission?.phase))) refuse('ACTIVE_ATTEMPT', 'Stop and settle the other variants before choosing a result');
      for (const other of others) {
        const saved = { ...other, state: 'superseded', supersededBy: current.id };
        this.db.prepare('UPDATE attempts SET state=?,body=? WHERE id=?').run(saved.state, JSON.stringify(saved), other.id);
        this.model.event(task.runId, 'worker.superseded', { attemptId: other.id, winner: current.id });
      }
      this.db.prepare('UPDATE tasks SET state=?,body=? WHERE id=?').run(current.state, JSON.stringify({ ...task, state: current.state, chosenAttemptId: current.id, chosenResultId: input.resultId }), task.id);
      this.model.event(task.runId, 'result.chosen', { attemptId: current.id, resultId: input.resultId }); return current;
    });
  }
  retire(input) {
    const attempt = this.model.row('attempts', input.attemptId);
    return this.model.operation('retire_worker', input, attempt.runId, () => {
      const current = this.model.row('attempts', attempt.id);
      if (current.presence !== 'paused' || ['resume_queued', 'resuming'].includes(current.admission?.phase)) refuse('ACTIVE_ATTEMPT', 'Stop and settle the worker before retiring it');
      if (TERMINAL_ATTEMPTS.has(current.state)) return current;
      return this.model.setAttemptState(current.id, ['requested', 'queued'].includes(current.state) ? 'cancelled' : 'retired', { launchId: current.launchId, endedReason: text(input.reason, 'reason', 2000) });
    });
  }
  recover() {
    for (const row of this.db.prepare("SELECT body FROM orchestration_operations WHERE phase='prepared'").all()) {
      const operation = JSON.parse(row.body); if (operation.kind !== 'take_in') continue;
      try { this.takeIn(operation.input); } catch { /* Unknown merges and writers stay explicitly held. */ }
    }
  }
  takeIn(input) {
    const attempt = this.model.row('attempts', input.attemptId); const run = this.model.row('runs', attempt.runId);
    const operation = this.model.prepareExternal('take_in', input, run.id);
    if (operation.phase === 'done') return operation.outcome;
    let mutated = false;
    try {
      if (run.paused) refuse('RUN_PAUSED', 'The run is paused');
      if (attempt.presence !== 'paused' || !['idle', 'ready', 'result_available', 'blocked', 'conflict', 'waiting_for_coordinator', 'integrated'].includes(attempt.state) || ['resuming', 'resume_queued'].includes(attempt.admission?.phase)) refuse('NOT_IDLE', 'Stop and settle this worker before changing its folder');
      const task = this.model.row('tasks', attempt.taskId);
      const subject = input.subjectResultId ? reviewSubject(this.model, run, { kind: 'review', subjectResultId: input.subjectResultId }) : null;
      if (subject && task.kind !== 'review') refuse('INVALID_INPUT', 'Result rechecks require a review task');
      const env = this.model.store.environments.record(attempt.environmentId);
      if (env.takeIn && env.takeIn.phase !== 'done' && env.takeIn.operationId !== operation.id) refuse('OPERATION_PENDING', 'Reconcile the previous take-in before changing this folder');
      if (operation.existing && (env.takeIn?.operationId !== operation.id || !['merged', 'refreshed'].includes(env.takeIn.phase))) refuse('OPERATION_PENDING', 'The interrupted merge has no verified completion checkpoint; inspect and resolve the saved folder before continuing');
      const target = operation.existing ? env.takeIn.target : subject?.subjectCommit ?? branchHead(this.model.store, run);
      if (!operation.existing) this.model.store.environments.patch(env.id, { takeIn: { operationId: operation.id, target, phase: 'prepared', previousBase: env.base, subject } });
      mutated = true;
      const outcome = this.model.store.environments.updateFromBranch(env.id, { target, operationId: operation.id, reviewBase: subject ? task.subjectCommit : null });
      this.model.atomic(() => {
        const rounds = (attempt.conflictRounds ?? 0) + (outcome.conflicts.length ? 1 : 0);
        this.model.setAttemptState(attempt.id, 'waiting_for_coordinator', { launchId: attempt.launchId, currentResultId: null, conflictRounds: rounds, repeatedConflict: rounds >= 3 });
        if (subject && !outcome.conflicts.length) {
          this.db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify({ ...task, ...subject, subjectBranch: null, subjectBranchHead: null }), task.id);
          this.model.event(run.id, 'review.subject_changed', { taskId: task.id, ...subject });
        }
        this.model.store.environments.patch(env.id, { takeIn: { operationId: operation.id, target, phase: 'done', conflicts: outcome.conflicts } });
        this.model.event(run.id, outcome.conflicts.length ? 'conflict.detected' : 'conflict.resolved', { attemptId: attempt.id, conflicts: outcome.conflicts, repeatedConflict: rounds >= 3 });
        this.model.messages.send({ callerId: 'runtime:take-in', requestId: operation.id, runId: run.id, recipient: attempt.id, kind: 'resolve_conflict', text: outcome.conflicts.length ? `Take-in found conflicts in ${outcome.conflicts.join(', ').slice(0, 3000)}. Resolve these in your assigned folder, then report the result in a new turn.` : 'Take-in completed. Read get_context for the pinned subject and continue the assigned task. Report a new result; previous reports remain historical.' });
        this.model.finishExternal(operation.id, outcome);
      });
      return outcome;
    } catch (error) { if (!mutated && !operation.existing) this.model.failExternal(operation.id, error); throw error; }
  }
}
