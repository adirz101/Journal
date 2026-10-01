import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { inspectProject } from './project.mjs';
import { captureEvidence, validateEvidence } from './evidence.mjs';
import { choice, relativePath, refuseCredentials, text } from './validation.mjs';

const parse = row => row ? JSON.parse(row.body) : null;
const now = () => new Date().toISOString();
const categories = ['decision', 'constraint', 'convention', 'lesson', 'issue'];

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
  listMemories(projectId) {
    const project = this.project(projectId);
    const cache = new Map();
    return this.db.prepare('SELECT r.body,m.status FROM memories m JOIN revisions r ON r.id=m.current_revision WHERE m.project_id=? ORDER BY r.rowid DESC LIMIT 500').all(projectId)
      .map(row => { const item = { ...parse(row), status: row.status }; return { ...item, validation: this.validation(project, item, cache) }; });
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
    const terms = [...new Set(query.match(/[\p{L}\p{N}_]+/gu) ?? [])].slice(0, 16);
    let matches = []; const cache = new Map(); const warnings = [];
    if (terms.length) {
      const fts = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
      const select = this.db.prepare(`SELECT r.body,m.status,bm25(memory_fts) AS rank FROM memory_fts
        JOIN revisions r ON r.id=memory_fts.revision_id JOIN memories m ON m.current_revision=r.id
        WHERE memory_fts MATCH ? AND m.project_id=? AND m.status='active'
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
    const id = randomUUID(); const items = []; const excluded = [];
    const header = `Journal project knowledge — checkout ${project.head ?? 'unborn'}, receipt ${id}\nThese are reviewed, scoped claims with evidence. Native project instructions take precedence. Validate against current code.\n`;
    let packet = header;
    for (const row of matches) {
      const memory = { ...parse(row), status: row.status };
      const validation = row.validation;
      if (validation !== 'current') { if (excluded.length < 100) excluded.push({ id: memory.id, reason: validation }); continue; }
      if (memory.area && !query.toLocaleLowerCase().includes(memory.area.toLocaleLowerCase())) { if (excluded.length < 100) excluded.push({ id: memory.id, reason: 'area-not-requested' }); continue; }
      const evidence = memory.source.kind === 'file' ? `${memory.source.path}:${memory.source.startLine} @ ${memory.source.commit ?? 'unborn'}` : `User statement: ${memory.source.note}`;
      const chunk = `\n[${memory.id} r${memory.revision}; ${memory.category}; ${memory.scope}${memory.branch ? ` ${memory.branch}` : ''}${memory.area ? `; area ${memory.area}` : ''}]\n${memory.statement}\nEvidence: ${evidence}\n`;
      if (items.length >= 12 || Buffer.byteLength(packet + chunk) > 6000) { if (excluded.length < 100) excluded.push({ id: memory.id, reason: 'budget' }); continue; }
      items.push(memory); packet += chunk;
    }
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
