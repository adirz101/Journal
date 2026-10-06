import { randomUUID, createHash } from 'node:crypto';
import { git } from '../project.mjs';
import { refuse } from './model.mjs';

export function hardGates(preview, attempt, run, task = {}) {
  const failures = [];
  if (task.variants && (task.chosenAttemptId !== attempt.id || task.chosenResultId !== attempt.currentResultId)) failures.push('VARIANT_NOT_SELECTED');
  if (run.paused) failures.push('RUN_PAUSED');
  if (!preview.clean || preview.unresolved?.length) failures.push('CONFLICT');
  if (preview.blockedBy?.length) failures.push('DIRTY_OVERLAP');
  if (preview.busy) failures.push('BRANCH_BUSY');
  if (preview.excluded?.length || preview.nested?.length) failures.push('EXCLUDED_CONTENT');
  if (!['ready', 'integrated'].includes(attempt.state) || attempt.presence === 'live' || attempt.presence === 'lost') failures.push('NOT_IDLE');
  return { pass: failures.length === 0, failures };
}
export function guards(preview, task, policy, result, recentApplies = 0) {
  const found = []; const add = (guard, detail, unknown = false) => found.push({ guard, outcome: unknown ? 'ask' : policy.guards[guard] ?? 'ask', detail });
  const changes = preview.changes ?? [];
  if (changes.filter(file => file.status.startsWith('D')).length > 20) add('deletions', 'More than 20 files deleted');
  const paths = task.scope?.paths ?? [];
  if (paths.length && changes.some(file => !paths.some(path => file.path === path || file.path.startsWith(path.endsWith('/') ? path : `${path}/`)))) add('outside_scope', 'Files outside the declared task scope changed');
  if (changes.some(file => /(^\.github\/|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock)$|(^|\/)release)/i.test(file.path))) add('infrastructure', 'CI, release or dependency-lock files changed');
  if (preview.knownTestCommand && result.testsVerified !== 'passed') add('tests', 'No passing check is bound to this result tree');
  if (preview.executable == null) add('executable', 'Executable-bit changes could not be verified', true);
  else if (preview.executable.length) add('executable', 'An executable bit was added');
  if (recentApplies >= 5) add('apply_rate', 'At least five results were applied in the last ten minutes');
  if (policy.integration === 'ask') found.push({ guard: 'integration_mode', outcome: 'ask', detail: 'Ask before every Apply' });
  return found;
}

export class IntegrationGate {
  constructor(model) { this.model = model; this.store = model.store; this.db = model.db; }
  subject(input, { retain = false } = {}) {
    const attempt = this.model.row('attempts', input.attemptId); const run = this.model.row('runs', attempt.runId);
    if (input.runId && run.id !== input.runId) refuse('NOT_FOUND', 'Unknown worker');
    if (attempt.currentResultId !== input.resultId) refuse('RESULT_CHANGED', 'Select the worker\'s current result');
    const result = this.model.row('results', input.resultId);
    if (result.attemptId !== attempt.id) refuse('RESULT_CHANGED', 'This result belongs to another attempt');
    const env = this.store.environments.record(result.environmentId);
    if (env.result?.resultId !== result.id || env.result.tree !== result.treeOid) refuse('RESULT_CHANGED', 'The environment has a newer result');
    const preview = this.store.environments.preview(env.id, { retain });
    try { preview.knownTestCommand = typeof JSON.parse(git(this.store.project(run.projectId).root, ['show', `${result.resultCommit}:package.json`])).scripts?.test === 'string'; } catch { preview.knownTestCommand = false; }
    const task = this.model.row('tasks', attempt.taskId);
    const recent = this.db.prepare("SELECT count(*) AS count FROM run_events WHERE run_id=? AND kind='result.applied' AND at>?").get(run.id, new Date(Date.now() - 600000).toISOString()).count;
    const binding = { attemptId: attempt.id, resultId: result.id, treeOid: result.treeOid, base: env.base, target: run.logicalBranch, targetHead: preview.logicalHead,
      captureGeneration: result.captureGeneration, policyVersion: run.policy.version, evidence: (result.checks ?? []).map(check => `${check.id}:${createHash('sha256').update(JSON.stringify(check)).digest('hex')}`).sort() };
    return { attempt, run, task, result, env, preview, binding, hardGates: hardGates(preview, attempt, run, task), guards: guards(preview, task, run.policy, result, recent) };
  }
  preview(input) {
    const subject = this.subject(input, { retain: true }); const { result, preview, binding } = subject;
    const saved = { ...result, previews: [...(result.previews ?? []), { expect: preview.expect, binding }].slice(-20) };
    this.db.prepare("UPDATE results SET status='previewed',body=? WHERE id=? AND status NOT IN ('applied','superseded')").run(JSON.stringify(saved), result.id);
    return { ...preview, resultId: result.id, binding, hardGates: subject.hardGates, guards: subject.guards, testsVerified: result.testsVerified, claim: result.claim };
  }
  request(input) {
    const attempt = this.model.row('attempts', input.attemptId);
    const operation = this.model.prepareExternal('apply_result', input, attempt.runId);
    if (operation.phase === 'done') return operation.outcome;
    if (operation.existing) {
      this.store.reconcileEnvironments();
      const env = this.store.environments.record(attempt.environmentId);
      const landed = env.integrations?.find(item => item.operationId === operation.id);
      if (landed) return this.complete(operation.id, input, landed);
      refuse('OPERATION_PENDING', 'The previous Apply needs reconciliation; it will not be replayed');
    }
    try {
      const subject = this.subject(input); const pinned = subject.result.previews?.find(preview => preview.expect === input.expect);
      if (!pinned || JSON.stringify(pinned.binding) !== JSON.stringify(subject.binding)) refuse('PREVIEW_EXPIRED', 'Result, branch, policy or evidence changed; preview again');
      if (!subject.hardGates.pass) refuse(subject.hardGates.failures[0], 'An integration hard gate refused this result', { failures: subject.hardGates.failures });
      if (subject.guards.some(guard => guard.outcome === 'refuse')) refuse('GUARD_REFUSED', 'Run policy refuses this result', { guards: subject.guards });
      const asks = subject.guards.filter(guard => guard.outcome === 'ask');
      let approval = null;
      if (input.approvalId) {
        approval = this.model.row('approvals', input.approvalId);
        if (approval.state !== 'approved' || approval.runId !== subject.run.id || approval.expect !== input.expect || JSON.stringify(approval.binding) !== JSON.stringify(subject.binding)) refuse('APPROVAL_EXPIRED', 'This approval no longer matches the result');
      }
      if (asks.length && !approval) {
        const approval = { id: randomUUID(), runId: subject.run.id, state: 'pending', kind: 'apply', attemptId: attempt.id, resultId: input.resultId, expect: input.expect, binding: subject.binding, guards: asks, createdAt: new Date().toISOString() };
        this.model.atomic(() => {
          this.db.prepare('INSERT INTO approvals VALUES(?,?,?,?)').run(approval.id, approval.runId, approval.state, JSON.stringify(approval));
          this.model.event(approval.runId, 'approval.requested', { approvalId: approval.id, resultId: input.resultId });
        });
        return this.model.finishExternal(operation.id, { approvalRequired: true, approval });
      }
      this.model.atomic(() => {
        if (approval) this.saveApproval(approval, 'consumed', { operationId: operation.id });
        this.model.setAttemptState(attempt.id, 'integrating', { launchId: attempt.launchId });
        this.db.prepare("UPDATE results SET status='applying' WHERE id=?").run(input.resultId);
      });
      const applied = this.store.environments.apply(subject.env.id, { expect: input.expect, operationId: operation.id });
      return this.complete(operation.id, input, this.store.environments.record(applied.id).integration);
    } catch (error) {
      const env = attempt.environmentId ? this.store.environments.record(attempt.environmentId) : null;
      if (env?.lifecycle === 'integrating') throw error; // Persisted Git intent owns crash reconciliation.
      const current = this.model.row('attempts', attempt.id);
      if (current.state === 'integrating') this.model.setAttemptState(attempt.id, error.code === 'CONFLICT' ? 'conflict' : 'ready', { launchId: current.launchId });
      this.db.prepare("UPDATE results SET status='refused' WHERE id=? AND status='applying'").run(input.resultId);
      this.model.failExternal(operation.id, error); throw error;
    }
  }
  complete(operationId, input, integration) {
    return this.model.atomic(() => {
      const result = this.model.row('results', input.resultId); const attempt = this.model.row('attempts', input.attemptId);
      const history = [...(result.integrations ?? [])]; if (!history.some(item => item.commit === integration.commit)) history.push(integration);
      this.db.prepare("UPDATE results SET status='applied',body=? WHERE id=?").run(JSON.stringify({ ...result, integrations: history }), result.id);
      if (attempt.state === 'integrating') this.model.setAttemptState(attempt.id, 'integrated', { launchId: attempt.launchId });
      this.db.prepare("UPDATE results SET status='stale' WHERE status='previewed' AND attempt_id IN (SELECT id FROM attempts WHERE run_id=?) AND id<>?").run(attempt.runId, result.id);
      this.model.event(attempt.runId, 'result.applied', { attemptId: attempt.id, resultId: result.id, operationId, commit: integration.commit });
      return this.model.finishExternal(operationId, { applied: true, resultId: result.id, commit: integration.commit });
    });
  }
  saveApproval(approval, state, patch = {}) { const saved = { ...approval, ...patch, state }; this.db.prepare('UPDATE approvals SET state=?,body=? WHERE id=?').run(state, JSON.stringify(saved), approval.id); return saved; }
  recover() {
    for (const row of this.db.prepare("SELECT * FROM orchestration_operations WHERE phase='prepared'").all()) {
      const operation = JSON.parse(row.body); if (operation.kind !== 'apply_result') continue;
      const attempt = this.model.row('attempts', operation.input.attemptId);
      const env = this.store.environments.record(attempt.environmentId);
      const landed = env.integrations?.find(item => item.operationId === row.id);
      if (landed) this.complete(row.id, operation.input, landed);
      // No landing evidence: keep the intent uncertain. Never retry a Git mutation blindly.
    }
    for (const row of this.db.prepare("SELECT body FROM approvals WHERE state='approved'").all()) {
      const approval = JSON.parse(row.body); if (approval.kind !== 'apply') continue;
      try { this.request({ callerId: 'desktop', requestId: `approval:${approval.id}`, approvalId: approval.id, attemptId: approval.attemptId, resultId: approval.resultId, expect: approval.expect }); }
      catch (error) { if (error.code !== 'OPERATION_PENDING') this.saveApproval(approval, 'expired', { reason: error.message }); }
    }
  }
  decide(input) {
    const approval = this.model.row('approvals', input.approvalId);
    if (input.callerId !== 'desktop') refuse('FORBIDDEN', 'Only the user can decide a Journal approval');
    const decided = this.model.operation('decide_approval', input, approval.runId, () => {
      const current = this.model.row('approvals', approval.id);
      if (current.state !== 'pending') refuse('INVALID_STATE', 'This approval is no longer pending');
      if (!['approved', 'rejected'].includes(input.decision)) refuse('INVALID_INPUT', 'Choose approve or reject');
      if (current.kind === 'decision') {
        const saved = this.saveApproval(current, input.decision); this.model.event(current.runId, `approval.${input.decision}`, { approvalId: current.id });
        this.model.messages.send({ callerId: 'runtime:decision', requestId: current.id, runId: current.runId, recipient: 'coordinator', kind: 'answer', text: `User decision: ${input.decision}. Question: ${current.summary}` }); return saved;
      }
      let subject; try { subject = this.subject(current); } catch { return this.saveApproval(current, 'expired'); }
      if (JSON.stringify(subject.binding) !== JSON.stringify(current.binding)) return this.saveApproval(current, 'expired');
      this.model.event(current.runId, `approval.${input.decision}`, { approvalId: current.id }); return this.saveApproval(current, input.decision);
    });
    if (decided.state !== 'approved' || decided.kind === 'decision') return decided;
    return this.request({ callerId: 'desktop', requestId: `approval:${approval.id}`, approvalId: approval.id, attemptId: approval.attemptId, resultId: approval.resultId, expect: approval.expect });
  }
}
