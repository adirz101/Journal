import * as z from 'zod/v4';
const id = z.string().min(1).max(200); const requestId = id.describe('Stable unique request ID. Reuse unchanged on retry after timeout or reconnect.');
const summary = z.string().min(1).max(2000); const taskId = id; const attemptId = id;
const tool = (description, shape) => ({ description, inputSchema: z.object(shape) });
const policy = z.object({ integration: z.enum(['ask', 'coordinator-managed']).optional(), idleReclamation: z.boolean().optional(), caps: z.object({ maxConcurrentWorkers: z.number().int().min(1).max(16) }).optional(), guards: z.record(z.enum(['deletions', 'outside_scope', 'infrastructure', 'executable', 'apply_rate']), z.enum(['allow', 'ask', 'refuse'])).optional() });
export const DEFINITIONS = {
  get_context: tool('Read your assigned task, worker state and current observed turn ID. A null turn ID is unobserved, not a reportable turn.', {}),
  get_run: tool('Read durable run state. Worker claims and captured evidence are distinct.', {}),
  get_capacity: tool('Read launch limits, occupancy and queued admission reasons.', {}),
  list_tasks: tool('List tasks, including blocked and runnable tasks. Unblocking never launches a worker.', { filter: z.string().optional() }),
  list_workers: tool('Read worker work states and independent live/paused/lost presence.', {}),
  get_worker: tool('Read one worker in this run.', { attemptId }),
  resume_worker: tool('Queue an exact-conversation resume. Requires verified absence of the previous provider process tree.', { requestId, attemptId }),
  stop_worker: tool('Gracefully stop the worker; this never means its task is complete.', { requestId, attemptId }),
  snapshot_worker: tool('Capture only at a qualified boundary or after verified process exit.', { attemptId }),
  request_result: tool('Queue a request for the worker to report its current result.', { requestId, attemptId }),
  request_retry: tool('Retire a settled attempt and request another, preserving history. Environment reuse requires writer exclusion.', { requestId, attemptId, provider: z.enum(['claude', 'codex', 'cursor']).optional(), from: z.enum(['base', 'result', 'environment']), reason: summary }),
  add_dependency: tool('Add a task dependency. Refused if it forms a cycle or the task already has an active attempt.', { requestId, taskId, dependsOn: id, when: z.enum(['ready', 'integrated']).optional() }),
  remove_dependency: tool('Remove a dependency without automatically starting a worker.', { requestId, taskId, dependsOn: id }),
  create_task: tool('Create a task. Dependencies gate requests; they never auto-start work.', { requestId, title: z.string().min(1).max(200), goal: z.string().max(20000).optional(), hostingAllowed: z.boolean().optional(), dependencies: z.array(z.union([id, z.object({ taskId, when: z.enum(['ready', 'integrated']) })])).max(100).optional(), priority: z.number().int().min(-10).max(10).optional(), kind: z.enum(['work', 'review']).optional(), acceptance: z.array(z.string().max(1000)).max(30).optional(), scope: z.object({ paths: z.array(z.string().max(300)).max(100), areas: z.array(z.string().max(200)).max(30) }).optional() }),
  update_task: tool('Update a task description or queue priority.', { requestId, taskId, title: z.string().max(200).optional(), goal: z.string().max(20000).optional(), priority: z.number().int().min(-10).max(10).optional() }),
  cancel_task: tool('Cancel a task and its unstarted requests. Active workers must be reconciled first.', { requestId, taskId, reason: summary.optional() }),
  complete_task: tool('Explicitly complete a ready or integrated task after reconciling its workers.', { requestId, taskId, reason: summary }),
  create_worker: tool('Request one worker. Capacity may queue it; a blocked task is refused.', { requestId, taskId, provider: z.enum(['claude', 'codex', 'cursor']), mode: z.enum(['build', 'research']).optional() }),
  send_message: tool('Queue an addressed message. Submission is not acknowledgment or execution.', { requestId, recipient: id, kind: z.enum(['instruction', 'answer', 'dependency_ready', 'review_feedback', 'retry', 'resolve_conflict']), text: z.string().min(1).max(8000) }),
  inbox: tool('Pull addressed messages and a receipt. Deduplicate by logical message ID before acting.', {}),
  ack: tool('Acknowledge receipt, not completion. Include the pull receipt or delivery ID.', { requestId, messageId: id, receiptId: id }),
  get_message: tool('Read a message addressed to this recipient.', { messageId: id }),
  wait_for_events: tool('Read durable events after a cursor; an empty result means no new recorded event.', { afterId: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(500).optional() }),
  accept_result: tool('Accept the exact current captured result without a worker report, with a reason.', { requestId, attemptId, resultId: id, reason: summary }),
  preview_result: tool('Preview an exact current result against the branch. Inspect hard gates, policy guards and tree-specific evidence.', { attemptId, resultId: id }),
  apply_result: tool('Request integration using an unchanged opaque preview. User approvals are reserved to the desktop.', { requestId, attemptId, resultId: id, expect: id }),
  report_result: tool('Report a current-turn claim. Journal captures and verifies separately; this call does not itself make the task ready.', { requestId, turnId: id, status: z.enum(['done', 'partial', 'blocked', 'failed']), summary }),
  ask: tool('Ask the coordinator a question. During work, wait state begins only when the turn settles.', { requestId, turnId: id, summary }),
  report_blocked: tool('Report a current-turn blocker.', { requestId, turnId: id, summary }),
  report_progress: tool('Record a short progress claim without changing readiness.', { requestId, summary }),
  pause_run: tool('Pause or resume new admissions and automatic operations.', { requestId, paused: z.boolean() }),
  finish_run: tool('Finish only after tasks, workers and messages have been reconciled.', { requestId, reason: summary }),
  record_decision: tool('Record a coordinator decision in the durable run story.', { requestId, summary }),
  publish_update: tool('Publish a short user-facing coordinator update in the run conversation. This is your report, not verified evidence, a permission grant or a worker quote.', { requestId, summary }),
};
DEFINITIONS.create_task.inputSchema = DEFINITIONS.create_task.inputSchema.extend({ variants: z.number().int().min(2).max(8).optional(), subjectResultId: id.optional(), subjectBranch: id.optional() });
DEFINITIONS.report_result.inputSchema = DEFINITIONS.report_result.inputSchema.extend({
  testsClaimed: z.array(z.object({ command: z.string().max(2000), outcome: z.enum(['passed', 'failed', 'not-run', 'unknown']) })).max(30).optional(),
  blockers: z.array(z.string().max(1000)).max(30).optional(), dependenciesDiscovered: z.array(z.string().max(1000)).max(30).optional(), needsFollowUp: z.boolean().optional(),
  memoryProposals: z.array(z.object({ statement: summary, category: z.enum(['decision', 'constraint', 'convention', 'lesson', 'issue']), scope: z.enum(['checkout', 'branch']), area: z.string().max(300) })).max(10).optional(),
  review: z.object({ subjectResultId: id.nullable().optional(), subjectTreeOid: id.nullable().optional(), subjectBranchHead: id.nullable().optional(), verdict: z.enum(['pass', 'changes_requested', 'blocked']), findings: z.array(z.object({ file: z.string().max(300), line: z.number().int().positive().optional(), severity: z.enum(['critical', 'important', 'minor', 'info']), text: summary })).max(100) }).optional(),
});
Object.assign(DEFINITIONS, {
  request_approval: tool('Ask the user for a real workflow decision. This cannot approve a provider permission or change policy.', { requestId, summary }),
  subscribe: tool('Read the durable event cursor and current run; reconnect using the same cursor with wait_for_events.', {}),
  take_in: tool('Take the pinned current branch into a stopped, writer-free worker folder. Conflicts stay in that folder.', { requestId, attemptId }),
  resolve_conflict: tool('Take in the branch and queue conflict instructions. Stop and settle the worker first when live mutation is unvalidated.', { requestId, attemptId }),
  take_in_result: tool('Refresh a stopped reviewer with an exact selected result. A new verdict is required.', { requestId, attemptId, subjectResultId: id }),
  create_workers: tool('Request all configured task variants at their pinned common base. Each is admitted separately.', { requestId, taskId, provider: z.enum(['claude', 'codex', 'cursor']) }),
  choose_result: tool('Select the current result of one variant. Other variants must first be stopped and settled.', { requestId, attemptId, resultId: id }),
  retire_worker: tool('Retire a paused, settled worker or cancel an unstarted request. Preserve its immutable history.', { requestId, attemptId, reason: summary }),
  set_policy: tool('Tighten run policy. Only the user can loosen it. Policy changes invalidate old approvals.', { requestId, policy }),
});
DEFINITIONS.wait_for_events.inputSchema = DEFINITIONS.wait_for_events.inputSchema.extend({ timeoutMs: z.number().int().min(0).max(25000).optional() });

const inlineTask = z.object({ title: z.string().min(1).max(200), goal: z.string().max(20000).optional(), acceptance: z.array(z.string().max(1000)).max(30).optional(), dependencies: z.array(id).max(100).optional(), hostingAllowed: z.boolean().optional(), scope: z.object({ paths: z.array(z.string().max(300)).max(100), areas: z.array(z.string().max(200)).max(30) }).optional() });
const workerOptions = { model: z.string().min(1).max(160).optional(), timeoutMinutes: z.number().int().min(1).max(1440).optional(), attachments: z.array(z.object({ path: z.string().min(1).max(300), startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional() })).max(20).optional() };
DEFINITIONS.create_worker.inputSchema = DEFINITIONS.create_worker.inputSchema.extend(workerOptions);
const workerItem = z.object({ ...workerOptions, taskId: id.optional(), task: inlineTask.optional(), provider: z.enum(['claude', 'codex', 'cursor']), mode: z.enum(['build', 'research']).optional() }).refine(item => !!item.taskId !== !!item.task, 'Choose an existing task or define an inline task');
DEFINITIONS.create_workers.inputSchema = z.union([DEFINITIONS.create_workers.inputSchema, z.object({ requestId, items: z.array(workerItem).min(1).max(20) })]);
DEFINITIONS.create_workers.description = 'Request task variants or an item-wise batch. Blocked inline tasks are retained; other items proceed. Reuse the batch request ID on retry.';
DEFINITIONS.create_worker.inputSchema = z.union([DEFINITIONS.create_worker.inputSchema, z.object({ ...workerOptions, requestId, task: inlineTask, provider: z.enum(['claude', 'codex', 'cursor']), mode: z.enum(['build', 'research']).optional() })]);
