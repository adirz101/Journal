// The same reviewed project knowledge, delivered differently per condition:
// AGENTS.md text, native Claude memory seeded through a "remember this"
// session, or Journal claims with evidence. Frozen before any trial run.

export const overviewConstraints = 'Constraints: Node built-ins only, no runtime dependencies. Run npm test before finishing.';

export const claims = [
  {
    id: 'money-cents', category: 'decision', scope: 'checkout',
    statement: 'Money is always integer cents. New code must use the helpers in src/money.mjs (percentOf, roundHalfEven, toCents); accounting requires half-even rounding. src/legacy/reports.mjs uses floating-point dollars and is kept only for the spreadsheet export; never copy its patterns.',
    source: { kind: 'user', note: 'Accounting requirement agreed with the bookkeeper.' },
  },
  {
    id: 'document-numbers', category: 'lesson', scope: 'checkout',
    statement: 'Document numbers (invoices, credit notes, any future document) must come from next(store, kind) in src/storage/sequence.mjs, with one kind per document type. In incident #12, numbers derived from Date.now() collided when two workers ran at once and produced duplicate invoice numbers.',
    source: { kind: 'user', note: 'Incident #12 postmortem.' },
  },
  {
    id: 'paylane-descriptor', category: 'constraint', scope: 'checkout',
    statement: 'Paylane rejects payout descriptors longer than 22 characters or containing non-ASCII characters, and the payout then fails a day later without an error at send time. Descriptors must be ASCII-only and at most 22 characters; keep the invoice number when it fits.',
    source: { kind: 'user', note: 'Paylane merchant integration guide, section 4.2.' },
  },
  {
    id: 'generated-tax', category: 'lesson', scope: 'checkout',
    statement: 'src/generated/taxRates.mjs is generated from data/tax-rates.csv by npm run gen, and npm test regenerates it first. Change tax rates in the CSV, never in the generated file; direct edits are silently overwritten.',
    source: { kind: 'file', path: 'package.json', startLine: 7, endLine: 7 },
  },
  {
    // Becomes false after the storage refactor on main. Nobody updates it.
    id: 'json-storage', category: 'convention', scope: 'checkout',
    statement: 'Persist data with readTable/writeTable from src/storage/jsonStore.mjs; every table is a JSON file in the store directory.',
    source: { kind: 'file', path: 'src/storage/jsonStore.mjs', startLine: 9, endLine: 16 },
  },
];

// Operator edits to the Git-drafted branch update on feature/refunds.
export const refundsCurrent = 'Current work: partial refunds; an invoice can receive several refunds.';
export const refundsNext = 'Next: createRefund must reject a refund when the total refunded for the invoice would exceed invoice.totalCents (throw an error; the route already maps errors to 400). Then add tests for partial and over-limit refunds.';

export const sqliteDecision = {
  id: 'sqlite-branch', category: 'decision', scope: 'branch',
  statement: 'Storage moves to SQLite through src/storage/sqlite.mjs (openDatabase, readRows, insertRow); create new tables there rather than as JSON files.',
  source: { kind: 'user', note: 'Storage spike decision on experiment/sqlite.' },
};

export function agentsMd({ overview, branchStatus, branchDecision }) {
  return [
    '# Project knowledge', '', '## Overview', overview, '', '## Decisions, constraints and lessons',
    ...claims.map(claim => `- ${claim.statement}`),
    ...(branchStatus ? ['', '## Current branch status (feature/refunds)', branchStatus] : []),
    ...(branchDecision ? ['', '## Branch decision (experiment/sqlite)', branchDecision] : []),
    '',
  ].join('\n');
}

const noEdits = 'Save it to your memory. Do not modify any repository files.';
export const memorySeeds = {
  main: overview => `Please remember the following about this project for future sessions. ${noEdits}\n\n${overview}\n\n${claims.map(claim => `- ${claim.statement}`).join('\n')}`,
  refunds: status => `Please remember the current status of this branch (feature/refunds) for future sessions. ${noEdits}\n\n${status}`,
  sqlite: () => `We are on the experiment/sqlite branch. Please remember this decision for future sessions. ${noEdits}\n\n${sqliteDecision.statement}`,
};
