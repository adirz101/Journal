import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { JournalStore } from '../src/core/store.mjs';
import { queryTerms } from '../src/core/retrieval.mjs';
import { removeLater } from './support/cleanup.mjs';

// Fixed identity and dates keep commits reproducible; the snapshot still masks HEAD.
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@a', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@a',
  GIT_AUTHOR_DATE: '2026-10-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-01T00:00:00Z' };

// One fixture for every selection stage: two checkout briefs and a branch
// brief, two pinned rules, an area claim reached only through a referenced
// folder, an FTS match set with a duplicate and a stale file claim, five
// lessons of one kind (category limit) and enough long claims for the
// 12-claim / 6000-byte budget.
function selectionFixture(t) {
  const root = mkdtempSync(join(process.env.JOURNAL_TEST_TMP ?? tmpdir(), 'preview-selection-'));
  const repo = join(root, 'repo');
  for (const dir of ['src/payments', 'src/billing', 'src/storage', 'docs']) mkdirSync(join(repo, dir), { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', encoding: 'utf8', env: GIT_ENV }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'src/payments/retry.mjs'), 'export const retries = 3;\nexport const backoff = "exponential";\n');
  writeFileSync(join(repo, 'src/payments/webhook.mjs'), 'export const verify = true;\n');
  writeFileSync(join(repo, 'src/billing/invoice.mjs'), 'export const invoice = 1;\n');
  writeFileSync(join(repo, 'src/storage/jsonStore.mjs'), 'export function readTable() {}\n');
  writeFileSync(join(repo, 'docs/notes.md'), 'Notes\n');
  git('add', '.'); git('commit', '-qm', 'init');
  const path = join(root, 'journal.sqlite'); const store = new JournalStore(path); const project = store.openProject(repo);
  t.after(() => { store.close(); removeLater(root); });
  const labels = new Map();
  const remember = (label, statement, extra = {}) => {
    const memory = store.proposeMemory(project.id, { statement, category: 'constraint', scope: 'checkout', area: '', source: { kind: 'user', note: `Fixture ${label}` }, ...extra });
    store.setMemoryStatus(memory.id, 'active'); labels.set(memory.id, label); return memory;
  };
  remember('brief-checkout-1', 'Journal fixture is a payments service with a billing module and a JSON storage layer.', { category: 'brief' });
  remember('brief-checkout-2', 'The payments service exposes webhooks; billing produces invoices nightly.', { category: 'brief' });
  remember('brief-branch', 'main: retries were reworked last week; next step is refund webhooks.', { category: 'brief', scope: 'branch' });
  store.setPinned(remember('pinned-1', 'Never log card numbers, even in debug builds.').id, true);
  store.setPinned(remember('pinned-2', 'Run the full test suite before every release tag.', { category: 'convention' }).id, true);
  remember('area-billing', 'Invoices are immutable once sent to the customer.', { area: 'src/billing', category: 'decision' });
  remember('retry-file', 'Payment retries use exponential backoff from src/payments/retry.mjs.', { source: { kind: 'file', path: 'src/payments/retry.mjs', startLine: 1, endLine: 2 } });
  remember('retry-duplicate', 'Payment retries use exponential backoff from src/payments/retry.mjs!');
  remember('webhook-stale', 'Payment webhooks must verify the signature before parsing the body.', { source: { kind: 'file', path: 'src/payments/webhook.mjs', startLine: 1, endLine: 1 } });
  for (let i = 1; i <= 5; i++) remember(`lesson-${i}`, `Lesson ${i}: payment retries and refund webhooks once failed together; cap the retry queue at ${i * 100} jobs.`, { category: 'lesson' });
  // Long, distinct claims that match one task word each, so they rank last and meet the budget.
  const topics = ['alpha ledger columns', 'bravo settlement batches', 'charlie currency rounding', 'delta tax regions', 'echo audit exports', 'foxtrot dispute evidence'];
  for (const [i, topic] of topics.entries()) remember(`long-${i + 1}`, `Refund handling for ${topic}: ${Array.from({ length: 24 }, (_, n) => `${topic.split(' ')[0]}${n}`).join(' ')}.`, { category: i % 2 ? 'issue' : 'decision' });
  remember('storage', 'Persist rows with readTable from src/storage/jsonStore.mjs.', { category: 'convention' });
  // Changed after capture: the webhook claim is now out of date.
  writeFileSync(join(repo, 'src/payments/webhook.mjs'), 'export const verify = false;\n');
  return { root, repo, git, store, project, labels, path, task: 'Fix payment retries and refund webhooks in readTable',
    references: [{ rootKey: 'checkout', path: 'src/billing' }] };
}

// Memory IDs and the receipt UUID are random; HEAD is masked so the snapshot holds on any Git.
function normalize(f, receipt) {
  const replacements = [[receipt.id, '<receipt>'], ...(receipt.checkout?.head ? [[receipt.checkout.head, '<head>']] : []),
    ...[...f.labels].map(([id, label]) => [id, `<${label}>`]), ...[...f.labels].map(([id, label]) => [id.slice(0, 8), `<${label}>`])];
  const mask = value => replacements.reduce((text, [from, to]) => text.replaceAll(from, to), value);
  return {
    packet: mask(receipt.packet),
    items: receipt.items.map(item => [f.labels.get(item.id), item.selection.reason]),
    excluded: receipt.excluded.map(item => [f.labels.get(item.id), item.reason]),
    warnings: receipt.warnings.map(mask),
  };
}

// Literal snapshot of today's packet (taken before the selection refactor).
const SNAPSHOT = {
  packet: [
    "Journal project knowledge \u2014 checkout <head>, receipt <receipt>",
    "Project: repo; branch main.",
    "These are reviewed, scoped claims with evidence. Native project instructions take precedence. Validate against current code.",
    "",
    "Project brief",
    "[<brief-checkout-2> r1; brief; checkout]",
    "The payments service exposes webhooks; billing produces invoices nightly.",
    "Evidence: User statement: Fixture brief-checkout-2",
    "",
    "Branch update",
    "[<brief-branch> r1; brief; branch main]",
    "main: retries were reworked last week; next step is refund webhooks.",
    "Evidence: User statement: Fixture brief-branch",
    "",
    "Project brief",
    "[<brief-checkout-1> r1; brief; checkout]",
    "Journal fixture is a payments service with a billing module and a JSON storage layer.",
    "Evidence: User statement: Fixture brief-checkout-1",
    "",
    "[<pinned-2> r1; convention; checkout]",
    "Run the full test suite before every release tag.",
    "Evidence: User statement: Fixture pinned-2",
    "",
    "[<pinned-1> r1; constraint; checkout]",
    "Never log card numbers, even in debug builds.",
    "Evidence: User statement: Fixture pinned-1",
    "",
    "[<area-billing> r1; decision; checkout; area src/billing]",
    "Invoices are immutable once sent to the customer.",
    "Evidence: User statement: Fixture area-billing",
    "",
    "[<storage> r1; convention; checkout]",
    "Persist rows with readTable from src/storage/jsonStore.mjs.",
    "Evidence: User statement: Fixture storage",
    "",
    "[<retry-file> r1; constraint; checkout]",
    "Payment retries use exponential backoff from src/payments/retry.mjs.",
    "Evidence: src/payments/retry.mjs:1 @ <head>",
    "",
    "[<lesson-1> r1; lesson; checkout]",
    "Lesson 1: payment retries and refund webhooks once failed together; cap the retry queue at 100 jobs.",
    "Evidence: User statement: Fixture lesson-1",
    "",
    "[<lesson-2> r1; lesson; checkout]",
    "Lesson 2: payment retries and refund webhooks once failed together; cap the retry queue at 200 jobs.",
    "Evidence: User statement: Fixture lesson-2",
    "",
    "[<lesson-3> r1; lesson; checkout]",
    "Lesson 3: payment retries and refund webhooks once failed together; cap the retry queue at 300 jobs.",
    "Evidence: User statement: Fixture lesson-3",
    "",
    "[<lesson-4> r1; lesson; checkout]",
    "Lesson 4: payment retries and refund webhooks once failed together; cap the retry queue at 400 jobs.",
    "Evidence: User statement: Fixture lesson-4",
    "",
    "Referenced by the user (read these yourself; their contents are not included here):",
    "- src/billing (folder: focus on this area)",
    "",
  ].join('\n'),
  items: [
    ["brief-checkout-2", "repo overview"],
    ["brief-branch", "branch update"],
    ["brief-checkout-1", "repo overview"],
    ["pinned-2", "pinned"],
    ["pinned-1", "pinned"],
    ["area-billing", "referenced area src/billing"],
    ["storage", "matched readtable, read, table, src"],
    ["retry-file", "matched payment, retries, src"],
    ["lesson-1", "matched payment, retries, refund, webhooks"],
    ["lesson-2", "matched payment, retries, refund, webhooks"],
    ["lesson-3", "matched payment, retries, refund, webhooks"],
    ["lesson-4", "matched payment, retries, refund, webhooks"],
  ],
  excluded: [
    ["retry-duplicate", "duplicate"],
    ["lesson-5", "category-limit"],
    ["webhook-stale", "stale"],
    ["long-1", "budget"],
    ["long-2", "budget"],
    ["long-3", "budget"],
    ["long-4", "budget"],
    ["long-5", "budget"],
    ["long-6", "budget"],
  ],
  warnings: [
    "Claims <lesson-1> r1 and <lesson-2> r1 may conflict. Review them in Knowledge.",
    "Claims <lesson-1> r1 and <lesson-3> r1 may conflict. Review them in Knowledge.",
    "Claims <lesson-1> r1 and <lesson-4> r1 may conflict. Review them in Knowledge.",
    "Claims <lesson-2> r1 and <lesson-3> r1 may conflict. Review them in Knowledge.",
    "Claims <lesson-2> r1 and <lesson-4> r1 may conflict. Review them in Knowledge.",
    "Claims <lesson-3> r1 and <lesson-4> r1 may conflict. Review them in Knowledge.",
  ],
};

test('prepareContext packets are unchanged by the selection refactor', t => {
  const f = selectionFixture(t);
  for (const persist of [false, true]) {
    const receipt = f.store.prepareContext(f.project.id, f.task, { references: f.references, persist });
    assert.deepEqual(normalize(f, receipt), SNAPSHOT);
    if (persist) assert.deepEqual(normalize(f, f.store.getReceipt(receipt.id)), SNAPSHOT, 'the stored receipt holds the same packet');
  }
});

// A small project: a Git checkout on main with approved notes added by remember().
function basic(t) {
  const root = mkdtempSync(join(process.env.JOURNAL_TEST_TMP ?? tmpdir(), 'preview-basic-'));
  const repo = join(root, 'repo'); mkdirSync(join(repo, 'src'), { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', encoding: 'utf8', env: GIT_ENV }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'src/worktree.mjs'), 'export const removal = "refuse locked";\n');
  git('add', '.'); git('commit', '-qm', 'init');
  const store = new JournalStore(join(root, 'journal.sqlite')); const project = store.openProject(repo);
  t.after(() => { store.close(); removeLater(root); });
  const remember = (statement, extra = {}, options) => {
    const memory = store.proposeMemory(project.id, { statement, category: 'constraint', scope: 'checkout', area: '', source: { kind: 'user', note: 'Fixture' }, ...extra }, options);
    store.setMemoryStatus(memory.id, 'active'); return memory;
  };
  return { root, repo, git, store, project, remember };
}
const count = (store, table) => store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
const changes = store => store.db.prepare('SELECT total_changes() AS n').get().n;

test('taskNotes counts in-scope non-brief notes', t => {
  const f = basic(t);
  f.remember('Worktree removal refuses locked worktrees.');
  f.remember('Branch names never start with a dash.', { category: 'convention' });
  f.remember('This repository is a fixture.', { category: 'brief' });
  f.git('checkout', '-q', '-b', 'feature/y');
  f.remember('Feature y is half done.', { scope: 'branch' });
  f.git('checkout', '-q', 'main');
  assert.equal(f.store.previewSelection(f.project.id, 'anything', { branch: 'main' }).taskNotes, 2);
  assert.equal(f.store.previewSelection(f.project.id, '', { branch: 'feature/y' }).taskNotes, 3);
});

test('previewSelection writes nothing', t => {
  const f = selectionFixture(t);
  f.store.prepareContext(f.project.id, f.task, { references: f.references });
  const before = { changes: changes(f.store), receipts: count(f.store, 'receipts'), audit: count(f.store, 'audit') };
  for (const task of [f.task, '', 'payment']) f.store.previewSelection(f.project.id, task, { branch: 'main', references: f.references, disabled: [] });
  assert.deepEqual({ changes: changes(f.store), receipts: count(f.store, 'receipts'), audit: count(f.store, 'audit') }, before);
});

test('previewSelection never runs Git or reads evidence', t => {
  const f = selectionFixture(t);
  const path = process.env.PATH; const empty = mkdtempSync(join(process.env.JOURNAL_TEST_TMP ?? tmpdir(), 'no-git-'));
  t.after(() => { process.env.PATH = path; removeLater(empty); });
  process.env.PATH = empty;
  const preview = f.store.previewSelection(f.project.id, f.task, { branch: 'main', references: f.references });
  assert.ok(preview.items.length > 0);
  assert.throws(() => f.store.prepareContext(f.project.id, f.task, { references: f.references, persist: false }), 'the guard is real: prepareContext needs Git');
  process.env.PATH = path;
  // A deleted evidence file: the typing preview still shows the note; the full preview leaves it out as out of date.
  rmSync(join(f.repo, 'src/payments/retry.mjs'));
  const retry = [...f.labels].find(([, label]) => label === 'retry-file')[0];
  assert.ok(f.store.previewSelection(f.project.id, f.task, { branch: 'main' }).items.some(item => item.id === retry));
  const full = f.store.prepareContext(f.project.id, f.task, { persist: false });
  assert.ok(!full.items.some(item => item.id === retry));
  assert.deepEqual(full.excluded.find(item => item.id === retry), { id: retry, reason: 'stale' });
});

test('previewSelection selects what prepareContext selects when every source is current', t => {
  const f = selectionFixture(t);
  writeFileSync(join(f.repo, 'src/payments/webhook.mjs'), 'export const verify = true;\n');
  // An additional folder, a worktree, and an area note that shares no word
  // with the task or the referenced path: only the referenced area selects it.
  const docs = join(f.root, 'handbook'); mkdirSync(docs); writeFileSync(join(docs, 'guide.md'), 'Guide\n');
  const [folder] = f.store.addProjectRoot(f.project.id, docs).roots;
  const ws = f.store.createWorkspace(f.project.id, { branch: 'feature/p4', base: 'main' }, join(f.root, 'worktrees'));
  const quiet = f.store.proposeMemory(f.project.id, { statement: 'Quokkas nap under marmalade lanterns.', category: 'decision', scope: 'checkout', area: 'src/storage', source: { kind: 'user', note: 'Fixture quiet' } });
  f.store.setMemoryStatus(quiet.id, 'active');
  const leftOut = [...f.labels].find(([, label]) => label === 'retry-file')[0];
  const shape = result => ({ items: result.items.map(item => [item.id, item.selection.reason, item.selection.terms]), excluded: result.excluded.map(item => [item.id, item.reason]), warnings: result.warnings });
  const sessions = [
    { workspaceId: null, branch: 'main', references: f.references, disabled: [[], [leftOut]] },
    // A reference to the primary checkout from an additional-folder session is primary: its area applies.
    { workspaceId: `root:${folder.id}`, branch: 'main', references: [{ rootKey: 'checkout', path: 'src/storage' }, { rootKey: `root:${folder.id}`, path: 'guide.md' }], disabled: [[]], quiet: true },
    { workspaceId: ws.id, branch: 'feature/p4', references: [{ rootKey: ws.id, path: 'src/storage' }], disabled: [[]], quiet: true },
  ];
  for (const session of sessions) for (const disabled of session.disabled) {
    const { workspaceId, branch, references } = session;
    const full = f.store.prepareContext(f.project.id, f.task, { workspaceId, references, disabled, persist: false });
    const preview = f.store.previewSelection(f.project.id, f.task, { workspaceId, branch, references, disabled });
    assert.deepEqual(shape(preview), shape(full), `session ${workspaceId}`);
    if (session.quiet) assert.ok(preview.items.some(item => item.id === quiet.id), `the referenced area selects the quiet note in ${workspaceId}`);
    assert.equal(preview.kind, 'selection'); assert.equal(preview.checked, false); assert.equal(preview.branch, branch); assert.equal(preview.query, f.task);
    assert.deepEqual(preview.terms, full.terms);
    assert.equal(preview.bytes, Buffer.byteLength(full.packet.slice(0, full.packet.indexOf('\nReferenced by the user'))), 'packet bytes before references');
  }
  // A primary path from another copy, and unknown roots, are refused with prepareContext's messages.
  const message = action => { try { action(); } catch (error) { return error.message; } return null; };
  const refused = [
    [ws.id, [{ rootKey: 'checkout', path: 'src/storage' }]], [null, [{ rootKey: ws.id, path: 'src/storage' }]],
    [null, [{ rootKey: 'root:missing', path: 'guide.md' }]], [null, [{ rootKey: randomUUID(), path: 'src' }]],
  ];
  for (const [workspaceId, references] of refused) {
    const expected = message(() => f.store.prepareContext(f.project.id, f.task, { workspaceId, references, persist: false }));
    assert.ok(expected, `prepareContext refuses ${JSON.stringify(references)} from ${workspaceId}`);
    assert.equal(message(() => f.store.previewSelection(f.project.id, f.task, { workspaceId, branch: 'main', references })), expected);
  }
  assert.match(message(() => f.store.previewSelection(f.project.id, f.task, { workspaceId: ws.id, references: [{ rootKey: 'checkout', path: 'src' }] })), /^src is in repo \(checkout\), but this session runs in repo \(worktree feature\/p4\)\. Reference it from the session's own copy\.$/);
});

test('wrong-branch and removed-folder notes are excluded from the stored records alone', t => {
  const f = basic(t);
  const docs = join(f.root, 'docs'); mkdirSync(docs); writeFileSync(join(docs, 'guide.md'), 'Worktree guide line\n');
  const [docsRoot] = f.store.addProjectRoot(f.project.id, docs).roots;
  const fromDocs = f.remember('Worktree guide explains removal.', { source: { kind: 'file', rootId: docsRoot.id, path: 'guide.md', startLine: 1, endLine: 1 } });
  const onMain = f.remember('Worktree removal on main keeps the branch.', { scope: 'branch' });
  f.store.removeProjectRoot(f.project.id, docsRoot.id);
  const preview = f.store.previewSelection(f.project.id, 'worktree removal', { branch: 'feature/x' });
  assert.deepEqual(preview.excluded.find(item => item.id === fromDocs.id), { id: fromDocs.id, reason: 'folder-removed' });
  // Selection filters scope by branch in SQL before ranking (as prepareContext does), so a
  // main note is never a candidate on feature/x; the stored-record check would call it wrong-branch.
  assert.ok(!preview.items.some(item => item.id === onMain.id));
  const view = { ...f.store.describe(f.store.storedProject(f.project.id)), branch: 'feature/x' };
  assert.equal(f.store.storedValidation(view, f.store.getMemory(onMain.id)), 'wrong-branch');
  assert.equal(f.store.storedValidation({ ...view, branch: 'main' }, f.store.getMemory(onMain.id)), 'unchecked');
  assert.equal(f.store.storedValidation(view, f.store.getMemory(fromDocs.id)), 'folder-removed');
  assert.ok(f.store.previewSelection(f.project.id, 'worktree removal', { branch: 'main' }).items.some(item => item.id === onMain.id));
  f.git('checkout', '-q', '-b', 'feature/x');
  const full = f.store.prepareContext(f.project.id, 'worktree removal', { persist: false });
  assert.deepEqual(full.items.map(item => item.id), preview.items.map(item => item.id));
  assert.deepEqual(full.excluded, preview.excluded);
});

test('previewSelection validates input like prepareContext', t => {
  const f = basic(t);
  const otherRepo = join(f.root, 'other'); execFileSync('git', ['init', '-q', '-b', 'main', otherRepo], { stdio: 'pipe' });
  const other = f.store.openProject(otherRepo);
  const foreign = f.store.saveWorkspace({ id: randomUUID(), projectId: other.id, kind: 'managed', path: join(f.root, 'other-wt'), branch: 'x', state: 'ready' });
  const message = action => { try { action(); } catch (error) { return error.message; } return null; };
  const cases = [['x'.repeat(4001), {}], ['use token=abcdefghijkl for this', {}], ['task', { disabled: Array.from({ length: 101 }, (_, i) => `id${i}`) }], ['task', { workspaceId: foreign.id }],
    ['task', { disabled: 'nope' }], ['task', { workspaceId: 'root:missing' }], ['task', { references: Array.from({ length: 21 }, () => ({ rootKey: 'checkout', path: 'src' })) }]];
  for (const [task, options] of cases) {
    const expected = message(() => f.store.prepareContext(f.project.id, task, { ...options, persist: false }));
    assert.ok(expected, `prepareContext refuses ${JSON.stringify(options).slice(0, 60)}`);
    assert.equal(message(() => f.store.previewSelection(f.project.id, task, { branch: 'main', ...options })), expected);
  }
  assert.throws(() => f.store.previewSelection(f.project.id, 'task', { branch: 'x'.repeat(256) }), /Invalid branch/);
  assert.throws(() => f.store.previewSelection(f.project.id, 'task', { references: [{ rootKey: 'checkout', path: '../escape' }] }), /Invalid file path/);
  f.store.removeProject(other.id);
  assert.equal(message(() => f.store.previewSelection(other.id, 'task')), message(() => f.store.prepareContext(other.id, 'task', { persist: false })));
});

test('selection.terms records the task words FTS matched', t => {
  const f = basic(t);
  const note = f.remember('Retry payment refunds with exponential backoff');
  f.store.setPinned(note.id, true);
  const brief = f.remember('This payments fixture handles payment retries.', { category: 'brief' });
  for (const prepare of [(task) => f.store.prepareContext(f.project.id, task, { persist: false }), (task) => f.store.previewSelection(f.project.id, task, { branch: 'main' })]) {
    const terms = task => Object.fromEntries(prepare(task).items.map(item => [item.id, item.selection.terms]));
    assert.deepEqual(terms('payment retries please'), { [brief.id]: [], [note.id]: ['payment', 'retries'] });
    assert.deepEqual(terms('retr'), { [brief.id]: [], [note.id]: [] }, 'nothing matches by prefix');
    assert.deepEqual(terms('backoff'), { [brief.id]: [], [note.id]: ['backoff'] });
  }
  const receipt = f.store.prepareContext(f.project.id, 'payment retries please');
  assert.deepEqual(receipt.terms, queryTerms('payment retries please'));
  assert.deepEqual(f.store.getReceipt(receipt.id).items.find(item => item.id === note.id).selection, { reason: 'pinned', bytes: receipt.items[1].selection.bytes, terms: ['payment', 'retries'] });
});

test('receipts without selection.terms still load', t => {
  const f = basic(t);
  const note = f.remember('Worktree removal refuses locked worktrees.');
  const body = { id: randomUUID(), projectId: f.project.id, query: 'worktree removal', packet: 'Journal project knowledge — fixture', items: [{ ...f.store.getMemory(note.id), selection: { reason: 'matched worktree, removal', bytes: 120 } }],
    excluded: [], warnings: [], disabled: [], workspaceId: null, references: [], checkout: { root: f.repo, branch: 'main', head: null }, state: 'submitted', estimatedTokens: 12, createdAt: '2026-10-01T00:00:00.000Z' };
  f.store.db.prepare('INSERT INTO receipts VALUES(?,?,?)').run(body.id, f.project.id, JSON.stringify(body));
  assert.deepEqual(f.store.getReceipt(body.id), body);
  assert.ok(f.store.listReceipts(f.project.id).some(receipt => receipt.id === body.id && receipt.terms === undefined));
});
