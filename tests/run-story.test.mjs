import { test } from 'node:test';
import assert from 'node:assert/strict';
const { buildRunStory } = await import('../src/core/story/run-story.mjs').catch(() => ({}));
test('run story uses stable titles, labels claims and preserves exact result links', () => {
  const events = [{ id: 2, at: '2026-10-06', kind: 'review.verdict', body: { attemptId: 'worker', resultId: 'result', verdict: 'pass', summary: 'Looks correct' } }, { id: 1, at: '2026-10-05', kind: 'worker.queued', body: { attemptId: 'worker' } }];
  const rows = buildRunStory(events, { tasks: [{ id: 'task', title: 'API' }], attempts: [{ id: 'worker', taskId: 'task' }] });
  assert.deepEqual(rows.map(row => row.id), [1, 2]); assert.equal(rows[0].title, 'API: waiting for capacity');
  assert.equal(rows[1].title, 'API: reviewer reported a verdict'); assert.equal(rows[1].claim, true); assert.equal(rows[1].resultId, 'result');
  assert.equal(buildRunStory([{ id: 3, kind: 'unknown.input', body: { title: 'Invented status' } }])[0].title, 'Run updated');
});
