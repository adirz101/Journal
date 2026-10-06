import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './helpers.mjs';
import { JournalStore } from '../../../src/core/store.mjs';

// Memory integration against Journal's real store (not redesigned here): what works today, and
// the gaps a real implementation must close. Each gap is asserted, so the test fails once it is fixed.
test('workers share project memory: context, provenance, conflicting proposals, unapplied evidence', async t => {
  const f = fixture(t); const m = f.manager();
  const store = new JournalStore(join(f.root, 'journal.sqlite')); t.after(() => store.close());
  const project = store.openProject(f.repo);
  // A branch note for feature/auth, remembered while the checkout is on it.
  const note = store.proposeMemory(project.id, { statement: 'Auth tokens are refreshed by the API gateway, never by the form', category: 'decision', scope: 'branch', area: '', source: { kind: 'user', note: 'team decision' } });
  store.setMemoryStatus(note.id, 'active');
  const [a, b] = await Promise.all(['A', 'B'].map(task => m.createEnvironment({ projectId: 'p1', logicalBranch: 'feature/auth', sessionId: task, task })));

  // 1. Every worker gets context for the same logical branch (works while the checkout is on it).
  for (const env of [a, b]) {
    const request = m.contextRequest(env.id);
    assert.deepEqual([request.logicalBranch, request.base], ['feature/auth', env.base]);
    const receipt = store.prepareContext(project.id, 'refresh tokens');
    assert.ok(receipt.items.some(item => item.id === note.id), 'the branch note reaches the worker');
    // GAP 1: the receipt cannot record the environment and base commit yet.
    assert.equal(receipt.environmentId, undefined);
  }
  // GAP 2: the packet follows the checkout's branch, not the worker's logical branch. When the user
  // switches the checkout away, a worker on feature/auth loses its branch notes.
  f.git(f.repo, 'checkout', '-q', 'main');
  assert.equal(store.prepareContext(project.id, 'refresh tokens').items.some(item => item.id === note.id), false);
  f.git(f.repo, 'checkout', '-q', 'feature/auth');

  // 2. Proposals from two workers on the same subject are both kept (no last-writer-wins).
  const proposal = (env, statement) => store.proposeMemory(project.id, { statement, category: 'decision', scope: 'checkout', area: 'src',
    source: { kind: 'user', note: `Proposed by a worker. ${JSON.stringify(m.provenance(env.id))}` } });
  writeFileSync(join(a.details.path, 'src', 'api.js'), 'retry: 3\n'); m.markCompleted(a.id);
  writeFileSync(join(b.details.path, 'src', 'api.js'), 'retry: 5\n'); m.markCompleted(b.id);
  const pa = proposal(a, 'Uploads retry three times before failing');
  const pb = proposal(b, 'Uploads retry five times before failing');
  assert.notEqual(pa.id, pb.id);
  assert.deepEqual([store.getMemory(pa.id).status, store.getMemory(pb.id).status], ['candidate', 'candidate']);
  // GAP 3: provenance only fits in the free-text note; it needs structured fields.
  assert.match(store.getMemory(pa.id).source.note, new RegExp(a.id));

  // 3. Unapplied evidence is identifiable: the provenance says whether the result is on the branch.
  assert.equal(m.provenance(a.id).applied, false);
  m.applyEnvironment(a.id);
  assert.deepEqual([m.provenance(a.id).applied, m.provenance(b.id).applied], [true, false]);
  assert.ok(m.provenance(a.id).integration);
});
