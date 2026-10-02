// Round 1 (October 2026) in the reusable suite format. The original frozen
// harness remains scripts/usefulness-trial.mjs; this port shares its
// repository, knowledge, tasks and graders. In this format the AGENTS.md and
// memory overview is the README purpose plus constraints rather than the
// Journal Git draft, so results are comparable to round 1, not identical.
import { steps } from '../../fixtures/usefulness/ledger.mjs';
import { claims, overviewConstraints, refundsCurrent, refundsNext, sqliteDecision } from '../../fixtures/usefulness/knowledge.mjs';
import { tasks } from '../../fixtures/usefulness/tasks.mjs';

const differentiating = new Set(['tax-region', 'continue-refunds', 'customer-notes']);
const strip = (text, prefix) => text.replace(new RegExp(`^${prefix}:\\s*`), '');

export default {
  name: 'ledger-round1',
  description: 'Synthetic ledger repository: six tasks, rules mostly derivable from code. Round 1 was inconclusive (all conditions passed).',
  repository: { kind: 'generated' },
  overviewPurpose: 'Purpose: Ledger records invoices, payouts and refunds for small independent shops.',
  timeline: [
    ...steps.base.map(commit => ({ commit })), { knowledge: 'main' },
    { branch: 'feature/refunds' }, ...steps.refunds.map(commit => ({ commit })), { knowledge: 'refunds' },
    { switch: 'main' }, { branch: 'experiment/sqlite' }, ...steps.sqlite.map(commit => ({ commit })), { knowledge: 'sqlite' },
    { switch: 'main' }, ...steps.refactor.map(commit => ({ commit })),
  ],
  knowledge: [
    { kind: 'overview', at: 'main', constraints: strip(overviewConstraints, 'Constraints') },
    ...claims.map(claim => ({ kind: 'claim', at: 'main', ...claim })),
    { kind: 'status', at: 'refunds', current: strip(refundsCurrent, 'Current work'), next: strip(refundsNext, 'Next') },
    { kind: 'claim', at: 'sqlite', ...sqliteDecision },
  ],
  tasks: tasks.map(task => ({ ...task, differentiating: differentiating.has(task.id) })),
  criteria: { minReps: 5 },
};
