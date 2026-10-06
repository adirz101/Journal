import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gitEnv } from './git-env.mjs';
import { isSensitivePath } from './evidence.mjs';

// Isolated environments (docs/ISOLATED-AGENT-ENVIRONMENTS.md): a Journal session works in its own
// Git worktree, detached at a recorded base commit of a logical branch, outside the user's checkout,
// with its own temp and log folders and port block. Its work comes back only through a previewed
// three-way Apply. Headless: every operation is a store method a window, the runtime or a future
// coordinator calls; callers see workers, tasks, states, results and conflicts, not Git.
//
// Records are workspaces of kind 'isolated' (the workspaces table), so a session in one gets the
// workspace plumbing for free (its folder, Files, Changes). `lifecycle` is the environment's state;
// `state` stays the workspace's ('intent' | 'ready' | 'failed' | 'removed').

export const LIFECYCLE = Object.freeze(['creating', 'ready', 'running', 'waiting', 'completed', 'failed', 'integrating', 'conflict', 'integrated', 'abandoned', 'cleanup_pending', 'removed']);
const TRANSITIONS = {
  creating: ['ready', 'failed'],
  ready: ['running', 'waiting', 'completed', 'abandoned', 'failed'],
  running: ['waiting', 'ready', 'completed', 'failed'],
  waiting: ['running', 'ready', 'completed', 'failed'],
  completed: ['running', 'waiting', 'integrating', 'conflict', 'abandoned'],
  conflict: ['running', 'waiting', 'completed', 'integrating', 'abandoned'],
  integrating: ['integrated', 'completed', 'conflict'],
  integrated: ['cleanup_pending', 'removed'],
  abandoned: ['completed', 'cleanup_pending', 'removed'],
  failed: ['abandoned', 'cleanup_pending', 'removed'],
  cleanup_pending: ['cleanup_pending', 'removed', 'completed'],
  removed: ['completed'],
};
const WORKSPACE_STATE = { creating: 'intent', failed: 'failed', removed: 'removed' };
export const REF = (id, name) => `refs/journal/env/${id}/${name}`;
const MARKER = 'journal-env';
const PORT_RANGE = { start: 42000, end: 46000, size: 10 };
const LIVE_SESSION = new Set(['starting', 'running', 'waiting', 'stopping', 'orphaned']);

// Errors a caller branches on by code (a coordinator never parses messages).
export class EnvironmentError extends Error { constructor(code, message, detail = {}) { super(message); this.code = code; this.detail = detail; } }
const fail = (code, message, detail) => { throw new EnvironmentError(code, message, detail); };
const short = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 8);
const now = () => new Date().toISOString();

// ---- Git ------------------------------------------------------------------------------------
class GitError extends Error { constructor(args, error) { super(`git ${args[0]} failed: ${String(error.stderr ?? error.message).trim().split('\n').at(-1) ?? ''}`.slice(0, 400)); this.status = error.status; this.stdout = String(error.stdout ?? ''); this.stderr = String(error.stderr ?? ''); } }
// Journal's own commits (results, Apply): a fixed committer, so a result never depends on the user's config.
const IDENTITY = { GIT_AUTHOR_NAME: 'Journal', GIT_AUTHOR_EMAIL: 'journal@localhost', GIT_COMMITTER_NAME: 'Journal', GIT_COMMITTER_EMAIL: 'journal@localhost' };
function git(cwd, args, { env = {}, allow = [], raw = false } = {}) {
  try {
    // Literal pathspecs are off here: these commands pass revisions and paths Journal produced itself.
    const out = execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: gitEnv({ GIT_LITERAL_PATHSPECS: '0', ...env }), stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 120000, windowsHide: true });
    return raw ? out : out.trim();
  } catch (error) {
    if (allow.includes(error.status)) return { status: error.status, stdout: String(error.stdout ?? '').trim(), stderr: String(error.stderr ?? '') };
    throw new GitError(args, error);
  }
}
const tryGit = (cwd, args, options) => { try { return git(cwd, args, options); } catch { return null; } };
export function gitSupportsEnvironments() {
  const match = /(\d+)\.(\d+)/.exec(execFileSync('git', ['--version'], { encoding: 'utf8', env: gitEnv() })) ?? [];
  const [major, minor] = [Number(match[1] ?? 0), Number(match[2] ?? 0)];
  return major > 2 || (major === 2 && minor >= 40);
}
function worktrees(repo) {
  const list = []; let current = null;
  for (const line of git(repo, ['worktree', 'list', '--porcelain'], { raw: true }).split('\n')) {
    if (!line) { if (current) list.push(current); current = null; continue; }
    const [key, ...rest] = line.split(' '); const value = rest.join(' ');
    if (key === 'worktree') current = { path: value, branch: null, locked: null };
    else if (!current) continue;
    else if (key === 'branch') current.branch = value;
    else if (key === 'locked') current.locked = value || '';
  }
  if (current) list.push(current);
  return list;
}
const real = path => { try { return realpathSync(path); } catch { return null; } };
const inside = (root, path) => { const rel = relative(root, path); return !!rel && !rel.startsWith('..') && !isAbsolute(rel); };
const samePath = (a, b) => (process.platform === 'darwin' || process.platform === 'win32') ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
function dirtyPaths(checkout) {
  const out = git(checkout, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { raw: true }).split('\0'); const paths = [];
  for (let i = 0; i < out.length; i++) { const entry = out[i]; if (!entry) continue; paths.push(entry.slice(3)); if (/^[RC]/.test(entry)) paths.push(out[++i]); }
  return paths;
}
const nameStatus = (repo, from, to) => git(repo, ['diff-tree', '-r', '--name-status', '--no-renames', from, to]).split('\n').filter(Boolean).map(line => { const [status, ...path] = line.split('\t'); return { status, path: path.join('\t') }; });

// ---- Ports (development isolation, not a network sandbox) ------------------------------------
export function portFree(port, hosts = ['127.0.0.1', '::1']) {
  return hosts.reduce((chain, host) => chain.then(ok => ok && new Promise(done => {
    const server = net.createServer(); server.unref();
    server.once('error', error => done(error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT'));
    server.listen({ port, host, exclusive: true }, () => server.close(() => done(true)));
  })), Promise.resolve(true));
}
export async function allocatePortBlock(taken, { range = PORT_RANGE, probe = portFree } = {}) {
  const held = new Set(taken);
  for (let start = range.start; start + range.size <= range.end; start += range.size) {
    if (held.has(start)) continue;
    const ports = Array.from({ length: range.size }, (_, i) => start + i);
    let free = true; for (const port of ports) if (!(await probe(port))) { free = false; break; }
    if (free) return ports;
  }
  throw new EnvironmentError('NO_PORTS', 'No free port block is left for a new isolated session');
}

// ---- Links (removed as links before a folder is deleted) -------------------------------------
function findLinks(root, tracked) {
  const links = []; const stack = [root];
  while (stack.length) {
    const dir = stack.pop(); let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (dir === root && entry.name === '.git') continue;
      const full = join(dir, entry.name); let stat; try { stat = lstatSync(full); } catch { continue; }
      if (stat.isSymbolicLink()) { if (!tracked.has(relative(root, full).split(sep).join('/'))) links.push(full); }
      else if (stat.isDirectory()) stack.push(full);
    }
  }
  return links;
}
function removeLink(path) { try { unlinkSync(path); } catch (error) { if (error.code === 'EPERM' || error.code === 'EISDIR') rmdirSync(path); else throw error; } }

// ---- The environment service ------------------------------------------------------------------
export class Environments {
  // store: the JournalStore. dataRoot: Journal's data folder (environments live under <dataRoot>/env).
  constructor(store, { dataRoot, probe, range, hooks = {}, remove } = {}) {
    this.store = store; this.dataRoot = dataRoot; this.probe = probe; this.range = range;
    // Test seams: hooks.afterFiles / beforeLand / afterLand inside Apply (races, crashes); remove replaces `git worktree remove`.
    this.hooks = hooks; this.removeWorktree = remove ?? ((repo, path) => git(repo, ['worktree', 'remove', path]));
  }
  get envRoot() { if (!this.dataRoot) fail('UNAVAILABLE', 'Isolated sessions need Journal\'s data folder'); const root = join(this.dataRoot, 'env'); mkdirSync(root, { recursive: true, mode: 0o700 }); return realpathSync(root); }
  record(id) { const env = this.store.getWorkspace(id); if (env.kind !== 'isolated') fail('NOT_FOUND', 'Not an isolated environment'); return env; }
  save(env) { return this.store.saveWorkspace({ ...env, state: WORKSPACE_STATE[env.lifecycle] ?? 'ready', updatedAt: now() }); }
  transition(id, to, patch = {}) {
    const env = this.record(id);
    if (env.lifecycle !== to && !TRANSITIONS[env.lifecycle]?.includes(to)) fail('INVALID_STATE', `An isolated session that is ${env.lifecycle} cannot become ${to}`, { state: env.lifecycle });
    const at = now();
    return this.save({ ...env, ...patch, lifecycle: to, history: [...(env.history ?? []), { state: to, at }].slice(-50) });
  }
  patch(id, patch) { return this.save({ ...this.record(id), ...patch }); }
  event(env, action, body = {}) { if (env.sessionId) { try { this.store.appendEvent(env.sessionId, 'environment', { action, environmentId: env.id, ...body }); } catch { /* the timeline is best effort */ } } }
  liveSessions(id) { return this.store.activeSessions().filter(session => session.workspaceId === id && LIVE_SESSION.has(session.status)); }

  // ---- Create, attach, list ----
  // Creations run one at a time, so two concurrent ones never pick the same port block.
  create(input) { const next = (this.creating ?? Promise.resolve()).catch(() => {}).then(() => this.createNow(input)); this.creating = next; return next; }
  async createNow({ projectId, logicalBranch, task = null, sessionId = null }) {
    if (!gitSupportsEnvironments()) fail('GIT_TOO_OLD', 'Isolated sessions need Git 2.40 or later');
    const project = this.store.project(projectId); const repo = project.root;
    if (typeof logicalBranch !== 'string' || !logicalBranch || logicalBranch.startsWith('-') || tryGit(repo, ['check-ref-format', '--branch', logicalBranch]) === null) fail('INVALID_BRANCH', 'Isolated sessions start from a named branch');
    const base = tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${logicalBranch}^{commit}`]);
    if (!base) fail('NOT_FOUND', `There is no branch ${logicalBranch}`);
    const id = randomUUID(); const projectDir = join(this.envRoot, short(projectId)); const path = join(projectDir, id.replace(/-/g, '').slice(0, 10));
    if (!inside(this.envRoot, path)) fail('UNSAFE_PATH', 'Isolated folders stay inside Journal\'s data folder');
    const taken = this.store.db.prepare(`SELECT body FROM workspaces WHERE json_extract(body,'$.kind')='isolated' AND json_extract(body,'$.lifecycle') NOT IN ('removed')`).all().map(row => JSON.parse(row.body).ports?.[0]).filter(Number.isInteger);
    const ports = await allocatePortBlock(taken, { ...(this.range ? { range: this.range } : {}), ...(this.probe ? { probe: this.probe } : {}) });
    const env = { id, projectId, kind: 'isolated', path, branch: null, logicalBranch, base, sessionId, task: typeof task === 'string' ? task.slice(0, 200) : null, ports,
      tmpDir: `${path}.tmp`, logDir: `${path}.log`, lifecycle: 'creating', result: null, conflict: null, integration: null, cleanup: null, error: null,
      createdAt: now(), history: [{ state: 'creating', at: now() }] };
    // Intent first: the record exists before any Git side effect, so a crash is reconciled.
    this.save(env); this.store.audit('environment-intent', { id, projectId, logicalBranch, base });
    try {
      mkdirSync(projectDir, { recursive: true, mode: 0o700 });
      git(repo, ['worktree', 'add', '--detach', '--lock', '--reason', `journal env ${id}`, path, base]);
      writeFileSync(join(git(path, ['rev-parse', '--absolute-git-dir']), MARKER), `${id}\n`);
      git(repo, ['update-ref', REF(id, 'base'), base]); git(repo, ['update-ref', REF(id, 'head'), base]);
      mkdirSync(env.tmpDir, { recursive: true, mode: 0o700 }); mkdirSync(env.logDir, { recursive: true, mode: 0o700 });
    } catch (error) { this.transition(id, 'failed', { error: String(error.message).slice(0, 400) }); throw error; }
    const ready = this.transition(id, 'ready'); this.store.audit('environment-created', { id });
    if (sessionId) this.event(ready, 'created', { logicalBranch, base });
    return this.view(ready);
  }
  attachSession(id, sessionId) { const env = this.patch(id, { sessionId }); this.event(env, 'created', { logicalBranch: env.logicalBranch, base: env.base }); return this.view(env); }
  get(id) { return this.view(this.record(id)); }
  list(projectId) {
    return this.store.db.prepare(`SELECT body FROM workspaces WHERE project_id=? AND json_extract(body,'$.kind')='isolated' ORDER BY rowid`).all(projectId).map(row => this.view(JSON.parse(row.body)));
  }
  // What a coordinator asks: which workers run, wait, are done, failed, unapplied, in conflict, cleanable.
  overview(projectId) {
    const all = this.list(projectId); const pick = states => all.filter(env => states.includes(env.state)).map(env => ({ id: env.id, sessionId: env.sessionId, task: env.task }));
    return { running: pick(['running']), waiting: pick(['waiting']), completed: pick(['completed']), failed: pick(['failed']), conflict: pick(['conflict']), integrated: pick(['integrated']),
      unapplied: all.filter(env => env.result && ['completed', 'conflict', 'abandoned'].includes(env.state)).map(env => ({ id: env.id, sessionId: env.sessionId, task: env.task })),
      cleanable: pick(['integrated', 'abandoned', 'failed', 'cleanup_pending']) };
  }

  // Follows the session that works in it: running and waiting while live; when it ends, the
  // result is captured and the environment is completed (Continue makes it running again).
  syncFromSession(session) {
    if (!session?.workspaceId) return null; let env; try { env = this.record(session.workspaceId); } catch { return null; }
    const to = session.status === 'waiting' ? 'waiting' : ['starting', 'running', 'stopping'].includes(session.status) ? 'running' : 'ended';
    if (to !== 'ended') { if (env.lifecycle !== to && TRANSITIONS[env.lifecycle]?.includes(to)) return this.view(this.transition(env.id, to, { sessionId: session.id })); return this.view(env); }
    if (['running', 'waiting', 'ready'].includes(env.lifecycle) && existsSync(env.path)) { this.snapshot(env.id); return this.view(this.transition(env.id, 'completed')); }
    return this.view(env);
  }

  // Variables for the agent's launch (TerminalManager): ports, temp and log folders, identity.
  launchVariables(id) {
    const env = this.record(id);
    return { JOURNAL_ENV_ID: env.id, JOURNAL_ENV_BASE: env.base, JOURNAL_LOGICAL_BRANCH: env.logicalBranch, JOURNAL_PORT: String(env.ports[0]), JOURNAL_PORTS: env.ports.join(','),
      JOURNAL_PORT_COUNT: String(env.ports.length), JOURNAL_ENV_LOG_DIR: env.logDir, TMPDIR: `${env.tmpDir}${sep}`, TEMP: env.tmpDir, TMP: env.tmpDir };
  }

  // ---- Result snapshot ----
  // Committed + staged + unstaged + untracked (not ignored) work as one commit whose parent is the
  // environment's HEAD, built in a side index (the worker's own index is untouched). New or
  // changed files with sensitive names are left out and listed. Idempotent for unchanged content.
  snapshot(id) {
    const env = this.record(id); const repo = this.store.project(env.projectId).root;
    if (!existsSync(env.path)) { if (env.result) return this.view(env); fail('INVALID_STATE', 'The isolated folder is gone and no result was captured'); }
    const head = git(env.path, ['rev-parse', 'HEAD']);
    mkdirSync(env.tmpDir, { recursive: true, mode: 0o700 });
    const index = join(env.tmpDir, `.journal-result-${process.pid}-${Date.now()}.index`);
    let tree; const excluded = [];
    try {
      const side = { GIT_INDEX_FILE: index };
      git(env.path, ['read-tree', head], { env: side }); git(env.path, ['add', '-A'], { env: side });
      for (const path of git(env.path, ['diff-index', '--cached', '--name-only', '--no-renames', head], { env: side }).split('\n').filter(Boolean)) {
        if (!isSensitivePath(path)) continue;
        excluded.push(path); git(env.path, ['reset', '-q', head, '--', path], { env: side });
      }
      tree = git(env.path, ['write-tree'], { env: side });
    } finally { rmSync(index, { force: true }); }
    git(repo, ['update-ref', REF(id, 'head'), head]);
    if (env.result && env.result.tree === tree && (env.result.head === head || env.result.sha === head)) return this.view(env);
    const message = [`Journal result of isolated session ${id}`, '', `Journal-Environment: ${id}`, `Journal-Session: ${env.sessionId ?? '-'}`, `Journal-Logical-Branch: ${env.logicalBranch}`, `Journal-Base: ${env.base}`].join('\n');
    const sha = git(repo, ['commit-tree', tree, '-p', head, '-m', message], { env: IDENTITY });
    git(repo, ['update-ref', REF(id, 'result'), sha]);
    const files = nameStatus(repo, env.base, tree);
    const saved = this.patch(id, { result: { sha, head, tree, files: files.slice(0, 500), fileCount: files.length, excluded, at: now() } });
    this.event(saved, 'result', { files: files.length, excluded: excluded.length });
    return this.view(saved);
  }

  // ---- Previewed Apply ----
  // Three-way merge of the result into the branch from the recorded base, in the object store only;
  // what Apply would change in the checkout holding the branch; overlap with its uncommitted work.
  preview(id) {
    const env = this.record(id); const repo = this.store.project(env.projectId).root;
    if (!env.result) fail('NO_RESULT', 'This isolated session has no captured result yet');
    const logicalHead = tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${env.logicalBranch}^{commit}`]);
    if (!logicalHead) fail('NOT_FOUND', `The branch ${env.logicalBranch} no longer exists`);
    const commitsSince = Number(git(repo, ['rev-list', '--count', `${env.base}..${logicalHead}`]));
    const baseOnBranch = git(repo, ['merge-base', '--is-ancestor', env.base, logicalHead], { allow: [1] }) === '';
    const merged = git(repo, ['merge-tree', '--write-tree', '--name-only', `--merge-base=${env.base}`, logicalHead, env.result.sha], { allow: [1] });
    const clean = typeof merged === 'string'; const lines = (clean ? merged : merged.stdout).split('\n');
    const tree = lines[0]; const blank = lines.indexOf('', 1);
    const paths = clean ? [] : lines.slice(1, blank === -1 ? lines.length : blank).filter(Boolean);
    const messages = blank === -1 ? [] : lines.slice(blank + 1);
    const conflicts = paths.map(path => ({ path, kind: (/^CONFLICT \(([^)]+)\)/.exec(messages.find(text => text.startsWith('CONFLICT') && text.includes(path)) ?? '') ?? [])[1] ?? 'content' }));
    const changes = clean ? nameStatus(repo, logicalHead, tree) : [];
    const checkout = worktrees(repo).find(entry => entry.branch === `refs/heads/${env.logicalBranch}`) ?? null;
    const dirty = checkout && existsSync(checkout.path) ? dirtyPaths(checkout.path) : [];
    const blockedBy = changes.map(change => change.path).filter(path => dirty.includes(path));
    return { environmentId: id, logicalBranch: env.logicalBranch, base: env.base, logicalHead, result: env.result.sha, moved: commitsSince > 0 || !baseOnBranch, commitsSince, baseOnBranch,
      clean, conflicts, changes, excluded: env.result.excluded ?? [], blockedBy, canApply: clean && blockedBy.length === 0, checkedOut: !!checkout, tree: clean ? tree : null,
      details: { checkout: checkout?.path ?? null } };
  }

  // Lands a previewed result (spec §8.3, the order the prototype proved): one Apply per branch at a
  // time; the checkout's own index lock is held throughout, so a `git commit` there fails cleanly;
  // the new index is built in a side file; the branch moves by compare-and-swap; only then the side
  // index replaces the real one. A conflict, overlap or race writes nothing.
  apply(id, { message } = {}) {
    const env = this.record(id); const repo = this.store.project(env.projectId).root;
    if (!['completed', 'conflict'].includes(env.lifecycle)) fail('INVALID_STATE', `An isolated session that is ${env.lifecycle} cannot be applied`, { state: env.lifecycle });
    if (this.liveSessions(id).length) fail('INVALID_STATE', 'Its session is still running; stop it first so the result is final');
    const lock = this.lock(`${short(env.projectId)}-${short(env.logicalBranch)}`); if (!lock) fail('LOCKED', 'Another Apply to this branch is in progress');
    try {
      const preview = this.preview(id);
      if (!preview.clean) {
        const saved = this.transition(id, 'conflict', { conflict: { paths: preview.conflicts, against: preview.logicalHead, at: now() } });
        this.event(saved, 'conflict', { paths: preview.conflicts.length, against: preview.logicalHead });
        fail('CONFLICT', 'The result conflicts with the branch; nothing was applied', { conflicts: preview.conflicts });
      }
      if (preview.blockedBy.length) fail('DIRTY_OVERLAP', 'Uncommitted changes in the checkout would be overwritten; nothing was applied', { paths: preview.blockedBy });
      const subject = (message ?? `Apply ${env.task ?? `isolated session ${id.slice(0, 8)}`}`).split('\n')[0].slice(0, 200);
      const body = [subject, '', `Journal-Environment: ${id}`, `Journal-Session: ${env.sessionId ?? '-'}`, `Journal-Base: ${env.base}`, `Journal-Result: ${env.result.sha}`].join('\n');
      const commit = git(repo, ['commit-tree', preview.tree, '-p', preview.logicalHead, '-m', body], { env: IDENTITY });
      const checkout = preview.details.checkout;
      const gitDir = checkout ? git(checkout, ['rev-parse', '--absolute-git-dir']) : null;
      const indexLock = checkout ? join(gitDir, 'index.lock') : null; const sideIndex = checkout ? join(gitDir, `journal-apply-${id}.index`) : null;
      const started = this.transition(id, 'integrating', { integration: { phase: 'planned', from: preview.logicalHead, commit, checkout, indexLock, sideIndex, changes: preview.changes.length, at: now() } });
      this.event(started, 'apply-started', { from: preview.logicalHead });
      if (checkout) {
        try { closeSync(openSync(indexLock, 'wx')); } catch { this.transition(id, 'completed', { integration: null }); fail('LOCKED', 'Git is busy in the checkout (its index is locked); try again in a moment'); }
        try { copyFileSync(join(gitDir, 'index'), sideIndex); git(checkout, ['read-tree', '-m', '-u', preview.logicalHead, commit], { env: { GIT_INDEX_FILE: sideIndex } }); }
        catch (error) { rmSync(sideIndex, { force: true }); rmSync(indexLock, { force: true }); this.transition(id, 'completed', { integration: null }); fail('CHECKOUT_REFUSED', 'Git refused to update the checkout; nothing was applied', { reason: String(error.stderr ?? error.message).trim().slice(0, 300) }); }
      }
      this.patch(id, { integration: { ...this.record(id).integration, phase: 'files' } });
      this.hooks.afterFiles?.(this.record(id)); this.hooks.beforeLand?.(this.record(id));
      const landed = git(repo, ['update-ref', '-m', `journal apply ${id}`, `refs/heads/${env.logicalBranch}`, commit, preview.logicalHead], { allow: [1, 128] });
      if (typeof landed !== 'string') {
        if (checkout) { git(checkout, ['read-tree', '-m', '-u', commit, preview.logicalHead], { env: { GIT_INDEX_FILE: sideIndex } }); rmSync(sideIndex, { force: true }); rmSync(indexLock, { force: true }); }
        this.transition(id, 'completed', { integration: null });
        fail('BRANCH_MOVED', 'The branch changed while applying; nothing was applied. Preview again.');
      }
      this.patch(id, { integration: { ...this.record(id).integration, phase: 'landed' } });
      this.hooks.afterLand?.(this.record(id));
      if (checkout) { renameSync(sideIndex, indexLock); renameSync(indexLock, join(gitDir, 'index')); }
      const done = this.transition(id, 'integrated', { conflict: null, integration: { ...this.record(id).integration, phase: 'done', landedAt: now() } });
      this.store.audit('environment-applied', { id, branch: env.logicalBranch, commit });
      this.event(done, 'applied', { commit, branch: env.logicalBranch, files: preview.changes.length });
      return this.view(done);
    } finally { lock.release(); }
  }

  // Resolve in the environment: the branch's current state is merged into the environment (never
  // the other way), conflict markers stay there for its worker, and the base moves to that commit.
  // The worker's work, uncommitted included, first becomes the environment's HEAD (its result), so
  // the merge never refuses and nothing is lost.
  updateFromBranch(id) {
    const env = this.record(id); const repo = this.store.project(env.projectId).root;
    if (!['completed', 'conflict', 'ready'].includes(env.lifecycle)) fail('INVALID_STATE', `An isolated session that is ${env.lifecycle} cannot take in its branch`, { state: env.lifecycle });
    if (!existsSync(env.path)) fail('INVALID_STATE', 'The isolated folder is gone');
    const target = git(repo, ['rev-parse', `refs/heads/${env.logicalBranch}`]);
    const result = this.snapshot(id).result.id;
    git(env.path, ['update-ref', '--no-deref', 'HEAD', result]); git(env.path, ['read-tree', result]);
    const merged = git(env.path, ['merge', '--no-ff', '--no-commit', target], { allow: [1], env: IDENTITY });
    const conflicts = typeof merged === 'string' ? [] : git(env.path, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
    git(repo, ['update-ref', REF(id, 'base'), target]);
    const saved = this.patch(id, { base: target, conflict: conflicts.length ? { paths: conflicts.map(path => ({ path, kind: 'content' })), against: target, at: now(), inEnvironment: true } : null });
    this.event(saved, 'updated', { to: target, conflicts: conflicts.length });
    return { environment: this.view(saved), conflicts };
  }

  // Keep the result, stop offering it: the folder is cleaned up when safe; restore brings it back.
  abandon(id) {
    const env = this.record(id);
    if (this.liveSessions(id).length) fail('INVALID_STATE', 'Its session is still running; stop it first');
    if (existsSync(env.path) && ['ready', 'completed', 'conflict'].includes(env.lifecycle)) this.snapshot(id);
    const saved = this.transition(id, 'abandoned', { abandonedAt: now() }); this.event(saved, 'abandoned');
    return this.cleanup(id);
  }
  // An abandoned (or cleaned-up) result back to "ready to apply": Apply needs only the refs.
  restore(id) {
    const env = this.record(id); const repo = this.store.project(env.projectId).root;
    if (!env.result || !tryGit(repo, ['rev-parse', '--verify', '--quiet', REF(id, 'result')])) fail('NO_RESULT', 'There is no saved result to restore');
    if (env.integration?.phase === 'done') fail('INVALID_STATE', 'This result was already applied');
    const saved = this.transition(id, 'completed', { abandonedAt: null, cleanup: null }); this.event(saved, 'restored');
    return this.view(saved);
  }

  // ---- Cleanup ----
  // Removes the folder only when every check passes; otherwise cleanup_pending with the reason.
  // Never --force: HEAD and the index are pointed at the captured result (equal to the files), so
  // `git worktree remove` succeeds only if nothing changed; untracked links are deleted as links.
  cleanup(id) {
    const env = this.record(id); const repo = this.store.project(env.projectId).root;
    if (!['integrated', 'abandoned', 'failed', 'cleanup_pending'].includes(env.lifecycle)) fail('INVALID_STATE', `An isolated session that is ${env.lifecycle} is not ready to clean up`, { state: env.lifecycle });
    const pending = reason => { const saved = this.transition(id, 'cleanup_pending', { cleanup: { reason, attempts: (env.cleanup?.attempts ?? 0) + 1, at: now(), from: env.cleanup?.from ?? env.lifecycle } }); this.event(saved, 'cleanup-pending', { reason }); return this.view(saved); };
    const live = this.liveSessions(id); if (live.length) return pending('its session is still running');
    if (!existsSync(env.path)) { this.forgetAdmin(repo, env); return this.removed(id); }
    const unsafe = this.unsafe(env, repo); if (unsafe) fail('UNSAFE_CLEANUP', unsafe);
    const before = env.result; const after = this.snapshot(id).result;
    if (before && before.sha !== after.id) return pending('new work appeared after its result was saved; it is saved now, try again');
    const result = this.record(id).result;
    try {
      if (result) { git(env.path, ['update-ref', '--no-deref', 'HEAD', result.sha]); git(env.path, ['read-tree', result.sha]); }
      const tracked = new Set(git(env.path, ['ls-files', '-z'], { raw: true }).split('\0').filter(Boolean));
      for (const link of findLinks(env.path, tracked)) removeLink(link);
      git(repo, ['worktree', 'unlock', env.path], { allow: [128] });
      this.removeWorktree(repo, env.path);
    } catch (error) {
      if (existsSync(env.path)) tryGit(repo, ['worktree', 'lock', '--reason', `journal env ${id}`, env.path]);
      return pending(error instanceof GitError ? error.stderr.trim().split('\n').at(-1) ?? error.message : `${error.code ?? ''} ${error.message}`.trim());
    }
    return this.removed(id);
  }
  removed(id) {
    const env = this.record(id);
    rmSync(env.tmpDir, { recursive: true, force: true }); rmSync(env.logDir, { recursive: true, force: true });
    const saved = this.transition(id, 'removed', { cleanup: { removedAt: now(), from: env.cleanup?.from ?? env.lifecycle } }); this.event(saved, 'cleaned');
    this.store.audit('environment-removed', { id }); return this.view(saved);
  }
  // Why this folder must not be removed by Journal, or null.
  unsafe(env, repo) {
    const resolved = real(env.path);
    if (!resolved || resolved !== env.path || !inside(this.envRoot, resolved)) return 'the folder is not inside Journal\'s isolated-session folder, or is reached through a link';
    if (!worktrees(repo).some(entry => samePath(real(entry.path) ?? entry.path, resolved))) return 'Git does not list this folder as a worktree of the project';
    const admin = tryGit(env.path, ['rev-parse', '--absolute-git-dir']);
    if (!admin || samePath(admin, git(repo, ['rev-parse', '--absolute-git-dir']))) return 'the folder\'s Git data resolves to the project\'s own checkout';
    let marker = ''; try { marker = readFileSync(join(admin, MARKER), 'utf8').trim(); } catch { /* none */ }
    if (marker !== env.id) return 'Journal did not create this worktree for this session';
    return null;
  }
  // The folder is already gone: remove only this environment's own admin entry (marked), never a
  // repository-wide prune (which would also drop other missing worktrees).
  forgetAdmin(repo, env) {
    const common = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    let names = []; try { names = readdirSync(join(common, 'worktrees')); } catch { return; }
    for (const name of names) {
      const admin = join(common, 'worktrees', name); let marker = ''; let gitdir = '';
      try { marker = readFileSync(join(admin, MARKER), 'utf8').trim(); gitdir = readFileSync(join(admin, 'gitdir'), 'utf8').trim(); } catch { continue; }
      if (marker === env.id && samePath(dirname(gitdir), env.path)) rmSync(admin, { recursive: true, force: true });
    }
  }

  // ---- Recovery ----
  // After a crash or restart: finish creation, follow sessions that ended, finish or roll back an
  // Apply from its durable plan, retry pending cleanups. Unknown work is never deleted.
  reconcile(projectId) {
    const report = [];
    const rows = this.store.db.prepare(`SELECT body FROM workspaces WHERE json_extract(body,'$.kind')='isolated' AND json_extract(body,'$.lifecycle') NOT IN ('removed')${projectId ? ' AND project_id=?' : ''}`).all(...(projectId ? [projectId] : []));
    for (const row of rows) {
      const env = JSON.parse(row.body); let repo; try { repo = this.store.project(env.projectId).root; } catch { continue; }
      try {
        if (env.lifecycle === 'creating') {
          const admin = existsSync(env.path) ? tryGit(env.path, ['rev-parse', '--absolute-git-dir']) : null;
          const ok = !!admin && !samePath(admin, git(repo, ['rev-parse', '--absolute-git-dir'])) && !!tryGit(repo, ['rev-parse', '--verify', '--quiet', REF(env.id, 'base')]);
          if (ok) { if (!existsSync(join(admin, MARKER))) writeFileSync(join(admin, MARKER), `${env.id}\n`); mkdirSync(env.tmpDir, { recursive: true }); mkdirSync(env.logDir, { recursive: true }); }
          this.transition(env.id, ok ? 'ready' : 'failed', ok ? {} : { error: 'Creation did not finish; anything left in its folder was kept' }); report.push([env.id, 'creating', ok ? 'ready' : 'failed']); continue;
        }
        if (['running', 'waiting'].includes(env.lifecycle) && !this.liveSessions(env.id).length) {
          if (existsSync(env.path)) { this.snapshot(env.id); this.transition(env.id, 'completed'); report.push([env.id, env.lifecycle, 'completed']); }
          else { this.transition(env.id, 'ready'); report.push([env.id, env.lifecycle, 'ready']); }
          continue;
        }
        if (env.lifecycle === 'integrating') {
          const { from, commit, checkout, indexLock, sideIndex } = env.integration ?? {}; const head = tryGit(repo, ['rev-parse', `refs/heads/${env.logicalBranch}`]);
          const ours = !!indexLock && existsSync(indexLock) && !!sideIndex && existsSync(sideIndex);
          if (head && head === commit) {
            if (ours) { renameSync(sideIndex, indexLock); renameSync(indexLock, join(dirname(indexLock), 'index')); }
            this.transition(env.id, 'integrated', { integration: { ...env.integration, phase: 'done' } }); report.push([env.id, 'integrating', 'integrated']); continue;
          }
          if (ours) { tryGit(checkout, ['read-tree', '-m', '-u', commit, from], { env: { GIT_INDEX_FILE: sideIndex } }); rmSync(sideIndex, { force: true }); rmSync(indexLock, { force: true }); }
          this.transition(env.id, 'completed', { integration: null }); report.push([env.id, 'integrating', 'completed']); continue;
        }
        if (env.lifecycle === 'cleanup_pending' || (env.lifecycle === 'integrated' && existsSync(env.path))) { const after = this.cleanup(env.id); report.push([env.id, env.lifecycle, after.state]); }
      } catch (error) { report.push([env.id, env.lifecycle, `error: ${error.message}`]); }
    }
    return report;
  }

  // One Apply per branch: an exclusive lock file holding the owner's pid; a dead owner's lock is taken over.
  lock(name) {
    const dir = join(this.dataRoot, 'locks'); mkdirSync(dir, { recursive: true, mode: 0o700 }); const file = join(dir, `${name}.lock`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try { const fd = openSync(file, 'wx', 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd); return { release: () => rmSync(file, { force: true }) }; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const owner = Number(readFileSync(file, 'utf8')) || 0; let alive = false; try { process.kill(owner, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
        if (owner && alive) return null; rmSync(file, { force: true });
      }
    }
    return null;
  }

  // What callers see: no paths or refs outside `details`.
  view(env) {
    return { id: env.id, projectId: env.projectId, sessionId: env.sessionId ?? null, task: env.task ?? null, logicalBranch: env.logicalBranch, base: env.base, state: env.lifecycle,
      result: env.result ? { id: env.result.sha, files: env.result.files, fileCount: env.result.fileCount ?? env.result.files.length, excluded: env.result.excluded ?? [], at: env.result.at } : null,
      conflict: env.conflict ?? null, integration: env.integration ? { commit: env.integration.commit, phase: env.integration.phase, landedAt: env.integration.landedAt ?? null } : null,
      cleanup: env.cleanup ?? null, error: env.error ?? null, ports: env.ports, createdAt: env.createdAt, updatedAt: env.updatedAt, folder: existsSync(env.path),
      details: { path: env.path, tmpDir: env.tmpDir, logDir: env.logDir, refs: { base: REF(env.id, 'base'), head: REF(env.id, 'head'), result: REF(env.id, 'result') } } };
  }
}
