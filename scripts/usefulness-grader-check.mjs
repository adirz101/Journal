import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Offline self-check: each hidden grader must pass a reference solution and
// fail the mistake it targets. No provider requests.
const J = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const { steps } = await import(pathToFileURL(join(J, 'fixtures/usefulness/ledger.mjs')).href);
const { tasks } = await import(pathToFileURL(join(J, 'fixtures/usefulness/tasks.mjs')).href);
const write = (repo, files) => { for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(repo, p)), { recursive: true }); writeFileSync(join(repo, p), c); } };
function build(branch) {
  const repo = mkdtempSync(join(tmpdir(), 'gv-')); const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  g('init', '-q', '-b', 'main'); const c = s => { write(repo, s.files); g('add', '-A'); g('-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', s.message); };
  steps.base.forEach(c);
  if (branch === 'feature/refunds') { steps.refunds.forEach(c); } else steps.refactor.forEach(c);
  return repo;
}
const good = {
  discount: { 'src/invoices/discount.mjs': `import { percentOf } from '../money.mjs';\nexport function applyDiscount(inv, p) { const lines = inv.lines.map(l => ({ ...l, totalCents: l.totalCents - percentOf(l.totalCents, p) })); return { ...inv, lines, totalCents: lines.reduce((a, l) => a + l.totalCents, 0) }; }\n` },
  'credit-notes': { 'src/credit-notes/create.mjs': `import { next } from '../storage/sequence.mjs';\nimport { insert } from '../storage/repo.mjs';\nexport function createCreditNote(store, invoice, reason) { return insert(store, 'creditNotes', { number: 'CN-' + String(next(store, 'credit-note')).padStart(6, '0'), invoiceNumber: invoice.number, reason }); }\n` },
  'payout-descriptor': { 'src/payouts/descriptor.mjs': `export function payoutDescriptor(shop, n) { const a = shop.normalize('NFKD').replace(/[^\\x20-\\x7e]/g, ''); return (a.slice(0, 22 - n.length - 1).trim() + ' ' + n).slice(0, 22); }\n` },
  'tax-region': { 'data/tax-rates.csv': 'region,rate\nON,0.13\nBC,0.12\nAB,0.05\nQC,0.14975\n' },
  'continue-refunds': { 'src/refunds/create.mjs': `import { readTable, writeTable } from '../storage/jsonStore.mjs';\nimport { refundRecord } from './model.mjs';\nexport function createRefund(store, invoice, amountCents, reason = '') { const prior = readTable(store, 'refunds').filter(r => r.invoiceNumber === invoice.number).reduce((a, r) => a + r.amountCents, 0); if (prior + amountCents > invoice.totalCents) throw new Error('Refund exceeds invoice'); const refund = refundRecord(invoice, amountCents, reason); writeTable(store, 'refunds', [...readTable(store, 'refunds'), refund]); return refund; }\nexport const refundsFor = (store, n) => readTable(store, 'refunds').filter(r => r.invoiceNumber === n);\n` },
  'customer-notes': { 'src/customers/notes.mjs': `import { all, insert } from '../storage/repo.mjs';\nexport const saveNote = (store, customerId, text) => insert(store, 'notes', { customerId, text });\nexport const listNotes = (store, customerId) => all(store, 'notes').filter(n => n.customerId === customerId);\n` },
};
const bad = {
  discount: { 'src/invoices/discount.mjs': `export function applyDiscount(inv, p) { const lines = inv.lines.map(l => ({ ...l, totalCents: l.totalCents * (1 - p / 100) })); return { ...inv, lines, totalCents: lines.reduce((a, l) => a + l.totalCents, 0) }; }\n` },
  'credit-notes': { 'src/credit-notes/create.mjs': `export function createCreditNote(store, invoice, reason) { return { number: 'CN-' + String(Date.now() % 1000000).padStart(6, '0') + Math.random(), reason }; }\n` },
  'payout-descriptor': { 'src/payouts/descriptor.mjs': `export const payoutDescriptor = (shop, n) => shop + ' ' + n;\n` },
  'tax-region': { 'src/generated/taxRates.mjs': 'export const taxRates = { ON: 0.13, BC: 0.12, AB: 0.05, QC: 0.14975 };\n' },
  'continue-refunds': { 'README.md': 'docs only\n' },
  'customer-notes': { 'src/customers/notes.mjs': `import { readTable, writeTable } from '../storage/jsonStore.mjs';\nexport const saveNote = (store, customerId, text) => writeTable(store, 'notes', [...readTable(store, 'notes'), { customerId, text }]);\nexport const listNotes = (store, customerId) => readTable(store, 'notes').filter(n => n.customerId === customerId);\n` },
};
for (const task of tasks) {
  for (const [label, files] of [['good', good[task.id]], ['bad', bad[task.id]]]) {
    const repo = build(task.branch); write(repo, files);
    const grader = join(repo, `.grader-${task.id}.mjs`); writeFileSync(grader, task.grader);
    let r; try { r = execFileSync(process.execPath, [grader, repo], { encoding: 'utf8', stdio: 'pipe' }).trim(); } catch (e) { r = 'ERR ' + e.stderr; }
    const passed = r.startsWith('{') && JSON.parse(r).pass;
    if (passed !== (label === 'good')) { console.error(`FAIL ${task.id} ${label}: ${r.slice(0, 300)}`); process.exitCode = 1; }
    else console.log(`ok ${task.id} ${label}`);
    rmSync(repo, { recursive: true, force: true });
  }
}
