import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { PROVIDERS } from './agents.mjs';
import { evidenceRoot, readEvidenceFile } from './evidence.mjs';
import { noteChange } from './hunks.mjs';

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
const handledAt = proposal => typeof proposal.handledAt === 'string' && proposal.handledAt ? proposal.handledAt : null;
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;

// Suggestions purged before Phase 5 kept neither field: read them from the wording proposals.mjs wrote.
function purgedSession(proposal) {
  const evidence = proposal.evidence ?? {};
  const parsed = proposal.kind === 'rule' ? /in the task of a (\w+) session on (\d{4}-\d{2}-\d{2})/.exec(proposal.source?.note ?? '')
    : /observed in a (\w+) session on (\d{4}-\d{2}-\d{2})/.exec(proposal.statement ?? '');
  const provider = knownProvider(evidence.provider) ?? knownProvider(parsed?.[1]);
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
    // The earliest handled suggestion wins; one without a handled time never displaces another.
    const prior = linked.get(proposal.memoryId); const at = handledAt(proposal);
    if (!prior || (at && (!handledAt(prior) || at < handledAt(prior)))) linked.set(proposal.memoryId, proposal);
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
      WHEN json_extract(s.body,'$.nativeId') IS NOT NULL THEN coalesce(json_extract(s.body,'$.provider'),'')||':'||json_extract(s.body,'$.nativeId')
      WHEN d.native_id IS NOT NULL THEN coalesce(d.provider,'')||':'||d.native_id
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

// ----- Phase 6: the session wrap-up -----

const RESUME_HOPS = 20; const MAX_STALE = 20; const MAX_CHANGED = 400;

// The session and the earlier sessions of the same conversation, newest first,
// following resumedFrom up to 20 hops and stopping at a missing (purged) row.
export function resumeChain(store, session) {
  const ids = [session.id]; let current = session;
  const get = store.db.prepare('SELECT body FROM sessions WHERE id=?');
  for (let hop = 0; hop < RESUME_HOPS && typeof current.resumedFrom === 'string' && current.resumedFrom; hop++) {
    const row = get.get(current.resumedFrom); if (!row) break;
    current = JSON.parse(row.body); if (ids.includes(current.id)) break;
    ids.push(current.id);
  }
  return ids;
}

// The json_extract expression must match proposals_session exactly; unary + keeps
// the planner off the (project_id, fingerprint) index.
const SESSION_PROPOSALS = `FROM proposals WHERE +project_id=? AND json_extract(body,'$.state')=? AND json_extract(body,'$.evidence.sessionId') IN (SELECT value FROM json_each(?))`;

// Suggestions of a session and its resume chain. earlier: made by an earlier session of
// the conversation (fingerprints are unique per project, so it is never made again).
export function sessionProposals(store, session, state) {
  const chain = resumeChain(store, session);
  return store.db.prepare(`SELECT body ${SESSION_PROPOSALS} ORDER BY rowid DESC LIMIT 100`).all(session.projectId, state, JSON.stringify(chain))
    .map(row => JSON.parse(row.body)).map(proposal => ({ ...proposal, earlier: proposal.evidence?.sessionId !== session.id }));
}

// What happened in a session, from stored data only: no Git, no hashing.
export function sessionSummary(store, id) {
  const session = store.getSession(id);
  const durationMs = session.endedAt && session.createdAt ? Date.parse(session.endedAt) - Date.parse(session.createdAt) : null;
  let tests = null;
  if (session.provider === 'claude') {
    const events = store.listEvents(id, 2000);
    const ends = new Map(events.filter(event => event.kind === 'command-end').map(event => [event.body.toolUseId, event.body.status]));
    tests = { passed: 0, failed: 0, unknown: 0, commands: [] };
    for (const start of events.filter(event => event.kind === 'command-start' && event.body.test === true)) {
      const status = ends.get(start.body.toolUseId);
      if (status === 'succeeded') tests.passed++; else if (status === 'failed') tests.failed++; else tests.unknown++;
      const command = String(start.body.command ?? '').slice(0, 60);
      if (command && tests.commands.length < 3 && !tests.commands.includes(command)) tests.commands.push(command);
    }
  }
  const suggestions = store.db.prepare(`SELECT count(*) AS n ${SESSION_PROPOSALS}`).get(session.projectId, 'open', JSON.stringify(resumeChain(store, session))).n;
  return { status: session.status, exitCode: Number.isInteger(session.exitCode) ? session.exitCode : null, signal: session.signal ?? null,
    durationMs: Number.isFinite(durationMs) ? durationMs : null, changes: session.changeStats ?? null, tests,
    identity: { nativeId: session.nativeId ?? null, confirmed: !!session.nativeIdConfirmed, source: session.nativeIdSource ?? null, mismatch: !!session.identityMismatch },
    suggestions };
}

// The end snapshot's changed set (D11), or live changes when no snapshot was taken.
// Files already changed when the session started are left out.
function changedPaths(store, session) {
  if (session.changeStats) return session.changeStats.available ? session.changeStats.paths ?? [] : null;
  const live = store.sessionChanges(session.id);
  return live.available ? live.files.filter(file => !file.preexisting).map(({ path, from }) => ({ path, from: from ?? null })) : null;
}

// The current file's lines on screen: the new side of the hunks, or the "Now" block.
function shownRange({ hunks, after }) {
  if (hunks) {
    const numbers = hunks.flatMap(hunk => hunk.lines.map(line => line.new)).filter(Number.isInteger);
    return numbers.length ? { startLine: Math.min(...numbers), endLine: Math.max(...numbers) } : null;
  }
  return after?.lines.length ? { startLine: after.startLine, endLine: after.startLine + after.lines.length - 1 } : null;
}

// Remembered notes on files the session changed that are now out of date, with
// what changed under their cited lines. At most 20 notes, one Git diff each.
export function staleNotesForSession(store, sessionId) {
  const session = store.getSession(sessionId);
  const unavailable = { available: false, notes: [], truncated: false };
  const changed = changedPaths(store, session); if (!changed) return unavailable;
  const workspaceId = session.workspaceId ?? null; const folderId = typeof workspaceId === 'string' && workspaceId.startsWith('root:') ? workspaceId.slice(5) : null;
  let view; try { view = store.view(session.projectId, folderId ? null : workspaceId); } catch { return unavailable; }
  // A folder session's paths are relative to its Git root; notes cite paths relative to the folder.
  let prefix = '';
  if (folderId) {
    const root = (view.roots ?? []).find(entry => entry.id === folderId); if (!root) return unavailable;
    const rel = root.kind === 'git' ? relative(root.gitRoot ?? root.path, root.path).split(sep).join('/') : '';
    prefix = rel ? `${rel}/` : '';
  }
  const local = path => typeof path === 'string' && path.startsWith(prefix) ? path.slice(prefix.length) : null;
  const byPath = new Map();
  for (const entry of changed.slice(0, MAX_CHANGED)) {
    const path = local(entry.path); if (!path) continue;
    if (!byPath.has(path)) byPath.set(path, { renamedTo: null });
    const from = local(entry.from); if (from) byPath.set(from, { renamedTo: path });
  }
  if (!byPath.size) return { available: true, notes: [], truncated: false };
  const rows = store.db.prepare(`SELECT r.body, m.status, m.pinned FROM memories m JOIN revisions r ON r.id=m.current_revision
    WHERE m.project_id=? AND m.status='active' AND json_extract(r.body,'$.source.kind')='file'
    AND json_extract(r.body,'$.source.path') IN (SELECT value FROM json_each(?))
    AND coalesce(json_extract(r.body,'$.source.rootId'),'') = ?
    AND (json_extract(r.body,'$.scope')='checkout' OR json_extract(r.body,'$.branch') IS ?)
    ORDER BY r.rowid DESC LIMIT 500`).all(session.projectId, JSON.stringify([...byPath.keys()]), folderId ?? '', view.branch ?? null);
  const cache = new Map(); const notes = []; let truncated = false;
  const inWorktree = !!workspaceId && !folderId;
  for (const row of rows) {
    const note = { ...JSON.parse(row.body), status: row.status, pinned: !!row.pinned };
    if (store.validation(view, note, cache) !== 'stale') continue;
    if (notes.length === MAX_STALE) { truncated = true; break; }
    const { path } = note.source; const { renamedTo } = byPath.get(path);
    const root = evidenceRoot(view, note.source.rootId ?? null);
    // contentHash: the file as shown here; "Still true" saves evidence only while the file still has it.
    let current = null; let contentHash = null;
    if (root && existsSync(join(root.path, ...path.split('/')))) { try { ({ content: current, contentHash } = readEvidenceFile(root.path, path, { tracked: root.git })); } catch { current = null; contentHash = null; } }
    const missing = !root || !existsSync(join(root.path, ...path.split('/')));
    const change = renamedTo || missing ? { hunks: null, before: { startLine: note.source.startLine, lines: String(note.source.excerpt ?? '').split(/\r?\n/) }, after: null, suggestedRange: null, truncated: false }
      : noteChange({ root: root.path, git: root.git }, note.source, current);
    const reaffirm = missing ? { allowed: false, reason: 'file-missing' } : note.scope === 'checkout' && inWorktree ? { allowed: false, reason: 'separate-copy' } : { allowed: true, reason: null };
    notes.push({ note: { ...note, validation: 'stale' }, path, renamedTo, ...change, shownRange: shownRange(change), contentHash: missing ? null : contentHash,
      reaffirm, workspaceId: note.scope === 'branch' && inWorktree ? workspaceId : null });
  }
  return { available: true, notes, truncated };
}
