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

test('purging detaches every suggestion from the session and its events; handled ones keep their outcome', t => {
  const f = fixture(t);
  const run = (s, id, text) => { f.store.appendEvent(s.id, 'command-start', { toolUseId: id, command: text, test: true }); f.store.appendEvent(s.id, 'command-end', { toolUseId: id, status: 'succeeded', exitCode: 0 }); };
  const s = f.session('', { survivors: [] }); run(s, 'a', 'npm test'); run(s, 'b', 'node --test'); run(s, 'c', 'npx vitest');
  const [open, accepted, dismissed] = f.store.generateProposals(s.id).filter(p => p.kind === 'test-command');
  assert.ok(open.evidence.eventId, 'the fixture links an event');
  const memory = f.store.acceptProposal(accepted.id); f.store.dismissProposal(dismissed.id);
  f.store.purgeSession(s.id);
  const note = 'Observed command exit status from Claude Code hooks in a purged session.';
  for (const [proposal, state] of [[open, 'open'], [accepted, 'accepted'], [dismissed, 'dismissed']]) {
    const after = f.store.getProposal(proposal.id);
    assert.equal(after.state, state); assert.equal(after.statement, proposal.statement); assert.equal(after.source.note, note);
    assert.equal(after.evidence.sessionId, null); assert.equal(after.evidence.eventId, null); assert.equal(after.evidence.sessionPurged, true);
  }
  assert.equal(f.store.getProposal(accepted.id).memoryId, memory.id, 'The accepted suggestion still links its note');
  assert.equal(f.store.acceptProposal(open.id).status, 'candidate');
});

test('purging falls back to replacing the bare session id in a note without the session phrase', t => {
  const f = fixture(t);
  const s = f.session('Rule: Release tags must be signed before publishing.', { survivors: [] });
  const [created] = f.store.generateProposals(s.id);
  f.store.db.prepare(`UPDATE proposals SET body=json_set(body,'$.source.note',?) WHERE id=?`).run(`Seen in ${s.id} and session ${s.id}.`, created.id);
  f.store.purgeSession(s.id);
  assert.equal(f.store.getProposal(created.id).source.note, 'Seen in a purged session and a purged session.');
});

test('a branch suggestion is remembered on the branch it came from, not the checked-out one', t => {
  const f = fixture(t); f.git('branch', 'feature/flags');
  const s = f.session('Rule: Feature flags on this branch default to off.', { survivors: [] });
  const [created] = f.store.generateProposals(s.id);
  f.store.db.prepare(`UPDATE proposals SET body=json_set(body,'$.scope','branch','$.branch','feature/flags') WHERE id=?`).run(created.id);
  const memory = f.store.acceptProposal(created.id);
  assert.equal(memory.scope, 'branch'); assert.equal(memory.branch, 'feature/flags');
  assert.equal(f.store.getProposal(created.id).state, 'accepted');
  assert.throws(() => f.store.setMemoryStatus(memory.id, 'active'), /check out that branch to approve it/, "It is approved on its own branch");
  f.git('checkout', '-q', 'feature/flags'); f.store.setMemoryStatus(memory.id, 'active');
  assert.equal(f.store.prepareContext(f.project.id, 'Feature flags default').items.length, 1);
  f.git('checkout', '-q', 'main');
  assert.equal(f.store.prepareContext(f.project.id, 'Feature flags default').items.length, 0, 'main does not receive another branch\'s memory');
});

test('a branch suggestion whose branch was deleted stays open and is not remembered', t => {
  const f = fixture(t);
  const s = f.session('Rule: Feature flags on this branch default to off.', { survivors: [] });
  const [created] = f.store.generateProposals(s.id);
  f.store.db.prepare(`UPDATE proposals SET body=json_set(body,'$.scope','branch','$.branch','feature/gone') WHERE id=?`).run(created.id);
  assert.throws(() => f.store.acceptProposal(created.id), /The branch feature\/gone no longer exists/);
  assert.equal(f.store.getProposal(created.id).state, 'open', 'Nothing changed');
});

test('an explicit bound branch is validated: option-like names, unknown branches and briefs are refused', t => {
  const f = fixture(t);
  const input = { statement: 'Feature flags default to off', category: 'constraint', scope: 'branch', area: '', source: { kind: 'user', note: 'fixture' } };
  assert.throws(() => f.store.proposeMemory(f.project.id, input, { branch: '--upload-pack=x' }), /Invalid branch name/);
  assert.throws(() => f.store.proposeMemory(f.project.id, input, { branch: 'nope' }), /no longer exists/);
  f.git('branch', 'feature/x');
  assert.throws(() => f.store.proposeMemory(f.project.id, { ...input, category: 'brief' }, { branch: 'feature/x' }), /brief/i);
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

test('a branch suggestion made without a branch checked out is refused rather than bound to the current branch', t => {
  const f = fixture(t);
  const s = f.session('Rule: Feature flags on this branch default to off.', { survivors: [] });
  const [created] = f.store.generateProposals(s.id);
  f.store.db.prepare(`UPDATE proposals SET body=json_set(body,'$.scope','branch','$.branch',json('null')) WHERE id=?`).run(created.id);
  assert.throws(() => f.store.acceptProposal(created.id), /without a branch checked out/);
  assert.equal(f.store.getProposal(created.id).state, 'open', 'Nothing changed');
});

test('revising a note bound to another branch is refused; approving it elsewhere names its branch', t => {
  const f = fixture(t); f.git('branch', 'feature/flags');
  const s = f.session('Rule: Feature flags on this branch default to off.', { survivors: [] });
  const [created] = f.store.generateProposals(s.id);
  f.store.db.prepare(`UPDATE proposals SET body=json_set(body,'$.scope','branch','$.branch','feature/flags') WHERE id=?`).run(created.id);
  const memory = f.store.acceptProposal(created.id);
  const revise = () => f.store.proposeMemory(f.project.id, { memoryId: memory.id, statement: 'Feature flags default to off everywhere', category: memory.category, scope: 'branch', area: '', source: { kind: 'user', note: 'fixture' } });
  assert.throws(revise, /This note belongs to branch feature\/flags; check out that branch to revise it/);
  assert.throws(() => f.store.setMemoryStatus(memory.id, 'active'), /belongs to branch feature\/flags; check out that branch to approve it/);
});

test('a suggestion made in a worktree is remembered on the worktree branch while the main checkout is elsewhere', t => {
  const f = fixture(t);
  const ws = f.store.createWorkspace(f.project.id, { branch: 'feature/flags', base: 'main' }, join(f.repo, '..', 'worktrees'));
  const s = f.session('', { survivors: [], workspaceId: ws.id, branch: 'feature/flags' });
  f.store.appendEvent(s.id, 'command-start', { toolUseId: 'a', command: 'npm test', test: true });
  f.store.appendEvent(s.id, 'command-end', { toolUseId: 'a', status: 'succeeded', exitCode: 0 });
  const proposal = f.store.generateProposals(s.id).find(p => p.kind === 'test-command');
  assert.equal(proposal.scope, 'branch'); assert.equal(proposal.branch, 'feature/flags');
  assert.equal(f.store.project(f.project.id).branch, 'main');
  assert.equal(f.store.acceptProposal(proposal.id).branch, 'feature/flags');
});

test('a note for a branch open in a worktree explains that it cannot be revised or approved from the main checkout yet', t => {
  const f = fixture(t);
  const ws = f.store.createWorkspace(f.project.id, { branch: 'feature/flags', base: 'main' }, join(f.repo, '..', 'worktrees'));
  const s = f.session('', { survivors: [], workspaceId: ws.id, branch: 'feature/flags' });
  f.store.appendEvent(s.id, 'command-start', { toolUseId: 'a', command: 'npm test', test: true });
  f.store.appendEvent(s.id, 'command-end', { toolUseId: 'a', status: 'succeeded', exitCode: 0 });
  const memory = f.store.acceptProposal(f.store.generateProposals(s.id).find(p => p.kind === 'test-command').id);
  const revise = () => f.store.proposeMemory(f.project.id, { memoryId: memory.id, statement: 'Run npm test before committing', category: memory.category, scope: 'branch', area: '', source: { kind: 'user', note: 'fixture' } });
  assert.throws(revise, { message: 'This note belongs to branch feature/flags, which is open in a separate copy (worktree); revising it from there is not available yet. You can reject it.' });
  assert.throws(() => f.store.setMemoryStatus(memory.id, 'active'), { message: 'This note belongs to branch feature/flags, which is open in a separate copy (worktree); approving it from there is not available yet. You can reject it.' });
  assert.equal(f.store.setMemoryStatus(memory.id, 'rejected').status, 'rejected');
});

test('branch names are matched by exact spelling and reported when invalid', t => {
  const f = fixture(t); f.git('branch', 'feature/flags');
  const input = { statement: 'Feature flags default to off', category: 'constraint', scope: 'branch', area: '', source: { kind: 'user', note: 'fixture' } };
  assert.throws(() => f.store.proposeMemory(f.project.id, input, { branch: 'Feature/Flags' }), /no longer exists.*Dismiss it/);
  assert.throws(() => f.store.proposeMemory(f.project.id, input, { branch: 'bad..name' }), /Invalid branch name: bad\.\.name/);
  assert.throws(() => f.store.proposeMemory(f.project.id, { ...input, source: { kind: 'user', rootId: 'x' } }, { branch: 'nope' }), /additional folders/);
});
