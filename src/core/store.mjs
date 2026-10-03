import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { inspectProject } from './project.mjs';
import { captureEvidence, validateEvidence } from './evidence.mjs';
import { choice, relativePath, refuseCredentials, text } from './validation.mjs';
import { branchDraft, commitsSince, overviewDraft, PLACEHOLDER } from './status.mjs';
import { aliasesFor, areaMatches, isDuplicate, possibleConflict, queryTerms } from './retrieval.mjs';
import { checkoutBaseline, fileDiff, openableFile, sessionChanges } from './changes.mjs';
import { classifyFolder, folderStatus } from './projects.mjs';
import { SESSION_USER_FIELDS, survivorScanPending } from './sessions.mjs';
import { basename, relative, sep } from 'node:path';
import { applyRetention, backupTo, checkpoint, exportBrain, importBrain, purgeSession, storageInfo } from './maintenance.mjs';
import { ruleProposals, statusProposal, testCommandProposals } from './proposals.mjs';
import { addWorktree, creationNotices, listGitWorktrees, plannedPath, registered, removalBlockers, removeWorktree, resolveBase, validateBranchName, workspaceView } from './workspaces.mjs';
import { redact } from './validation.mjs';

const LIVE = "('starting','running','waiting','stopping')";
const EVENT_LIMIT = 2000;

const parse = row => row ? JSON.parse(row.body) : null;
const now = () => new Date().toISOString();
const categories = ['brief', 'decision', 'constraint', 'convention', 'lesson', 'issue'];

export class JournalStore {
  constructor(path) {
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, root TEXT UNIQUE NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), current_revision TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions(id TEXT PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES memories(id), number INTEGER NOT NULL, body TEXT NOT NULL, UNIQUE(memory_id,number));
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(revision_id UNINDEXED, statement, tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), body TEXT NOT NULL);`);
    this.migrate();
  }
  // Ordered, idempotent migrations. The desktop app and the runtime open the
  // same file, so each step re-checks the version inside its own transaction.
  migrate() {
    const steps = [
      [1, () => {}],
      [2, () => this.db.exec(`CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS events_session ON events(session_id, id);`)],
      [3, () => {
        // Stemmed statement plus identifier/path aliases for lexical relevance.
        this.db.exec(`DROP TABLE IF EXISTS memory_fts;
          CREATE VIRTUAL TABLE memory_fts USING fts5(revision_id UNINDEXED, statement, aliases, tokenize='porter unicode61');`);
        const insert = this.db.prepare('INSERT INTO memory_fts(revision_id,statement,aliases) VALUES(?,?,?)');
        for (const row of this.db.prepare('SELECT id, body FROM revisions').all()) { const item = JSON.parse(row.body); insert.run(row.id, item.statement, aliasesFor(item)); }
      }],
      [4, () => this.db.exec(`CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, at TEXT NOT NULL, action TEXT NOT NULL, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), fingerprint TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(project_id, fingerprint));`)],
      // Pinning is a selection preference, not claim content: no new revision.
      [5, () => this.db.exec('ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0')],
      // Projects become managed entities: display name, pin, extra folders.
      [6, () => {
        const update = this.db.prepare('UPDATE projects SET body=? WHERE id=?');
        for (const row of this.db.prepare('SELECT rowid, id, root, body FROM projects').all()) {
          const body = JSON.parse(row.body);
          // rowid preserves the previous most-recent-first order.
          update.run(JSON.stringify({ displayName: null, pinned: false, pinnedAt: null, roots: [], removed: false, openSeq: row.rowid, ...body, folderName: body.folderName ?? basename(row.root) }), row.id);
        }
      }],
      // Sessions gain user-owned display names, pins and removal markers.
      [7, () => {
        const update = this.db.prepare('UPDATE sessions SET body=? WHERE id=?');
        for (const row of this.db.prepare('SELECT id, body FROM sessions').all()) {
          const body = JSON.parse(row.body);
          update.run(JSON.stringify({ displayName: null, pinned: false, pinSeq: null, archived: false, removed: false, ...body }), row.id);
        }
      }],
    ];
    for (const [version, apply] of steps) {
      if (this.db.prepare('PRAGMA user_version').get().user_version >= version) continue;
      this.transaction(() => {
        if (this.db.prepare('PRAGMA user_version').get().user_version >= version) return;
        apply(); this.db.exec(`PRAGMA user_version=${version}`);
      });
    }
  }
  close() { if (this.db?.isOpen) { try { checkpoint(this.db); } catch { /* read-only or busy */ } this.db.close(); } }
  backup(destination) { return backupTo(this.db, destination).then(result => { this.audit('backup', { bytes: result.bytes }); return result; }); }
  checkpoint() { return checkpoint(this.db); }
  storageInfo() { return storageInfo(this.db, this.path); }
  exportBrain(projectId) { const result = exportBrain(this, projectId); this.audit('brain-exported', { projectId, memories: result.json.memories.length }); return result; }
  importBrain(projectId, raw) { return importBrain(this, projectId, raw); }
  purgeSession(sessionId) { return purgeSession(this, sessionId); }
  applyRetention(options) { return applyRetention(this, options); }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    // SQLite may already have rolled back (for example on a full disk); keep the original error.
    catch (error) { if (this.db.isTransaction !== false) { try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ } } throw error; }
  }
  // Reopening keeps the project's name, pin, folders and data, and restores
  // a project that was removed from Journal without deleting its data.
  openProject(root) {
    const info = inspectProject(root);
    const prior = parse(this.db.prepare('SELECT body FROM projects WHERE root=?').get(info.root));
    // A monotonic open sequence orders projects deterministically, even within one millisecond.
    const openSeq = (this.db.prepare("SELECT max(coalesce(json_extract(body,'$.openSeq'),0)) AS n FROM projects").get().n ?? 0) + 1;
    const project = { displayName: null, pinned: false, pinnedAt: null, roots: [], ...prior, ...info, folderName: info.name, id: prior?.id ?? randomUUID(), openedAt: now(), openSeq, removed: false, removedAt: null };
    this.db.prepare('INSERT INTO projects(id,root,body) VALUES(?,?,?) ON CONFLICT(root) DO UPDATE SET body=excluded.body').run(project.id, project.root, JSON.stringify(project));
    if (prior?.removed) this.audit('project-restored', { id: project.id });
    return this.describe(project);
  }
  describe(stored) { return { ...stored, name: stored.displayName || stored.folderName || stored.name, roots: stored.roots ?? [] }; }
  // Pinned first (in pin order), then most recently opened; ties by name and ID.
  listProjects() {
    return this.db.prepare('SELECT body FROM projects').all().map(row => this.describe(parse(row))).filter(project => !project.removed)
      .sort((a, b) => (b.pinned - a.pinned) || (a.pinned ? String(a.pinnedAt).localeCompare(String(b.pinnedAt)) || (a.pinSeq ?? 0) - (b.pinSeq ?? 0) : (b.openSeq ?? 0) - (a.openSeq ?? 0))
        || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }
  storedProject(id) {
    const stored = parse(this.db.prepare('SELECT body FROM projects WHERE id=?').get(text(id, 'project ID', 100)));
    if (!stored) throw new Error('Unknown project');
    return stored;
  }
  saveProject(project) { this.db.prepare('UPDATE projects SET body=? WHERE id=?').run(JSON.stringify(project), project.id); return this.describe(project); }
  project(id) {
    const stored = this.storedProject(id);
    if (stored.removed) throw new Error('This project was removed from Journal; open its folder again to restore it');
    const current = inspectProject(stored.root);
    if (current.root !== stored.root || current.commonDir !== stored.commonDir) throw new Error('Project checkout identity changed; reopen the project');
    return this.describe({ ...stored, ...current, folderName: current.name });
  }
  renameProject(id, name) {
    const stored = this.storedProject(id);
    const displayName = name === null || name === '' ? null : text(name, 'project name', 120);
    this.audit('project-renamed', { id }); return this.saveProject({ ...stored, displayName });
  }
  setProjectPinned(id, pinned) {
    if (typeof pinned !== 'boolean') throw new Error('Invalid pin');
    const stored = this.storedProject(id);
    const pinSeq = pinned && !stored.pinned ? (this.db.prepare("SELECT max(coalesce(json_extract(body,'$.pinSeq'),0)) AS n FROM projects").get().n ?? 0) + 1 : stored.pinSeq;
    return this.saveProject({ ...stored, pinned, pinnedAt: pinned ? (stored.pinned ? stored.pinnedAt : now()) : null, pinSeq: pinned ? pinSeq : null });
  }
  addProjectRoot(id, path) {
    const project = this.project(id);
    const root = classifyFolder(project, path);
    this.audit('project-folder-added', { id, rootId: root.id, kind: root.kind });
    return this.saveProject({ ...this.storedProject(id), roots: [...project.roots, root] });
  }
  // Knowledge from a removed folder is kept but excluded as stale until the
  // folder is added again (same path, same identity).
  removeProjectRoot(id, rootId) {
    const stored = this.storedProject(id);
    if (!(stored.roots ?? []).some(root => root.id === rootId)) throw new Error('Unknown folder');
    if (this.activeSessions().some(session => session.projectId === id && session.workspaceId === `root:${rootId}`)) throw new Error('A session is still running in this folder');
    this.audit('project-folder-removed', { id, rootId });
    return this.saveProject({ ...stored, roots: stored.roots.filter(root => root.id !== rootId) });
  }
  // Works even when the primary folder was moved or deleted, so the project
  // can still be inspected and removed from Journal.
  projectDetails(id) {
    let project; let missing = false;
    try { project = this.project(id); } catch (error) { if (/removed from Journal/.test(error.message)) throw error; project = this.describe(this.storedProject(id)); missing = true; }
    const count = (sql, ...args) => this.db.prepare(sql).get(...args).n;
    const knowledgeBy = new Map(this.db.prepare(`SELECT json_extract(r.body,'$.source.rootId') AS root, count(*) AS n FROM memories m JOIN revisions r ON r.id=m.current_revision WHERE m.project_id=? AND m.status IN ('active','candidate') GROUP BY root`).all(id).map(row => [row.root, row.n]));
    return {
      project, missing, roots: project.roots.map(root => ({ ...folderStatus(root), knowledge: knowledgeBy.get(root.id) ?? 0 })),
      counts: {
        knowledge: count(`SELECT count(*) AS n FROM memories WHERE project_id=? AND status IN ('active','candidate')`, id),
        sessions: count('SELECT count(*) AS n FROM sessions WHERE project_id=?', id),
        liveSessions: this.activeSessions().filter(session => session.projectId === id).length,
        receipts: count('SELECT count(*) AS n FROM receipts WHERE project_id=?', id),
        events: count('SELECT count(*) AS n FROM events WHERE session_id IN (SELECT id FROM sessions WHERE project_id=?)', id),
        proposals: count(`SELECT count(*) AS n FROM proposals WHERE project_id=? AND json_extract(body,'$.state')='open'`, id),
        worktrees: count(`SELECT count(*) AS n FROM workspaces WHERE project_id=? AND json_extract(body,'$.kind')='managed' AND json_extract(body,'$.state') IN ('ready','intent','missing')`, id),
      },
    };
  }
  // Removes Journal's registration, never files. With deleteData, also
  // deletes this project's knowledge, sessions, receipts, timelines,
  // proposals and workspace records from Journal's database.
  removeProject(id, { deleteData = false } = {}) {
    const stored = this.storedProject(id);
    if (this.activeSessions().some(session => session.projectId === id)) throw new Error('Stop this project\'s running sessions first');
    if (!deleteData) { this.audit('project-removed', { id, deleteData: false }); this.saveProject({ ...stored, removed: true, removedAt: now() }); return { removed: id, deletedData: false }; }
    const worktrees = this.db.prepare(`SELECT body FROM workspaces WHERE project_id=? AND json_extract(body,'$.kind')='managed' AND json_extract(body,'$.state') IN ('ready','intent','missing')`).all(id).length;
    if (worktrees) throw new Error('Remove this project\'s Journal worktrees first (Workspaces…). Journal never deletes worktree folders as part of removing a project.');
    this.transaction(() => {
      const revisionIds = this.db.prepare('SELECT r.id FROM revisions r JOIN memories m ON m.id=r.memory_id WHERE m.project_id=?').all(id).map(row => row.id);
      const deleteFts = this.db.prepare('DELETE FROM memory_fts WHERE revision_id=?'); for (const revision of revisionIds) deleteFts.run(revision);
      this.db.prepare('DELETE FROM revisions WHERE memory_id IN (SELECT id FROM memories WHERE project_id=?)').run(id);
      this.db.prepare('DELETE FROM memories WHERE project_id=?').run(id);
      this.db.prepare('DELETE FROM events WHERE session_id IN (SELECT id FROM sessions WHERE project_id=?)').run(id);
      for (const table of ['sessions', 'receipts', 'proposals', 'workspaces']) this.db.prepare(`DELETE FROM ${table} WHERE project_id=?`).run(id);
      this.db.prepare('DELETE FROM projects WHERE id=?').run(id);
      this.audit('project-removed', { id, deleteData: true, knowledge: revisionIds.length });
    });
    return { removed: id, deletedData: true };
  }
  proposeMemory(projectId, input) {
    const project = this.project(projectId);
    const statement = text(input.statement, 'statement'); refuseCredentials(statement);
    const category = choice(input.category, categories, 'category');
    const scope = choice(input.scope, ['checkout', 'branch'], 'scope');
    if (scope === 'branch' && !project.branch) throw new Error('Branch scope requires a named branch');
    const area = relativePath(input.area ?? '', true);
    // Optional environment qualifier ("macOS only", "with Docker running").
    const environment = text(input.environment ?? '', 'environment qualifier', 200, true); if (environment) refuseCredentials(environment);
    // A revision of a replacement keeps what it replaces unless told otherwise.
    const carried = !input.supersedes && input.memoryId ? (() => { try { return this.getMemory(input.memoryId).supersedes?.id ?? null; } catch { return null; } })() : null;
    const supersedes = input.supersedes || carried ? this.getMemory(input.supersedes || carried) : null;
    if (input.source?.rootId && scope === 'branch') throw new Error('Branch scope applies to the primary repository; use project scope for knowledge from additional folders');
    if (supersedes && supersedes.projectId !== projectId) throw new Error('Superseded memory belongs to another project');
    if (supersedes && (supersedes.id === input.memoryId || (supersedes.status !== 'active' && !carried))) throw new Error('Only another approved claim can be superseded; revise a claim to change it');
    if (category === 'brief' && area) throw new Error('Project briefs apply to the whole checkout; leave the area empty');
    if (input.source?.kind === 'git' && PLACEHOLDER.test(statement)) throw new Error('Replace the bracketed placeholders before saving the update');
    const source = captureEvidence(project, input.source);
    let previous = null;
    if (input.memoryId) {
      previous = this.getMemory(input.memoryId);
      if (previous.projectId !== projectId) throw new Error('Memory belongs to another project');
    }
    const id = previous?.id ?? randomUUID();
    const revision = (previous?.revision ?? 0) + 1;
    const branch = scope === 'branch' ? project.branch : null;
    // Flag, never block: the reviewer decides whether two claims really conflict.
    const conflicts = this.db.prepare(`SELECT r.body FROM memories m JOIN revisions r ON r.id=m.current_revision
      WHERE m.project_id=? AND m.status='active' AND m.id<>? LIMIT 500`).all(projectId, id).map(parse)
      .filter(other => (other.scope === 'checkout' || scope === 'checkout' || other.branch === branch) && (!other.area || !area || other.area.startsWith(area) || area.startsWith(other.area)))
      .filter(other => possibleConflict(statement, other.statement)).slice(0, 5)
      .map(other => ({ id: other.id, revision: other.revision, statement: other.statement.slice(0, 160) }));
    const item = { id, projectId, revisionId: randomUUID(), revision, statement, category, scope, area,
      branch, source, conflicts, createdAt: now(), ...(environment ? { environment } : {}),
      ...(supersedes ? { supersedes: { id: supersedes.id, revision: supersedes.revision } } : {}),
      ...(input.promotedFrom ? { promotedFrom: input.promotedFrom } : {}) };
    this.transaction(() => {
      this.db.prepare('INSERT INTO memories(id,project_id,current_revision,status) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET current_revision=excluded.current_revision,status=excluded.status').run(id, projectId, item.revisionId, 'candidate');
      this.db.prepare('INSERT INTO revisions VALUES(?,?,?,?)').run(item.revisionId, id, revision, JSON.stringify(item));
      this.db.prepare('INSERT INTO memory_fts(revision_id,statement,aliases) VALUES(?,?,?)').run(item.revisionId, statement, aliasesFor(item));
    });
    return { ...item, status: 'candidate', validation: 'current' };
  }
  getMemory(id) {
    const row = this.db.prepare('SELECT r.body,m.status,m.pinned FROM memories m JOIN revisions r ON r.id=m.current_revision WHERE m.id=?').get(text(id, 'memory ID', 100));
    if (!row) throw new Error('Unknown memory');
    return { ...parse(row), status: row.status, pinned: !!row.pinned };
  }
  memoryHistory(id) {
    this.getMemory(id);
    return this.db.prepare('SELECT body FROM revisions WHERE memory_id=? ORDER BY number DESC').all(id).map(parse);
  }
  validation(project, memory, cache) {
    if (memory.source?.rootId && !(project.roots ?? []).some(root => root.id === memory.source.rootId)) return 'folder-removed';
    if (memory.scope === 'branch' && project.branch !== memory.branch) return 'wrong-branch';
    if (!validateEvidence(project, memory.source, cache, memory.scope)) return 'stale';
    return 'current';
  }
  // Commits made after a current-branch update was recorded. Unknown for
  // statement-only sources; drift prompts review, it never excludes the update.
  drift(project, memory, cache) {
    const commit = memory.source.kind === 'git' ? memory.source.head : memory.source.commit;
    if (memory.category !== 'brief' || memory.scope !== 'branch' || !commit || !project.head) return null;
    const key = `drift:${commit}`;
    if (!cache.has(key)) { const count = commitsSince(project.root, commit); cache.set(key, Number.isFinite(count) ? count : null); }
    return cache.get(key);
  }
  listMemories(projectId) {
    const project = this.project(projectId);
    const cache = new Map();
    return this.db.prepare('SELECT r.body,m.status FROM memories m JOIN revisions r ON r.id=m.current_revision WHERE m.project_id=? ORDER BY r.rowid DESC LIMIT 500').all(projectId)
      .map(row => {
        const item = { ...parse(row), status: row.status }; const validation = this.validation(project, item, cache);
        return { ...item, validation, drift: validation === 'current' ? this.drift(project, item, cache) : null };
      });
  }
  // Read-only draft for a reviewed repo overview or current-branch update.
  proposeStatusUpdate(projectId, scope) {
    const project = this.project(projectId);
    choice(scope, ['checkout', 'branch'], 'scope');
    if (scope === 'branch' && !project.branch) throw new Error('Branch updates require a named branch');
    const row = this.db.prepare(`SELECT r.body,m.status FROM memories m JOIN revisions r ON r.id=m.current_revision
      WHERE m.project_id=? AND m.status IN ('active','candidate') AND json_extract(r.body,'$.category')='brief'
      AND json_extract(r.body,'$.scope')=? AND (? = 'checkout' OR json_extract(r.body,'$.branch')=?)
      ORDER BY m.status='active' DESC, r.rowid DESC LIMIT 1`).get(projectId, scope, scope, project.branch);
    const previous = row ? { ...parse(row), status: row.status } : null;
    const draft = scope === 'branch' ? branchDraft(project, previous) : overviewDraft(project, previous);
    return { scope, memoryId: previous?.id ?? null, previousRevision: previous?.revision ?? null, previousStatement: previous?.statement ?? null, ...draft };
  }
  // Paged, filtered list for the knowledge panel; validation runs per page.
  listMemoryPage(projectId, { offset = 0, limit = 100, filter = 'all', search = '' } = {}) {
    const project = this.project(projectId); const cache = new Map();
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid page');
    const statuses = { all: ['candidate', 'active'], review: ['candidate'], active: ['active'], history: ['candidate', 'active', 'rejected', 'archived'] }[choice(filter, ['all', 'review', 'active', 'history'], 'filter')];
    search = text(search, 'search', 200, true).toLocaleLowerCase();
    const where = `m.project_id=? AND m.status IN (${statuses.map(() => '?').join(',')}) AND (?='' OR instr(lower(json_extract(r.body,'$.statement')),?)>0 OR instr(lower(coalesce(json_extract(r.body,'$.source.path'),'')),?)>0 OR json_extract(r.body,'$.category')=?)`;
    const args = [projectId, ...statuses, search, search, search, search];
    const total = this.db.prepare(`SELECT count(*) AS n FROM memories m JOIN revisions r ON r.id=m.current_revision WHERE ${where}`).get(...args).n;
    const items = this.db.prepare(`SELECT r.body,m.status,m.pinned FROM memories m JOIN revisions r ON r.id=m.current_revision WHERE ${where} ORDER BY m.pinned DESC, r.rowid DESC LIMIT ? OFFSET ?`).all(...args, limit, offset)
      .map(row => { const item = { ...parse(row), status: row.status, pinned: !!row.pinned }; const validation = this.validation(project, item, cache); return { ...item, validation, drift: validation === 'current' ? this.drift(project, item, cache) : null }; });
    const counts = Object.fromEntries(this.db.prepare('SELECT status, count(*) AS n FROM memories WHERE project_id=? GROUP BY status').all(projectId).map(row => [row.status, row.n]));
    return { items, total, offset, limit, counts };
  }
  setMemoryStatus(id, status, { reason = null } = {}) {
    choice(status, ['active', 'rejected', 'archived'], 'status');
    if (reason !== null) choice(reason, ['incorrect', 'superseded', 'withdrawn'], 'reason');
    const memory = this.getMemory(id);
    if (status === 'active' && memory.status !== 'candidate') throw new Error('Only a candidate can be approved');
    if (status === 'active' && this.validation(this.project(memory.projectId), memory) !== 'current') throw new Error('Evidence or branch changed; revise before approving');
    this.transaction(() => {
      this.db.prepare('UPDATE memories SET status=?, pinned=CASE WHEN ?=\'active\' THEN pinned ELSE 0 END WHERE id=?').run(status, status, id);
      // Approving a replacement retires the claim it supersedes.
      if (status === 'active' && memory.supersedes) this.db.prepare(`UPDATE memories SET status='archived', pinned=0 WHERE id=? AND status='active'`).run(memory.supersedes.id);
      if (status === 'active' && memory.category === 'brief' && memory.scope === 'branch') this.db.prepare(`UPDATE proposals SET body=json_set(body,'$.state','accepted','$.memoryId',?) WHERE project_id=? AND json_extract(body,'$.kind')='branch-status' AND json_extract(body,'$.branch')=? AND json_extract(body,'$.state')='open'`).run(id, memory.projectId, memory.branch);
      this.audit(`memory-${status}`, { id, revision: memory.revision, reason, supersedes: status === 'active' ? memory.supersedes?.id ?? null : null });
    });
    return this.getMemory(id);
  }
  setPinned(id, pinned) {
    const memory = this.getMemory(id);
    if (typeof pinned !== 'boolean') throw new Error('Invalid pin');
    if (pinned && memory.status !== 'active') throw new Error('Only an approved claim can be pinned');
    this.db.prepare('UPDATE memories SET pinned=? WHERE id=?').run(pinned ? 1 : 0, id); this.audit(pinned ? 'memory-pinned' : 'memory-unpinned', { id });
    return this.getMemory(id);
  }
  // A branch-scoped claim proposed for every branch: a new candidate that
  // still needs review; the branch claim stays as it is.
  proposePromotion(id) {
    const memory = this.getMemory(id);
    if (memory.scope !== 'branch' || memory.status !== 'active') throw new Error('Only an approved branch claim can be proposed for all branches');
    if (memory.category === 'brief') throw new Error('Branch updates describe one branch; write a repo overview instead');
    const source = memory.source.kind === 'file' ? { kind: 'file', path: memory.source.path, startLine: memory.source.startLine, endLine: memory.source.endLine }
      : { kind: 'user', note: `${memory.source.note ?? 'Reviewed claim'} (promoted from branch ${memory.branch})`.slice(0, 2000) };
    return this.proposeMemory(memory.projectId, { statement: memory.statement, category: memory.category, scope: 'checkout', area: memory.area, environment: memory.environment, source,
      promotedFrom: { id: memory.id, revision: memory.revision, branch: memory.branch } });
  }
  prepareContext(projectId, query, { workspaceId = null, disabled = [] } = {}) {
    query = text(query, 'task', 4000, true); refuseCredentials(query);
    if (!Array.isArray(disabled) || disabled.length > 100 || disabled.some(x => typeof x !== 'string')) throw new Error('Invalid disabled claims');
    const project = this.view(projectId, workspaceId);
    const terms = queryTerms(query);
    let matches = []; const cache = new Map(); const warnings = []; const matchedIds = new Set();
    // Orientation is independent of task words. Current checkout identity and
    // current-branch updates alternate so neither silently crowds out the other.
    const briefs = this.db.prepare(`SELECT r.body,m.status FROM memories m JOIN revisions r ON r.id=m.current_revision
      WHERE m.project_id=? AND m.status='active' AND json_extract(r.body,'$.category')='brief'
      AND (json_extract(r.body,'$.scope')='checkout' OR json_extract(r.body,'$.branch')=?)
      ORDER BY r.rowid DESC LIMIT 101`).all(projectId, project.branch);
    if (briefs.length > 100) warnings.push('Project brief search inspected 100 entries. Retire superseded briefs to include others.');
    const checkoutBriefs = briefs.slice(0, 100).filter(row => parse(row).scope === 'checkout');
    const branchBriefs = briefs.slice(0, 100).filter(row => parse(row).scope === 'branch');
    for (let i = 0; i < Math.max(checkoutBriefs.length, branchBriefs.length); i++) {
      for (const row of [checkoutBriefs[i], branchBriefs[i]]) if (row) matches.push({ ...row, validation: this.validation(project, parse(row), cache), reason: parse(row).scope === 'checkout' ? 'repo overview' : 'branch update' });
    }
    // Pinned rules come next, independent of task words but never exempt from
    // scope, freshness or area rules.
    for (const row of this.db.prepare(`SELECT r.body,m.status FROM memories m JOIN revisions r ON r.id=m.current_revision
      WHERE m.project_id=? AND m.status='active' AND m.pinned=1 AND json_extract(r.body,'$.category')!='brief'
      AND (json_extract(r.body,'$.scope')='checkout' OR json_extract(r.body,'$.branch')=?) ORDER BY r.rowid DESC LIMIT 20`).all(projectId, project.branch)) {
      matches.push({ ...row, validation: this.validation(project, parse(row), cache), reason: 'pinned', pinned: true }); matchedIds.add(parse(row).id);
    }
    if (terms.length) {
      const fts = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
      const select = this.db.prepare(`SELECT r.body,m.status,bm25(memory_fts, 0, 1.0, 0.6) AS rank FROM memory_fts
        JOIN revisions r ON r.id=memory_fts.revision_id JOIN memories m ON m.current_revision=r.id
        WHERE memory_fts MATCH ? AND m.project_id=? AND m.status='active'
        AND json_extract(r.body,'$.category')!='brief'
        AND (json_extract(r.body,'$.scope')='checkout' OR json_extract(r.body,'$.branch')=?)
        ORDER BY rank,r.rowid LIMIT 100 OFFSET ?`);
      // Page past ineligible matches; 100 is the eligible-candidate limit, not a
      // cutoff that lets stale or wrong-branch records hide current knowledge.
      let eligible = 0;
      for (let offset = 0; eligible < 100 && offset < 1000; offset += 100) {
        const page = select.all(fts, projectId, project.branch, offset); if (!page.length) break;
        for (const row of page) {
          const item = parse(row);
          const validation = this.validation(project, item, cache);
          const valid = validation === 'current' && areaMatches(item.area, query);
          if (matchedIds.has(item.id)) continue; matchedIds.add(item.id);
          const lower = `${item.statement} ${aliasesFor(item)}`.toLocaleLowerCase();
          const hit = terms.filter(term => lower.includes(term.slice(0, Math.max(4, term.length - 2))));
          matches.push({ ...row, validation, reason: `matched ${hit.slice(0, 4).join(', ') || 'task terms'}${item.area ? ` in ${item.area}` : ''}` }); if (valid) eligible++;
          if (eligible === 100) break;
        }
        if (page.length < 100) break;
        if (offset === 900 && eligible < 100) warnings.push('Search inspected 1000 matches. Refine the task or retire stale knowledge to search further.');
      }
    }
    const id = randomUUID(); const items = []; const excluded = []; let briefCount = 0; const perCategory = new Map();
    const disabledSet = new Set(disabled);
    const header = `Journal project knowledge — checkout ${project.head ?? 'unborn'}, receipt ${id}\nProject: ${project.name}; branch ${project.branch ?? 'detached HEAD'}.\n${project.cwd ? `Working folder: ${project.cwd}. Evidence paths without a folder are relative to the primary repository at ${project.root}.\n` : ''}These are reviewed, scoped claims with evidence. Native project instructions take precedence. Validate against current code.\n`;
    let packet = header;
    for (const row of matches) {
      const memory = { ...parse(row), status: row.status };
      const validation = row.validation;
      if (disabledSet.has(memory.id)) { if (excluded.length < 100) excluded.push({ id: memory.id, reason: 'left-out-for-task' }); continue; }
      if (validation !== 'current') { if (excluded.length < 100) excluded.push({ id: memory.id, reason: validation }); continue; }
      if (!areaMatches(memory.area, query)) { if (excluded.length < 100) excluded.push({ id: memory.id, reason: 'area-not-requested' }); continue; }
      if (items.some(item => isDuplicate(item.statement, memory.statement))) { if (excluded.length < 100) excluded.push({ id: memory.id, reason: 'duplicate' }); continue; }
      if (memory.category === 'brief' && briefCount >= 4) {
        if (excluded.length < 100) excluded.push({ id: memory.id, reason: 'brief-limit' });
        continue;
      }
      // Category diversity: at most four task claims of one kind.
      if (memory.category !== 'brief' && !row.pinned && (perCategory.get(memory.category) ?? 0) >= 4) { if (excluded.length < 100) excluded.push({ id: memory.id, reason: 'category-limit' }); continue; }
      // Folder evidence names its absolute folder so the agent can find it from any cwd.
      const folder = memory.source.rootId ? `${(project.roots ?? []).find(root => root.id === memory.source.rootId)?.path ?? '(removed folder)'}/` : '';
      const evidence = memory.source.kind === 'file' ? `${folder}${memory.source.path}:${memory.source.startLine} @ ${memory.source.commit ?? (memory.source.rootId ? 'untracked folder' : 'unborn')}`
        : memory.source.kind === 'git' ? `Git history ${memory.source.base ? `${memory.source.base.slice(0, 7)}..` : ''}${memory.source.head.slice(0, 7)}`
        : memory.source.kind === 'import' ? `Imported (reviewed here): ${memory.source.note}`
        : `User statement: ${memory.source.note}`;
      const drift = this.drift(project, memory, cache);
      const age = drift ? `; ${drift} commit${drift === 1 ? '' : 's'} since this update` : '';
      const label = memory.category === 'brief' ? `${memory.scope === 'checkout' ? 'Project brief' : 'Branch update'}\n` : '';
      const qualifier = memory.environment ? `\nApplies when: ${memory.environment}` : '';
      const chunk = `\n${label}[${memory.id} r${memory.revision}; ${memory.category}; ${memory.scope}${memory.branch ? ` ${memory.branch}` : ''}${memory.area ? `; area ${memory.area}` : ''}]\n${memory.statement}${qualifier}\nEvidence: ${evidence}${age}\n`;
      if (items.length >= 12 || Buffer.byteLength(packet + chunk) > 6000) { if (excluded.length < 100) excluded.push({ id: memory.id, reason: 'budget' }); continue; }
      items.push({ ...memory, selection: { reason: row.reason ?? 'matched', bytes: Buffer.byteLength(chunk) } }); packet += chunk; if (memory.category === 'brief') briefCount++;
      else perCategory.set(memory.category, (perCategory.get(memory.category) ?? 0) + 1);
      if (drift) warnings.push(`The current branch update is ${drift} commit${drift === 1 ? '' : 's'} behind HEAD. Propose a status update to review recent progress.`);
    }
    for (const [index, a] of items.entries()) for (const b of items.slice(index + 1)) {
      if (possibleConflict(a.statement, b.statement)) warnings.push(`Claims ${a.id.slice(0, 8)} r${a.revision} and ${b.id.slice(0, 8)} r${b.revision} may conflict. Review them in Knowledge.`);
    }
    if (excluded.some(item => item.reason === 'brief-limit')) warnings.push('Only four current project brief entries fit the orientation limit. Consolidate superseded briefs.');
    if (matches.some(row => parse(row).category === 'brief' && excluded.some(item => item.id === parse(row).id && item.reason === 'budget'))) warnings.push('A project brief was excluded by the context budget. Shorten or consolidate the reviewed summaries.');
    if (!items.some(item => item.category === 'brief' && item.scope === 'checkout')) warnings.push('No current approved project brief is included. Add a checkout-scoped brief to orient every session.');
    if (!items.length) packet = '';
    const receipt = { id, projectId, query, packet, items, excluded, warnings, disabled: [...disabledSet], workspaceId, checkout: { root: project.root, branch: project.branch, head: project.head }, state: 'prepared', estimatedTokens: Math.ceil(Buffer.byteLength(packet) / 3), createdAt: now() };
    this.db.prepare('INSERT INTO receipts VALUES(?,?,?)').run(id, projectId, JSON.stringify(receipt));
    return receipt;
  }
  getReceipt(id) {
    const receipt = parse(this.db.prepare('SELECT body FROM receipts WHERE id=?').get(text(id, 'receipt ID', 100)));
    if (!receipt) throw new Error('Unknown receipt');
    return receipt;
  }
  latestNativeReceipt(projectId, provider, nativeId) {
    // A native conversation spans launch rows. Ignore previews/failed launches,
    // but retain possibly delivered context after an uncertain interruption.
    const row = this.db.prepare(`WITH deliveries AS (
      SELECT r.rowid AS sequence,r.body FROM sessions s JOIN receipts r ON r.id=json_extract(s.body,'$.receiptId')
      WHERE s.project_id=? AND json_extract(s.body,'$.provider')=? AND json_extract(s.body,'$.nativeId')=?
      AND json_extract(r.body,'$.state') IN ('submitted','uncertain')
    ) SELECT body,EXISTS(SELECT 1 FROM deliveries WHERE json_array_length(body,'$.items')>0) AS had_knowledge
      FROM deliveries ORDER BY sequence DESC LIMIT 1`).get(projectId, provider, nativeId);
    return row ? { ...parse(row), hadKnowledge: !!row.had_knowledge } : null;
  }
  listReceipts(projectId) {
    this.project(projectId);
    return this.db.prepare('SELECT body FROM receipts WHERE project_id=? ORDER BY rowid DESC LIMIT 50').all(projectId).map(parse);
  }
  updateReceiptState(id, state, sessionId, launchPrompt) {
    choice(state, ['submitted', 'failed', 'uncertain'], 'delivery state');
    const receipt = this.getReceipt(id);
    if (receipt.state !== 'prepared' && !(receipt.state === 'submitted' && state === 'uncertain')) throw new Error('Receipt delivery is already recorded');
    if (launchPrompt !== undefined && (typeof launchPrompt !== 'string' || Buffer.byteLength(launchPrompt) > 32000)) throw new Error('Invalid launch prompt snapshot');
    const updated = { ...receipt, state, sessionId: sessionId ?? receipt.sessionId, updatedAt: now(),
      ...(receipt.state === 'prepared' && launchPrompt !== undefined ? { launchPrompt } : {}) };
    this.db.prepare('UPDATE receipts SET body=? WHERE id=?').run(JSON.stringify(updated), id);
    return updated;
  }
  // Runtime saves carry status; user-owned fields (name, pin, archive,
  // removal) always come from the stored row, so a status save can never
  // undo a rename. updateSessionUser is the only writer of those fields.
  // One atomic statement each: the app and the runtime write sessions from
  // separate processes, so read-then-write would let one undo the other.
  saveSession(session) {
    // '->' keeps JSON types (true stays true); a missing field patches as null and is dropped.
    const userFields = SESSION_USER_FIELDS.map(field => `'${field}', sessions.body -> '$.${field}'`).join(', ');
    // A late runtime save (for example a leftover-process scan) never recreates a purged session.
    this.db.prepare(`INSERT INTO sessions SELECT ?,?,? WHERE NOT EXISTS (SELECT 1 FROM audit WHERE action='session-purged' AND json_extract(body,'$.sessionId')=?) ON CONFLICT(id) DO UPDATE SET body=json_patch(excluded.body, json_object(${userFields}))`)
      .run(session.id, session.projectId, JSON.stringify(session), session.id);
    return this.db.prepare('SELECT 1 FROM sessions WHERE id=?').get(session.id) ? this.getSession(session.id) : null;
  }
  updateSessionUser(id, patch) {
    const keys = Object.keys(patch);
    if (!keys.length || keys.some(key => !SESSION_USER_FIELDS.includes(key))) throw new Error('Invalid session field');
    const { changes } = this.db.prepare(`UPDATE sessions SET body=json_set(body, ${keys.map(key => `'$.${key}', json(?)`).join(', ')}) WHERE id=?`)
      .run(...keys.map(key => JSON.stringify(patch[key] ?? null)), text(id, 'session ID', 100));
    if (!changes) throw new Error('Unknown session');
    return this.getSession(id);
  }
  renameSession(id, name) {
    const displayName = name === null || name === '' ? null : text(name, 'session name', 120);
    return this.updateSessionUser(id, { displayName });
  }
  setSessionPinned(id, pinned) {
    if (typeof pinned !== 'boolean') throw new Error('Invalid pin');
    const session = this.getSession(id);
    const pinSeq = pinned ? session.pinned ? session.pinSeq : (this.db.prepare("SELECT max(coalesce(json_extract(body,'$.pinSeq'),0)) AS n FROM sessions").get().n ?? 0) + 1 : null;
    return this.updateSessionUser(id, { pinned, pinSeq });
  }
  unarchiveSession(id) { return this.updateSessionUser(id, { archived: false, archivedAt: null }); }
  // Hides the session everywhere and drops its timeline. Receipts stay:
  // exact resume of the same native conversation relies on them. Never
  // touches files, worktrees or the native CLI conversation.
  removeSession(id) {
    const session = this.getSession(id);
    if (['starting', 'running', 'waiting', 'stopping', 'orphaned'].includes(session.status)) throw new Error('Stop the session before removing it');
    if (session.survivors?.length) throw new Error('End or keep the leftover child processes first; removing would hide them');
    if (survivorScanPending(session)) throw new Error('Journal is still checking for leftover child processes; try again in a moment, or archive the session instead');
    this.db.prepare('DELETE FROM events WHERE session_id=?').run(id);
    this.audit('session-removed', { id });
    return this.updateSessionUser(id, { removed: true, removedAt: now(), pinned: false, pinSeq: null });
  }
  getSession(id) {
    const session = parse(this.db.prepare('SELECT body FROM sessions WHERE id=?').get(text(id, 'session ID', 100)));
    if (!session) throw new Error('Unknown session');
    return session;
  }
  // Audit trail of reviewer and maintenance actions (bounded metadata).
  audit(action, body = {}) {
    this.db.prepare('INSERT INTO audit(at,action,body) VALUES(?,?,?)').run(now(), text(action, 'audit action', 80), JSON.stringify(body).slice(0, 4000));
  }
  listAudit(limit = 200) { return this.db.prepare('SELECT * FROM (SELECT id,at,action,body FROM audit ORDER BY id DESC LIMIT ?) ORDER BY id').all(Math.min(limit, 1000)).map(row => ({ ...row, body: JSON.parse(row.body) })); }

  // ----- Proposal inbox (deterministic extraction) -----
  generateProposals(sessionId) {
    const session = this.getSession(sessionId);
    if (session.removed) return []; // removed by the user: nothing is derived from it
    const receipt = (() => { try { return this.getReceipt(session.receiptId); } catch { return null; } })();
    // Proposals describe the primary repository: use its view, never a folder's Git identity.
    const inFolder = String(session.workspaceId ?? '').startsWith('root:');
    let project; try { project = this.view(session.projectId, inFolder ? null : session.workspaceId ?? null); } catch { return []; }
    const existing = this.db.prepare(`SELECT r.body FROM memories m JOIN revisions r ON r.id=m.current_revision WHERE m.project_id=? AND m.status IN ('active','candidate')`).all(session.projectId).map(row => parse(row).statement);
    const branchUpdate = this.db.prepare(`SELECT r.body FROM memories m JOIN revisions r ON r.id=m.current_revision WHERE m.project_id=? AND m.status='active'
      AND json_extract(r.body,'$.category')='brief' AND json_extract(r.body,'$.scope')='branch' AND json_extract(r.body,'$.branch')=? ORDER BY r.rowid DESC LIMIT 1`).get(session.projectId, project.branch);
    const update = branchUpdate ? parse(branchUpdate) : null;
    // Commands and commits in an additional folder belong to that folder, not the primary branch.
    const candidates = [...ruleProposals(session, receipt), ...(inFolder ? [] : [...testCommandProposals(session, this.listEvents(sessionId, 2000)),
      ...statusProposal(session, project, update ? this.drift(project, { ...update, category: 'brief', scope: 'branch' }, new Map()) : 0, !!update)])];
    const created = [];
    for (const candidate of candidates.slice(0, 10)) {
      if (candidate.statement && candidate.kind !== 'branch-status' && existing.some(statement => isDuplicate(statement, candidate.statement))) continue;
      const body = { id: randomUUID(), projectId: session.projectId, ...candidate, branch: candidate.scope === 'branch' ? project.branch : null, state: 'open', createdAt: now() };
      // UNIQUE(project, fingerprint): regenerating, or a dismissed fingerprint, never duplicates.
      const result = this.db.prepare('INSERT INTO proposals(id,project_id,fingerprint,body) VALUES(?,?,?,?) ON CONFLICT(project_id,fingerprint) DO NOTHING').run(body.id, body.projectId, body.fingerprint, JSON.stringify(body));
      if (result.changes) created.push(body);
    }
    return created;
  }
  listProposals(projectId, state = 'open') {
    this.project(projectId); choice(state, ['open', 'accepted', 'dismissed'], 'proposal state');
    return this.db.prepare(`SELECT body FROM proposals WHERE project_id=? AND json_extract(body,'$.state')=? ORDER BY rowid DESC LIMIT 100`).all(projectId, state).map(parse);
  }
  getProposal(id) {
    const proposal = parse(this.db.prepare('SELECT body FROM proposals WHERE id=?').get(text(id, 'proposal ID', 100)));
    if (!proposal) throw new Error('Unknown proposal'); return proposal;
  }
  // Accepting creates a candidate (still unapproved); status proposals open the helper instead.
  acceptProposal(id) {
    const proposal = this.getProposal(id);
    if (proposal.state !== 'open') throw new Error('This proposal was already handled');
    if (proposal.kind === 'branch-status') throw new Error('Use Propose branch update for status proposals');
    if (proposal.evidence?.sessionId) this.getSession(proposal.evidence.sessionId);
    const memory = this.proposeMemory(proposal.projectId, { statement: proposal.statement, category: proposal.category, scope: proposal.scope, area: '', source: proposal.source });
    this.db.prepare('UPDATE proposals SET body=? WHERE id=?').run(JSON.stringify({ ...proposal, state: 'accepted', memoryId: memory.id, handledAt: now() }), id);
    this.audit('proposal-accepted', { id, memoryId: memory.id, kind: proposal.kind });
    return memory;
  }
  dismissProposal(id) {
    const proposal = this.getProposal(id);
    this.db.prepare('UPDATE proposals SET body=? WHERE id=?').run(JSON.stringify({ ...proposal, state: 'dismissed', handledAt: now() }), id);
    this.audit('proposal-dismissed', { id, kind: proposal.kind });
    return { ...proposal, state: 'dismissed' };
  }

  // ----- Workspaces -----
  getWorkspace(id) {
    const workspace = parse(this.db.prepare('SELECT body FROM workspaces WHERE id=?').get(text(id, 'workspace ID', 100)));
    if (!workspace) throw new Error('Unknown workspace');
    return workspace;
  }
  saveWorkspace(workspace) {
    this.db.prepare('INSERT INTO workspaces VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(workspace.id, workspace.projectId, JSON.stringify(workspace));
    return workspace;
  }
  // Brings stored workspaces in line with Git: unfinished intents become
  // ready (Git finished) or failed; vanished worktrees become missing.
  // Nothing on disk is created or deleted here.
  reconcileWorkspaces(projectId) {
    const project = this.project(projectId);
    for (const row of this.db.prepare(`SELECT body FROM workspaces WHERE project_id=? AND json_extract(body,'$.state') IN ('intent','ready','missing')`).all(projectId)) {
      const workspace = parse(row); const entry = registered(project, workspace.path);
      let next = workspace;
      if (entry) next = { ...workspace, state: 'ready', branch: entry.branch ?? workspace.branch, head: entry.head, detached: entry.detached, error: null };
      else if (workspace.state === 'intent') next = { ...workspace, state: 'failed', error: existsSync(workspace.path) ? 'Creation did not finish; the folder exists but is not a registered worktree, so Journal left it untouched.' : 'Creation did not finish; no worktree was created.' };
      else next = { ...workspace, state: 'missing', error: 'This worktree is no longer registered or its folder was removed outside Journal.' };
      if (JSON.stringify(next) !== JSON.stringify(workspace)) { this.saveWorkspace(next); this.audit('workspace-reconciled', { id: workspace.id, from: workspace.state, to: next.state }); }
    }
  }
  listWorkspaces(projectId) {
    this.reconcileWorkspaces(projectId);
    const project = this.project(projectId);
    const tracked = this.db.prepare(`SELECT body FROM workspaces WHERE project_id=? AND json_extract(body,'$.state')<>'removed' ORDER BY rowid`).all(projectId).map(parse);
    const known = new Set([project.root, ...tracked.map(w => w.path)]);
    const importable = listGitWorktrees(project.root).filter(entry => !known.has(entry.path) && !entry.bare && !entry.prunable && existsSync(entry.path)).map(entry => ({ path: entry.path, branch: entry.branch, head: entry.head, detached: entry.detached }));
    return { checkout: { id: null, kind: 'checkout', path: project.root, branch: project.branch, head: project.head, state: 'ready' }, workspaces: tracked, importable };
  }
  planWorkspace(projectId, { branch, base }, worktreeRoot) {
    const project = this.project(projectId);
    branch = validateBranchName(project.root, branch);
    const commit = resolveBase(project.root, base || project.branch || 'HEAD');
    const id = randomUUID();
    return { id, branch, base: commit, baseLabel: base || project.branch || 'HEAD', path: plannedPath(text(worktreeRoot, 'worktree root', 4096), project, branch, id), notices: creationNotices(project) };
  }
  // Creates exactly what was reviewed: the planned ID (hence path) and the
  // base commit resolved at review time, so a moved branch cannot change it.
  createWorkspace(projectId, request, worktreeRoot) {
    const project = this.project(projectId);
    const plan = this.planWorkspace(projectId, { branch: request.branch, base: request.baseCommit ?? request.base }, worktreeRoot);
    if (request.planId) {
      if (!/^[0-9a-f-]{36}$/.test(request.planId)) throw new Error('Invalid plan');
      // A plan ID creates one workspace once; it can never overwrite a record.
      if (this.db.prepare('SELECT 1 FROM workspaces WHERE id=?').get(request.planId)) throw new Error('This plan was already used; review again');
      plan.id = request.planId; plan.path = plannedPath(text(worktreeRoot, 'worktree root', 4096), project, plan.branch, request.planId);
    }
    // Intent first: a crash after this point is reconciled from Git.
    const workspace = { id: plan.id, projectId, kind: 'managed', path: plan.path, branch: plan.branch, base: plan.base, baseLabel: request.base === undefined ? plan.baseLabel : text(request.base, 'base', 200), state: 'intent', notices: plan.notices, createdAt: now() };
    this.saveWorkspace(workspace); this.audit('workspace-intent', { id: workspace.id, branch: workspace.branch, base: workspace.base });
    try { addWorktree(project, workspace); }
    catch (error) { this.reconcileWorkspaces(projectId); const current = this.getWorkspace(workspace.id); if (current.state !== 'ready') { this.saveWorkspace({ ...current, state: 'failed', error: error.message }); throw error; } }
    this.reconcileWorkspaces(projectId);
    const created = this.getWorkspace(workspace.id); this.audit('workspace-created', { id: created.id, state: created.state });
    return created;
  }
  importWorkspace(projectId, path) {
    const project = this.project(projectId);
    const entry = registered(project, text(path, 'worktree path', 4096));
    if (!entry || entry.path === project.root) throw new Error('Choose another registered worktree of this repository');
    if (this.db.prepare(`SELECT 1 FROM workspaces WHERE project_id=? AND json_extract(body,'$.path')=? AND json_extract(body,'$.state')<>'removed'`).get(projectId, entry.path)) throw new Error('This worktree is already in Journal');
    const workspace = { id: randomUUID(), projectId, kind: 'imported', path: entry.path, branch: entry.branch, head: entry.head, detached: entry.detached, state: 'ready', createdAt: now() };
    this.saveWorkspace(workspace); this.audit('workspace-imported', { id: workspace.id, path: entry.path });
    return workspace;
  }
  workspaceRemovalBlockers(id) {
    const workspace = this.getWorkspace(id); const project = this.project(workspace.projectId);
    const live = this.activeSessions().filter(session => session.workspaceId === id);
    return removalBlockers(project, workspace, live);
  }
  removeWorkspace(id) {
    const workspace = this.getWorkspace(id); const project = this.project(workspace.projectId);
    const blockers = this.workspaceRemovalBlockers(id);
    if (blockers.length) throw new Error(`Not removed: ${blockers.join(' ')}`);
    removeWorktree(project, workspace);
    this.audit('workspace-removed', { id, path: workspace.path, branchKept: workspace.branch });
    return this.saveWorkspace({ ...workspace, state: 'removed', removedAt: now() });
  }
  // Stops tracking without touching files (imported, failed or missing entries).
  forgetWorkspace(id) {
    const workspace = this.getWorkspace(id);
    if (workspace.kind === 'managed' && workspace.state === 'ready') throw new Error('Remove a ready managed worktree instead; forgetting it would leave it unmanaged');
    if (this.activeSessions().some(session => session.workspaceId === id)) throw new Error('A session is still running in this workspace');
    this.audit('workspace-forgotten', { id, path: workspace.path });
    return this.saveWorkspace({ ...workspace, state: 'removed', removedAt: now() });
  }
  // The project as seen from a workspace (or its own checkout when null).
  view(projectId, workspaceId = null) {
    const project = this.project(projectId);
    if (!workspaceId) return project;
    if (workspaceId.startsWith('root:')) {
      // An additional folder as the session's working directory. Knowledge
      // keeps the primary repository's branch; the folder keeps its own Git identity.
      const root = project.roots.find(entry => entry.id === workspaceId.slice(5));
      if (!root) throw new Error('That folder is no longer part of this project');
      const status = folderStatus(root); if (!status.exists) throw new Error(`Folder ${root.path} no longer exists`);
      return { ...project, cwd: root.path, cwdBranch: status.currentBranch, cwdHead: status.head, cwdIsGit: root.kind === 'git', cwdGitRoot: root.gitRoot ?? root.path, workspaceId };
    }
    const workspace = this.getWorkspace(workspaceId);
    if (workspace.projectId !== projectId) throw new Error('Workspace belongs to another project');
    return workspaceView(project, workspace);
  }

  listSessions(projectId, includeArchived = false) {
    this.project(projectId);
    return this.db.prepare(`SELECT body FROM sessions WHERE project_id=? AND coalesce(json_extract(body,'$.removed'),0)=0 AND (? OR coalesce(json_extract(body,'$.archived'),0)=0) ORDER BY rowid DESC LIMIT 200`).all(projectId, includeArchived ? 1 : 0).map(parse);
  }
  liveSessions() { return this.db.prepare(`SELECT body FROM sessions WHERE json_extract(body,'$.status') IN ${LIVE} ORDER BY rowid LIMIT 100`).all().map(parse); }
  // Sessions needing attention across all projects: running, waiting or orphaned.
  activeSessions() { return this.db.prepare(`SELECT body FROM sessions WHERE json_extract(body,'$.status') IN ('starting','running','waiting','stopping','orphaned') AND coalesce(json_extract(body,'$.removed'),0)=0 ORDER BY rowid DESC LIMIT 100`).all().map(parse); }
  // Archiving moves a session out of Recent; a running one keeps running and
  // stays in Active, marked archived, until it ends.
  archiveSession(id) { return this.updateSessionUser(id, { archived: true, archivedAt: now() }); }
  // Bounded per-session timeline. Bodies are small metadata: no terminal
  // output, prompts or tool results.
  appendEvent(sessionId, kind, body) {
    const text = JSON.stringify(body ?? {});
    if (text.length > 4000) throw new Error('Timeline event is too large');
    this.db.prepare('INSERT INTO events(session_id,at,kind,body) VALUES(?,?,?,?)').run(sessionId, now(), choice(kind, ['start', 'resume', 'context', 'prompt', 'permission', 'turn-end', 'command-start', 'command-end', 'file', 'interrupt', 'stop', 'exit', 'error', 'recovered', 'cleanup', 'disconnected'], 'event kind'), text);
    this.eventCounts ??= new Map(); const count = (this.eventCounts.get(sessionId) ?? 0) + 1; this.eventCounts.set(sessionId, count);
    if (count % 50 === 0) this.db.prepare(`DELETE FROM events WHERE session_id=? AND id <= (SELECT id FROM events WHERE session_id=? ORDER BY id DESC LIMIT 1 OFFSET ${EVENT_LIMIT})`).run(sessionId, sessionId);
  }
  listEvents(sessionId, limit = 500) {
    this.getSession(sessionId);
    return this.db.prepare('SELECT * FROM (SELECT id,at,kind,body FROM events WHERE session_id=? ORDER BY id DESC LIMIT ?) ORDER BY id').all(sessionId, Math.min(Math.max(1, limit), EVENT_LIMIT))
      .map(row => ({ id: row.id, at: row.at, kind: row.kind, body: JSON.parse(row.body) }));
  }
  // Git views (baselines, changes) of where the session actually runs.
  cwdView(view) {
    if (!view.cwd) return view;
    if (!view.cwdIsGit) throw new Error('This folder is not a Git repository, so changes cannot be listed');
    // Git runs at the repository root; a subfolder of another repository is listed by prefix.
    const prefix = relative(view.cwdGitRoot, view.cwd).split(sep).join('/');
    return { ...view, root: view.cwdGitRoot, head: view.cwdHead, branch: view.cwdBranch, pathPrefix: prefix ? `${prefix}/` : '' };
  }
  checkoutBaseline(projectId, workspaceId = null) { const view = this.view(projectId, workspaceId); return view.cwd && !view.cwdIsGit ? null : checkoutBaseline(this.cwdView(view)); }
  sessionView(session) { return this.cwdView(this.view(session.projectId, session.workspaceId ?? null)); }
  sessionChanges(sessionId) {
    const session = this.getSession(sessionId); let view;
    try { view = this.sessionView(session); } catch (error) { return { base: session.head ?? '', available: false, reason: `${error.message}. Changes for this session are no longer available.`, files: [] }; }
    return sessionChanges(view, session);
  }
  openableFile(sessionId, path) { const session = this.getSession(sessionId); return openableFile(this.sessionView(session), session, path); }
  sessionFileDiff(sessionId, path) { const session = this.getSession(sessionId); return fileDiff(this.sessionView(session), session, path); }
  recoverSessions() {
    for (const row of this.db.prepare('SELECT body FROM sessions').all()) {
      const session = parse(row);
      if (['running', 'starting', 'waiting'].includes(session.status)) {
        this.saveSession({ ...session, status: 'interrupted', endedAt: now() });
        const receipt = this.getReceipt(session.receiptId);
        if (['prepared', 'submitted'].includes(receipt.state)) this.updateReceiptState(receipt.id, 'uncertain', session.id);
      }
    }
  }
}
