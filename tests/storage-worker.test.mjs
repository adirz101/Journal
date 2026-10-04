import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StoreClient } from '../src/desktop/store-client.mjs';
import { removeLater } from './support/cleanup.mjs';

test('worker-backed storage persists approved knowledge and marks unfinished deliveries uncertain on restart', async t => {
  const root = mkdtempSync(resolve(process.env.JOURNAL_TEST_TMP ?? tmpdir(), 'storage-worker-'));
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'pipe' });
  const path = resolve(root, 'journal.sqlite'); let store = new StoreClient(path);
  t.after(async () => { await store.close(); removeLater(root); });
  const project = await store.openProject(root);
  await assert.rejects(store.getReceipt('not-a-receipt'), /Unknown receipt/);
  const memory = await store.proposeMemory(project.id, { statement: 'Docker tests require a local engine', category: 'constraint', scope: 'branch',
    source: { kind: 'user', note: 'Fixture owner explicitly requires it' } });
  await store.setMemoryStatus(memory.id, 'active');
  const receipt = await store.prepareContext(project.id, 'Docker tests'); const id = randomUUID();
  await store.saveSession({ id, projectId: project.id, provider: 'claude', status: 'running', receiptId: receipt.id });
  await store.updateReceiptState(receipt.id, 'submitted', id);
  assert.equal((await store.memoryOrigins(project.id, [memory.id]))[memory.id].kind, 'manual');
  assert.deepEqual(await store.deliveryCounts(project.id, [memory.id]), { [memory.id]: 1 });
  assert.deepEqual((await store.memoryChecks(project.id, { offset: 0, limit: 50 })).stale, []);
  await store.close(); await store.close();
  await assert.rejects(store.listProjects(), /closed/);
  store = new StoreClient(path); await store.recoverSessions();
  assert.equal((await store.getSession(id)).status, 'interrupted');
  assert.equal((await store.getReceipt(receipt.id)).state, 'uncertain');
  assert.equal((await store.prepareContext(project.id, 'Docker tests')).items[0].revisionId, memory.revisionId);
});

test('a failed storage worker rejects further requests instead of leaving callers waiting', async t => {
  const store = new StoreClient(':memory:'); await store.ready;
  t.after(() => store.worker.terminate());
  await store.worker.terminate();
  await assert.rejects(store.listProjects(), /stopped unexpectedly/);
});

test('previewSelection is callable through the worker', async t => {
  const root = mkdtempSync(resolve(process.env.JOURNAL_TEST_TMP ?? tmpdir(), 'storage-worker-'));
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'pipe' });
  const store = new StoreClient(resolve(root, 'journal.sqlite'));
  t.after(async () => { await store.close(); removeLater(root); });
  const project = await store.openProject(root);
  const memory = await store.proposeMemory(project.id, { statement: 'Docker tests require a local engine', category: 'constraint', scope: 'checkout',
    source: { kind: 'user', note: 'Fixture owner explicitly requires it' } });
  await store.setMemoryStatus(memory.id, 'active');
  const preview = await store.previewSelection(project.id, 'Docker tests', { branch: 'main' });
  assert.equal(preview.kind, 'selection'); assert.equal(preview.checked, false); assert.equal(preview.query, 'Docker tests'); assert.equal(preview.branch, 'main');
  assert.deepEqual(preview.items.map(item => item.id), [memory.id]);
  assert.deepEqual(preview.items[0].selection.terms, ['docker', 'tests']);
  assert.deepEqual(preview.terms, ['docker', 'tests']); assert.equal(preview.taskNotes, 1);
  assert.ok(preview.bytes > 0); assert.ok(Array.isArray(preview.excluded)); assert.ok(Array.isArray(preview.warnings));
  assert.equal((await store.projectDetails(project.id)).counts.receipts, 0, 'a preview stores nothing');
});

test('the Phase 6 session-end methods are callable through the worker', async t => {
  const root = mkdtempSync(resolve(process.env.JOURNAL_TEST_TMP ?? tmpdir(), 'storage-worker-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main'); writeFileSync(resolve(root, 'a.txt'), 'one\ntwo\n'); git('add', '.'); git('-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'init');
  const store = new StoreClient(resolve(root, 'journal.sqlite'));
  t.after(async () => { await store.close(); removeLater(root); });
  const project = await store.openProject(root);
  const receipt = await store.prepareContext(project.id, 'Ship.\nRule: Release tags must be signed by CI.'); const id = randomUUID();
  await store.saveSession({ id, projectId: project.id, provider: 'claude', status: 'exited', receiptId: receipt.id, createdAt: new Date().toISOString(), endedAt: new Date().toISOString(), branch: 'main', survivors: [] });
  const [proposal] = await store.generateProposals(id);
  assert.equal((await store.sessionSummary(id)).suggestions, 1);
  const [note] = await store.rememberProposals([proposal.id], { via: 'wrap-up' }); assert.equal(note.status, 'active');
  const file = await store.proposeMemory(project.id, { statement: 'The a file lists two items', category: 'convention', scope: 'checkout', area: '', source: { kind: 'file', path: 'a.txt', startLine: 1, endLine: 2 } });
  await store.setMemoryStatus(file.id, 'active');
  writeFileSync(resolve(root, 'a.txt'), 'one\n2\n');
  // No baseline was recorded, so the live changes count every file against the empty tree.
  assert.deepEqual((await store.staleNotesForSession(id)).notes.map(item => item.note.id), [file.id]);
  assert.equal((await store.reaffirmMemory(file.id, {})).revision, 2);
});
