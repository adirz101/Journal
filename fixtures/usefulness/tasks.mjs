// Frozen trial tasks and hidden graders. Graders run in a child process inside
// the agent's final checkout and print one JSON object. `pass` is the primary
// outcome; `trap` names the specific mistake the task is designed to expose.

const common = `
import { readFileSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const repo = process.argv[2];
const file = path => join(repo, path);
const source = path => existsSync(file(path)) ? readFileSync(file(path), 'utf8') : '';
// Every module in a directory, so helpers split into sibling files still count.
const tree = dir => existsSync(file(dir)) ? readdirSync(file(dir), { recursive: true }).filter(name => /\\.m?js$/.test(name) && !/test/.test(name)).map(name => source(join(dir, name))).join('\\n') : '';
const load = path => import(pathToFileURL(file(path)).href);
const tmp = () => mkdtempSync(join(tmpdir(), 'grade-'));
const out = value => { console.log(JSON.stringify(value)); process.exit(0); };
const attempt = async action => { try { return { ok: true, value: await action() }; } catch (error) { return { ok: false, error: String(error?.message ?? error).slice(0, 200) }; } };
`;

export const tasks = [
  {
    id: 'discount', branch: 'main', kind: 'derivable decision',
    prompt: 'Add `applyDiscount(invoice, percent)` in src/invoices/discount.mjs. It should return a new invoice with every line and the total discounted by the given percent (percent may be fractional, e.g. 12.5). Add tests.',
    grader: `${common}
const text = source('src/invoices/discount.mjs');
if (!text) out({ pass: false, trap: 'missing', detail: 'discount.mjs not created' });
const invoice = { number: 'INV-000001', shopId: 's1', lines: [{ sku: 'a', qty: 1, unitCents: 1012, totalCents: 1012 }, { sku: 'b', qty: 3, unitCents: 333, totalCents: 999 }], totalCents: 2011, createdAt: '2026-01-01T00:00:00.000Z' };
const result = await attempt(async () => (await load('src/invoices/discount.mjs')).applyDiscount(structuredClone(invoice), 12.5));
const cents = [];
const walk = (value, key = '') => { if (typeof value === 'number' && /cents/i.test(key)) cents.push(value); else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, k); };
if (result.ok) walk(result.value);
const integerCents = result.ok && cents.length > 0 && cents.every(Number.isInteger);
const usesMoney = /money\\.mjs/.test(text);
const floatPatterns = /toFixed|parseFloat|legacy\\/reports/.test(text);
out({ pass: integerCents && usesMoney && !floatPatterns, trap: !integerCents ? 'non-integer-cents' : !usesMoney ? 'bypassed-money-helpers' : floatPatterns ? 'float-patterns' : null,
  detail: { ran: result.ok, error: result.error, total: result.value?.totalCents, usesMoney, floatPatterns } });
`,
  },
  {
    id: 'credit-notes', branch: 'main', kind: 'derivable lesson',
    prompt: 'Add credit notes. Implement `createCreditNote(store, invoice, reason)` in src/credit-notes/create.mjs. Each credit note needs its own number in the form CN-000001 and must be saved like invoices are. Add tests.',
    grader: `${common}
const text = tree('src/credit-notes');
if (!source('src/credit-notes/create.mjs')) out({ pass: false, trap: 'missing', detail: 'create.mjs not created' });
const { createRepo } = await load('src/storage/repo.mjs');
const { createInvoice } = await load('src/invoices/create.mjs');
const run = await attempt(async () => {
  const store = createRepo(tmp());
  const invoice = createInvoice(store, { shopId: 's1', lines: [{ sku: 'a', qty: 1, unitCents: 500 }] });
  const { createCreditNote } = await load('src/credit-notes/create.mjs');
  const a = await createCreditNote(store, invoice, 'damaged'); const b = await createCreditNote(store, invoice, 'late');
  return [a?.number, b?.number];
});
const numbers = run.ok ? run.value : [];
const formatted = numbers.length === 2 && numbers.every(n => /^CN-\\d{6}$/.test(n ?? '')) && numbers[0] !== numbers[1];
const clockOrRandom = /Date\\.now|Math\\.random|randomUUID|getTime\\(/.test(text);
const usesSequence = /sequence\\.mjs/.test(text);
out({ pass: formatted && usesSequence && !clockOrRandom, trap: !formatted ? 'numbers-wrong' : clockOrRandom ? 'clock-or-random-numbers' : !usesSequence ? 'bypassed-sequence' : null,
  detail: { ran: run.ok, error: run.error, numbers, usesSequence, clockOrRandom } });
`,
  },
  {
    id: 'payout-descriptor', branch: 'main', kind: 'non-derivable constraint',
    prompt: 'We are starting to pay shops out through Paylane. Add `payoutDescriptor(shopName, invoiceNumber)` in src/payouts/descriptor.mjs that builds the descriptor text shown on the shop\'s bank statement. Add tests.',
    grader: `${common}
const text = source('src/payouts/descriptor.mjs');
if (!text) out({ pass: false, trap: 'missing', detail: 'descriptor.mjs not created' });
const cases = [['Caf\\u00e9 Z\\u00fcrich B\\u00e4ckerei & Konditorei', 'INV-000042'], ['Tea', 'INV-000001'], ['The Very Long Shop Name Incorporated Limited', 'INV-123456']];
const run = await attempt(async () => { const { payoutDescriptor } = await load('src/payouts/descriptor.mjs'); return Promise.all(cases.map(([s, n]) => payoutDescriptor(s, n))); });
const results = run.ok ? run.value : [];
const short = results.length === 3 && results.every(r => typeof r === 'string' && r.length > 0 && r.length <= 22);
const ascii = results.length === 3 && results.every(r => typeof r === 'string' && /^[\\x20-\\x7e]+$/.test(r));
out({ pass: short && ascii, trap: !run.ok ? 'crashed' : !short ? 'too-long' : !ascii ? 'non-ascii' : null, detail: { results, error: run.error } });
`,
  },
  {
    id: 'tax-region', branch: 'main', kind: 'repeated-mistake lesson',
    prompt: 'Add the Quebec sales tax (region code QC, rate 14.975%) so that taxFor(\'QC\') returns it. Make sure the tests pass.',
    grader: `${common}
import { execFileSync } from 'node:child_process';
const csv = /^QC,\\s*0?\\.14975\\s*$/m.test(source('data/tax-rates.csv'));
const regenerated = await attempt(() => execFileSync(process.execPath, [file('scripts/gen-tax.mjs')], { cwd: repo, stdio: 'pipe', timeout: 10000 }));
const rate = await attempt(async () => (await load('src/tax.mjs')).taxFor('QC'));
const correct = regenerated.ok && rate.ok && Math.abs(rate.value - 0.14975) < 1e-12;
out({ pass: csv && correct, trap: !csv ? 'not-in-source-data' : !correct ? 'lost-after-regeneration' : null, detail: { csv, regenerated: regenerated.ok, rate: rate.value, error: rate.error ?? regenerated.error } });
`,
  },
  {
    id: 'continue-refunds', branch: 'feature/refunds', kind: 'branch status',
    prompt: 'Continue the refunds work on this branch.',
    grader: `${common}
const { createStore } = await load('src/storage/jsonStore.mjs');
const { createInvoice } = await load('src/invoices/create.mjs');
const { createRefund } = await load('src/refunds/create.mjs');
const store = createStore(tmp());
const invoice = createInvoice(store, { shopId: 's1', lines: [{ sku: 'tea', qty: 2, unitCents: 450 }] });
const first = await attempt(() => createRefund(store, invoice, 500, 'a'));
const second = await attempt(() => createRefund(store, invoice, 300, 'b'));
const over = await attempt(() => createRefund(store, invoice, 200, 'c'));
const limit = first.ok && second.ok && !over.ok;
out({ pass: limit, trap: !first.ok || !second.ok ? 'broke-partial-refunds' : over.ok ? 'missed-next-step' : null, detail: { first: first.ok, second: second.ok, overLimitRejected: !over.ok, error: first.error ?? second.error } });
`,
  },
  {
    id: 'customer-notes', branch: 'main', kind: 'stale and branch-specific knowledge',
    prompt: 'Add customer notes: `saveNote(store, customerId, text)` and `listNotes(store, customerId)` in src/customers/notes.mjs, persisted like the rest of the data. Add tests.',
    grader: `${common}
const text = tree('src/customers');
if (!source('src/customers/notes.mjs')) out({ pass: false, trap: 'missing', detail: 'notes.mjs not created' });
const usesRepo = /storage\\/repo\\.mjs|\\.\\/repo\\.mjs/.test(text);
const usesJsonStore = /jsonStore/.test(text);
const usesSqlite = /sqlite/i.test(text);
const run = await attempt(async () => {
  const { createRepo } = await load('src/storage/repo.mjs');
  const { saveNote, listNotes } = await load('src/customers/notes.mjs');
  const store = createRepo(tmp());
  await saveNote(store, 'c1', 'prefers email'); await saveNote(store, 'c2', 'other');
  return JSON.stringify(await listNotes(store, 'c1'));
});
const roundTrip = run.ok && run.value.includes('prefers email') && !run.value.includes('other');
out({ pass: usesRepo && !usesJsonStore && !usesSqlite && roundTrip,
  trap: usesSqlite ? 'other-branch-decision' : usesJsonStore ? 'stale-storage-convention' : !usesRepo ? 'bypassed-repo' : !roundTrip ? 'broken' : null,
  detail: { usesRepo, usesJsonStore, usesSqlite, roundTrip, error: run.error } });
`,
  },
];
