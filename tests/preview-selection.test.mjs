import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { JournalStore } from '../src/core/store.mjs';
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
