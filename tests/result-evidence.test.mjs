import { test } from 'node:test';
import assert from 'node:assert/strict';
const { testEvidenceState } = await import('../src/core/orchestration/results.mjs').catch(() => ({}));
test('only the latest configured test invocation can certify tests, never unrelated successful checks', () => {
  const check = (command, exit) => ({ command, exit, state: 'finished', provenance: 'isolated-verification', isolation: 'fixture-proof' });
  assert.equal(testEvidenceState([check(['true'], 0)], true), 'not-run');
  assert.equal(testEvidenceState([check(['npm', 'test'], 1), check(['npm', 'run', 'lint'], 0)], true), 'failed');
  assert.equal(testEvidenceState([check(['npm', 'test'], 1), check(['npm', 'run', 'test'], 0)], true), 'passed');
  assert.equal(testEvidenceState([check(['npm', 'test'], 0)], false), 'unknown');
  assert.equal(testEvidenceState([{ ...check(['npm', 'test'], 0), isolation: null }], true), 'unknown');
});
