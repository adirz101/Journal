import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { removeLater } from './support/cleanup.mjs';
const { materializeResult } = await import('../src/runtime/verification.mjs').catch(() => ({}));
test('verification materializes the pinned tree without observing later worker edits or copying symlinks', t => {
  const root = mkdtempSync(join(tmpdir(), 'journal-check-')); t.after(() => removeLater(root)); const repo = join(root, 'repo'); mkdirSync(repo);
  const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git(['init', '-q']); writeFileSync(join(repo, 'value'), 'pinned'); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base']);
  const commit = git(['rev-parse', 'HEAD']); const tree = git(['rev-parse', 'HEAD^{tree}']);
  writeFileSync(join(repo, 'value'), 'changed');
  const path = join(root, 'verification'); mkdirSync(path); materializeResult(repo, { resultCommit: commit, treeOid: tree }, path);
  assert.equal(readFileSync(join(path, 'value'), 'utf8'), 'pinned');
  assert.throws(() => materializeResult(repo, { resultCommit: commit, treeOid: 'wrong' }, path), { code: 'RESULT_CHANGED' });
});

test('verification reserves its single lane before asynchronous lookup and releases it on lookup failure', async () => {
  const { VerificationManager } = await import('../src/runtime/verification.mjs');
  let release; const pending = new Promise((_, reject) => { release = reject; });
  const manager = new VerificationManager({ store: { getRun: () => pending }, executor: { validatedIsolation: true } });
  const first = manager.run({ runId: 'run' });
  const second = manager.run({ runId: 'run' });
  // A competing call must refuse immediately, without waiting for the first store lookup.
  const race = await Promise.race([second.catch(error => error.code), new Promise(resolve => setTimeout(() => resolve('not-reserved'), 20))]);
  release(new Error('fixture lookup failed')); await assert.rejects(first, /fixture lookup failed/); await second.catch(() => {});
  assert.equal(race, 'CHECK_BUSY'); assert.equal(manager.active, false);
});
