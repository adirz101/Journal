import { test } from 'node:test';
import assert from 'node:assert/strict';
const { hardGates, guards } = await import('../src/core/orchestration/gates.mjs').catch(() => ({}));
const preview = { clean: true, unresolved: [], blockedBy: [], excluded: [], nested: [], busy: false, changes: [], executable: [] };
const attempt = { state: 'ready', presence: 'paused' };
const policy = { integration: 'coordinator-managed', guards: { deletions: 'ask', outside_scope: 'allow', infrastructure: 'allow', tests: 'allow', executable: 'ask', apply_rate: 'ask' } };

test('integration hard gates distinguish paused runs, live writers and unsafe trees', () => {
  assert.equal(hardGates(preview, attempt, { paused: false }).pass, true);
  assert.ok(hardGates(preview, { ...attempt, presence: 'live' }, {}).failures.includes('NOT_IDLE'));
  assert.ok(hardGates(preview, attempt, { paused: true }).failures.includes('RUN_PAUSED'));
  for (const [field, value, code] of [['clean', false, 'CONFLICT'], ['blockedBy', ['file'], 'DIRTY_OVERLAP'], ['busy', 'rebase', 'BRANCH_BUSY'], ['nested', ['vendor'], 'EXCLUDED_CONTENT'], ['excluded', ['.env'], 'EXCLUDED_CONTENT']]) assert.ok(hardGates({ ...preview, [field]: value }, attempt, {}).failures.includes(code));
});
test('guards report scope and checks separately from claims, and unknown risk requires a decision', () => {
  const task = { scope: { paths: ['src/'], areas: [] } };
  const changes = [...Array.from({ length: 21 }, (_, i) => ({ path: `src/${i}`, status: 'D' })), { path: 'package-lock.json', status: 'M' }];
  const found = guards({ ...preview, changes, executable: ['bin/tool'], knownTestCommand: true }, task, policy, { testsVerified: 'not-run', claim: { testsClaimed: [{ outcome: 'passed' }] } });
  assert.equal(found.find(item => item.guard === 'deletions').outcome, 'ask');
  assert.equal(found.find(item => item.guard === 'outside_scope').outcome, 'allow');
  assert.equal(found.find(item => item.guard === 'tests').detail, 'No passing check is bound to this result tree');
  assert.equal(guards({ ...preview, executable: null }, task, policy, {}).find(item => item.guard === 'executable').outcome, 'ask');
});
test('unselected variants cannot pass integration gates', () => {
  const variant = { ...attempt, id: 'candidate', currentResultId: 'result' };
  assert.ok(hardGates(preview, variant, {}, { variants: 2 }).failures.includes('VARIANT_NOT_SELECTED'));
  assert.equal(hardGates(preview, variant, {}, { variants: 2, chosenAttemptId: 'candidate', chosenResultId: 'result' }).pass, true);
});
