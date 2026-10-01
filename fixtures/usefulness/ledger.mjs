// Synthetic "ledger" repository for the usefulness trial. Each step is one
// commit. Knowledge in knowledge.mjs is deliberately absent from this code:
// it is the tribal context a previous session or teammate would hold.

const packageJson = `{
  "name": "ledger",
  "private": true,
  "type": "module",
  "scripts": {
    "gen": "node scripts/gen-tax.mjs",
    "pretest": "npm run gen --silent",
    "test": "node --test"
  }
}
`;

const readme = `# Ledger

Ledger records invoices, payouts and refunds for small independent shops.

## Layout

- \`src/invoices\` creates and numbers invoices.
- \`src/money.mjs\` holds money helpers.
- \`src/storage\` persists tables as JSON files.
- \`src/payouts\` sends shop payouts.
- \`src/legacy\` contains the old reporting code.

Run \`npm test\`.
`;

const money = `// Money helpers.

export function roundHalfEven(value) {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (Math.abs(diff - 0.5) < 1e-9) return floor % 2 === 0 ? floor : floor + 1;
  return Math.round(value);
}

export const toCents = dollars => roundHalfEven(dollars * 100);

export const percentOf = (cents, percent) => roundHalfEven((cents * percent) / 100);

export function formatCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return \`\${sign}$\${Math.floor(abs / 100)}.\${String(abs % 100).padStart(2, '0')}\`;
}
`;

const jsonStore = `import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function createStore(dir) {
  mkdirSync(dir, { recursive: true });
  return { dir };
}

export function readTable(store, name) {
  const file = join(store.dir, \`\${name}.json\`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
}

export function writeTable(store, name, rows) {
  writeFileSync(join(store.dir, \`\${name}.json\`), JSON.stringify(rows, null, 2));
}
`;

const sequence = `import { readTable, writeTable } from './jsonStore.mjs';

export function next(store, kind) {
  const rows = readTable(store, 'sequences');
  const row = rows.find(r => r.kind === kind) ?? { kind, value: 0 };
  row.value += 1;
  writeTable(store, 'sequences', [...rows.filter(r => r.kind !== kind), row]);
  return row.value;
}
`;

const invoiceNumber = `import { next } from '../storage/sequence.mjs';

export const invoiceNumber = store => \`INV-\${String(next(store, 'invoice')).padStart(6, '0')}\`;
`;

const invoiceCreate = `import { readTable, writeTable } from '../storage/jsonStore.mjs';
import { invoiceNumber } from './number.mjs';
import { lineTotal } from './total.mjs';

// lines: [{ sku, qty, unitCents }]
export function createInvoice(store, { shopId, lines }) {
  if (!lines?.length) throw new Error('An invoice needs at least one line');
  const priced = lines.map(line => ({ ...line, totalCents: lineTotal(line) }));
  const invoice = {
    number: invoiceNumber(store),
    shopId,
    lines: priced,
    totalCents: priced.reduce((sum, line) => sum + line.totalCents, 0),
    createdAt: new Date().toISOString(),
  };
  writeTable(store, 'invoices', [...readTable(store, 'invoices'), invoice]);
  return invoice;
}

export const findInvoice = (store, number) => readTable(store, 'invoices').find(i => i.number === number) ?? null;
`;

const invoiceTotal = `export const lineTotal = line => line.qty * line.unitCents;
`;

const legacyReports = `// Monthly report used by the back office spreadsheet export.

export function monthlyRevenue(invoices) {
  let total = 0;
  for (const invoice of invoices) total += invoice.totalCents / 100;
  return total.toFixed(2);
}

export function discountedRevenue(invoices, pct) {
  return (Number(monthlyRevenue(invoices)) * (1 - pct / 100)).toFixed(2);
}
`;

const invoiceTest = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/storage/jsonStore.mjs';
import { createInvoice, findInvoice } from '../src/invoices/create.mjs';

test('invoices are numbered and totalled in cents', () => {
  const store = createStore(mkdtempSync(join(tmpdir(), 'ledger-')));
  const a = createInvoice(store, { shopId: 's1', lines: [{ sku: 'tea', qty: 2, unitCents: 450 }] });
  const b = createInvoice(store, { shopId: 's1', lines: [{ sku: 'cup', qty: 1, unitCents: 1299 }] });
  assert.equal(a.number, 'INV-000001'); assert.equal(b.number, 'INV-000002');
  assert.equal(a.totalCents, 900); assert.deepEqual(findInvoice(store, b.number).totalCents, 1299);
});
`;

const moneyTest = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roundHalfEven, percentOf, formatCents } from '../src/money.mjs';

test('money helpers', () => {
  assert.equal(roundHalfEven(2.5), 2); assert.equal(roundHalfEven(3.5), 4);
  assert.equal(percentOf(1000, 12.5), 125); assert.equal(formatCents(1299), '$12.99');
});
`;

const taxCsv = `region,rate
ON,0.13
BC,0.12
AB,0.05
`;

const genTax = `import { readFileSync, writeFileSync } from 'node:fs';

const rows = readFileSync(new URL('../data/tax-rates.csv', import.meta.url), 'utf8').trim().split('\\n').slice(1);
const entries = rows.map(row => row.split(',')).map(([region, rate]) => \`  \${region}: \${Number(rate)},\`);
writeFileSync(new URL('../src/generated/taxRates.mjs', import.meta.url), \`export const taxRates = {\\n\${entries.join('\\n')}\\n};\\n\`);
`;

const taxRatesGenerated = `export const taxRates = {
  ON: 0.13,
  BC: 0.12,
  AB: 0.05,
};
`;

const tax = `import { taxRates } from './generated/taxRates.mjs';

export function taxFor(region) {
  const rate = taxRates[region];
  if (rate === undefined) throw new Error(\`Unknown tax region \${region}\`);
  return rate;
}
`;

const taxTest = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taxFor } from '../src/tax.mjs';

test('known tax regions', () => {
  assert.equal(taxFor('ON'), 0.13);
  assert.throws(() => taxFor('ZZ'));
});
`;

const paylane = `// Paylane payout client. Network calls are stubbed in this repository.
export const sent = [];

export function sendPayout({ shopId, amountCents, descriptor }) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('Payout amount must be positive cents');
  const payout = { shopId, amountCents, descriptor, status: 'queued' };
  sent.push(payout);
  return payout;
}
`;

const refundModel = `// A refund returns part or all of an invoice to the customer.
// { invoiceNumber, amountCents, reason, createdAt }
export function refundRecord(invoice, amountCents, reason) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('Refund amount must be positive cents');
  return { invoiceNumber: invoice.number, amountCents, reason, createdAt: new Date().toISOString() };
}
`;

const refundCreate = `import { readTable, writeTable } from '../storage/jsonStore.mjs';
import { refundRecord } from './model.mjs';

export function createRefund(store, invoice, amountCents, reason = '') {
  const refund = refundRecord(invoice, amountCents, reason);
  writeTable(store, 'refunds', [...readTable(store, 'refunds'), refund]);
  return refund;
}

export const refundsFor = (store, invoiceNumber) => readTable(store, 'refunds').filter(r => r.invoiceNumber === invoiceNumber);
`;

const refundRoute = `import { findInvoice } from '../invoices/create.mjs';
import { createRefund } from './create.mjs';

// POST /invoices/:number/refunds  { amountCents, reason }
export function handleRefund(store, params, body) {
  const invoice = findInvoice(store, params.number);
  if (!invoice) return { status: 404, body: { error: 'Invoice not found' } };
  try {
    return { status: 201, body: createRefund(store, invoice, body.amountCents, body.reason) };
  } catch (error) {
    return { status: 400, body: { error: error.message } };
  }
}
`;

const refundTest = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/storage/jsonStore.mjs';
import { createInvoice } from '../src/invoices/create.mjs';
import { handleRefund } from '../src/refunds/route.mjs';

test('a refund is recorded against an invoice', () => {
  const store = createStore(mkdtempSync(join(tmpdir(), 'ledger-')));
  const invoice = createInvoice(store, { shopId: 's1', lines: [{ sku: 'tea', qty: 2, unitCents: 450 }] });
  const response = handleRefund(store, { number: invoice.number }, { amountCents: 300, reason: 'damaged' });
  assert.equal(response.status, 201); assert.equal(response.body.amountCents, 300);
  assert.equal(handleRefund(store, { number: 'INV-999999' }, { amountCents: 1 }).status, 404);
});
`;

const sqliteSpike = `import { DatabaseSync } from 'node:sqlite';

// Spike: one SQLite file instead of JSON tables.
export function openDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE IF NOT EXISTS rows(tbl TEXT NOT NULL, body TEXT NOT NULL)');
  return db;
}

export const readRows = (db, tbl) => db.prepare('SELECT body FROM rows WHERE tbl=?').all(tbl).map(r => JSON.parse(r.body));
export const insertRow = (db, tbl, row) => db.prepare('INSERT INTO rows(tbl, body) VALUES(?, ?)').run(tbl, JSON.stringify(row));
`;

// Refactor on main after the knowledge was recorded.
const repo = `import { mkdirSync, readFileSync, writeFileSync, existsSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

// All application data goes through the repo. Writes take a lock file so two
// processes cannot interleave read-modify-write cycles on the same table.
export function createRepo(dir) {
  mkdirSync(dir, { recursive: true });
  return { dir };
}

export function all(repo, table) {
  const file = join(repo.dir, \`\${table}.json\`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
}

export function update(repo, table, change) {
  const lock = join(repo.dir, \`\${table}.lock\`);
  const fd = openSync(lock, 'wx');
  try {
    const rows = change(all(repo, table));
    writeFileSync(join(repo.dir, \`\${table}.json\`), JSON.stringify(rows, null, 2));
    return rows;
  } finally { closeSync(fd); unlinkSync(lock); }
}

export const insert = (repo, table, row) => { update(repo, table, rows => [...rows, row]); return row; };
`;

const jsonStoreDeprecated = `import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Legacy table access kept for scripts/import-2023.mjs only. No write lock.

export function createStore(dir) {
  mkdirSync(dir, { recursive: true });
  return { dir };
}

export function readTable(store, name) {
  const file = join(store.dir, \`\${name}.json\`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
}

export function writeTable(store, name, rows) {
  writeFileSync(join(store.dir, \`\${name}.json\`), JSON.stringify(rows, null, 2));
}
`;

const importScript = `import { createStore, readTable } from '../src/storage/jsonStore.mjs';

// One-off import of the 2023 spreadsheet export.
const store = createStore(process.argv[2] ?? 'data/2023');
console.log(readTable(store, 'invoices').length, 'legacy invoices');
`;

const sequenceRepo = `import { update } from './repo.mjs';

export function next(repo, kind) {
  let value;
  update(repo, 'sequences', rows => {
    const row = rows.find(r => r.kind === kind) ?? { kind, value: 0 };
    value = row.value + 1;
    return [...rows.filter(r => r.kind !== kind), { kind, value }];
  });
  return value;
}
`;

const invoiceCreateRepo = `import { all, insert } from '../storage/repo.mjs';
import { invoiceNumber } from './number.mjs';
import { lineTotal } from './total.mjs';

// lines: [{ sku, qty, unitCents }]
export function createInvoice(repo, { shopId, lines }) {
  if (!lines?.length) throw new Error('An invoice needs at least one line');
  const priced = lines.map(line => ({ ...line, totalCents: lineTotal(line) }));
  return insert(repo, 'invoices', {
    number: invoiceNumber(repo),
    shopId,
    lines: priced,
    totalCents: priced.reduce((sum, line) => sum + line.totalCents, 0),
    createdAt: new Date().toISOString(),
  });
}

export const findInvoice = (repo, number) => all(repo, 'invoices').find(i => i.number === number) ?? null;
`;

const invoiceTestRepo = invoiceTest.replace("import { createStore } from '../src/storage/jsonStore.mjs';", "import { createRepo } from '../src/storage/repo.mjs';").replace('createStore(mkdtempSync', 'createRepo(mkdtempSync');

const readmeRepo = readme.replace('- `src/storage` persists tables as JSON files.', '- `src/storage` persists tables as JSON files through `repo.mjs`.');

export const steps = {
  base: [
    { message: 'Initial ledger with invoices, money helpers and JSON storage', files: {
      'package.json': packageJson, 'README.md': readme, 'src/money.mjs': money, 'src/storage/jsonStore.mjs': jsonStore,
      'src/storage/sequence.mjs': sequence, 'src/invoices/number.mjs': invoiceNumber, 'src/invoices/create.mjs': invoiceCreate,
      'src/invoices/total.mjs': invoiceTotal, 'src/legacy/reports.mjs': legacyReports, 'test/invoices.test.mjs': invoiceTest, 'test/money.test.mjs': moneyTest,
    } },
    { message: 'Add regional tax rates', files: {
      'data/tax-rates.csv': taxCsv, 'scripts/gen-tax.mjs': genTax, 'src/generated/taxRates.mjs': taxRatesGenerated, 'src/tax.mjs': tax, 'test/tax.test.mjs': taxTest,
    } },
    { message: 'Add Paylane payout client', files: { 'src/payouts/paylane.mjs': paylane } },
  ],
  refunds: [
    { message: 'Add refund model', files: { 'src/refunds/model.mjs': refundModel } },
    { message: 'Record refunds against invoices', files: { 'src/refunds/create.mjs': refundCreate } },
    { message: 'Add refund route and test', files: { 'src/refunds/route.mjs': refundRoute, 'test/refunds.test.mjs': refundTest } },
  ],
  sqlite: [
    { message: 'Spike SQLite storage', files: { 'src/storage/sqlite.mjs': sqliteSpike } },
  ],
  refactor: [
    { message: 'Move storage to a locked repo module', files: {
      'src/storage/repo.mjs': repo, 'src/storage/jsonStore.mjs': jsonStoreDeprecated, 'scripts/import-2023.mjs': importScript,
      'src/storage/sequence.mjs': sequenceRepo, 'src/invoices/create.mjs': invoiceCreateRepo, 'test/invoices.test.mjs': invoiceTestRepo, 'README.md': readmeRepo,
    } },
  ],
};
