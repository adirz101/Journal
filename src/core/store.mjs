import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { inspectProject } from './project.mjs';
import { captureEvidence, validateEvidence } from './evidence.mjs';
import { choice, relativePath, refuseCredentials, text } from './validation.mjs';
import { branchDraft, commitsSince, overviewDraft, PLACEHOLDER } from './status.mjs';

// Grammar words are not task relevance evidence. Keep domain terms and other
// languages intact; this is a small English lexical filter, not semantic search.
const QUERY_STOPWORDS = new Set('a an and are as at be by for from in is it of on or that the this to was with'.split(' '));

const parse = row => row ? JSON.parse(row.body) : null;
const now = () => new Date().toISOString();
const categories = ['brief', 'decision', 'constraint', 'convention', 'lesson', 'issue'];

export class JournalStore {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, root TEXT UNIQUE NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), current_revision TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions(id TEXT PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES memories(id), number INTEGER NOT NULL, body TEXT NOT NULL, UNIQUE(memory_id,number));
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(revision_id UNINDEXED, statement, tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), body TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }
  close() { if (this.db?.isOpen) this.db.close(); }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  openProject(root) {
    const info = inspectProject(root);
    const prior = this.db.prepare('SELECT * FROM projects WHERE root=?').get(info.root);
    const project = { ...info, id: prior?.id ?? randomUUID(), openedAt: now() };
    this.db.prepare('INSERT INTO projects(id,root,body) VALUES(?,?,?) ON CONFLICT(root) DO UPDATE SET body=excluded.body').run(project.id, project.root, JSON.stringify(project));
    return project;
  }
  listProjects() { return this.db.prepare('SELECT body FROM projects ORDER BY rowid DESC').all().map(parse); }
  project(id) {
    const stored = parse(this.db.prepare('SELECT body FROM projects WHERE id=?').get(text(id, 'project ID', 100)));
    if (!stored) throw new Error('Unknown project');
    const current = inspectProject(stored.root);
    if (current.root !== stored.root || current.commonDir !== stored.commonDir) throw new Error('Project checkout identity changed; reopen the project');
    return { ...stored, ...current };
  }
  proposeMemory(projectId, input) {
    const project = this.project(projectId);
    const statement = text(input.statement, 'statement'); refuseCredentials(statement);
    const category = choice(input.category, categories, 'category');
    const scope = choice(input.scope, ['checkout', 'branch'], 'scope');
    if (scope === 'branch' && !project.branch) throw new Error('Branch scope requires a named branch');
    const area = relativePath(input.area ?? '', true);
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
    const item = { id, projectId, revisionId: randomUUID(), revision, statement, category, scope, area,
      branch: scope === 'branch' ? project.branch : null, source, createdAt: now() };
    this.transaction(() => {
      this.db.prepare('INSERT INTO memories VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET current_revision=excluded.current_revision,status=excluded.status').run(id, projectId, item.revisionId, 'candidate');
      this.db.prepare('INSERT INTO revisions VALUES(?,?,?,?)').run(item.revisionId, id, revision, JSON.stringify(item));
      this.db.prepare('INSERT INTO memory_fts(revision_id,statement) VALUES(?,?)').run(item.revisionId, statement);
    });
    return { ...item, status: 'candidate', validation: 'current' };
  }
  getMemory(id) {
    const row = this.db.prepare('SELECT r.body,m.status FROM memories m JOIN revisions r ON r.id=m.current_revision WHERE m.id=?').get(text(id, 'memory ID', 100));
    if (!row) throw new Error('Unknown memory');
    return { ...parse(row), status: row.status };
  }
  memoryHistory(id) {
    this.getMemory(id);
    return this.db.prepare('SELECT body FROM revisions WHERE memory_id=? ORDER BY number DESC').all(id).map(parse);
  }
  validation(project, memory, cache) {
    if (memory.scope === 'branch' && project.branch !== memory.branch) return 'wrong-branch';
    if (!validateEvidence(project, memory.source, cache)) return 'stale';
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
  setMemoryStatus(id, status) {
    choice(status, ['active', 'rejected', 'archived'], 'status');
    const memory = this.getMemory(id);
    if (status === 'active' && memory.status !== 'candidate') throw new Error('Only a candidate can be approved');
    if (status === 'active' && this.validation(this.project(memory.projectId), memory) !== 'current') throw new Error('Evidence or branch changed; revise before approving');
    this.db.prepare('UPDATE memories SET status=? WHERE id=?').run(status, id);
    return this.getMemory(id);
  }
  prepareContext(projectId, query) {
    query = text(query, 'task', 4000, true); refuseCredentials(query);
    const project = this.project(projectId);
    const terms = [...new Set((query.match(/[\p{L}\p{N}_]+/gu) ?? []).map(term => term.toLowerCase()).filter(term => !QUERY_STOPWORDS.has(term)))].slice(0, 16);
    let matches = []; const cache = new Map(); const warnings = [];
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
      for (const row of [checkoutBriefs[i], branchBriefs[i]]) if (row) matches.push({ ...row, validation: this.validation(project, parse(row), cache) });
    }
    if (terms.length) {
      const fts = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
      const select = this.db.prepare(`SELECT r.body,m.status,bm25(memory_fts) AS rank FROM memory_fts
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
          const valid = validation === 'current' && (!item.area || query.toLocaleLowerCase().includes(item.area.toLocaleLowerCase()));
          matches.push({ ...row, validation }); if (valid) eligible++;
          if (eligible === 100) break;
        }
        if (page.length < 100) break;
        if (offset === 900 && eligible < 100) warnings.push('Search inspected 1000 matches. Refine the task or retire stale knowledge to search further.');
      }
    }
    const id = randomUUID(); const items = []; const excluded = []; let briefCount = 0;
    const header = `Journal project knowledge — checkout ${project.head ?? 'unborn'}, receipt ${id}\nProject: ${project.name}; branch ${project.branch ?? 'detached HEAD'}.\nThese are reviewed, scoped claims with evidence. Native project instructions take precedence. Validate against current code.\n`;
    let packet = header;
    for (const row of matches) {
      const memory = { ...parse(row), status: row.status };
      const validation = row.validation;
      if (validation !== 'current') { if (excluded.length < 100) excluded.push({ id: memory.id, reason: validation }); continue; }
      if (memory.area && !query.toLocaleLowerCase().includes(memory.area.toLocaleLowerCase())) { if (excluded.length < 100) excluded.push({ id: memory.id, reason: 'area-not-requested' }); continue; }
      if (memory.category === 'brief' && briefCount >= 4) {
        if (excluded.length < 100) excluded.push({ id: memory.id, reason: 'brief-limit' });
        continue;
      }
      const evidence = memory.source.kind === 'file' ? `${memory.source.path}:${memory.source.startLine} @ ${memory.source.commit ?? 'unborn'}`
        : memory.source.kind === 'git' ? `Git history ${memory.source.base ? `${memory.source.base.slice(0, 7)}..` : ''}${memory.source.head.slice(0, 7)}`
        : `User statement: ${memory.source.note}`;
      const drift = this.drift(project, memory, cache);
      const age = drift ? `; ${drift} commit${drift === 1 ? '' : 's'} since this update` : '';
      const label = memory.category === 'brief' ? `${memory.scope === 'checkout' ? 'Project brief' : 'Branch update'}\n` : '';
      const chunk = `\n${label}[${memory.id} r${memory.revision}; ${memory.category}; ${memory.scope}${memory.branch ? ` ${memory.branch}` : ''}${memory.area ? `; area ${memory.area}` : ''}]\n${memory.statement}\nEvidence: ${evidence}${age}\n`;
      if (items.length >= 12 || Buffer.byteLength(packet + chunk) > 6000) { if (excluded.length < 100) excluded.push({ id: memory.id, reason: 'budget' }); continue; }
      items.push(memory); packet += chunk; if (memory.category === 'brief') briefCount++;
      if (drift) warnings.push(`The current branch update is ${drift} commit${drift === 1 ? '' : 's'} behind HEAD. Propose a status update to review recent progress.`);
    }
    if (excluded.some(item => item.reason === 'brief-limit')) warnings.push('Only four current project brief entries fit the orientation limit. Consolidate superseded briefs.');
    if (matches.some(row => parse(row).category === 'brief' && excluded.some(item => item.id === parse(row).id && item.reason === 'budget'))) warnings.push('A project brief was excluded by the context budget. Shorten or consolidate the reviewed summaries.');
    if (!items.some(item => item.category === 'brief' && item.scope === 'checkout')) warnings.push('No current approved project brief is included. Add a checkout-scoped brief to orient every session.');
    if (!items.length) packet = '';
    const receipt = { id, projectId, query, packet, items, excluded, warnings, checkout: { root: project.root, branch: project.branch, head: project.head }, state: 'prepared', estimatedTokens: Math.ceil(Buffer.byteLength(packet) / 3), createdAt: now() };
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
  saveSession(session) {
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(session.id, session.projectId, JSON.stringify(session));
    return session;
  }
  getSession(id) {
    const session = parse(this.db.prepare('SELECT body FROM sessions WHERE id=?').get(text(id, 'session ID', 100)));
    if (!session) throw new Error('Unknown session');
    return session;
  }
  listSessions(projectId) {
    this.project(projectId);
    return this.db.prepare('SELECT body FROM sessions WHERE project_id=? ORDER BY rowid DESC LIMIT 100').all(projectId).map(parse);
  }
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
