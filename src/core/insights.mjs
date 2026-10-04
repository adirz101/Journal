import { PROVIDERS } from './agents.mjs';

// Read-only answers about notes: where each came from, how many conversations
// it was sent to, and which current notes need a check. Origins and counts use
// the stored project only (no Git, no hashing); memoryChecks is the one call
// that validates evidence, in bounded chunks.

const MAX_IDS = 200; const MAX_CHECKS = 50;

export function noteIds(ids) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_IDS || ids.some(id => typeof id !== 'string' || !id || id.length > 100) || new Set(ids).size !== ids.length) throw new Error('Invalid note list');
  return JSON.stringify(ids);
}

// The expression must match proposals_memory exactly. Unary + keeps the planner off the
// (project_id, fingerprint) index, which would scan every suggestion of the project.
export const ORIGIN_PROPOSALS_SQL = `SELECT body FROM proposals WHERE +project_id=? AND json_extract(body,'$.memoryId') IN (SELECT value FROM json_each(?))`;

const knownProvider = value => PROVIDERS.includes(value) ? value : null;
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;

// Suggestions purged before Phase 5 kept neither field: read them from the wording proposals.mjs wrote.
function purgedSession(proposal) {
  const evidence = proposal.evidence ?? {};
  const parsed = proposal.kind === 'rule' ? /in the task of a (\w+) session on (\d{4}-\d{2}-\d{2})/.exec(proposal.source?.note ?? '')
    : /observed in a (\w+) session on (\d{4}-\d{2}-\d{2})/.exec(proposal.statement ?? '');
  const provider = evidence.provider !== undefined ? knownProvider(evidence.provider) : knownProvider(parsed?.[1]);
  const date = day(evidence.sessionDate) ?? parsed?.[2] ?? day(proposal.createdAt);
  return { id: null, title: null, provider, date, state: 'purged' };
}

export function memoryOrigins(store, projectId, ids) {
  store.storedProject(projectId); const list = noteIds(ids);
  const notes = store.db.prepare(`SELECT m.id, m.approved_at, m.approved_revision, r.body FROM memories m JOIN revisions r ON r.memory_id=m.id AND r.number=1
    WHERE m.project_id=? AND m.id IN (SELECT value FROM json_each(?))`).all(projectId, list);
  // Session suggestions that became notes; branch updates never define an origin.
  const linked = new Map();
  for (const row of store.db.prepare(ORIGIN_PROPOSALS_SQL).all(projectId, list)) {
    const proposal = JSON.parse(row.body);
    if (!['rule', 'test-command'].includes(proposal.kind)) continue;
    const prior = linked.get(proposal.memoryId);
    if (!prior || String(proposal.handledAt ?? '') < String(prior.handledAt ?? '')) linked.set(proposal.memoryId, proposal);
  }
  const sessionIds = [...new Set([...linked.values()].map(p => p.evidence?.sessionId).filter(id => typeof id === 'string'))];
  const sessions = new Map(sessionIds.length ? store.db.prepare('SELECT id, body FROM sessions WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(sessionIds)).map(row => [row.id, JSON.parse(row.body)]) : []);
  const origins = {};
  for (const row of notes) {
    const first = JSON.parse(row.body);
    const origin = { kind: 'manual', createdAt: first.createdAt, approvedAt: row.approved_at ?? null, approvedRevision: row.approved_revision ?? null };
    const proposal = linked.get(row.id);
    if (proposal) {
      const session = proposal.evidence?.sessionId ? sessions.get(proposal.evidence.sessionId) : null;
      origin.kind = 'session';
      if (session) {
        const present = !session.removed;
        // A removed session's title stays hidden: the user removed it.
        origin.session = { id: present ? session.id : null, title: present ? session.displayName || session.title || null : null,
          provider: knownProvider(session.provider), date: day(session.createdAt), state: present ? 'present' : 'removed' };
      } else origin.session = purgedSession(proposal);
    } else if (first.promotedFrom) { origin.kind = 'promoted'; origin.promotedFrom = { branch: first.promotedFrom.branch }; }
    else if (first.source?.kind === 'git') { origin.kind = 'git'; origin.git = { base: first.source.base ?? null, head: first.source.head }; }
    else if (first.source?.kind === 'import') origin.kind = 'import';
    origins[row.id] = origin;
  }
  return origins;
}

// Distinct native conversations per note (decision D6), keyed by the session's
// current native ID: it is often learned after delivery (Codex, confirmation).
export function deliveryCounts(store, projectId, ids) {
  store.storedProject(projectId); const list = noteIds(ids);
  const foreign = new Set(store.db.prepare('SELECT id FROM memories WHERE project_id<>? AND id IN (SELECT value FROM json_each(?))').all(projectId, list).map(row => row.id));
  const counts = Object.fromEntries(ids.filter(id => !foreign.has(id)).map(id => [id, 0]));
  for (const row of store.db.prepare(`SELECT d.memory_id AS id, count(DISTINCT CASE
      WHEN json_extract(s.body,'$.nativeId') IS NOT NULL THEN json_extract(s.body,'$.provider')||':'||json_extract(s.body,'$.nativeId')
      WHEN d.native_id IS NOT NULL THEN d.provider||':'||d.native_id
      WHEN d.session_id IS NOT NULL THEN 'session:'||d.session_id
      ELSE 'receipt:'||d.receipt_id END) AS n
    FROM deliveries d LEFT JOIN sessions s ON s.id=d.session_id
    WHERE d.project_id=? AND d.memory_id IN (SELECT value FROM json_each(?)) GROUP BY d.memory_id`).all(projectId, list)) counts[row.id] = row.n;
  return counts;
}

// Current notes (remembered and waiting for review) in Memory-list order, one
// bounded chunk per call so other storage requests interleave.
export function memoryChecks(store, projectId, { offset = 0, limit = MAX_CHECKS } = {}) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > MAX_CHECKS) throw new Error('Invalid page');
  const project = store.project(projectId); const cache = new Map();
  const where = `m.project_id=? AND m.status IN ('active','candidate')`;
  const total = store.db.prepare(`SELECT count(*) AS n FROM memories m WHERE ${where}`).get(projectId).n;
  const rows = store.db.prepare(`SELECT r.body FROM memories m JOIN revisions r ON r.id=m.current_revision WHERE ${where} ORDER BY m.pinned DESC, r.rowid DESC LIMIT ? OFFSET ?`).all(projectId, limit, offset);
  const stale = rows.map(row => JSON.parse(row.body)).filter(note => store.validation(project, note, cache) === 'stale').map(note => note.id);
  return { offset, checked: rows.length, total, stale };
}
