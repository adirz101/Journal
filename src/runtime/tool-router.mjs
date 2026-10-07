import { randomBytes, randomUUID } from 'node:crypto';
import { refuse } from '../core/orchestration/model.mjs';
import { DEFINITIONS } from '../agent-tools/definitions.mjs';

export const WORKER_TOOLS = ['get_context', 'report_progress', 'ask', 'report_blocked', 'report_result', 'inbox', 'ack', 'get_message'];
export const COORDINATOR_TOOLS = ['get_run', 'get_capacity', 'create_task', 'update_task', 'cancel_task', 'complete_task', 'list_tasks', 'create_worker', 'get_worker', 'list_workers', 'send_message', 'inbox', 'ack', 'get_message', 'wait_for_events', 'accept_result', 'pause_run', 'finish_run', 'record_decision'];
COORDINATOR_TOOLS.push('preview_result', 'apply_result');
COORDINATOR_TOOLS.push('publish_update');
COORDINATOR_TOOLS.push('resume_worker', 'stop_worker', 'snapshot_worker', 'request_result', 'request_retry', 'add_dependency', 'remove_dependency');
COORDINATOR_TOOLS.push('create_workers', 'choose_result', 'retire_worker', 'set_policy');
COORDINATOR_TOOLS.push('take_in', 'resolve_conflict', 'take_in_result');
COORDINATOR_TOOLS.push('request_approval', 'subscribe', 'verify_result');

export class ToolRouter {
  constructor({ store, terminals, workers, verification = null, capacity = () => ({}) }) { Object.assign(this, { store, terminals, workers, verification, capacity }); this.grants = new Map(); }
  issue(binding) {
    const grant = { ...binding, id: randomUUID(), token: randomBytes(32).toString('hex'), calls: [], launches: [] };
    this.grants.set(grant.id, grant); return grant;
  }
  authenticate(id) { return this.grants.get(id) ?? null; }
  revoke(id) { this.grants.delete(id); }
  tools(id) { const grant = this.grants.get(id); if (!grant) refuse('UNAUTHORIZED', 'Unknown tool credential'); return grant.role === 'coordinator' ? COORDINATOR_TOOLS : WORKER_TOOLS; }
  async call(id, { tool, args = {} }) {
    const grant = this.grants.get(id); if (!grant) refuse('UNAUTHORIZED', 'Unknown tool credential');
    const entry = this.terminals.entry(grant.sessionId);
    if (!entry || entry.exited || entry.launchId !== grant.launchId) refuse('STALE_LAUNCH', 'This tool credential is no longer live');
    if (!this.tools(id).includes(tool)) refuse('FORBIDDEN', 'This tool is not available to this role');
    if (!args || typeof args !== 'object' || Array.isArray(args) || Buffer.byteLength(JSON.stringify(args)) > 32768) refuse('INVALID_INPUT', 'Expected a bounded arguments object');
    const at = Date.now(); grant.calls = grant.calls.filter(time => at - time < 60000);
    if (grant.calls.length >= 120) refuse('RATE_LIMIT', 'Wait before making more tool calls'); grant.calls.push(at);
    if (tool === 'create_worker' || tool === 'create_workers') {
      grant.launches = grant.launches.filter(time => at - time < 60000);
      if (grant.launches.length >= 5) refuse('RATE_LIMIT', 'At most five worker requests per minute'); grant.launches.push(at);
    }
    if (args.runId && args.runId !== grant.runId) refuse('NOT_FOUND', 'Unknown run');
    await this.workers.pending;
    const run = await this.store.getRun(grant.runId);
    const owns = (collection, key) => { if (args[key] && !collection?.some(item => item.id === args[key])) refuse('NOT_FOUND', 'Unknown record'); };
    owns(run.tasks, 'taskId'); owns(run.attempts, 'attemptId'); owns(run.messages, 'messageId');
    if (args.dependsOn && !run.tasks.some(task => task.id === args.dependsOn)) refuse('NOT_FOUND', 'Unknown dependency');
    for (const dep of args.dependencies ?? []) if (!run.tasks.some(task => task.id === (typeof dep === 'string' ? dep : dep.taskId))) refuse('NOT_FOUND', 'Unknown dependency');
    if (grant.role === 'worker' && args.attemptId && args.attemptId !== grant.attemptId) refuse('NOT_FOUND', 'Unknown worker');
    const parsed = DEFINITIONS[tool]?.inputSchema.safeParse(args);
    if (!parsed?.success) refuse('INVALID_INPUT', 'Arguments do not match this tool schema');
    args = parsed.data;
    const recipient = grant.role === 'coordinator' ? 'coordinator' : grant.attemptId;
    const receiptBound = ['inbox', 'ack', 'get_message', 'report_progress', 'report_result', 'ask', 'report_blocked', 'publish_update'].includes(tool);
    const input = { ...args, runId: grant.runId, callerId: `${grant.role}:${grant.attemptId ?? grant.runId}`, ...(receiptBound ? { launchId: grant.launchId, sessionId: grant.sessionId } : {}) };
    const reportingTurn = entry.identityAmbiguous ? null : entry.currentTurn;
    const report = kind => {
      if (!reportingTurn || input.turnId !== reportingTurn) refuse('STALE_TURN', 'Read get_context for the current observed turn before reporting');
      return this.store.reportWorker({ ...input, attemptId: grant.attemptId, kind });
    };
    switch (tool) {
      case 'get_context': { const attempt = run.attempts.find(item => item.id === grant.attemptId); return { runId: grant.runId, decisions: run.decisions ?? [], attempt, task: run.tasks.find(item => item.id === attempt?.taskId), turnId: reportingTurn, launchId: grant.launchId }; }
      case 'get_run': return run;
      case 'subscribe': return { cursor: run.eventCursor, run };
      case 'request_approval': return this.store.requestRunApproval(input);
      case 'verify_result': return this.verification?.run(input) ?? refuse('CHECK_ISOLATION_UNVERIFIED', 'Isolated verification is unavailable');
      case 'get_capacity': return this.capacity(grant.runId);
      case 'list_tasks': return this.store.listTasks(grant.runId, args.filter);
      case 'list_workers': return run.attempts;
      case 'get_worker': return run.attempts.find(item => item.id === args.attemptId) ?? refuse('NOT_FOUND', 'Unknown worker');
      case 'create_task': return this.store.createTask(input);
      case 'update_task': return this.store.updateTask(input);
      case 'cancel_task': return this.store.cancelTask(input);
      case 'complete_task': return this.store.completeTask(input);
      case 'create_worker': { const attempt = input.task ? (await this.store.requestWorkers({ callerId: input.callerId, requestId: input.requestId, runId: input.runId, items: [{ task: input.task, provider: input.provider, mode: input.mode, model: input.model, timeoutMinutes: input.timeoutMinutes, attachments: input.attachments }] }))[0] : await this.store.requestWorker(input); void this.workers.reevaluate(); return attempt; }
      case 'create_workers': { const attempts = await this.store.requestWorkers(input); void this.workers.reevaluate(); return attempts; }
      case 'choose_result': return this.store.chooseResult(input);
      case 'retire_worker': return this.store.retireWorker(input);
      case 'set_policy': return this.store.setRunPolicy(input);
      case 'take_in': case 'resolve_conflict': case 'take_in_result': return this.workers.takeIn(input);
      case 'accept_result': return this.store.acceptResult(input);
      case 'preview_result': return this.store.previewResult(input);
      case 'apply_result': return this.store.applyResult(input);
      case 'resume_worker': return this.workers.resume(input);
      case 'stop_worker': return this.workers.stop(input);
      case 'snapshot_worker': return this.workers.snapshot(input);
      case 'request_retry': return this.workers.retry(input);
      case 'add_dependency': return this.store.addDependency(input);
      case 'remove_dependency': return this.store.removeDependency(input);
      case 'request_result': return this.store.sendMessage({ ...input, recipient: args.attemptId, kind: 'instruction', text: 'Read get_context for the current turn ID, then report_result with your current status, summary and test claims. Do not repeat work just to provide the report.' });
      case 'pause_run': return this.store.pauseRun(input);
      case 'finish_run': return this.store.finishRun(input);
      case 'record_decision': return this.store.recordDecision(input);
      case 'publish_update': return this.store.publishUpdate(input);
      case 'report_progress': return this.store.reportProgress({ ...input, attemptId: grant.attemptId });
      case 'report_result': return report('result');
      case 'ask': return report('ask');
      case 'report_blocked': return report('blocked');
      case 'send_message':
        if (args.recipient !== 'coordinator' && !run.attempts.some(item => item.id === args.recipient)) refuse('NOT_FOUND', 'Unknown recipient');
        return this.store.sendMessage(input);
      case 'inbox': return this.store.getInbox({ ...input, recipient });
      case 'ack': return this.store.ackMessage({ ...input, recipient });
      case 'get_message': { const message = run.messages.find(item => item.id === args.messageId && item.recipient === recipient); if (!message) refuse('NOT_FOUND', 'Unknown message'); return message; }
      case 'wait_for_events': {
        const deadline = Date.now() + (args.timeoutMs ?? 0);
        do {
          const events = await this.store.runEvents(grant.runId, args.afterId, args.limit);
          if (events.length || Date.now() >= deadline) return events;
          await new Promise(resolve => setTimeout(resolve, Math.min(250, deadline - Date.now())));
          if (entry.exited || entry.launchId !== grant.launchId) refuse('STALE_LAUNCH', 'The requesting launch ended');
        } while (Date.now() <= deadline);
        return [];
      }
      default: refuse('FORBIDDEN', 'This tool is unavailable');
    }
  }
}
