import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, renameSync, rmSync, statfsSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { isDuplicate } from './retrieval.mjs';
import { survivorScanPending } from './sessions.mjs';
import { redact, refuseCredentials, relativePath, text } from './validation.mjs';

// Backups, storage accounting, Brain export/import, retention and purge.
// Exports carry approved knowledge (unreviewed candidates only on request):
// no sessions, terminal output, commands or receipts, and every text field is
// redacted again on the way out.

export const BRAIN_FORMAT = 'journal-brain'; export const BRAIN_VERSION = 1;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const CATEGORIES = ['brief', 'decision', 'constraint', 'convention', 'lesson', 'issue'];
const checksum = memories => createHash('sha256').update(JSON.stringify(memories)).digest('hex');
const size = path => { try { return statSync(path).size; } catch { return 0; } };

// Online backup through SQLite's backup API, written beside the target and
// renamed only after an integrity check passes.
export async function backupTo(db, destination) {
  destination = text(destination, 'backup path', 4096);
  if (!isAbsolute(destination)) throw new Error('Backup path must be absolute');
  const temporary = `${destination}.partial-${randomUUID().slice(0, 8)}`;
  try {
    // One step: a stepped backup restarts whenever the runtime writes. Node 24
    // (Electron's) requires a positive page count, so pass the int32 maximum.
    await sqliteBackup(db, temporary, { rate: 2147483647 });
    const copy = new DatabaseSync(temporary, { readOnly: true });
    let integrity; try { integrity = copy.prepare('PRAGMA integrity_check').get().integrity_check; } finally { copy.close(); }
    if (integrity !== 'ok') throw new Error(`Backup failed its integrity check: ${integrity}`);
    renameSync(temporary, destination);
    return { path: destination, bytes: size(destination), integrity };
  } catch (error) { rmSync(temporary, { force: true }); throw error; }
}

export function storageInfo(db, path) {
  const count = table => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  const info = { database: size(path), wal: size(`${path}-wal`), tables: Object.fromEntries(['memories', 'revisions', 'receipts', 'sessions', 'events', 'proposals', 'workspaces', 'audit'].map(t => [t, count(t)])) };
  try { const fs = statfsSync(dirname(path)); info.freeBytes = fs.bavail * fs.bsize; info.lowDisk = info.freeBytes < 200 * 1024 * 1024; } catch { info.freeBytes = null; info.lowDisk = null; }
  return info;
}

function exportSource(source, roots = []) {
  const folder = source.rootId ? roots.find(root => root.id === source.rootId) : null;
  // Folder name only: exports are shareable and must not carry local absolute paths.
  const base = { kind: source.kind, ...(source.rootId ? { folder: { name: folder?.name ?? '(removed folder)' } } : {}) };
  if (source.kind === 'file') return { ...base, path: source.path, startLine: source.startLine, endLine: source.endLine, commit: source.commit ?? null, contentHash: source.contentHash, excerpt: redact(source.excerpt ?? '', 4000) };
  if (source.kind === 'git') return { ...base, base: source.base ?? null, head: source.head };
  return { ...base, note: redact(source.note ?? '', 2000) };
}

export function exportBrain(store, projectId, { includeUnreviewed = false } = {}) {
  const project = store.project(projectId);
  // Approved claims by default; unreviewed candidates only when asked for, and labelled.
  const statuses = includeUnreviewed ? "('active','candidate')" : "('active')";
  const rows = store.db.prepare(`SELECT m.id, m.status, m.pinned FROM memories m WHERE m.project_id=? AND m.status IN ${statuses} ORDER BY m.rowid`).all(projectId);
  const memories = rows.map(row => ({
    id: row.id, status: row.status, pinned: !!row.pinned,
    revisions: store.memoryHistory(row.id).reverse().map(r => ({ revision: r.revision, statement: redact(r.statement, 2000), category: r.category, scope: r.scope, branch: r.branch ?? null,
      area: r.area ?? '', environment: r.environment ? redact(r.environment, 200) : undefined, source: exportSource(r.source, project.roots), createdAt: r.createdAt })),
  }));
  const document = { format: BRAIN_FORMAT, version: BRAIN_VERSION, exportedAt: new Date().toISOString(), project: { name: project.name }, memories, checksum: checksum(memories) };
  return { json: document, markdown: brainMarkdown(document) };
}

export function brainMarkdown(document) {
  const lines = [`# Journal knowledge: ${document.project.name}`, '', `Exported ${document.exportedAt}. Format ${document.format} v${document.version}. Approved claims${document.memories.some(m => m.status === 'candidate') ? ' and unreviewed candidates (marked)' : ' only'}; no sessions or terminal output.`, ''];
  for (const status of ['active', 'candidate']) {
    const group = document.memories.filter(m => m.status === status); if (!group.length) continue;
    lines.push(`## ${status === 'active' ? 'Approved' : 'Unreviewed candidates (not approved)'}`, '');
    for (const memory of group) {
      const r = memory.revisions.at(-1);
      lines.push(`- **${r.category}** (${r.scope === 'branch' ? `branch ${r.branch}` : 'all branches'}${r.area ? `, ${r.area}` : ''}${memory.pinned ? ', pinned' : ''}, r${r.revision}): ${r.statement.replace(/\n/g, ' ')}`);
      if (r.environment) lines.push(`  - Applies when: ${r.environment}`);
      lines.push(`  - Evidence: ${r.source.kind === 'file' ? `${r.source.folder ? `${r.source.folder.name}/` : ''}${r.source.path}:${r.source.startLine}` : r.source.kind === 'git' ? `Git ${r.source.head?.slice(0, 7)}` : r.source.note}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// Imported claims arrive as candidates with an "imported" source: never
// trusted, never matched to a repository automatically, always reviewed.
export function importBrain(store, projectId, raw) {
  const project = store.project(projectId);
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_IMPORT_BYTES) throw new Error('Import file is missing or larger than 5 MiB');
  let document; try { document = JSON.parse(raw); } catch { throw new Error('Import file is not valid JSON'); }
  if (document?.format !== BRAIN_FORMAT || document.version !== BRAIN_VERSION || !Array.isArray(document.memories)) throw new Error('Not a Journal project memory export (format journal-brain, version 1)');
  if (document.memories.length > 5000) throw new Error('Too many notes in one import');
  if (document.checksum !== checksum(document.memories)) throw new Error('Checksum mismatch: the export was modified or damaged');
  const origin = text(String(document.project?.name ?? 'unknown project'), 'project name', 200);
  const existing = store.db.prepare(`SELECT r.body FROM memories m JOIN revisions r ON r.id=m.current_revision WHERE m.project_id=? AND m.status IN ('active','candidate')`).all(projectId).map(row => JSON.parse(row.body).statement);
  const imported = []; const skipped = [];
  for (const [index, memory] of document.memories.entries()) {
    const latest = Array.isArray(memory?.revisions) ? memory.revisions.at(-1) : null;
    try {
      if (!latest || memory.status === 'archived') { skipped.push({ index, reason: 'withdrawn or empty' }); continue; }
      const statement = text(latest.statement, 'statement'); refuseCredentials(statement);
      if (!CATEGORIES.includes(latest.category) || !['checkout', 'branch'].includes(latest.scope)) throw new Error('invalid category or scope');
      const area = relativePath(latest.area ?? '', true);
      if (existing.some(other => isDuplicate(other, statement))) { skipped.push({ index, reason: 'duplicate' }); continue; }
      const original = latest.source?.kind === 'file' ? `${latest.source.folder ? `folder ${String(latest.source.folder.name)}: ` : ''}${latest.source.path}:${latest.source.startLine}` : latest.source?.kind === 'git' ? `Git ${String(latest.source.head ?? '').slice(0, 7)}` : String(latest.source?.note ?? '');
      // Branch claims become checkout candidates unless that branch is current; the reviewer decides.
      const scope = latest.scope === 'branch' && latest.branch !== project.branch ? 'checkout' : latest.scope;
      const created = store.proposeMemory(projectId, { statement, category: latest.category, scope, area: latest.category === 'brief' ? '' : area,
        environment: latest.environment ?? '', source: { kind: 'import', note: `Imported from "${origin}" (${document.exportedAt ?? 'unknown date'}); original evidence: ${original}`.slice(0, 2000) } });
      existing.push(statement); imported.push(created.id);
    } catch (error) { skipped.push({ index, reason: error.message.slice(0, 120) }); }
  }
  store.audit('brain-imported', { projectId, origin, imported: imported.length, skipped: skipped.length });
  return { imported: imported.length, skipped };
}

// Explicit purge of one ended session: its timeline, receipts and metadata.
export function purgeSession(store, sessionId) {
  const session = store.getSession(sessionId);
  if (['starting', 'running', 'waiting', 'stopping', 'orphaned'].includes(session.status)) throw new Error('Stop the session before purging it');
  // Purging must not erase the only record of processes the agent left behind.
  if (session.survivors?.length) throw new Error('End or keep the leftover child processes first; purging would hide them');
  if (survivorScanPending(session)) throw new Error('Journal is still checking for leftover child processes; try again in a moment');
  // Resume compares against the latest delivery in the same native
  // conversation; deleting one of several rows would hide what was delivered.
  if (session.nativeId && store.db.prepare(`SELECT 1 FROM sessions WHERE id<>? AND json_extract(body,'$.provider')=? AND json_extract(body,'$.nativeId')=?`).get(sessionId, session.provider, session.nativeId)) throw new Error('Other sessions continue this native conversation; purge cannot remove one of them without breaking resume history');
  store.transaction(() => {
    store.db.prepare('DELETE FROM events WHERE session_id=?').run(sessionId);
    store.db.prepare(`DELETE FROM receipts WHERE id=? OR json_extract(body,'$.sessionId')=?`).run(session.receiptId, sessionId);
    // Suggestions outlive their session: open ones stay acceptable, handled ones keep their state and note link.
    // Record why no session is linked and drop what pointed at the purge ("session <id>" or the bare id in a note,
    // the deleted event). Absent notes stay absent.
    store.db.prepare(`UPDATE proposals SET body=json_set(
        CASE WHEN json_extract(body,'$.source.note') IS NOT NULL THEN json_set(body,'$.source.note',replace(replace(json_extract(body,'$.source.note'),'session '||?1,'a purged session'),?1,'a purged session')) ELSE body END,
        '$.evidence.sessionId',NULL,'$.evidence.eventId',NULL,'$.evidence.sessionPurged',json('true'))
      WHERE json_extract(body,'$.evidence.sessionId')=?1`).run(sessionId);
    store.db.prepare('DELETE FROM sessions WHERE id=?').run(sessionId);
    store.audit('session-purged', { sessionId });
  });
  return { purged: sessionId };
}

// Trace retention: timelines of sessions that ended long ago are dropped;
// session rows, receipts and all knowledge are kept.
export function applyRetention(store, { eventDays = 90 } = {}) {
  const cutoff = new Date(Date.now() - eventDays * 86400_000).toISOString();
  const { changes } = store.db.prepare(`DELETE FROM events WHERE session_id IN (SELECT id FROM sessions WHERE json_extract(body,'$.endedAt') IS NOT NULL AND json_extract(body,'$.endedAt') < ?)`).run(cutoff);
  if (changes) store.audit('retention-applied', { eventDays, eventsDeleted: changes });
  return { eventsDeleted: changes };
}

export function checkpoint(db) { return db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get(); }
export const backupExists = path => existsSync(path);
