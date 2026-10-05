import { createHash } from 'node:crypto';
import { normalizedStatement } from './retrieval.mjs';
import { refuseCredentials } from './validation.mjs';

// Deterministic knowledge proposals from evidence Journal itself recorded.
// No model calls. Every proposal goes to the inbox; accepting one creates a
// candidate that still needs approval. Fingerprints make generation
// idempotent, and dismissed proposals are never proposed again.

export const fingerprint = (...parts) => createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
const RULE_LINE = /^\s*(rule|remember|decision|constraint|convention|lesson)\s*:\s*(.+?)\s*$/gim;
const CATEGORY = { rule: 'constraint', remember: 'lesson', decision: 'decision', constraint: 'constraint', convention: 'convention', lesson: 'lesson' };
// Generic advice that is not project knowledge, even when stated as a rule.
const GENERIC = /^(?:(?:always|never|please)\s+)?(?:write|use|follow|keep)\s+(?:clean|good|best|readable|simple|proper|consistent)\b|^(?:test|document|comment)\s+(?:your|the)\s+code\b|^be\s+(?:careful|concise|helpful)\b/i;

const safe = text => { try { refuseCredentials(text); return true; } catch { return false; } };

export function ruleProposals(session, receipt) {
  const out = [];
  for (const match of (receipt?.query ?? '').matchAll(RULE_LINE)) {
    const statement = match[2];
    if (statement.split(/\s+/).length < 4 || statement.length > 400 || GENERIC.test(statement) || !safe(statement)) continue;
    out.push({ kind: 'rule', category: CATEGORY[match[1].toLowerCase()], statement, scope: 'checkout',
      source: { kind: 'user', note: `Stated as "${match[1]}:" in the task of a ${session.provider} session on ${session.createdAt.slice(0, 10)}.` },
      fingerprint: fingerprint('rule', session.projectId, normalizedStatement(statement)), evidence: { sessionId: session.id } });
  }
  return out;
}

// A test command that exited 0 is evidence of how tests run here; one
// proposal per distinct command, never for failures or unknown exits.
export function testCommandProposals(session, events) {
  const starts = new Map(events.filter(e => e.kind === 'command-start' && e.body.test).map(e => [e.body.toolUseId, e]));
  const seen = new Set(); const out = [];
  for (const end of events.filter(e => e.kind === 'command-end' && e.body.status === 'succeeded')) {
    const start = starts.get(end.body.toolUseId); if (!start) continue;
    const command = String(start.body.command ?? '').trim();
    if (!command || command.length > 120 || command.includes('[redacted]') || command.includes('\n') || seen.has(command) || !safe(command)) continue;
    seen.add(command);
    out.push({ kind: 'test-command', category: 'convention', scope: session.branch ? 'branch' : 'checkout',
      statement: `Tests run with \`${command}\` (exit 0 observed in a ${session.provider} session on ${end.at.slice(0, 10)}).`,
      source: { kind: 'user', note: `Observed command exit status from ${{ claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' }[session.provider] ?? 'agent'} hooks in session ${session.id}.` },
      fingerprint: fingerprint('test-command', session.projectId, command), evidence: { sessionId: session.id, eventId: end.id ?? null } });
  }
  return out;
}

// After a session that moved the branch, suggest reviewing its status.
export function statusProposal(session, project, drift, hasUpdate) {
  if (!project.branch || project.branch !== session.branch || !session.head || session.head === project.head) return [];
  if (hasUpdate && !drift) return [];
  return [{ kind: 'branch-status', category: 'brief', scope: 'branch', statement: `Branch ${project.branch} has ${drift ? `${drift} commit${drift === 1 ? '' : 's'} since its last update` : 'no reviewed status update'}. Propose a branch update to record progress.`,
    source: null, fingerprint: fingerprint('branch-status', session.projectId, project.branch, project.head), evidence: { sessionId: session.id, head: project.head } }];
}
