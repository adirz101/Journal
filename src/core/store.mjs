import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { git, inspectProject } from './project.mjs';
import { captureEvidence, validateEvidence } from './evidence.mjs';
import { choice, relativePath, refuseCredentials, text } from './validation.mjs';
import { branchDraft, commitsSince, overviewDraft, PLACEHOLDER } from './status.mjs';
import { aliasesFor, areaMatches, isDuplicate, possibleConflict, queryTerms } from './retrieval.mjs';
import { checkoutBaseline, fileDiff, openableFile, sessionChanges } from './changes.mjs';
import { classifyFolder, folderStatus } from './projects.mjs';
import { SESSION_USER_FIELDS, survivorScanPending } from './sessions.mjs';
import { basename, join, relative, sep } from 'node:path';
import { applyRetention, backupTo, checkpoint, exportBrain, importBrain, purgeSession, storageInfo } from './maintenance.mjs';
import { ruleProposals, statusProposal, testCommandProposals } from './proposals.mjs';
import { addWorktree, creationNotices, listGitWorktrees, plannedPath, registered, removalBlockers, removeWorktree, resolveBase, validateBranchName, workspaceView } from './workspaces.mjs';
import { redact } from './validation.mjs';
import { fingerprintSync, treePath } from './files.mjs';
import { MAX_REFERENCES, pathFromCwd, referencesBlock } from './references.mjs';
import { deliveryCounts, memoryChecks, memoryOrigins, noteIds, sessionProposals, sessionSummary, staleNotesForSession } from './insights.mjs';

const LIVE = "('starting','running','waiting','stopping')";
const EVENT_LIMIT = 2000;

const parse = row => row ? JSON.parse(row.body) : null;
const now = () => new Date().toISOString();
const NO_BRIEF_WARNING = 'No current approved project brief is included. Add a checkout-scoped brief to orient every session.';
const categories = ['brief', 'decision', 'constraint', 'convention', 'lesson', 'issue'];
// One row per note in a launch that reached (or may have reached) the agent. Previews
// (never stored), prepared and failed launches are not deliveries. RECORD_DELIVERIES
// scans every receipt (the v8 backfill); RECORD_RECEIPT_DELIVERIES records one launch
// and finds its receipt through the primary key.
export const RECORD_DELIVERIES = `INSERT OR IGNORE INTO deliveries(receipt_id, memory_id, revision, project_id, session_id, provider, native_id, at)
  SELECT r.id, json_extract(i.value,'$.id'), json_extract(i.value,'$.revision'), r.project_id,
    coalesce(json_extract(r.body,'$.sessionId'), s.id), json_extract(s.body,'$.provider'), json_extract(s.body,'$.nativeId'),
    coalesce(json_extract(r.body,'$.updatedAt'), json_extract(r.body,'$.createdAt'))
  FROM receipts r JOIN json_each(r.body,'$.items') i
  LEFT JOIN sessions s ON s.id = coalesce(json_extract(r.body,'$.sessionId'),
    (SELECT s2.id FROM sessions s2 WHERE json_extract(s2.body,'$.receiptId')=r.id LIMIT 1))
  WHERE json_extract(r.body,'$.state') IN ('submitted','uncertain') AND json_extract(i.value,'$.id') IS NOT NULL`;
export const RECORD_RECEIPT_DELIVERIES = `${RECORD_DELIVERIES} AND r.id=?`;

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
      // Note trust: origin lookups, approval time and a per-conversation delivery count.
      [8, () => {
        const columns = new Set(this.db.prepare('PRAGMA table_info(memories)').all().map(column => column.name));
        if (!columns.has('approved_at')) this.db.exec('ALTER TABLE memories ADD COLUMN approved_at TEXT');
        if (!columns.has('approved_revision')) this.db.exec('ALTER TABLE memories ADD COLUMN approved_revision INTEGER');
        this.db.exec(`CREATE INDEX IF NOT EXISTS proposals_memory ON proposals(json_extract(body,'$.memoryId'));
          CREATE INDEX IF NOT EXISTS proposals_session ON proposals(json_extract(body,'$.evidence.sessionId'));
          CREATE TABLE IF NOT EXISTS deliveries(receipt_id TEXT NOT NULL, memory_id TEXT NOT NULL, revision INTEGER, project_id TEXT NOT NULL,
            session_id TEXT, provider TEXT, native_id TEXT, at TEXT NOT NULL, PRIMARY KEY(receipt_id, memory_id));
          CREATE INDEX IF NOT EXISTS deliveries_memory ON deliveries(project_id, memory_id);
          CREATE INDEX IF NOT EXISTS deliveries_session ON deliveries(session_id);`);
        // Latest approval per note, in one ordered pass over the audit log (no per-row subquery).
        const latest = new Map();
        for (const row of this.db.prepare(`SELECT at, body FROM audit WHERE action='memory-active' ORDER BY id`).all()) {
          try { const body = JSON.parse(row.body); if (typeof body.id === 'string') latest.set(body.id, { at: row.at, revision: Number.isInteger(body.revision) ? body.revision : null }); } catch { /* truncated body: skip */ }
        }
        const set = this.db.prepare('UPDATE memories SET approved_at=?, approved_revision=? WHERE id=?');
        for (const [id, approval] of latest) set.run(approval.at, approval.revision, id);
        this.db.prepare(RECORD_DELIVERIES).run();
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
      for (const table of ['sessions', 'receipts', 'deliveries', 'proposals', 'workspaces']) this.db.prepare(`DELETE FROM ${table} WHERE project_id=?`).run(id);
      this.db.prepare('DELETE FROM projects WHERE id=?').run(id);
      this.audit('project-removed', { id, deleteData: true, knowledge: revisionIds.length });
    });
    return { removed: id, deletedData: true };
  }
  // The internal `branch` option (never reachable from the renderer) binds branch-scoped knowledge to the
  // branch a suggestion came from instead of the checked-out one. Briefs always follow the checkout.
  proposeMemory(projectId, input, options = {}) {
    const { item, expected } = this.prepareMemory(projectId, input, options);
    this.transaction(() => this.writeMemory(item, expected));
    return { ...item, status: 'candidate', validation: 'current' };
  }
  // Every check, Git query and evidence read of a new revision, with no writes, so
  // Git and file I/O never run inside BEGIN IMMEDIATE. `view` (internal) is the copy
  // the evidence is read from: a ready worktree on the note's branch, or the checkout.
  // expected: the revision the note had when it was checked (null for a new note).
  prepareMemory(projectId, input, { branch: boundBranch = null, view = null } = {}) {
    const project = this.project(projectId); const seen = view ?? project;
    const statement = text(input.statement, 'statement'); refuseCredentials(statement);
    const category = choice(input.category, categories, 'category');
    const scope = choice(input.scope, ['checkout', 'branch'], 'scope');
    const target = scope === 'branch' ? boundBranch ?? seen.branch : null;
    if (scope === 'branch' && !target) throw new Error('Branch scope requires a named branch');
    if (input.source?.rootId && scope === 'branch') throw new Error('Notes on one branch must come from the primary repository; choose All branches for notes from additional folders');
    if (scope === 'branch' && boundBranch) {
      if (category === 'brief') throw new Error('A project summary follows the checked-out branch');
      // Cheap checks first, then Git; the name is validated so it can never be read as an option.
      const invalid = () => new Error(`Invalid branch name: ${String(boundBranch).slice(0, 80)}`);
      if (typeof boundBranch !== 'string' || boundBranch.startsWith('-') || boundBranch.length > 200) throw invalid();
      try { git(project.root, ['check-ref-format', '--branch', boundBranch]); } catch { throw invalid(); }
      // Exact spelling: a case-insensitive file system must not match feature/Flags to feature/flags.
      let listed = ''; try { listed = git(project.root, ['for-each-ref', '--format=%(refname:short)', `refs/heads/${boundBranch}`]); } catch { /* treated as missing */ }
      if (listed !== boundBranch) throw new Error(`The branch ${boundBranch} no longer exists; this suggestion cannot be remembered. Dismiss it to clear it from your suggestions.`);
    }
    const area = relativePath(input.area ?? '', true);
    // Optional environment qualifier ("macOS only", "with Docker running").
    const environment = text(input.environment ?? '', 'environment qualifier', 200, true); if (environment) refuseCredentials(environment);
    // A revision of a replacement keeps what it replaces unless told otherwise.
    const carried = !input.supersedes && input.memoryId ? (() => { try { return this.getMemory(input.memoryId).supersedes?.id ?? null; } catch { return null; } })() : null;
    const supersedes = input.supersedes || carried ? this.getMemory(input.supersedes || carried) : null;
    if (supersedes && supersedes.projectId !== projectId) throw new Error('Superseded memory belongs to another project');
    if (supersedes && (supersedes.id === input.memoryId || (supersedes.status !== 'active' && !carried))) throw new Error('Only another remembered note can be replaced; revise a note to change it');
    if (category === 'brief' && area) throw new Error('A project summary applies to the whole project; leave the area empty');
    if (input.source?.kind === 'git' && PLACEHOLDER.test(statement)) throw new Error('Replace the bracketed placeholders before saving the update');
    const source = captureEvidence(seen, input.source);
    let previous = null;
    if (input.memoryId) {
      previous = this.getMemory(input.memoryId);
      if (previous.projectId !== projectId) throw new Error('Memory belongs to another project');
      if (previous.scope === 'branch' && scope === 'branch' && !boundBranch && previous.branch !== seen.branch) throw this.wrongBranch(projectId, previous.branch, 'revise');
    }
    const id = previous?.id ?? randomUUID();
    const revision = (previous?.revision ?? 0) + 1;
    const branch = target;
    // Flag, never block: the reviewer decides whether two claims really conflict.
    const conflicts = this.conflictsWith(projectId, id, { statement, scope, branch, area });
    const item = { id, projectId, revisionId: randomUUID(), revision, statement, category, scope, area,
      branch, source, conflicts, createdAt: now(), ...(environment ? { environment } : {}),
      ...(supersedes ? { supersedes: { id: supersedes.id, revision: supersedes.revision } } : {}),
      ...(input.promotedFrom ? { promotedFrom: input.promotedFrom } : {}) };
    return { item, expected: previous?.revisionId ?? null };
  }
  // Remembered notes a statement may contradict (at most 5), from SQLite alone.
  conflictsWith(projectId, id, { statement, scope, branch, area }) {
    return this.db.prepare(`SELECT r.body FROM memories m JOIN revisions r ON r.id=m.current_revision
      WHERE m.project_id=? AND m.status='active' AND m.id<>? LIMIT 500`).all(projectId, id).map(parse)
      .filter(other => (other.scope === 'checkout' || scope === 'checkout' || other.branch === branch) && (!other.area || !area || other.area.startsWith(area) || area.startsWith(other.area)))
      .filter(other => possibleConflict(statement, other.statement)).slice(0, 5)
      .map(other => ({ id: other.id, revision: other.revision, statement: other.statement.slice(0, 160) }));
  }
  // The writes of a prepared revision, without a transaction of its own: the caller
  // holds one. The note must still be at the revision prepareMemory saw.
  writeMemory(item, expected) {
    const row = this.db.prepare('SELECT current_revision FROM memories WHERE id=?').get(item.id);
    if ((row?.current_revision ?? null) !== expected) throw new Error('This note changed while you were checking it; try again');
    this.db.prepare('INSERT INTO memories(id,project_id,current_revision,status) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET current_revision=excluded.current_revision,status=excluded.status').run(item.id, item.projectId, item.revisionId, 'candidate');
    this.db.prepare('INSERT INTO revisions VALUES(?,?,?,?)').run(item.revisionId, item.id, item.revision, JSON.stringify(item));
    this.db.prepare('INSERT INTO memory_fts(revision_id,statement,aliases) VALUES(?,?,?)').run(item.revisionId, item.statement, aliasesFor(item));
  }
  // Remembering a checked candidate, without a transaction of its own. via (internal,
  // set by the main process or core) labels a one-step path in the audit log.
  // retire: false (reaffirm) keeps the supersedes record without archiving what it replaced again.
  approveMemory(memory, { via = null, reason = null, retire = true } = {}) {
    const { id } = memory;
    // Only the revision that was checked is remembered; a newer one (another window) is left for review.
    const { changes } = this.db.prepare(`UPDATE memories SET status='active', approved_at=?, approved_revision=? WHERE id=? AND current_revision=?`).run(now(), memory.revision, id, memory.revisionId);
    if (changes !== 1) throw new Error('This note changed while you were checking it; try again');
    const retired = retire ? memory.supersedes?.id ?? null : null;
    // Approving a replacement retires the claim it supersedes.
    if (retired) this.db.prepare(`UPDATE memories SET status='archived', pinned=0 WHERE id=? AND status='active'`).run(retired);
    if (memory.category === 'brief' && memory.scope === 'branch') this.db.prepare(`UPDATE proposals SET body=json_set(body,'$.state','accepted','$.memoryId',?) WHERE project_id=? AND json_extract(body,'$.kind')='branch-status' AND json_extract(body,'$.branch')=? AND json_extract(body,'$.state')='open'`).run(id, memory.projectId, memory.branch);
    this.audit('memory-active', { id, revision: memory.revision, reason, supersedes: retired, ...(via ? { via } : {}) });
  }
  // Where a note can be checked for approval: the checkout, or for a note on another
  // branch a ready separate copy (worktree) whose live branch is that branch. Folder
  // notes are project-level and always use the checkout.
  approvalView(memory) {
    const project = this.project(memory.projectId);
    if (memory.scope !== 'branch' || memory.source?.rootId || project.branch === memory.branch) return project;
    for (const row of this.db.prepare(`SELECT body FROM workspaces WHERE project_id=? AND json_extract(body,'$.state')='ready' ORDER BY rowid`).all(memory.projectId)) {
      const workspace = parse(row); if (!existsSync(workspace.path)) continue;
      try { const view = workspaceView(project, workspace); if (view.branch === memory.branch) return view; } catch { /* not a usable copy */ }
    }
    return project;
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
    if (scope === 'branch' && !project.branch) throw new Error('"Where this branch stands" needs a named branch');
    const row = this.db.prepare(`SELECT r.body,m.status FROM memories m JOIN revisions r ON r.id=m.current_revision
      WHERE m.project_id=? AND m.status IN ('active','candidate') AND json_extract(r.body,'$.category')='brief'
      AND json_extract(r.body,'$.scope')=? AND (? = 'checkout' OR json_extract(r.body,'$.branch')=?)
      ORDER BY m.status='active' DESC, r.rowid DESC LIMIT 1`).get(projectId, scope, scope, project.branch);
    const previous = row ? { ...parse(row), status: row.status } : null;
    const draft = scope === 'branch' ? branchDraft(project, previous) : overviewDraft(project, previous);
    return { scope, memoryId: previous?.id ?? null, previousRevision: previous?.revision ?? null, previousStatement: previous?.statement ?? null, ...draft };
  }
  // Paged, filtered list for the knowledge panel; validation runs per page.
  // Category counts ignore the category; the other-branch count ignores the category, the
  // other-branch toggle and the note list, so each control shows what choosing it would list.
  listMemoryPage(projectId, { offset = 0, limit = 100, filter = 'all', search = '', category = 'all', otherBranch = false, ids = null } = {}) {
    const project = this.project(projectId); const cache = new Map();
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid page');
    const statuses = { all: ['candidate', 'active'], review: ['candidate'], active: ['active'], history: ['candidate', 'active', 'rejected', 'archived'] }[choice(filter, ['all', 'review', 'active', 'history'], 'filter')];
    search = text(search, 'search', 200, true).toLocaleLowerCase();
    choice(category, ['all', ...categories], 'category');
    if (typeof otherBranch !== 'boolean') throw new Error('Invalid filter');
    const list = ids === null ? null : noteIds(ids);
    const base = [`m.project_id=? AND m.status IN (${statuses.map(() => '?').join(',')}) AND (?='' OR instr(lower(json_extract(r.body,'$.statement')),?)>0 OR instr(lower(coalesce(json_extract(r.body,'$.source.path'),'')),?)>0 OR json_extract(r.body,'$.category')=?)`,
      [projectId, ...statuses, search, search, search, search]];
    // With a detached HEAD (no branch), every branch note belongs to another branch.
    const other = [`json_extract(r.body,'$.scope')='branch' AND json_extract(r.body,'$.branch') IS NOT ?`, [project.branch ?? null]];
    const conditions = [base, ...(otherBranch ? [other] : []), ...(list ? [['m.id IN (SELECT value FROM json_each(?))', [list]]] : [])];
    const join = parts => [parts.map(([sql]) => `(${sql})`).join(' AND '), parts.flatMap(([, args]) => args)];
    const [where, args] = join([...conditions, [`(?='all' OR json_extract(r.body,'$.category')=?)`, [category, category]]]);
    const from = 'FROM memories m JOIN revisions r ON r.id=m.current_revision';
    const total = this.db.prepare(`SELECT count(*) AS n ${from} WHERE ${where}`).get(...args).n;
    const items = this.db.prepare(`SELECT r.body,m.status,m.pinned ${from} WHERE ${where} ORDER BY m.pinned DESC, r.rowid DESC LIMIT ? OFFSET ?`).all(...args, limit, offset)
      .map(row => { const item = { ...parse(row), status: row.status, pinned: !!row.pinned }; const validation = this.validation(project, item, cache); return { ...item, validation, drift: validation === 'current' ? this.drift(project, item, cache) : null }; });
    const counts = Object.fromEntries(this.db.prepare('SELECT status, count(*) AS n FROM memories WHERE project_id=? GROUP BY status').all(projectId).map(row => [row.status, row.n]));
    const [byWhere, byArgs] = join(conditions);
    const categoryCounts = Object.fromEntries(['all', ...categories].map(name => [name, 0]));
    for (const row of this.db.prepare(`SELECT json_extract(r.body,'$.category') AS category, count(*) AS n ${from} WHERE ${byWhere} GROUP BY 1`).all(...byArgs)) {
      categoryCounts.all += row.n; if (Object.hasOwn(categoryCounts, row.category) && row.category !== 'all') categoryCounts[row.category] = row.n;
    }
    const [otherWhere, otherArgs] = join([base, other]);
    const otherCount = this.db.prepare(`SELECT count(*) AS n ${from} WHERE ${otherWhere}`).get(...otherArgs).n;
    return { items, total, offset, limit, counts, categoryCounts, otherBranch: otherCount };
  }
  // Git refuses to check out a branch that another worktree has checked out.
  wrongBranch(projectId, branch, verb) {
    const open = this.db.prepare(`SELECT 1 FROM workspaces WHERE project_id=? AND json_extract(body,'$.branch')=? AND json_extract(body,'$.state')='ready'`).get(projectId, branch);
    // Approval runs in a ready copy on the branch (approvalView); revising from a worktree is not offered yet.
    return new Error(open && verb !== 'approve' ? `This note belongs to branch ${branch}, which is open in a separate copy (worktree); revising it from there is not available yet. You can reject it.`
      : `This note belongs to branch ${branch}; check out that branch to ${verb === 'approve' ? 'remember' : verb} it`);
  }
  setMemoryStatus(id, status, { reason = null } = {}) {
    choice(status, ['active', 'rejected', 'archived'], 'status');
    if (reason !== null) choice(reason, ['incorrect', 'superseded', 'withdrawn'], 'reason');
    const memory = this.getMemory(id);
    if (status === 'active' && memory.status !== 'candidate') throw new Error('Only a note waiting for review can be remembered');
    if (status === 'active') {
      const validation = this.validation(this.approvalView(memory), memory);
      if (validation === 'wrong-branch') throw this.wrongBranch(memory.projectId, memory.branch, 'approve');
      if (validation !== 'current') throw new Error('Evidence or branch changed; revise the note before remembering it');
      this.transaction(() => this.approveMemory(memory, { reason }));
      return this.getMemory(id);
    }
    this.transaction(() => {
      // Archive and reject keep approved_at: an archived note still says when it was remembered.
      this.db.prepare('UPDATE memories SET status=?, pinned=0 WHERE id=?').run(status, id);
      this.audit(`memory-${status}`, { id, revision: memory.revision, reason, supersedes: null });
    });
    return this.getMemory(id);
  }
  memoryOrigins(projectId, ids) { return memoryOrigins(this, projectId, ids); }
  deliveryCounts(projectId, ids) { return deliveryCounts(this, projectId, ids); }
  memoryChecks(projectId, options) { return memoryChecks(this, projectId, options); }
  setPinned(id, pinned) {
    const memory = this.getMemory(id);
    if (typeof pinned !== 'boolean') throw new Error('Invalid pin');
    if (pinned && memory.status !== 'active') throw new Error('Only a remembered note can be pinned');
    this.db.prepare('UPDATE memories SET pinned=? WHERE id=?').run(pinned ? 1 : 0, id); this.audit(pinned ? 'memory-pinned' : 'memory-unpinned', { id });
    return this.getMemory(id);
  }
  // A branch-scoped claim proposed for every branch: a new candidate that
  // still needs review; the branch claim stays as it is.
  proposePromotion(id) {
    const memory = this.getMemory(id);
    if (memory.scope !== 'branch' || memory.status !== 'active') throw new Error('Only a remembered note on one branch can be proposed for all branches');
    if (memory.category === 'brief') throw new Error('"Where this branch stands" describes one branch; write "About this project" instead');
    const source = memory.source.kind === 'file' ? { kind: 'file', path: memory.source.path, startLine: memory.source.startLine, endLine: memory.source.endLine }
      : { kind: 'user', note: `${memory.source.note ?? 'Reviewed claim'} (promoted from branch ${memory.branch})`.slice(0, 2000) };
    return this.proposeMemory(memory.projectId, { statement: memory.statement, category: memory.category, scope: 'checkout', area: memory.area, environment: memory.environment, source,
      promotedFrom: { id: memory.id, revision: memory.revision, branch: memory.branch } });
  }
  prepareContext(projectId, query, { workspaceId = null, disabled = [], references = [], persist = true } = {}) {
    query = text(query, 'task', 4000, true); refuseCredentials(query);
    if (!Array.isArray(disabled) || disabled.length > 100 || disabled.some(x => typeof x !== 'string')) throw new Error('Invalid disabled claims');
    const project = this.view(projectId, workspaceId);
    const referenced = this.resolveReferences(projectId, workspaceId, project, references);
    // Referenced paths also select knowledge: their words match claims, and
    // area-scoped claims for a referenced area become eligible.
    const areaQuery = [query, ...referenced.map(ref => ref.path)].join(' ');
    const terms = queryTerms(areaQuery);
    const cache = new Map();
    const referencedPaths = referenced.filter(ref => ref.family === 'primary').map(ref => ref.path);
    const selected = this.selectCandidates(projectId, project, { areaQuery, terms, referencedPaths, check: item => this.validation(project, item, cache) });
    const id = randomUUID();
    const assembled = this.assemblePacket(selected.matches, project, { id, disabled, areaQuery, drift: memory => this.drift(project, memory, cache) });
    const { items, excluded } = assembled; const disabledSet = new Set(disabled);
    this.matchedTerms(items, terms);
    const warnings = [...selected.warnings, ...assembled.warnings];
    // References carry paths, ranges and hashes, never contents.
    const packet = assembled.packet + referencesBlock(referenced);
    const receipt = { id, projectId, query, packet, items, excluded, warnings, disabled: [...disabledSet], workspaceId, references: referenced, checkout: { root: project.root, branch: project.branch, head: project.head }, state: 'prepared', estimatedTokens: Math.ceil(Buffer.byteLength(packet) / 3), createdAt: now(), terms };
    // Previews show what would be sent; only a launch keeps an immutable receipt.
    if (!persist) return { ...receipt, preview: true };
    this.db.prepare('INSERT INTO receipts VALUES(?,?,?)').run(id, projectId, JSON.stringify(receipt));
    return receipt;
  }
  // Candidate rows in delivery order: briefs, pinned rules, referenced areas,
  // then paged FTS matches. check(item) returns the validation word; a page
  // counts an item as eligible when it is 'current' or 'unchecked' (the typing
  // preview) and its area applies.
  selectCandidates(projectId, project, { areaQuery, terms, referencedPaths, check }) {
    const matches = []; const warnings = []; const matchedIds = new Set();
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
      for (const row of [checkoutBriefs[i], branchBriefs[i]]) if (row) matches.push({ ...row, validation: check(parse(row)), reason: parse(row).scope === 'checkout' ? 'repo overview' : 'branch update' });
    }
    // Pinned rules come next, independent of task words but never exempt from
    // scope, freshness or area rules.
    for (const row of this.db.prepare(`SELECT r.body,m.status FROM memories m JOIN revisions r ON r.id=m.current_revision
      WHERE m.project_id=? AND m.status='active' AND m.pinned=1 AND json_extract(r.body,'$.category')!='brief'
      AND (json_extract(r.body,'$.scope')='checkout' OR json_extract(r.body,'$.branch')=?) ORDER BY r.rowid DESC LIMIT 20`).all(projectId, project.branch)) {
      matches.push({ ...row, validation: check(parse(row)), reason: 'pinned', pinned: true }); matchedIds.add(parse(row).id);
    }
    // Claims scoped to an area the user referenced (a file or folder of the
    // primary repository inside that area, or the area inside a referenced folder).
    if (referencedPaths.length) {
      for (const row of this.db.prepare(`SELECT r.body,m.status FROM memories m JOIN revisions r ON r.id=m.current_revision
        WHERE m.project_id=? AND m.status='active' AND coalesce(json_extract(r.body,'$.area'),'')<>'' AND json_extract(r.body,'$.category')!='brief'
        AND (json_extract(r.body,'$.scope')='checkout' OR json_extract(r.body,'$.branch')=?) ORDER BY r.rowid DESC LIMIT 200`).all(projectId, project.branch)) {
        const item = parse(row); if (matchedIds.has(item.id)) continue;
        const area = item.area.replace(/\/+$/, '');
        if (!referencedPaths.some(path => path === area || path.startsWith(`${area}/`) || area.startsWith(`${path}/`))) continue;
        matches.push({ ...row, validation: check(item), reason: `referenced area ${area}` }); matchedIds.add(item.id);
      }
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
          const validation = check(item);
          const valid = (validation === 'current' || validation === 'unchecked') && areaMatches(item.area, areaQuery);
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
    return { matches, warnings };
  }
  // Exclusions, duplicates, the brief and category limits and the
  // 12-claim/6000-byte budget, in candidate order; then the packet text and
  // its warnings. 'unchecked' (the typing preview) counts as current.
  assemblePacket(matches, project, { id, disabled, areaQuery, drift }) {
    const items = []; const excluded = []; const warnings = []; let briefCount = 0; const perCategory = new Map();
    const disabledSet = new Set(disabled);
    const header = `Journal project knowledge — checkout ${project.head ?? 'unborn'}, receipt ${id}\nProject: ${project.name}; branch ${project.branch ?? 'detached HEAD'}.\n${project.cwd ? `Working folder: ${project.cwd}. Evidence paths without a folder are relative to the primary repository at ${project.root}.\n` : ''}These are reviewed, scoped claims with evidence. Native project instructions take precedence. Validate against current code.\n`;
    let packet = header;
    for (const row of matches) {
      const memory = { ...parse(row), status: row.status };
      const validation = row.validation;
      if (disabledSet.has(memory.id)) { if (excluded.length < 100) excluded.push({ id: memory.id, reason: 'left-out-for-task' }); continue; }
      if (validation !== 'current' && validation !== 'unchecked') { if (excluded.length < 100) excluded.push({ id: memory.id, reason: validation }); continue; }
      if (!areaMatches(memory.area, areaQuery)) { if (excluded.length < 100) excluded.push({ id: memory.id, reason: 'area-not-requested' }); continue; }
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
      const commits = drift(memory);
      const age = commits ? `; ${commits} commit${commits === 1 ? '' : 's'} since this update` : '';
      const label = memory.category === 'brief' ? `${memory.scope === 'checkout' ? 'Project brief' : 'Branch update'}\n` : '';
      const qualifier = memory.environment ? `\nApplies when: ${memory.environment}` : '';
      const chunk = `\n${label}[${memory.id} r${memory.revision}; ${memory.category}; ${memory.scope}${memory.branch ? ` ${memory.branch}` : ''}${memory.area ? `; area ${memory.area}` : ''}]\n${memory.statement}${qualifier}\nEvidence: ${evidence}${age}\n`;
      if (items.length >= 12 || Buffer.byteLength(packet + chunk) > 6000) { if (excluded.length < 100) excluded.push({ id: memory.id, reason: 'budget' }); continue; }
      items.push({ ...memory, selection: { reason: row.reason ?? 'matched', bytes: Buffer.byteLength(chunk) } }); packet += chunk; if (memory.category === 'brief') briefCount++;
      else perCategory.set(memory.category, (perCategory.get(memory.category) ?? 0) + 1);
      if (commits) warnings.push(`The current branch update is ${commits} commit${commits === 1 ? '' : 's'} behind HEAD. Propose a status update to review recent progress.`);
    }
    for (const [index, a] of items.entries()) for (const b of items.slice(index + 1)) {
      if (possibleConflict(a.statement, b.statement)) warnings.push(`Claims ${a.id.slice(0, 8)} r${a.revision} and ${b.id.slice(0, 8)} r${b.revision} may conflict. Review them in Knowledge.`);
    }
    if (excluded.some(item => item.reason === 'brief-limit')) warnings.push('Only four current project brief entries fit the orientation limit. Consolidate superseded briefs.');
    if (matches.some(row => parse(row).category === 'brief' && excluded.some(item => item.id === parse(row).id && item.reason === 'budget'))) warnings.push('A project brief was excluded by the context budget. Shorten or consolidate the reviewed summaries.');
    if (!items.some(item => item.category === 'brief' && item.scope === 'checkout')) warnings.push(NO_BRIEF_WARNING);
    if (!items.length) packet = '';
    return { items, excluded, warnings, packet };
  }
  // The typing preview: what prepareContext would select, from SQLite alone.
  // It never runs Git, reads or hashes evidence, or writes. The branch is the
  // renderer's display hint, never trusted for launch: the full preview and the
  // launch validate again. Notes are 'unchecked' unless stored records exclude them.
  previewSelection(projectId, task, { workspaceId = null, branch = null, disabled = [], references = [] } = {}) {
    const query = text(task, 'task', 4000, true); refuseCredentials(query);
    if (!Array.isArray(disabled) || disabled.length > 100 || disabled.some(x => typeof x !== 'string')) throw new Error('Invalid disabled claims');
    const project = this.storedView(projectId, workspaceId, branch === null ? null : text(branch, 'branch', 255));
    // Reference paths only: resolving a reference hashes its file.
    if (!Array.isArray(references) || references.length > MAX_REFERENCES) throw new Error(`Reference up to ${MAX_REFERENCES} files or folders per task`);
    // resolveReferences' rules from stored records: a reference is primary unless
    // its root is an additional folder, and a primary path must come from the
    // session's own copy when the session itself runs in a primary copy.
    const sessionRoot = references.length ? this.storedRoot(projectId, project, workspaceId ?? 'checkout') : null;
    const paths = references.map(input => {
      if (!input || typeof input !== 'object') throw new Error('Invalid reference');
      if (input.projectId !== undefined && input.projectId !== projectId) throw new Error(`${input.path} was chosen in another project; add it again from this project`);
      const root = this.storedRoot(projectId, project, text(input.rootKey, 'reference root', 100));
      if (root.family === 'primary' && sessionRoot.family === 'primary' && root.key !== sessionRoot.key) throw new Error(`${input.path} is in ${root.label}, but this session runs in ${sessionRoot.label}. Reference it from the session's own copy.`);
      return { path: treePath(input.path), primary: root.family === 'primary' };
    });
    const areaQuery = [query, ...paths.map(ref => ref.path)].join(' ');
    const terms = queryTerms(areaQuery);
    const { matches, warnings } = this.selectCandidates(projectId, project, { areaQuery, terms, referencedPaths: paths.filter(ref => ref.primary).map(ref => ref.path), check: item => this.storedValidation(project, item) });
    const assembled = this.assemblePacket(matches, project, { id: randomUUID(), disabled, areaQuery, drift: () => null });
    this.matchedTerms(assembled.items, terms);
    // Whether a brief is current is known only after validation.
    return { kind: 'selection', checked: false, query, branch: project.branch, items: assembled.items, excluded: assembled.excluded,
      warnings: [...warnings, ...assembled.warnings.filter(warning => warning !== NO_BRIEF_WARNING)], bytes: Buffer.byteLength(assembled.packet), terms, taskNotes: this.taskNotes(projectId, project.branch) };
  }
  // The project as stored, seen from a workspace, on the branch the renderer shows.
  // The same checks and messages as view(), without Git or the file system.
  storedView(projectId, workspaceId, branch) {
    const stored = this.storedProject(projectId);
    if (stored.removed) throw new Error('This project was removed from Journal; open its folder again to restore it');
    const project = { ...this.describe(stored), branch };
    if (!workspaceId) return project;
    if (workspaceId.startsWith('root:')) {
      const root = project.roots.find(entry => entry.id === workspaceId.slice(5));
      if (!root) throw new Error('That folder is no longer part of this project');
      return { ...project, cwd: root.path, workspaceId };
    }
    const workspace = this.getWorkspace(workspaceId);
    if (workspace.projectId !== projectId) throw new Error('Workspace belongs to another project');
    if (workspace.state !== 'ready') throw new Error(`Workspace ${workspace.branch ?? basename(workspace.path)} is ${workspace.state}`);
    return { ...project, root: workspace.path, head: workspace.head ?? project.head, workspaceId };
  }
  // fileRoot() from stored records only: the same keys, families, labels and
  // messages, without Git or checking that the folder still exists on disk.
  storedRoot(projectId, project, key) {
    if (key === 'checkout') return { key, family: 'primary', label: `${project.name} (checkout)` };
    if (typeof key === 'string' && key.startsWith('root:')) {
      if (!(project.roots ?? []).some(entry => `root:${entry.id}` === key)) throw new Error('That folder is no longer part of this project');
      return { key, family: 'folder' };
    }
    const workspace = this.getWorkspace(text(key, 'root', 100));
    if (workspace.projectId !== projectId) throw new Error('Workspace belongs to another project');
    if (workspace.state !== 'ready') throw new Error('This worktree is not available');
    return { key, family: 'primary', label: `${project.name} (worktree ${workspace.branch ?? basename(workspace.path)})` };
  }
  // validation() from stored records only: evidence is not read, so a note is
  // 'unchecked' rather than 'current'.
  storedValidation(project, memory) {
    if (memory.source?.rootId && !(project.roots ?? []).some(root => root.id === memory.source.rootId)) return 'folder-removed';
    // A guard: selectCandidates already filters branch scope in SQL, so a
    // candidate on another branch never reaches this check.
    if (memory.scope === 'branch' && project.branch !== memory.branch) return 'wrong-branch';
    return 'unchecked';
  }
  // selection.terms: the searched terms (task text and referenced paths) FTS
  // (porter stemming, no prefixes) matches in each selected note, one statement per term. Briefs never depend on task words.
  matchedTerms(items, terms) {
    const byRevision = new Map(items.map(item => [item.revisionId, []]));
    const ids = JSON.stringify(items.filter(item => item.category !== 'brief').map(item => item.revisionId));
    if (terms.length && ids !== '[]') {
      const check = this.db.prepare('SELECT revision_id FROM memory_fts WHERE memory_fts MATCH ? AND revision_id IN (SELECT value FROM json_each(?))');
      for (const term of terms) for (const { revision_id: revision } of check.all(`"${term.replaceAll('"', '""')}"`, ids)) byRevision.get(revision)?.push(term);
    }
    for (const item of items) item.selection.terms = item.category === 'brief' ? [] : byRevision.get(item.revisionId) ?? [];
    return items;
  }
  // Remembered notes a task could match on this branch: active, not briefs, checkout-wide or on the branch.
  taskNotes(projectId, branch) {
    return this.db.prepare(`SELECT count(*) AS n FROM memories m JOIN revisions r ON r.id=m.current_revision
      WHERE m.project_id=? AND m.status='active' AND json_extract(r.body,'$.category')!='brief'
      AND (json_extract(r.body,'$.scope')='checkout' OR json_extract(r.body,'$.branch')=?)`).get(projectId, branch).n;
  }
  // Files and folders the user chose for the next task, recorded with what
  // they were at selection time. A primary-repository path must come from the
  // same checkout or worktree the session runs in, so the agent never edits
  // the wrong copy.
  resolveReferences(projectId, workspaceId, view, references) {
    if (!Array.isArray(references) || references.length > MAX_REFERENCES) throw new Error(`Reference up to ${MAX_REFERENCES} files or folders per task`);
    if (!references.length) return [];
    const sessionKey = workspaceId ?? 'checkout'; const sessionRoot = this.fileRoot(projectId, sessionKey);
    const cwd = view.cwd ?? view.root; const seen = new Set();
    return references.map(input => {
      if (!input || typeof input !== 'object') throw new Error('Invalid reference');
      // A reference chosen in one project never resolves against another one's paths.
      if (input.projectId !== undefined && input.projectId !== projectId) throw new Error(`${input.path} was chosen in another project; add it again from this project`);
      const root = this.fileRoot(projectId, text(input.rootKey, 'reference root', 100));
      if (root.family === 'primary' && sessionRoot.family === 'primary' && root.key !== sessionRoot.key) throw new Error(`${input.path} is in ${root.label}, but this session runs in ${sessionRoot.label}. Reference it from the session's own copy.`);
      const path = treePath(input.path);
      const startLine = input.startLine ?? null; const endLine = input.endLine ?? startLine;
      const print = fingerprintSync(root.path, path, startLine, endLine);
      const absolute = join(root.path, ...path.split('/'));
      const display = pathFromCwd(cwd, absolute) ?? absolute;
      const key = `${root.key}\u0000${path}\u0000${startLine}-${endLine}`; if (seen.has(key)) return null; seen.add(key);
      return { kind: print.kind, source: 'user-reference', projectId, rootKey: root.key, rootLabel: root.label, family: root.family, path, display, startLine: print.kind === 'lines' ? startLine : null, endLine: print.kind === 'lines' ? endLine : null,
        contentHash: print.contentHash, rangeHash: print.rangeHash, head: root.head ?? null, createdAt: now() };
    }).filter(Boolean);
  }
  // A reference chosen for the next task, validated without recording anything.
  describeReference(projectId, workspaceId, input) {
    return this.resolveReferences(projectId, workspaceId ?? null, this.view(projectId, workspaceId ?? null), [input])[0];
  }
  // One reference for a running session, relative to where that session runs.
  referenceFor(sessionId, input) {
    const session = this.getSession(sessionId);
    if (input?.projectId && input.projectId !== session.projectId) throw new Error('That file belongs to another project');
    const workspaceId = session.workspaceId ?? null;
    const [reference] = this.resolveReferences(session.projectId, workspaceId, { ...this.view(session.projectId, workspaceId), cwd: session.cwd }, [input]);
    return { ...reference, provider: session.provider };
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
    // Older versions stored every preview as a prepared receipt without a session. Receipts are immutable,
    // so those stay stored but unlisted. A launch receipt is prepared until delivery records its session id,
    // but its session row names it from before the agent starts.
    return this.db.prepare(`SELECT r.body FROM receipts r WHERE r.project_id=? AND NOT (json_extract(r.body,'$.state')='prepared' AND json_extract(r.body,'$.sessionId') IS NULL
      AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.project_id=r.project_id AND json_extract(s.body,'$.receiptId')=r.id)) ORDER BY r.rowid DESC LIMIT 50`).all(projectId).map(parse);
  }
  // One transaction: the app and the runtime both record deliveries, and the
  // delivery rows must match the state change exactly once.
  updateReceiptState(id, state, sessionId, launchPrompt) {
    choice(state, ['submitted', 'failed', 'uncertain'], 'delivery state');
    if (launchPrompt !== undefined && (typeof launchPrompt !== 'string' || Buffer.byteLength(launchPrompt) > 32000)) throw new Error('Invalid launch prompt snapshot');
    return this.transaction(() => {
      const receipt = this.getReceipt(id);
      if (receipt.state !== 'prepared' && !(receipt.state === 'submitted' && state === 'uncertain')) throw new Error('Receipt delivery is already recorded');
      const updated = { ...receipt, state, sessionId: sessionId ?? receipt.sessionId, updatedAt: now(),
        ...(receipt.state === 'prepared' && launchPrompt !== undefined ? { launchPrompt } : {}) };
      this.db.prepare('UPDATE receipts SET body=? WHERE id=?').run(JSON.stringify(updated), id);
      // From prepared only: submitted → uncertain is the same delivery.
      if (receipt.state === 'prepared' && state !== 'failed') this.db.prepare(RECORD_RECEIPT_DELIVERIES).run(id);
      return updated;
    });
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
  // With sessionId: that session's suggestions and its resume chain's (earlier: true), each with
  // the remembered notes it may conflict with, so a one-click Remember is offered only without one.
  listProposals(projectId, state = 'open', { sessionId } = {}) {
    this.project(projectId); choice(state, ['open', 'accepted', 'dismissed'], 'proposal state');
    if (sessionId !== undefined && sessionId !== null) {
      const session = this.getSession(sessionId);
      if (session.projectId !== projectId) throw new Error('Session belongs to another project');
      return sessionProposals(this, session, state).map(proposal => proposal.kind === 'branch-status' || !proposal.statement ? proposal
        : { ...proposal, conflicts: this.conflictsWith(projectId, '', { statement: proposal.statement, scope: proposal.scope, branch: proposal.branch ?? null, area: '' }) });
    }
    return this.db.prepare(`SELECT body FROM proposals WHERE project_id=? AND json_extract(body,'$.state')=? ORDER BY rowid DESC LIMIT 100`).all(projectId, state).map(parse);
  }
  getProposal(id) {
    const proposal = parse(this.db.prepare('SELECT body FROM proposals WHERE id=?').get(text(id, 'proposal ID', 100)));
    if (!proposal) throw new Error('Unknown proposal'); return proposal;
  }
  // Accepting creates a candidate (still unapproved); status proposals open the helper instead.
  acceptProposal(id) {
    const proposal = this.openProposal(id);
    const memory = this.proposeMemory(proposal.projectId, { statement: proposal.statement, category: proposal.category, scope: proposal.scope, area: '', source: proposal.source },
      proposal.scope === 'branch' ? { branch: proposal.branch } : undefined);
    this.db.prepare('UPDATE proposals SET body=? WHERE id=?').run(JSON.stringify({ ...proposal, state: 'accepted', memoryId: memory.id, handledAt: now() }), id);
    this.audit('proposal-accepted', { id, memoryId: memory.id, kind: proposal.kind });
    return memory;
  }
  // ----- Phase 6: the session wrap-up -----
  sessionSummary(id) { return sessionSummary(this, id); }
  staleNotesForSession(sessionId, options) { return staleNotesForSession(this, sessionId, options); }
  // acceptProposal's checks, before anything is written.
  openProposal(id) {
    const proposal = this.getProposal(id);
    if (proposal.state !== 'open') throw new Error('This suggestion was already handled');
    if (proposal.kind === 'branch-status') throw new Error('This suggestion updates “Where this branch stands”. Use its own update button instead of Add for review.');
    if (proposal.scope === 'branch' && !proposal.branch) throw new Error('This suggestion was made without a branch checked out, so Journal cannot tell which branch it belongs to. Dismiss it to clear it from your suggestions.');
    if (proposal.evidence?.sessionId) this.getSession(proposal.evidence.sessionId);
    return proposal;
  }
  // One-step Remember (D1): the full statement was on screen. All or nothing. Every
  // item is checked (Git, evidence) before one transaction writes and remembers them
  // all; `via` (set by the main process) labels the audit entries.
  rememberProposals(ids, { via } = {}) {
    choice(via, ['wrap-up'], 'remember path');
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 5 || ids.some(id => typeof id !== 'string' || !id || id.length > 100) || new Set(ids).size !== ids.length) throw new Error('Choose 1 to 5 suggestions');
    const prepared = ids.map(id => {
      const proposal = this.openProposal(id);
      const branch = proposal.scope === 'branch' ? proposal.branch : null;
      // A branch suggestion is checked in a copy that has its branch checked out.
      const view = branch ? this.approvalView({ projectId: proposal.projectId, scope: 'branch', branch }) : null;
      if (branch && view.branch !== branch) throw this.wrongBranch(proposal.projectId, branch, 'approve');
      const { item, expected } = this.prepareMemory(proposal.projectId, { statement: proposal.statement, category: proposal.category, scope: proposal.scope, area: '', source: proposal.source },
        branch ? { branch, view } : {});
      if (item.conflicts.length) throw new Error(`"${proposal.statement.slice(0, 60)}" may conflict with a remembered note. Review it in Memory.`);
      return { proposal, item, expected };
    });
    if (new Set(prepared.map(({ proposal }) => proposal.projectId)).size > 1) throw new Error('Choose suggestions from one project');
    for (const [index, a] of prepared.entries()) for (const b of prepared.slice(index + 1)) {
      if (isDuplicate(a.item.statement, b.item.statement)) throw new Error(`"${b.item.statement.slice(0, 60)}" repeats another suggestion; remember only one of them`);
      const overlap = a.item.scope === 'checkout' || b.item.scope === 'checkout' || a.item.branch === b.item.branch;
      if (overlap && possibleConflict(a.item.statement, b.item.statement)) throw new Error(`"${b.item.statement.slice(0, 60)}" may contradict another suggestion; remember only one of them`);
    }
    return this.transaction(() => prepared.map(({ proposal, item, expected }) => {
      // Re-read inside the lock: another window may have handled it meanwhile.
      const current = this.getProposal(proposal.id);
      if (current.state !== 'open') throw new Error('This suggestion was already handled');
      // Again under the lock (SQLite only): a note remembered meanwhile may contradict it.
      if (this.conflictsWith(item.projectId, item.id, item).length) throw new Error(`"${proposal.statement.slice(0, 60)}" may conflict with a remembered note. Review it in Memory.`);
      this.writeMemory(item, expected);
      this.db.prepare('UPDATE proposals SET body=? WHERE id=?').run(JSON.stringify({ ...current, state: 'accepted', memoryId: item.id, handledAt: now() }), proposal.id);
      this.audit('proposal-accepted', { id: proposal.id, memoryId: item.id, kind: proposal.kind, via });
      this.approveMemory(this.getMemory(item.id), { via });
      return this.getMemory(item.id);
    }));
  }
  // "Still true": the user checked an out-of-date file note against the change. A new
  // revision with fresh evidence (the same statement, scope and qualifiers), remembered
  // at once with via 'reaffirm'. Earlier revisions are never edited; pinning is kept.
  // expectedHash: the file's contentHash from staleNotesForSession, the content the user
  // was shown; a file edited since then is refused rather than saved unseen.
  reaffirmMemory(id, { startLine, endLine, workspaceId = null, expectedHash } = {}) {
    const memory = this.getMemory(id);
    if (memory.status !== 'active' || memory.source?.kind !== 'file') throw new Error('Only a remembered note based on a file can be marked still true');
    if (workspaceId !== null && typeof workspaceId !== 'string') throw new Error('Invalid workspace');
    let view;
    if (memory.source.rootId || memory.scope !== 'branch') {
      // Folder notes are project-level; an all-branches note is checked against the main checkout.
      if (workspaceId !== null) throw new Error('Check this note from the main checkout');
      view = this.project(memory.projectId);
    } else {
      if (workspaceId?.startsWith('root:')) throw new Error('Check this note from the main checkout');
      view = this.view(memory.projectId, workspaceId);
      if (view.branch !== memory.branch) throw this.wrongBranch(memory.projectId, memory.branch, 'approve');
    }
    if (this.validation(view, memory) !== 'stale') throw new Error('This note\'s file is unchanged; there is nothing to check');
    if (typeof expectedHash !== 'string' || !/^[0-9a-f]{64}$/.test(expectedHash)) throw new Error('Check the change before marking the note still true');
    const source = { kind: 'file', ...(memory.source.rootId ? { rootId: memory.source.rootId } : {}), path: memory.source.path,
      startLine: startLine ?? memory.source.startLine, endLine: endLine ?? memory.source.endLine };
    // The view is on the note's branch, so a branch note keeps it without a bound branch.
    const { item, expected } = this.prepareMemory(memory.projectId, { memoryId: id, statement: memory.statement, category: memory.category, scope: memory.scope,
      area: memory.area, environment: memory.environment, source, ...(memory.promotedFrom ? { promotedFrom: memory.promotedFrom } : {}) }, { view });
    if (item.source.contentHash !== expectedHash) throw new Error('The file changed again; check it once more.');
    if (memory.supersedes) item.supersedes = memory.supersedes;
    this.transaction(() => { this.writeMemory(item, expected); this.approveMemory(this.getMemory(id), { via: 'reaffirm', retire: false }); });
    return { ...this.getMemory(id), validation: 'current' };
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
  // Browsable roots: the primary repository as its checkout or any ready
  // worktree (alternatives, never shown together), plus additional folders.
  fileRoots(projectId) {
    const { checkout, workspaces } = this.listWorkspaces(projectId); const project = this.project(projectId);
    const primary = [{ key: 'checkout', family: 'primary', kind: 'checkout', label: `${project.name} (checkout)`, path: checkout.path, branch: checkout.branch, git: true },
      ...workspaces.filter(w => w.state === 'ready').map(w => ({ key: w.id, family: 'primary', kind: w.kind, label: `${project.name} (${w.kind === 'managed' ? 'worktree' : 'imported worktree'} ${w.branch ?? basename(w.path)})`, path: w.path, branch: w.branch ?? null, git: true }))];
    const folders = (project.roots ?? []).map(root => { const status = folderStatus(root); return { key: `root:${root.id}`, family: 'folder', kind: root.kind, label: root.name, path: root.path, branch: status.currentBranch, git: root.kind === 'git', exists: status.exists }; });
    return { primary, folders };
  }
  // Resolves a root key from Journal's records: the checkout, a ready worktree
  // of this project, or one of its folders. Never a path from the renderer.
  fileRoot(projectId, key) {
    const project = this.project(projectId);
    if (key === 'checkout') return { key, family: 'primary', label: `${project.name} (checkout)`, path: project.root, gitRoot: project.root, prefix: '', head: project.head, git: true };
    if (typeof key === 'string' && key.startsWith('root:')) {
      const root = (project.roots ?? []).find(entry => `root:${entry.id}` === key); if (!root) throw new Error('That folder is no longer part of this project');
      const status = folderStatus(root); if (!status.exists) throw new Error(`Folder ${root.path} no longer exists`);
      const gitRoot = root.kind === 'git' ? root.gitRoot ?? root.path : null;
      const prefix = gitRoot ? relative(gitRoot, root.path).split(sep).join('/') : '';
      return { key, family: 'folder', label: root.name, path: root.path, gitRoot, prefix: prefix ? `${prefix}/` : '', head: status.head, git: !!gitRoot };
    }
    const workspace = this.getWorkspace(text(key, 'root', 100));
    if (workspace.projectId !== projectId) throw new Error('Workspace belongs to another project');
    if (workspace.state !== 'ready' || !existsSync(workspace.path)) throw new Error('This worktree is not available');
    const view = workspaceView(project, workspace);
    return { key, family: 'primary', label: `${project.name} (worktree ${view.branch ?? basename(workspace.path)})`, path: view.root, gitRoot: view.root, prefix: '', head: view.head, git: true };
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
    this.db.prepare('INSERT INTO events(session_id,at,kind,body) VALUES(?,?,?,?)').run(sessionId, now(), choice(kind, ['start', 'resume', 'context', 'prompt', 'permission', 'turn-end', 'command-start', 'command-end', 'file', 'interrupt', 'stop', 'exit', 'error', 'recovered', 'cleanup', 'disconnected', 'reference'], 'event kind'), text);
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
