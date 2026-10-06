import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, edit, lines } from './helpers.mjs';

// Prototype 8: the brief's coordinator scenario, driven only through the control surface
// (no Git, no paths): workers, tasks, states, results, conflicts. Steps marked MISSING need a
// primitive the prototype does not have; they are simulated here and listed in the README.
test('coordinator scenario: three workers from feature/auth; apply A; re-preview C; B keeps running', async t => {
  const f = fixture(t); const m = f.manager();
  const tasks = { A: 'backend API', B: 'frontend form', C: 'tests' };
  const workers = {};
  for (const [name, task] of Object.entries(tasks)) workers[name] = await m.createEnvironment({ projectId: 'p1', logicalBranch: 'feature/auth', sessionId: `session-${name}`, task });
  // MISSING: start a Journal session in an environment with a task and its memory packet (launchWorker).
  for (const name of Object.keys(workers)) { assert.equal(m.contextRequest(workers[name].id).logicalBranch, 'feature/auth'); m.markRunning(workers[name].id, { pid: process.pid }); }
  assert.deepEqual(m.overview('p1').running.map(w => w.task), ['backend API', 'frontend form', 'tests']);
  // MISSING: send worker B a follow-up message and read its reply (sendToWorker / worker events).
  // The workers' work (simulated: in reality the agents write it).
  const api = lines('api', 10);
  writeFileSync(join(m.getEnvironment(workers.A.id).details.path, 'src', 'api.js'), edit(api, 5, 'POST /login'));
  writeFileSync(join(m.getEnvironment(workers.C.id).details.path, 'src', 'api.js'), edit(api, 5, 'test hook for /login'));
  writeFileSync(join(m.getEnvironment(workers.C.id).details.path, 'auth.test.js'), 'test("login")\n');
  // MISSING: learn that a worker finished its task (a "turn ended with the task done" signal); here the coordinator decides.
  m.markCompleted(workers.A.id); m.markCompleted(workers.C.id);
  const o = m.overview('p1');
  assert.deepEqual([o.running.map(w => w.task), o.unapplied.map(w => w.task)], [['frontend form'], ['backend API', 'tests']]);
  // Preview both, apply A, re-preview C against the new branch state, surface the conflict.
  const [pa, pc] = [m.previewApply(workers.A.id), m.previewApply(workers.C.id)];
  assert.deepEqual([pa.canApply, pc.canApply], [true, true], 'each is clean against the branch as it is');
  m.applyEnvironment(workers.A.id);
  const again = m.previewApply(workers.C.id);
  assert.deepEqual([again.moved, again.clean, again.conflicts.map(c => c.path)], [true, false, ['src/api.js']]);
  // B is untouched throughout.
  assert.equal(m.getEnvironment(workers.B.id).state, 'running');
  assert.deepEqual(m.overview('p1').integrated.map(w => w.task), ['backend API']);
  // The coordinator's next move: have C resolve in its own environment (updateFromBranch), re-run, re-preview.
  const { conflicts } = m.updateFromBranch(workers.C.id);
  assert.deepEqual(conflicts, ['src/api.js']);
});
