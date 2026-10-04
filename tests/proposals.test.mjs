import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { JournalStore } from '../src/core/store.mjs';
import { removeLater } from './support/cleanup.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'proposals-')); const repo = join(root, 'repo'); mkdirSync(repo);
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe', encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); writeFileSync(join(repo, 'a.txt'), 'a\n'); git('add', '.'); git('-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'init');
  const store = new JournalStore(join(root, 'j.sqlite')); const project = store.openProject(repo);
  t.after(() => { store.close(); removeLater(root); });
  const session = (query, extra = {}) => {
    const receipt = store.prepareContext(project.id, query);
    const s = { id: `s-${Math.random().toString(16).slice(2)}`, projectId: project.id, provider: 'claude', status: 'stopped', receiptId: receipt.id, createdAt: new Date().toISOString(), head: store.project(project.id).head, branch: 'main', ...extra };
    store.saveSession(s); return s;
  };
  return { repo, git, store, project, session };
}

test('explicit rule lines become reviewable proposals; generic advice and secrets are rejected; generation is idempotent', t => {
  const f = fixture(t);
  const s = f.session('Fix login.\nRule: Session cookies must stay SameSite=Strict for the admin app.\nRemember: always write clean code\nnote: not a rule line');
  const created = f.store.generateProposals(s.id);
  assert.deepEqual(created.map(p => p.statement), ['Session cookies must stay SameSite=Strict for the admin app.']);
  assert.equal(f.store.generateProposals(s.id).length, 0, 'Regenerating creates nothing new');
  assert.throws(() => f.session('Decision: our deploy token=abcd1234efgh5678 lives here'), /credential/, 'A task carrying a secret is refused before anything is stored');
  const memory = f.store.acceptProposal(created[0].id);
  assert.equal(memory.status, 'candidate', 'Accepting still requires approval');
  assert.throws(() => f.store.acceptProposal(created[0].id), /already handled/);
  const again = f.session('Rule: Session cookies must stay SameSite=Strict for the admin app!');
  assert.equal(f.store.generateProposals(again.id).length, 0, 'An existing claim is not proposed twice');
});

test('passing test commands are proposed once; failures, unknown exits and redacted commands are not', t => {
  const f = fixture(t); const s = f.session('');
  const command = (id, text, status, exitCode = null) => { f.store.appendEvent(s.id, 'command-start', { toolUseId: id, command: text, test: true }); f.store.appendEvent(s.id, 'command-end', { toolUseId: id, status, exitCode, durationMs: 5 }); };
  command('a', 'npm test', 'failed', 1); command('b', 'npm test', 'succeeded', 0); command('c', 'npm test', 'succeeded', 0);
  command('d', 'node --test --grep x', 'unknown'); command('e', 'API_KEY=[redacted] npm test', 'succeeded', 0);
  const created = f.store.generateProposals(s.id).filter(p => p.kind === 'test-command');
  assert.equal(created.length, 1); assert.match(created[0].statement, /Tests run with `npm test`/);
  f.store.dismissProposal(created[0].id);
  const later = f.session(''); f.store.appendEvent(later.id, 'command-start', { toolUseId: 'z', command: 'npm test', test: true }); f.store.appendEvent(later.id, 'command-end', { toolUseId: 'z', status: 'succeeded', exitCode: 0 });
  assert.equal(f.store.generateProposals(later.id).filter(p => p.kind === 'test-command').length, 0, 'Dismissed proposals are never re-proposed');
});

test('a session that moved the branch suggests a status review; proposals reference real sessions', t => {
  const f = fixture(t); const s = f.session('', { head: f.store.project(f.project.id).head });
  writeFileSync(join(f.repo, 'b.txt'), 'b\n'); f.git('add', '.'); f.git('-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'work');
  const status = f.store.generateProposals(s.id).filter(p => p.kind === 'branch-status');
  assert.equal(status.length, 1); assert.throws(() => f.store.acceptProposal(status[0].id), /Propose branch update/);
  assert.equal(f.store.listProposals(f.project.id).length, 1);
  f.store.db.prepare(`UPDATE proposals SET body=json_set(body, '$.kind', 'rule', '$.evidence.sessionId', 'invented') WHERE id=?`).run(status[0].id);
  assert.throws(() => f.store.acceptProposal(status[0].id), /Unknown session/);
});

test('a status proposal is only made for the branch the session ran on', t => {
  const f = fixture(t); const s = f.session('', { head: f.store.project(f.project.id).head, branch: 'main' });
  f.git('switch', '-q', '-c', 'other'); writeFileSync(join(f.repo, 'c.txt'), 'c\n'); f.git('add', '.'); f.git('-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'other work');
  assert.equal(f.store.generateProposals(s.id).filter(p => p.kind === 'branch-status').length, 0);
});

test('approving a branch update closes that branch\'s open status proposals', t => {
  const f = fixture(t); const s = f.session('', { head: f.store.project(f.project.id).head });
  writeFileSync(join(f.repo, 'd.txt'), 'd\n'); f.git('add', '.'); f.git('-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'work');
  assert.equal(f.store.generateProposals(s.id).filter(p => p.kind === 'branch-status').length, 1);
  const update = f.store.proposeMemory(f.project.id, { statement: 'Status: work done.', category: 'brief', scope: 'branch', area: '', source: { kind: 'user', note: 'n' } });
  f.store.setMemoryStatus(update.id, 'active');
  assert.equal(f.store.listProposals(f.project.id).length, 0);
});

test('a suggestion from a purged session can still be accepted; forged sessions are still refused', t => {
  const f = fixture(t);
  const s = f.session('Ship it.\nRule: Release tags must be signed before publishing.', { survivors: [] });
  const [created] = f.store.generateProposals(s.id);
  f.store.purgeSession(s.id);
  const kept = f.store.getProposal(created.id);
  assert.equal(kept.evidence.sessionId, null);
  assert.equal(kept.evidence.sessionPurged, true);
  assert.equal(f.store.acceptProposal(created.id).status, 'candidate');
  const other = f.session('Rule: Migrations must be reversible before they merge.', { survivors: [] });
  const [forged] = f.store.generateProposals(other.id);
  f.store.db.prepare(`UPDATE proposals SET body=json_set(body, '$.evidence.sessionId', 'invented') WHERE id=?`).run(forged.id);
  assert.throws(() => f.store.acceptProposal(forged.id), /Unknown session/);
});

test('purging detaches open test-command suggestions from the session and its events; handled ones are left alone', t => {
  const f = fixture(t);
  const run = (s, id, text) => { f.store.appendEvent(s.id, 'command-start', { toolUseId: id, command: text, test: true }); f.store.appendEvent(s.id, 'command-end', { toolUseId: id, status: 'succeeded', exitCode: 0 }); };
  const s = f.session('', { survivors: [] }); run(s, 'a', 'npm test'); run(s, 'b', 'node --test');
  const [open, handled] = f.store.generateProposals(s.id).filter(p => p.kind === 'test-command');
  assert.ok(open.evidence.eventId, 'the fixture links an event');
  f.store.acceptProposal(handled.id);
  f.store.purgeSession(s.id);
  const after = f.store.getProposal(open.id);
  assert.ok(!after.source.note.includes(s.id)); assert.match(after.source.note, /a purged session/);
  assert.equal(after.evidence.eventId, null); assert.equal(after.evidence.sessionId, null);
  assert.equal(f.store.getProposal(handled.id).evidence.sessionId, s.id, 'Only open proposals are detached');
  assert.equal(f.store.acceptProposal(open.id).status, 'candidate');
});

test('a branch suggestion cannot be remembered while another branch is checked out', t => {
  const f = fixture(t);
  const s = f.session('Rule: Feature flags on this branch default to off.', { survivors: [] });
  const [created] = f.store.generateProposals(s.id);
  f.store.db.prepare(`UPDATE proposals SET body=json_set(body,'$.scope','branch','$.branch','feature/flags') WHERE id=?`).run(created.id);
  assert.throws(() => f.store.acceptProposal(created.id), /Switch to feature\/flags/);
  assert.equal(f.store.getProposal(created.id).state, 'open', 'Nothing changed');
});

test('a branch suggestion made on the checked-out branch is remembered on that branch', t => {
  const f = fixture(t);
  const current = f.store.project(f.project.id).branch;
  assert.equal(current, 'main');
  const s = f.session('Rule: Feature flags on this branch default to off.', { survivors: [] });
  const [created] = f.store.generateProposals(s.id);
  f.store.db.prepare(`UPDATE proposals SET body=json_set(body,'$.scope','branch','$.branch',?) WHERE id=?`).run(current, created.id);
  const memory = f.store.acceptProposal(created.id);
  assert.equal(memory.scope, 'branch'); assert.equal(memory.branch, 'main');
});
