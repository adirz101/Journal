import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRows } from '../src/ui/runTreeModel.ts';
test('run navigation keeps task-without-worker distinct from a queued request and limits attention to user decisions', () => {
  const run = { id: 'run', goal: 'Build', state: 'active', paused: false, coordinatorSessionId: 'coordinator', tasks: [{ id: 'blocked', title: 'Later', state: 'blocked', dependencies: [] }, { id: 'requested', title: 'Now', state: 'queued', dependencies: [] }], attempts: [{ id: 'worker', taskId: 'requested', state: 'queued', presence: 'paused', currentSessionId: null, admission: { reasons: ['GLOBAL_CAP'] } }], approvals: [] };
  const rows = runRows([run]); assert.deepEqual(rows.map(row => row.kind), ['run', 'task', 'worker']); assert.equal(rows[1].state, 'Waiting for dependency'); assert.equal(rows[2].detail, 'GLOBAL_CAP'); assert.ok(rows.every(row => !row.attention));
  assert.equal(runRows([run], new Set(['run'])).length, 1);
  assert.equal(runRows([{ ...run, approvals: [{ state: 'pending' }] }])[0].attention, true);
});
