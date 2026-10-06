export interface TreeRun { id: string; goal: string; state: string; paused: boolean; coordinatorSessionId: string | null; tasks: { id: string; title: string; state: string; dependencies: { taskId: string; when: string }[] }[]; attempts: { id: string; taskId: string; state: string; presence: string; currentSessionId: string | null; admission?: { reasons?: string[] } }[]; approvals?: { state: string }[]; }
export interface RunRow { id: string; runId: string; parentId: string | null; kind: 'run' | 'worker' | 'task'; title: string; state: string; presence?: string; sessionId: string | null; attention: boolean; detail?: string; }
export function runRows(runs: TreeRun[], collapsed: ReadonlySet<string> = new Set()): RunRow[] {
  return runs.flatMap(run => {
    const rows: RunRow[] = [{ id: run.id, runId: run.id, parentId: null, kind: 'run', title: run.goal.split('\n')[0], state: run.paused ? 'Paused' : run.state, sessionId: run.coordinatorSessionId, attention: !!run.approvals?.some(item => item.state === 'pending') || run.state === 'waiting_for_user' }];
    if (collapsed.has(run.id)) return rows;
    for (const task of run.tasks) {
      const attempts = run.attempts.filter(attempt => attempt.taskId === task.id && !['superseded', 'retired', 'cancelled', 'abandoned'].includes(attempt.state));
      if (!attempts.length) rows.push({ id: task.id, runId: run.id, parentId: run.id, kind: 'task', title: task.title, state: task.state === 'blocked' ? 'Waiting for dependency' : task.state === 'pending' ? 'Not started' : task.state, sessionId: run.coordinatorSessionId, attention: false });
      for (const attempt of attempts) rows.push({ id: attempt.id, runId: run.id, parentId: run.id, kind: 'worker', title: task.title, state: attempt.state === 'result_available' ? 'Result not reported' : attempt.state.replaceAll('_', ' '), presence: attempt.presence, sessionId: attempt.currentSessionId ?? run.coordinatorSessionId, attention: attempt.state === 'waiting_for_user', detail: attempt.admission?.reasons?.join(', ') });
    }
    return rows;
  });
}
