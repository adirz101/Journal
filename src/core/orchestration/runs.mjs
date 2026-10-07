import { createHash, randomUUID } from 'node:crypto';
import { text, choice, relativePath, redact } from '../validation.mjs';
import { Workflows, branchHead, reviewSubject, resultClaim } from './workflows.mjs';
import { RUN_TRANSITIONS, WORKER_TRANSITIONS, TASK_TRANSITIONS, TERMINAL_ATTEMPTS, refuse, transition, taskStateFor } from './model.mjs';
import { Messages } from './messages.mjs';
import { IntegrationGate } from './gates.mjs';

const safeText = (value, label, max) => redact(text(value, label, max), max);
const safeInput = value => typeof value === 'string' ? redact(value, value.length) : Array.isArray(value) ? value.map(safeInput) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeInput(item)])) : value;
const now = () => new Date().toISOString();
const parse = row => row ? JSON.parse(row.body) : null;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;

// Only trusted runtime code calls state setters. Agent-facing mutations use operation() so
// request identity, state changes and their events commit together, across all StoreClients.
export class Orchestration {
  constructor(store) { this.store = store; this.db = store.db; this.messages = new Messages(this); this.gates = new IntegrationGate(this); this.workflows = new Workflows(this); }
  atomic(fn) { return this.db.isTransaction ? fn() : this.store.transaction(fn); }
  row(table, id) {
    const row = parse(this.db.prepare(`SELECT body FROM ${table} WHERE id=?`).get(text(id, 'ID', 100)));
    if (!row) refuse('NOT_FOUND', `Unknown ${table} record`);
    return row;
  }
  event(runId, kind, body) { this.db.prepare('INSERT INTO run_events(run_id,at,kind,body) VALUES(?,?,?,?)').run(runId, now(), kind, JSON.stringify(body)); }
  prepareExternal(kind, input, runId) {
    const callerId = text(input.callerId, 'caller ID', 200); const requestId = text(input.requestId, 'request ID', 200);
    const { callerId: _caller, requestId: _request, ...args } = input;
    if (['resume_worker', 'retry_worker'].includes(kind)) { delete args.sessionId; delete args.writersExcluded; }
    const hash = createHash('sha256').update(JSON.stringify(canonical({ kind, args }))).digest('hex');
    return this.atomic(() => {
      const old = this.db.prepare('SELECT * FROM orchestration_operations WHERE caller_id=? AND request_id=?').get(callerId, requestId);
      if (old) {
        const body = JSON.parse(old.body); if (body.hash !== hash) refuse('REQUEST_MISMATCH', 'This request ID was used with different arguments');
        if (old.phase === 'failed') refuse(body.error.code, body.error.message);
        return { id: old.id, phase: old.phase, existing: true, ...body };
      }
      const id = randomUUID(); const body = { kind, hash, input: safeInput(input), createdAt: now() };
      this.db.prepare('INSERT INTO orchestration_operations VALUES(?,?,?,?,?,?)').run(id, runId, callerId, requestId, 'prepared', JSON.stringify(body));
      return { id, phase: 'prepared', existing: false, ...body };
    });
  }
  finishExternal(id, outcome) {
    const row = this.db.prepare('SELECT body FROM orchestration_operations WHERE id=?').get(id);
    this.db.prepare('UPDATE orchestration_operations SET phase=?,body=? WHERE id=?').run('done', JSON.stringify({ ...JSON.parse(row.body), outcome }), id); return outcome;
  }
  failExternal(id, error) {
    const row = this.db.prepare('SELECT body FROM orchestration_operations WHERE id=?').get(id);
    this.db.prepare('UPDATE orchestration_operations SET phase=?,body=? WHERE id=?').run('failed', JSON.stringify({ ...JSON.parse(row.body), error: { code: error.code ?? 'FAILED', message: redact(String(error.message), 1000) } }), id);
  }
  operationOutcome(kind, input) {
    const old = this.db.prepare('SELECT phase,body FROM orchestration_operations WHERE caller_id=? AND request_id=?').get(input.callerId, input.requestId);
    if (!old) return { found: false };
    const { callerId, requestId, sessionId, writersExcluded, ...args } = input;
    const body = JSON.parse(old.body); if (['resume_worker', 'retry_worker'].includes(kind)) { delete args.sessionId; delete args.writersExcluded; }
    const hash = createHash('sha256').update(JSON.stringify(canonical({ kind, args }))).digest('hex');
    if (hash !== body.hash) refuse('REQUEST_MISMATCH', 'This request ID was already used with different arguments');
    if (old.phase !== 'done') refuse('OPERATION_PENDING', 'The original request is still being reconciled');
    return { found: true, outcome: body.outcome };
  }
  operation(kind, input, runId, fn) {
    const callerId = text(input.callerId, 'caller ID', 200); const requestId = text(input.requestId, 'request ID', 200);
    const { callerId: _caller, requestId: _request, ...args } = input;
    if (['resume_worker', 'retry_worker'].includes(kind)) { delete args.sessionId; delete args.writersExcluded; }
    const hash = createHash('sha256').update(JSON.stringify(canonical({ kind, args }))).digest('hex');
    return this.atomic(() => {
      const old = this.db.prepare('SELECT phase,body FROM orchestration_operations WHERE caller_id=? AND request_id=?').get(callerId, requestId);
      if (old) {
        const body = JSON.parse(old.body);
        if (body.hash !== hash) refuse('REQUEST_MISMATCH', 'This request ID was already used with different arguments');
        if (old.phase !== 'done') refuse('OPERATION_PENDING', 'The original request is still being reconciled');
        return body.outcome;
      }
      const id = randomUUID(); const body = { kind, hash, createdAt: now() };
      this.db.prepare('INSERT INTO orchestration_operations VALUES(?,?,?,?,?,?)').run(id, runId, callerId, requestId, 'prepared', JSON.stringify(body));
      const outcome = fn();
      if (outcome?.then) throw new Error('Durable model transactions must be synchronous');
      this.db.prepare('UPDATE orchestration_operations SET phase=?,body=? WHERE id=?').run('done', JSON.stringify({ ...body, outcome }), id);
      return outcome;
    });
  }
  createRun(input) {
    const id = randomUUID();
    return this.operation('create_run', input, id, () => {
      this.store.project(input.projectId);
      const run = { id, projectId: input.projectId, state: 'creating', provider: choice(input.provider ?? 'claude', ['claude', 'codex'], 'coordinator provider'), goal: safeText(input.goal, 'goal', 20000), logicalBranch: text(input.logicalBranch, 'branch', 200),
        journalToolsAllowed: input.journalToolsAllowed === true, coordinatorSessionId: null, coordinatorHistory: [], paused: false, createdAt: now(), endedAt: null,
        policy: { version: 1, integration: 'coordinator-managed', caps: { maxConcurrentWorkers: 3 }, idleReclamation: false, guards: { deletions: 'ask', outside_scope: 'allow', infrastructure: 'allow', executable: 'ask', apply_rate: 'ask' } } };
      this.db.prepare('INSERT INTO runs VALUES(?,?,?,?)').run(id, run.projectId, run.state, JSON.stringify(run));
      this.event(id, 'run.created', { goal: run.goal }); return run;
    });
  }
  getRun(id) {
    const run = this.row('runs', id); const tasks = this.listTasks(id); const attempts = this.listAttempts(id);
    const results = this.db.prepare('SELECT r.body,r.status FROM results r JOIN attempts a ON a.id=r.attempt_id WHERE a.run_id=? ORDER BY r.rowid DESC').all(id).map(row => ({ ...parse(row), status: row.status }));
    let currentHead = null; try { currentHead = branchHead(this.store, run); } catch { /* Missing branch means unknown freshness. */ }
    for (const result of results) {
      const review = result.claim?.review; if (!review) continue;
      result.reviewFreshness = review.subjectResultId
        ? (attempts.some(attempt => attempt.currentResultId === review.subjectResultId) ? 'current' : 'stale')
        : currentHead ? (review.subjectBranchHead === currentHead ? 'current' : 'stale') : 'unknown';
    }
    return { ...run, tasks, attempts, results, currentHead,
      decisions: this.db.prepare("SELECT body FROM run_events WHERE run_id=? AND kind='run.decision' ORDER BY id DESC LIMIT 100").all(id).map(parse).reverse(),
      messages: this.db.prepare('SELECT body FROM messages WHERE run_id=? ORDER BY rowid').all(id).map(parse),
      approvals: this.db.prepare('SELECT body FROM approvals WHERE run_id=? ORDER BY rowid DESC').all(id).map(parse),
      eventCursor: this.db.prepare('SELECT max(id) AS id FROM run_events WHERE run_id=?').get(id).id ?? 0 };
  }
  listRuns(projectId) { return this.db.prepare('SELECT body FROM runs WHERE project_id=? ORDER BY rowid DESC').all(projectId).map(parse); }
  runEvents(runId, afterId = 0, limit = 100) { this.row('runs', runId); return this.db.prepare('SELECT * FROM run_events WHERE run_id=? AND id>? ORDER BY id LIMIT ?').all(runId, Number.isSafeInteger(afterId) ? afterId : 0, Math.max(1, Math.min(500, Number(limit) || 100))).map(row => ({ ...row, body: JSON.parse(row.body) })); }
  setRunState(id, state, patch = {}) {
    return this.atomic(() => {
      const run = this.row('runs', id); transition(RUN_TRANSITIONS, run.state, state);
      const saved = { ...run, ...patch, id, projectId: run.projectId, state, updatedAt: now(), ...(state === 'finished' ? { endedAt: now() } : {}) };
      this.db.prepare('UPDATE runs SET state=?,body=? WHERE id=?').run(state, JSON.stringify(saved), id);
      this.event(id, `run.${state}`, { previous: run.state }); return saved;
    });
  }
  createTask(input) {
    return this.operation('create_task', input, input.runId, () => {
      const run = this.row('runs', input.runId); if (run.state === 'finished') refuse('INVALID_STATE', 'This run has finished');
      const task = { id: randomUUID(), runId: run.id, title: safeText(input.title, 'title', 200), goal: safeText(input.goal ?? input.title, 'goal', 20000),
        kind: choice(input.kind ?? 'work', ['work', 'review'], 'task kind'), state: 'pending', acceptance: (input.acceptance ?? []).map(item => safeText(item, 'acceptance criterion', 2000)), scope: input.scope ?? { paths: [], areas: [] },
        priority: Number.isInteger(input.priority) ? Math.max(-10, Math.min(10, input.priority)) : 0, variants: input.variants === true ? 2 : input.variants || 0, hostingAllowed: !!input.hostingAllowed, createdAt: now(), ...reviewSubject(this, run, input) };
      if (!Number.isInteger(task.variants) || task.variants < 0 || task.variants > 8) refuse('INVALID_INPUT', 'Choose up to eight variants');
      task.scope = { paths: (task.scope.paths ?? []).map(path => relativePath(path.replace(/\/$/, ''))), areas: (task.scope.areas ?? []).map(area => safeText(area, 'area', 200)) };
      if (task.variants) task.variantBase = branchHead(this.store, run);
      this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?)').run(task.id, task.runId, task.state, JSON.stringify(task));
      for (const dependency of input.dependencies ?? []) this.insertDependency(task.id, typeof dependency === 'string' ? dependency : dependency.taskId, dependency.when ?? 'integrated');
      if (task.subjectTaskId && !task.dependencies?.some(dep => dep.taskId === task.subjectTaskId)) this.insertDependency(task.id, task.subjectTaskId, 'ready');
      this.refreshDependencies(run.id); this.event(run.id, 'task.created', { taskId: task.id }); return this.row('tasks', task.id);
    });
  }
  listTasks(runId, filter = null) { this.row('runs', runId); return this.db.prepare('SELECT body FROM tasks WHERE run_id=? ORDER BY rowid').all(runId).map(parse).map(task => ({ ...task, dependencies: this.db.prepare('SELECT depends_on AS taskId,kind AS "when" FROM dependencies WHERE task_id=?').all(task.id) })).filter(task => !filter || task.state === (filter === 'runnable' ? 'pending' : filter)); }
  updateTask(input) {
    const task = this.row('tasks', input.taskId);
    return this.operation('update_task', input, task.runId, () => {
      const current = this.row('tasks', task.id); if (['done', 'cancelled'].includes(current.state)) refuse('INVALID_STATE', 'This task has ended');
      const patch = {};
      for (const key of ['title', 'goal']) if (input[key] !== undefined) patch[key] = safeText(input[key], key, key === 'title' ? 200 : 20000);
      if (input.priority !== undefined) { if (!Number.isInteger(input.priority) || Math.abs(input.priority) > 10) refuse('INVALID_INPUT', 'Priority must be an integer from -10 to 10'); patch.priority = input.priority; }
      const saved = { ...current, ...patch }; this.db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(saved), task.id);
      this.event(task.runId, 'task.updated', { taskId: task.id, fields: Object.keys(patch) }); return saved;
    });
  }
  cancelTask(input) {
    const task = this.row('tasks', input.taskId);
    return this.operation('cancel_task', input, task.runId, () => {
      const current = this.row('tasks', task.id); const active = this.activeAttempts(task.id);
      if (active.some(attempt => !['requested', 'queued'].includes(attempt.state))) refuse('ACTIVE_ATTEMPT', 'Stop and retire the active worker explicitly before cancelling this task');
      transition(TASK_TRANSITIONS, current.state, 'cancelled');
      for (const attempt of active) this.setAttemptState(attempt.id, 'cancelled', { launchId: attempt.launchId });
      const saved = { ...current, state: 'cancelled', completedReason: input.reason ? safeText(input.reason, 'reason', 2000) : null };
      this.db.prepare('UPDATE tasks SET state=?,body=? WHERE id=?').run(saved.state, JSON.stringify(saved), task.id);
      this.event(task.runId, 'task.cancelled', { taskId: task.id }); return saved;
    });
  }
  completeTask(input) {
    const task = this.row('tasks', input.taskId);
    return this.operation('complete_task', input, task.runId, () => {
      const current = this.row('tasks', task.id); transition(TASK_TRANSITIONS, current.state, 'done');
      const attempts = this.activeAttempts(task.id);
      if (attempts.some(attempt => attempt.presence === 'live' || !['ready', 'integrated'].includes(attempt.state))) refuse('ACTIVE_ATTEMPT', 'Reconcile active workers before completing this task');
      const reason = safeText(input.reason, 'completion reason', 2000);
      for (const attempt of attempts) this.setAttemptState(attempt.id, 'done', { launchId: attempt.launchId, endedReason: reason });
      const saved = { ...current, state: 'done', completedReason: reason }; this.db.prepare('UPDATE tasks SET state=?,body=? WHERE id=?').run('done', JSON.stringify(saved), task.id);
      this.event(task.runId, 'task.done', { taskId: task.id, reason }); this.refreshDependencies(task.runId); return saved;
    });
  }
  finishRun(input) {
    return this.operation('finish_run', input, input.runId, () => {
      const run = this.getRun(input.runId);
      if (run.attempts.some(attempt => !TERMINAL_ATTEMPTS.has(attempt.state) || attempt.presence === 'live')) refuse('ACTIVE_ATTEMPT', 'Reconcile the workers before finishing this run');
      if (run.approvals.some(approval => ['pending', 'approved'].includes(approval.state))) refuse('PENDING_APPROVALS', 'Resolve pending decisions before finishing');
      if (run.tasks.some(task => !['done', 'cancelled'].includes(task.state))) refuse('UNFINISHED_TASKS', 'Complete or cancel the remaining tasks');
      if (run.messages.some(message => !['acknowledged', 'cancelled'].includes(message.state))) refuse('PENDING_MESSAGES', 'Resolve pending messages before finishing');
      return this.setRunState(run.id, 'finished', { endedReason: safeText(input.reason, 'reason', 2000) });
    });
  }
  recordDecision(input) {
    return this.operation('record_decision', input, input.runId, () => {
      this.row('runs', input.runId); const decision = { id: randomUUID(), summary: safeText(input.summary, 'decision', 4000), at: now(), callerId: input.callerId };
      this.event(input.runId, 'run.decision', decision); return decision;
    });
  }
  reportProgress(input) {
    const attempt = this.row('attempts', input.attemptId);
    return this.operation('report_progress', input, attempt.runId, () => {
      const current = this.row('attempts', attempt.id); this.fence(current, input);
      const progress = { summary: text(input.summary, 'progress', 2000), at: now() };
      this.db.prepare('UPDATE attempts SET body=? WHERE id=?').run(JSON.stringify({ ...current, progress }), current.id);
      this.event(current.runId, 'worker.progress', { attemptId: current.id, ...progress }); return progress;
    });
  }
  listAttempts(runId) { this.row('runs', runId); return this.db.prepare('SELECT body FROM attempts WHERE run_id=? ORDER BY rowid').all(runId).map(parse); }
  activeAttempts(taskId) { return this.db.prepare('SELECT body FROM attempts WHERE task_id=?').all(taskId).map(parse).filter(attempt => !TERMINAL_ATTEMPTS.has(attempt.state)); }
  insertDependency(taskId, dependsOn, when = 'integrated') {
    const task = this.row('tasks', taskId); const parent = this.row('tasks', dependsOn);
    if (this.activeAttempts(taskId).length) refuse('ACTIVE_ATTEMPT', 'Cancel or finish this task\'s attempt before changing dependencies');
    if (task.runId !== parent.runId) refuse('WRONG_RUN', 'Dependencies must belong to the same run');
    choice(when, ['ready', 'integrated'], 'dependency condition');
    const visit = (id, seen = new Set()) => { if (id === taskId) return true; if (seen.has(id)) return false; seen.add(id); return this.db.prepare('SELECT depends_on FROM dependencies WHERE task_id=?').all(id).some(row => visit(row.depends_on, seen)); };
    if (visit(dependsOn)) refuse('DEPENDENCY_CYCLE', 'This dependency would create a cycle');
    this.db.prepare('INSERT INTO dependencies VALUES(?,?,?) ON CONFLICT(task_id,depends_on) DO UPDATE SET kind=excluded.kind').run(taskId, dependsOn, when);
  }
  addDependency(input) { const task = this.row('tasks', input.taskId); return this.operation('add_dependency', input, task.runId, () => { this.insertDependency(task.id, input.dependsOn, input.when); this.refreshDependencies(task.runId); this.event(task.runId, 'task.dependency_added', { taskId: task.id, dependsOn: input.dependsOn }); return this.row('tasks', task.id); }); }
  removeDependency(input) { const task = this.row('tasks', input.taskId); return this.operation('remove_dependency', input, task.runId, () => { if (this.activeAttempts(task.id).length) refuse('ACTIVE_ATTEMPT', 'This task has an active attempt'); this.db.prepare('DELETE FROM dependencies WHERE task_id=? AND depends_on=?').run(task.id, input.dependsOn); this.refreshDependencies(task.runId); return this.row('tasks', task.id); }); }
  refreshDependencies(runId) {
    for (const task of this.listTasks(runId).filter(task => ['pending', 'blocked'].includes(task.state))) {
      const missing = task.dependencies.filter(dependency => { const parent = this.row('tasks', dependency.taskId); return !(dependency.when === 'ready' ? ['ready', 'integrated', 'done'] : ['integrated', 'done']).includes(parent.state); });
      const state = missing.length ? 'blocked' : 'pending'; if (state === task.state) continue;
      const saved = { ...task, state, blockedReason: missing.length ? { dependencies: missing.map(item => item.taskId) } : null };
      this.db.prepare('UPDATE tasks SET state=?,body=? WHERE id=?').run(state, JSON.stringify(saved), task.id);
      this.event(runId, state === 'pending' ? 'task.unblocked' : 'task.blocked', { taskId: task.id });
    }
  }
  requestWorker(input) {
    const task = this.row('tasks', input.taskId);
    return this.operation('create_worker', input, task.runId, () => {
      const current = this.row('tasks', task.id); const run = this.row('runs', task.runId);
      if (run.paused || run.state === 'finished') refuse('RUN_PAUSED', 'This run is paused or finished');
      if (current.state === 'blocked') refuse('TASK_BLOCKED', 'This task has unmet dependencies');
      if (this.activeAttempts(task.id).length && !current.variants) refuse('ACTIVE_ATTEMPT', 'This task already has an active attempt');
      if (current.variants && this.activeAttempts(task.id).length >= current.variants) refuse('VARIANT_LIMIT', 'All variants have already been requested');
      if (current.state !== 'pending' && !(current.variants && ['queued', 'in_progress', 'ready', 'result_available'].includes(current.state))) refuse('INVALID_STATE', 'This task cannot request a new worker');
      const attempt = { id: randomUUID(), taskId: task.id, runId: task.runId, state: 'requested', presence: 'paused', provider: choice(input.provider, ['claude', 'codex', 'cursor'], 'provider'),
        model: input.model == null ? null : text(input.model, 'model', 160), timeoutMinutes: input.timeoutMinutes ?? null, attachments: input.attachments ?? [],
        mode: task.kind === 'review' ? 'review' : choice(input.mode ?? 'build', ['build', 'research'], 'mode'), baseCommit: task.subjectCommit ?? task.subjectBranchHead ?? task.variantBase ?? null, environmentId: null, sessionIds: [], currentSessionId: null, launchId: null, results: [], admission: null, createdAt: now() };
      if (attempt.model && !/^[A-Za-z0-9][A-Za-z0-9._:/ -]*$/.test(attempt.model)) refuse('INVALID_INPUT', 'Invalid model identifier');
      if (attempt.timeoutMinutes !== null && (!Number.isInteger(attempt.timeoutMinutes) || attempt.timeoutMinutes < 1 || attempt.timeoutMinutes > 1440)) refuse('INVALID_INPUT', 'Choose a soft timeout between one minute and one day');
      if (!Array.isArray(attempt.attachments) || attempt.attachments.length > 20) refuse('INVALID_INPUT', 'Reference at most twenty project files');
      attempt.attachments = attempt.attachments.map(item => { if (item.startLine != null && (!Number.isSafeInteger(item.startLine) || item.startLine < 1 || !Number.isSafeInteger(item.endLine ?? item.startLine) || (item.endLine ?? item.startLine) < item.startLine)) refuse('INVALID_INPUT', 'Invalid attachment line range'); return { path: relativePath(item.path), ...(item.startLine ? { startLine: item.startLine, endLine: item.endLine ?? item.startLine } : {}) }; });
      this.db.prepare('INSERT INTO attempts VALUES(?,?,?,?,?,?)').run(attempt.id, task.id, task.runId, attempt.state, attempt.presence, JSON.stringify(attempt));
      this.event(task.runId, 'worker.requested', { attemptId: attempt.id, taskId: task.id }); return attempt;
    });
  }
  remindWorkers(at = Date.now()) {
    return this.atomic(() => {
      let count = 0;
      for (const row of this.db.prepare("SELECT body FROM attempts WHERE presence='live'").all()) {
        const attempt = parse(row); if (!attempt.timeoutMinutes || !attempt.startedAt || TERMINAL_ATTEMPTS.has(attempt.state)) continue;
        const run = this.row('runs', attempt.runId); if (run.paused || run.state === 'finished') continue;
        const elapsed = at - Date.parse(attempt.startedAt); const interval = attempt.timeoutMinutes * 60000;
        const phase = elapsed >= interval * 2 ? 'coordinator' : elapsed >= interval ? 'worker' : null;
        if (!phase || attempt.timeoutReminders?.includes(phase)) continue;
        const summary = phase === 'worker' ? 'The task soft time limit has passed. Report progress or a blocker; this reminder does not stop your work.' : 'A worker remains active beyond its soft time limit. Review its progress before deciding what to do.';
        this.messages.send({ callerId: 'runtime:timeout', requestId: `${attempt.id}:${attempt.launchId}:${phase}`, runId: run.id, recipient: phase === 'worker' ? attempt.id : 'coordinator', kind: 'instruction', text: summary });
        this.setAttemptState(attempt.id, attempt.state, { launchId: attempt.launchId, timeoutReminders: [...(attempt.timeoutReminders ?? []), phase] });
        this.event(run.id, 'worker.soft_timeout', { attemptId: attempt.id, phase, summary }); count++;
      }
      return count;
    });
  }
  fence(attempt, patch) { if (attempt.launchId && patch.launchId !== attempt.launchId) refuse('STALE_LAUNCH', 'This event does not belong to the current launch'); }
  pauseRun(input) {
    return this.operation('pause_run', input, input.runId, () => {
      const run = this.row('runs', input.runId);
      if (run.state === 'finished') refuse('INVALID_STATE', 'This run has finished');
      if (typeof input.paused !== 'boolean') refuse('INVALID_INPUT', 'paused must be a boolean');
      return this.setRunState(run.id, run.state, { paused: input.paused });
    });
  }
  queuedAttempts() {
    return this.db.prepare("SELECT a.body,t.body AS task FROM attempts a JOIN tasks t ON t.id=a.task_id WHERE a.state IN ('requested','queued') OR (a.state IN ('idle','ready','integrated','result_available','blocked','conflict','waiting_for_coordinator') AND json_extract(a.body,'$.admission.phase')='resume_queued') ORDER BY a.rowid").all().map(row => ({ ...parse(row), priority: JSON.parse(row.task).priority }));
  }
  assertFolderSettled(environmentId) {
    if (!environmentId) return;
    const env = this.store.environments.record(environmentId);
    if (env.takeIn?.operationId && env.takeIn.phase !== 'done') refuse('OPERATION_PENDING', 'Reconcile the pending take-in before admitting another writer');
  }
  requestResume(input) {
    const attempt = this.row('attempts', input.attemptId);
    return this.operation('resume_worker', input, attempt.runId, () => {
      const current = this.row('attempts', attempt.id);
      if (current.presence !== 'paused' || !['idle', 'ready', 'integrated', 'result_available', 'blocked', 'conflict', 'waiting_for_coordinator'].includes(current.state)) refuse('INVALID_STATE', 'Only a settled paused worker can resume');
      this.assertFolderSettled(current.environmentId);
      if (!current.currentSessionId || current.currentSessionId !== input.sessionId) refuse('STALE_LAUNCH', 'Resume the worker\'s current exact conversation');
      if (['resume_queued', 'resuming'].includes(current.admission?.phase)) refuse('ACTIVE_ATTEMPT', 'A resume is already pending');
      return this.setAttemptState(current.id, current.state, { launchId: current.launchId, admission: { phase: 'resume_queued', resumeSessionId: current.currentSessionId, queuedAt: now(), reasons: [] } });
    });
  }
  retryWorker(input) {
    const attempt = this.row('attempts', input.attemptId);
    return this.operation('retry_worker', input, attempt.runId, () => {
      const current = this.row('attempts', attempt.id);
      if (!['idle', 'result_available', 'ready', 'blocked', 'conflict', 'waiting_for_coordinator', 'launch_failed', 'integrated'].includes(current.state)) refuse('INVALID_STATE', 'Settle the current work or cancel its launch before retrying');
      if (current.presence === 'live' || current.presence === 'lost' || ['resume_queued', 'resuming'].includes(current.admission?.phase)) refuse('ACTIVE_ATTEMPT', 'Stop and settle the worker and cancel any pending resume before retrying');
      const from = choice(input.from ?? 'base', ['base', 'result', 'environment'], 'retry source');
      if (from === 'environment') this.assertFolderSettled(current.environmentId);
      if (from === 'environment' && input.writersExcluded !== true) refuse('WRITERS_UNKNOWN', 'Verify the previous process tree has ended before reusing its folder');
      if (from === 'result' && !current.currentResultId) refuse('NO_RESULT', 'No captured result is available for this retry');
      if (this.activeAttempts(current.taskId).some(other => other.id !== current.id)) refuse('ACTIVE_ATTEMPT', 'Select a variant before retrying this task');
      const reason = safeText(input.reason, 'retry reason', 2000);
      this.setAttemptState(current.id, 'retired', { launchId: current.launchId, endedReason: reason });
      const task = this.row('tasks', current.taskId);
      this.db.prepare('UPDATE tasks SET state=?,body=? WHERE id=?').run('pending', JSON.stringify({ ...task, state: 'pending' }), task.id);
      const next = this.requestWorker({ callerId: input.callerId, requestId: createHash('sha256').update(`retry:${input.requestId}`).digest('hex'), taskId: task.id, provider: input.provider ?? current.provider, model: input.provider && input.provider !== current.provider ? null : current.model, timeoutMinutes: current.timeoutMinutes, attachments: current.attachments, mode: current.mode });
      const saved = { ...next, retryOf: current.id, retryReason: reason, sourceResultId: from === 'result' ? current.currentResultId : null, handoffFrom: from === 'environment' ? current.id : null, environmentId: from === 'environment' ? current.environmentId : null };
      if (from === 'environment') { const env = this.store.environments.record(current.environmentId); this.store.environments.patch(current.environmentId, { attemptId: next.id, ...(env.lifecycle === 'integrated' ? { lifecycle: 'completed' } : {}) }); }
      this.db.prepare('UPDATE attempts SET body=? WHERE id=?').run(JSON.stringify(saved), next.id); this.event(current.runId, 'worker.retry_requested', { attemptId: next.id, previousAttemptId: current.id, from }); return saved;
    });
  }
  queueAttempt(id, decision) {
    return this.atomic(() => {
      const attempt = this.row('attempts', id);
      if (attempt.admission?.resumeSessionId && ['resume_queued', 'resuming', 'resume_failed'].includes(attempt.admission.phase)) return this.setAttemptState(id, attempt.state, { launchId: attempt.launchId, admission: { ...attempt.admission, ...decision, phase: 'resume_queued' } });
      if (!['requested', 'queued', 'launch_failed'].includes(attempt.state)) refuse('INVALID_STATE', 'This attempt cannot be queued');
      const admission = { ...attempt.admission, ...decision, queuedAt: attempt.admission?.queuedAt ?? now() };
      if (attempt.state === 'queued' && JSON.stringify(attempt.admission) === JSON.stringify(admission)) return attempt;
      return this.setAttemptState(id, 'queued', { launchId: attempt.launchId, admission });
    });
  }
  admitAttempt(id, intent) {
    return this.atomic(() => {
      const attempt = this.row('attempts', id); const run = this.row('runs', attempt.runId);
      const resume = attempt.admission?.phase === 'resume_queued';
      if (resume && (attempt.presence !== 'paused' || !['idle', 'ready', 'integrated', 'result_available', 'blocked', 'conflict', 'waiting_for_coordinator'].includes(attempt.state))) refuse('INVALID_STATE', 'This worker can no longer resume');
      if (!resume && !['requested', 'queued'].includes(attempt.state)) refuse('INVALID_STATE', 'This attempt is not waiting for admission');
      if (run.paused || run.state === 'finished') refuse('RUN_PAUSED', 'This run is paused or finished');
      if ((attempt.admission?.backoffUntil ?? 0) > (intent.at ?? Date.now())) refuse('BACKOFF', 'This launch is cooling down after a resource failure');
      const launchId = text(intent.launchId, 'launch ID', 100);
      // A new launch identity is installed only in the atomic queued -> starting transition.
      this.db.prepare('UPDATE attempts SET body=? WHERE id=?').run(JSON.stringify({ ...attempt, launchId }), id);
      return this.setAttemptState(id, resume ? attempt.state : 'starting', { launchId, turnId: null, admission: { ...attempt.admission, ...intent, reasons: [], phase: resume ? 'resuming' : 'intent' } });
    });
  }
  failAttemptLaunch(id, failure) {
    return this.atomic(() => {
      const attempt = this.row('attempts', id); this.fence(attempt, failure);
      const resume = attempt.admission?.phase === 'resuming';
      if (attempt.state !== 'starting' && !resume) refuse('INVALID_STATE', 'This launch is no longer starting');
      const failures = (attempt.admission?.failures ?? 0) + 1;
      const retry = failure.noProcess === true && ['ENOMEM', 'EAGAIN', 'EMFILE', 'NO_PORTS'].includes(failure.code);
      const admission = { ...attempt.admission, phase: failure.noProcess ? 'not-started' : 'uncertain', failures, reasons: [failure.code], error: String(failure.message ?? failure.code).slice(0, 1000),
        backoffUntil: retry ? (failure.at ?? Date.now()) + Math.min(240000, 15000 * 2 ** Math.min(failures - 1, 4)) : 0 };
      if (resume) admission.phase = 'resume_failed';
      const saved = this.setAttemptState(id, resume ? attempt.state : 'launch_failed', { launchId: attempt.launchId, admission, presence: failure.noProcess ? 'paused' : 'lost' });
      return retry ? this.queueAttempt(id, admission) : saved;
    });
  }
  recoverOrchestration() {
    return this.atomic(() => {
      for (const row of this.db.prepare("SELECT body FROM runs WHERE state IN ('starting','active','idle','waiting_for_user')").all()) {
        const run = JSON.parse(row.body);
        const session = run.coordinatorLaunchId ? parse(this.db.prepare("SELECT body FROM sessions WHERE json_extract(body,'$.runId')=? AND json_extract(body,'$.role')='coordinator' AND json_extract(body,'$.launchId')=? ORDER BY rowid DESC LIMIT 1").get(run.id, run.coordinatorLaunchId)) : null;
        const recovered = this.setRunState(run.id, 'detached', { ...(session ? { coordinatorSessionId: session.id, coordinatorHistory: [...new Set([...run.coordinatorHistory, session.id])] } : {}), attention: { code: 'RUNTIME_RESTARTED', reason: 'The coordinator launch must be reconciled before continuing.' } });
        if (session && run.coordinatorOperationId) this.finishExternal(run.coordinatorOperationId, recovered);
      }
      const attempts = this.db.prepare("SELECT body FROM attempts WHERE state NOT IN ('cancelled','done','retired','abandoned','superseded')").all().map(parse);
      for (const attempt of attempts) {
        if (attempt.state === 'starting' || attempt.admission?.phase === 'resuming') {
          const session = parse(this.db.prepare("SELECT body FROM sessions WHERE json_extract(body,'$.attemptId')=? AND json_extract(body,'$.launchId')=? ORDER BY rowid DESC LIMIT 1").get(attempt.id, attempt.launchId));
          if (session) {
            const ended = ['stopped', 'exited', 'failed', 'interrupted'].includes(session.status) && Array.isArray(session.survivors) && !session.survivors.length;
            this.setAttemptState(attempt.id, 'working', { launchId: attempt.launchId, currentSessionId: session.id, environmentId: session.environmentId ?? session.workspaceId ?? attempt.environmentId, sessionIds: [...new Set([...attempt.sessionIds, session.id])], turnId: session.turnId ?? null, presence: ended ? 'paused' : 'lost', admission: { ...attempt.admission, phase: 'recovered', resumeSessionId: null } });
          } else this.failAttemptLaunch(attempt.id, { launchId: attempt.launchId, code: 'START_UNCERTAIN', message: 'The runtime restarted during launch. Reconcile this attempt before retrying.' });
        }
        else if (attempt.presence === 'live') this.setPresence(attempt.id, 'lost', { launchId: attempt.launchId });
      }
      for (const row of this.db.prepare("SELECT id,body FROM orchestration_operations WHERE phase='prepared'").all()) {
        const operation = JSON.parse(row.body); if (operation.kind !== 'verify_result') continue;
        const result = this.row('results', operation.input.resultId);
        // Retain receipts from the retired verifier. A pending legacy check may
        // be interrupted after restart, but never resumed or declared successful.
        const checks = (result.checks ?? []).map(check => check.operationId === row.id && check.state === 'running'
          ? { ...check, state: 'interrupted', exit: null, endedAt: now() } : check);
        if (checks.some((check, index) => check !== result.checks[index])) this.db.prepare('UPDATE results SET body=? WHERE id=?').run(JSON.stringify({ ...result, checks, testsVerified: 'unknown' }), result.id);
        this.failExternal(row.id, { code: 'CHECK_INTERRUPTED', message: 'The earlier Journal verifier stopped before this check completed and has been retired. This check will not rerun; use project-appropriate checks through the native agent.' });
      }
      return attempts.length;
    });
  }
  setAttemptState(id, state, patch = {}) {
    return this.atomic(() => {
      const attempt = this.row('attempts', id); this.fence(attempt, patch); transition(WORKER_TRANSITIONS, attempt.state, state);
      if (state === attempt.state && Object.entries(patch).every(([key, value]) => JSON.stringify(attempt[key]) === JSON.stringify(value))) return attempt;
      const saved = { ...attempt, ...patch, id, taskId: attempt.taskId, runId: attempt.runId, state, updatedAt: now() };
      this.db.prepare('UPDATE attempts SET state=?,presence=?,body=? WHERE id=?').run(state, saved.presence, JSON.stringify(saved), id);
      const task = this.row('tasks', attempt.taskId); const projected = taskStateFor(state);
      if (projected && projected !== task.state && (!task.variants || task.chosenAttemptId === id || !this.activeAttempts(task.id).some(other => other.id !== id && ['working', 'starting', 'ready', 'integrated'].includes(other.state)))) { transition(TASK_TRANSITIONS, task.state, projected); this.db.prepare('UPDATE tasks SET state=?,body=? WHERE id=?').run(projected, JSON.stringify({ ...task, state: projected }), task.id); }
      this.event(attempt.runId, `worker.${state}`, { attemptId: id, previous: attempt.state }); this.refreshDependencies(attempt.runId); return saved;
    });
  }
  setPresence(id, presence, binding = {}) {
    return this.atomic(() => {
      const attempt = this.row('attempts', id); this.fence(attempt, binding); choice(presence, ['live', 'paused', 'lost'], 'presence');
      if (attempt.presence === presence) return attempt;
      const saved = { ...attempt, presence };
      this.db.prepare('UPDATE attempts SET presence=?,body=? WHERE id=?').run(presence, JSON.stringify(saved), id);
      this.event(attempt.runId, 'worker.presence', { attemptId: id, presence }); return saved;
    });
  }
  reportWorker(input) {
    const attempt = this.row('attempts', input.attemptId);
    return this.operation('report_worker', input, attempt.runId, () => {
      const current = this.row('attempts', attempt.id); this.fence(current, input);
      if (!current.turnId || current.turnId !== input.turnId) refuse('STALE_TURN', 'This report does not belong to the current turn');
      if (!['working', 'idle', 'waiting_for_coordinator'].includes(current.state)) refuse('INVALID_STATE', 'This worker cannot report in its current state');
      const kind = choice(input.kind, ['result', 'ask', 'blocked'], 'report kind');
      const report = { kind, launchId: input.launchId, turnId: input.turnId, summary: redact(text(input.summary, 'summary', 2000)), ...(kind === 'result' ? resultClaim(input, this.row('tasks', current.taskId)) : {}),
        status: kind === 'result' ? choice(input.status, ['done', 'partial', 'blocked', 'failed'], 'report status') : null, at: now() };
      const saved = { ...current, reports: { ...(current.reports ?? {}), [kind]: report } };
      this.db.prepare('UPDATE attempts SET body=? WHERE id=?').run(JSON.stringify(saved), current.id);
      this.event(current.runId, `worker.report_${kind}`, { attemptId: current.id, claim: report });
      return kind === 'ask' && current.state === 'idle' ? this.setAttemptState(current.id, 'waiting_for_coordinator', { launchId: current.launchId }) : saved;
    });
  }
  recordResult({ environmentId, resultId, attemptId = null, launchId = null, turnId = null, captureGeneration = null }) {
    return this.atomic(() => {
      const snapshot = this.store.getEnvironmentResult(environmentId, resultId);
      const id = snapshot.resultId; const existing = parse(this.db.prepare('SELECT body FROM results WHERE id=?').get(id));
      const attempt = attemptId ? this.row('attempts', attemptId) : null;
      if (attempt) {
        this.fence(attempt, { launchId });
        if (attempt.environmentId !== environmentId || attempt.turnId !== turnId) refuse('STALE_TURN', 'This capture is not for the current worker environment and turn');
      }
      if (existing) {
        if (existing.environmentId !== environmentId || (existing.attemptId && existing.attemptId !== attemptId)) refuse('RESULT_CHANGED', 'This result belongs to another subject');
        if (attempt && !existing.attemptId) {
          const bound = { ...existing, attemptId, launchId, turnId, captureGeneration, changedFiles: existing.changedFiles ?? snapshot.files };
          this.db.prepare('UPDATE results SET attempt_id=?,body=? WHERE id=?').run(attemptId, JSON.stringify(bound), id);
          this.db.prepare('UPDATE attempts SET body=? WHERE id=?').run(JSON.stringify({ ...attempt, currentResultId: id, results: [...new Set([...attempt.results, id])] }), attempt.id);
          return bound;
        }
        return { ...existing, changedFiles: existing.changedFiles ?? snapshot.files };
      }
      const result = { id, environmentId, attemptId, launchId, turnId, captureGeneration, resultCommit: snapshot.sha, treeOid: snapshot.tree,
        base: snapshot.base, resultRef: `refs/journal/env/${environmentId}/results/${id}`, changedFiles: snapshot.files, excludedFiles: snapshot.excluded, nestedRepositories: snapshot.nested,
        claim: null, checks: [], testsVerified: 'not-run', integrations: [], capturedAt: snapshot.at };
      this.db.prepare("UPDATE results SET status='superseded' WHERE environment_id=? AND status IN ('current','previewed','stale','refused')").run(environmentId);
      this.db.prepare('INSERT INTO results VALUES(?,?,?,?,?)').run(id, environmentId, attemptId, 'current', JSON.stringify(result));
      if (attempt) {
        this.db.prepare('UPDATE attempts SET body=? WHERE id=?').run(JSON.stringify({ ...attempt, currentResultId: id, results: [...attempt.results, id] }), attempt.id);
        this.event(attempt.runId, 'result.captured', { attemptId, resultId: id, treeOid: result.treeOid });
      }
      return result;
    });
  }
  settleAttempt(id, boundary) {
    return this.atomic(() => {
      let attempt = this.row('attempts', id); this.fence(attempt, boundary);
      if (attempt.turnId !== boundary.turnId) refuse('STALE_TURN', 'This boundary is not for the current turn');
      if (boundary.approvalOpen || attempt.state === 'waiting_for_user') return attempt;
      if (attempt.settledTurnId === boundary.turnId) return attempt;
      if (attempt.state !== 'working') refuse('INVALID_STATE', 'Only a working turn can settle');
      const result = boundary.resultId ? this.recordResult({ ...boundary, resultId: boundary.resultId, environmentId: attempt.environmentId, attemptId: id }) : null;
      attempt = this.row('attempts', id);
      const report = kind => { const value = attempt.reports?.[kind]; return value?.launchId === boundary.launchId && value?.turnId === boundary.turnId ? value : null; };
      const blocker = report('blocked'); const question = report('ask'); const done = report('result');
      const state = blocker || done?.status === 'blocked' ? 'blocked' : question ? 'waiting_for_coordinator'
        : done?.status === 'done' && (result || boundary.captureVerified === true) && boundary.outcome !== 'error' && boundary.outcome !== 'interrupted' ? 'ready'
          : result?.changedFiles.length ? 'result_available' : 'idle';
      if (result && done) {
        const run = this.row('runs', attempt.runId); const memoryCandidates = [];
        for (const proposal of done.memoryProposals ?? []) {
          const { item, expected } = this.store.prepareMemory(run.projectId, { ...proposal, source: { kind: 'user', note: `Worker proposal from result ${result.id}; requires user review` } }, { branch: run.logicalBranch });
          item.origin = { sessionId: attempt.currentSessionId, environmentId: result.environmentId, logicalBranch: run.logicalBranch, base: result.base, result: result.resultCommit, resultId: result.id, runId: run.id, attemptId: attempt.id };
          this.store.writeMemory(item, expected); memoryCandidates.push(item.id);
        }
        this.db.prepare('UPDATE results SET body=? WHERE id=?').run(JSON.stringify({ ...result, claim: done, memoryCandidates }), result.id);
        if (done.review) this.event(run.id, 'review.verdict', { attemptId: attempt.id, resultId: result.id, claim: done.review });
      }
      return this.setAttemptState(id, state, { launchId: boundary.launchId, settledTurnId: boundary.turnId });
    });
  }
  acceptResult(input) {
    const attempt = this.row('attempts', input.attemptId);
    return this.operation('accept_result', input, attempt.runId, () => {
      const current = this.row('attempts', attempt.id);
      if (current.state !== 'result_available' || current.currentResultId !== input.resultId) refuse('RESULT_CHANGED', 'Accept only the current available result');
      const reason = safeText(input.reason, 'reason', 2000);
      this.event(attempt.runId, 'result.accepted_without_report', { attemptId: current.id, resultId: input.resultId, reason });
      return this.setAttemptState(current.id, 'ready', { launchId: current.launchId, acceptedResultId: input.resultId });
    });
  }
}
