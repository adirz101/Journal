export class OrchestrationError extends Error {
  constructor(code, message, detail = {}) { super(message); this.code = code; this.detail = detail; }
}
export const refuse = (code, message, detail) => { throw new OrchestrationError(code, message, detail); };
export const RUN_TRANSITIONS = Object.freeze({ creating: ['starting', 'detached'], starting: ['active', 'detached'], active: ['idle', 'waiting_for_user', 'detached', 'finished'], idle: ['active', 'detached', 'finished'], waiting_for_user: ['active', 'detached'], detached: ['starting', 'active', 'finished'], finished: [] });
export const WORKER_TRANSITIONS = Object.freeze({
  requested: ['queued', 'starting', 'cancelled'], queued: ['starting', 'cancelled'], starting: ['working', 'launch_failed'], launch_failed: ['queued', 'retired'],
  working: ['idle', 'result_available', 'ready', 'waiting_for_user', 'waiting_for_coordinator', 'blocked'],
  waiting_for_user: ['working'], idle: ['working', 'waiting_for_coordinator', 'abandoned', 'retired'],
  result_available: ['waiting_for_coordinator', 'working', 'ready', 'abandoned', 'retired'], ready: ['waiting_for_coordinator', 'working', 'integrating', 'done', 'superseded', 'abandoned', 'retired'],
  waiting_for_coordinator: ['working', 'retired'], blocked: ['waiting_for_coordinator', 'working', 'retired'], integrating: ['integrated', 'ready', 'conflict'],
  conflict: ['waiting_for_coordinator', 'working', 'abandoned', 'retired'], integrated: ['waiting_for_coordinator', 'working', 'done', 'retired'],
  cancelled: [], done: [], superseded: [], abandoned: [], retired: [],
});
export const TASK_TRANSITIONS = Object.freeze({
  pending: ['blocked', 'queued', 'in_progress', 'cancelled'], blocked: ['pending', 'cancelled'], queued: ['in_progress', 'needs_decision', 'pending', 'cancelled'],
  in_progress: ['ready', 'result_available', 'needs_decision', 'cancelled'], ready: ['in_progress', 'integrated', 'done', 'cancelled'],
  integrated: ['in_progress', 'done'], result_available: ['ready', 'in_progress', 'needs_decision', 'cancelled'],
  needs_decision: ['in_progress', 'queued', 'pending', 'cancelled'], done: [], cancelled: [],
});
export const RESULT_TRANSITIONS = Object.freeze({ current: ['superseded', 'previewed'], previewed: ['stale', 'applying', 'superseded'], stale: ['previewed', 'superseded'], applying: ['applied', 'refused'], refused: ['previewed', 'superseded'], applied: [], superseded: [] });
export const TERMINAL_ATTEMPTS = new Set(['cancelled', 'done', 'superseded', 'abandoned', 'retired']);
export function transition(table, from, to) {
  if (!Object.hasOwn(table, from) || (from !== to && !table[from].includes(to))) refuse('INVALID_STATE', `Cannot move from ${from} to ${to}`);
}
export const taskStateFor = state => ({ queued: 'queued', starting: 'in_progress', working: 'in_progress', waiting_for_coordinator: 'in_progress', ready: 'ready', result_available: 'result_available', integrated: 'integrated', launch_failed: 'needs_decision' })[state] ?? null;
