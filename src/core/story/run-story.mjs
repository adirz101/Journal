const TITLES = Object.freeze({
  'coordinator.update': 'Coordinator update', 'run.created': 'Run created', 'run.starting': 'Coordinator starting', 'run.active': 'Coordinator working', 'run.idle': 'Coordinator idle', 'run.detached': 'Coordinator disconnected', 'run.finished': 'Run finished', 'run.paused': 'Run paused', 'run.resumed': 'Run continued', 'run.waiting_for_user': 'Coordinator waiting for you',
  'task.created': 'task added', 'task.unblocked': 'dependencies satisfied', 'task.done': 'task completed', 'task.cancelled': 'task cancelled',
  'worker.requested': 'worker requested', 'worker.queued': 'waiting for capacity', 'worker.starting': 'worker starting', 'worker.working': 'worker working', 'worker.idle': 'worker idle', 'worker.ready': 'result ready', 'worker.result_available': 'result captured without a completion report', 'worker.integrated': 'result integrated', 'worker.retired': 'worker retired', 'worker.superseded': 'another variant selected', 'worker.waiting_for_user': 'waiting for you', 'worker.blocked': 'worker blocked',
  'result.captured': 'immutable result captured', 'result.applied': 'result applied to the branch', 'result.accepted': 'result accepted', 'result.chosen': 'variant selected',
  'review.verdict': 'reviewer reported a verdict', 'review.subject_changed': 'review subject updated', 'conflict.detected': 'conflict found', 'conflict.resolved': 'conflict resolved',
  'approval.requested': 'Decision requested', 'approval.approved': 'Decision allowed', 'approval.rejected': 'Decision rejected', 'policy.changed': 'Run policy changed', 'run.decision': 'Coordinator recorded a decision',
  'message.queued': 'Message queued', 'message.submitted': 'Message submitted', 'message.acknowledged': 'Message receipt acknowledged', 'message.uncertain': 'Message delivery uncertain',
});
export function buildRunStory(events, run = {}) {
  const tasks = new Map((run.tasks ?? []).map(task => [task.id, task]));
  const attempts = new Map((run.attempts ?? []).map(attempt => [attempt.id, attempt]));
  return [...events].sort((a, b) => a.id - b.id).map(event => {
    const body = event.body ?? {}; const task = tasks.get(body.taskId ?? attempts.get(body.attemptId)?.taskId);
    const fixed = TITLES[event.kind] ?? 'Run updated'; const claim = ['coordinator.update', 'review.verdict', 'worker.reported', 'worker.progress', 'run.decision'].includes(event.kind);
    return { id: event.id, at: event.at, title: task ? `${task.title}: ${fixed}` : fixed, claim, detail: typeof body.summary === 'string' ? body.summary : null, resultId: body.resultId ?? null, attemptId: body.attemptId ?? null };
  });
}
