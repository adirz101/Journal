import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { atLeast, git, GitError, gitVersion, JOURNAL_IDENTITY, tryGit, worktrees } from './git.mjs';
import { acquireLock, defaultAlive, Records } from './records.mjs';
import { allocateBlock, DEFAULT_RANGE } from './ports.mjs';
import { findLinks, removeLink } from './links.mjs';

// Isolated environments (docs/ISOLATED-AGENT-ENVIRONMENTS.md), feasibility prototype.
// Headless and deterministic: every operation is a method a desktop UI, the runtime or a future
// coordinator (CLI/MCP) can call. Callers think in workers, tasks, states, results and conflicts;
// worktrees, refs and merge-tree stay inside this module (visible only under `details`).

export const STATES = Object.freeze(['creating', 'ready', 'running', 'waiting', 'completed', 'failed', 'integrating', 'conflict', 'integrated', 'abandoned', 'cleanup_pending', 'removed']);
const TRANSITIONS = {
  creating: ['ready', 'failed'],
  ready: ['running', 'completed', 'abandoned', 'failed'],
  running: ['waiting', 'ready', 'completed', 'failed'],
  waiting: ['running', 'ready', 'completed', 'failed'],
  completed: ['running', 'integrating', 'conflict', 'abandoned'],
  conflict: ['running', 'completed', 'integrating', 'abandoned'],
  integrating: ['integrated', 'completed', 'conflict'],
  integrated: ['cleanup_pending', 'removed'],
  abandoned: ['cleanup_pending', 'removed'],
  failed: ['abandoned', 'cleanup_pending', 'removed'],
  cleanup_pending: ['cleanup_pending', 'removed'],
  removed: [],
};

// Errors a caller can branch on (the coordinator never parses messages).
export class EnvironmentError extends Error { constructor(code, message, detail = {}) { super(message); this.code = code; this.detail = detail; } }
const fail = (code, message, detail) => { throw new EnvironmentError(code, message, detail); };

const short = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 8);
const REF = (id, name) => `refs/journal/env/${id}/${name}`;
const MARKER = 'journal-env';

export class EnvironmentManager {
  // dataRoot: Journal's data folder (environments live under <dataRoot>/env). repos: projectId → repository root.
  constructor({ dataRoot, repos, range = DEFAULT_RANGE, probe, excluded = [], alive = defaultAlive, now = () => new Date().toISOString(), hooks = {}, remove } = {}) {
    if (!atLeast(gitVersion(), [2, 40])) fail('GIT_TOO_OLD', 'Isolated environments need Git 2.40 or later (merge-tree with --merge-base)');
    this.root = resolve(dataRoot); mkdirSync(join(this.root, 'env'), { recursive: true });
    this.envRoot = realpathSync(join(this.root, 'env'));
    this.records = new Records(join(this.root, 'environments.json'));
    this.repos = repos; this.range = range; this.probe = probe; this.excluded = excluded; this.alive = alive; this.now = now;
    // Test seams: hooks.afterFiles / hooks.beforeLand run inside Apply (to simulate races and crashes);
    // remove replaces `git worktree remove` (to simulate a file held open on Windows).
    this.hooks = hooks; this.remove = remove ?? ((repo, path) => git(repo, ['worktree', 'remove', path]));
  }

  repo(projectId) { const root = this.repos[projectId]; if (!root) fail('NOT_FOUND', `Unknown project ${projectId}`); return root; }
  record(id) { const env = this.records.load().environments[id]; if (!env) fail('NOT_FOUND', `Unknown environment ${id}`); return env; }
  // A durable, checked state change (intent first: callers write the state before the side effect).
  transition(id, to, patch = {}) {
    return this.records.update(data => {
      const env = data.environments[id]; if (!env) fail('NOT_FOUND', `Unknown environment ${id}`);
      if (env.state !== to && !TRANSITIONS[env.state]?.includes(to)) fail('INVALID_STATE', `An environment that is ${env.state} cannot become ${to}`, { state: env.state });
      Object.assign(env, patch, { state: to, updatedAt: this.now() });
      env.history = [...(env.history ?? []), { state: to, at: env.updatedAt }].slice(-50);
      return { ...env };
    });
  }
  patch(id, patch) { return this.records.update(data => { Object.assign(data.environments[id], patch, { updatedAt: this.now() }); return { ...data.environments[id] }; }); }

  // ---- The control surface ---------------------------------------------------------------
  async createEnvironment({ projectId, logicalBranch, sessionId = null, task = null, base }) {
    const repo = this.repo(projectId);
    const branchRef = `refs/heads/${logicalBranch}`;
    if (tryGit(repo, ['show-ref', '--verify', '--quiet', branchRef]) === null) fail('NOT_FOUND', `No branch ${logicalBranch}`);
    const baseSha = git(repo, ['rev-parse', '--verify', `${base ?? branchRef}^{commit}`]);
    const id = randomUUID(); const projectDir = join(this.envRoot, short(projectId));
    const path = join(projectDir, id.replace(/-/g, '').slice(0, 10));
    this.contained(path);
    const ports = await this.allocatePorts(id);
    const env = { id, projectId, sessionId, task, logicalBranch, base: baseSha, state: 'creating', createdAt: this.now(), updatedAt: this.now(), ports,
      path, tmpDir: `${path}.tmp`, logDir: `${path}.log`, result: null, conflict: null, integration: null, processes: [], cleanup: null, history: [{ state: 'creating', at: this.now() }] };
    this.records.update(data => { data.environments[id] = env; });
    try {
      mkdirSync(projectDir, { recursive: true });
      git(repo, ['worktree', 'add', '--detach', '--lock', '--reason', `journal env ${id}`, path, baseSha]);
      writeFileSync(join(this.adminDir(path), MARKER), `${id}\n`);
      git(repo, ['update-ref', REF(id, 'base'), baseSha]); git(repo, ['update-ref', REF(id, 'head'), baseSha]);
      mkdirSync(env.tmpDir, { recursive: true }); mkdirSync(env.logDir, { recursive: true });
    } catch (error) { this.transition(id, 'failed', { error: error.message }); throw error; }
    return this.view(this.transition(id, 'ready'));
  }
  getEnvironment(id) { return this.view(this.record(id)); }
  listEnvironments(projectId, { states } = {}) {
    return Object.values(this.records.load().environments).filter(env => (!projectId || env.projectId === projectId) && (!states || states.includes(env.state)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(env => this.view(env));
  }
  // What a coordinator asks: which workers are running, waiting, done, failed, unapplied, in conflict, cleanable.
  overview(projectId) {
    const all = this.listEnvironments(projectId); const ids = list => list.map(env => ({ id: env.id, sessionId: env.sessionId, task: env.task }));
    return { running: ids(all.filter(e => e.state === 'running')), waiting: ids(all.filter(e => e.state === 'waiting')), completed: ids(all.filter(e => e.state === 'completed')),
      failed: ids(all.filter(e => e.state === 'failed')), unapplied: ids(all.filter(e => e.result && ['completed', 'conflict'].includes(e.state))),
      conflict: ids(all.filter(e => e.state === 'conflict')), integrated: ids(all.filter(e => e.state === 'integrated')),
      cleanable: ids(all.filter(e => ['integrated', 'abandoned', 'failed', 'cleanup_pending'].includes(e.state))) };
  }

  // Session lifecycle (the runtime reports these; a coordinator reads them).
  markRunning(id, { pid = null, sessionId } = {}) {
    const env = this.record(id);
    return this.view(this.transition(id, 'running', { ...(sessionId ? { sessionId } : {}), processes: pid ? [...env.processes.filter(p => p.pid !== pid), { pid, at: this.now() }] : env.processes }));
  }
  markWaiting(id) { return this.view(this.transition(id, 'waiting')); }
  markStopped(id) { return this.view(this.transition(id, 'ready', { processes: [] })); }
  markFailed(id, reason) { return this.view(this.transition(id, 'failed', { error: String(reason ?? 'failed') })); }
  markCompleted(id) { this.snapshotEnvironment(id); return this.view(this.transition(id, 'completed', { processes: [] })); }
  markEnvironmentAbandoned(id) {
    const env = this.record(id);
    if (existsSync(env.path) && ['ready', 'running', 'waiting', 'completed', 'conflict'].includes(env.state)) this.snapshotEnvironment(id);
    return this.view(this.transition(id, 'abandoned', { processes: [] }));
  }

  // Variables a worker process gets (development isolation, not a security boundary).
  environmentVariables(id) {
    const env = this.record(id);
    return { JOURNAL_ENV_ID: env.id, JOURNAL_ENV_BASE: env.base, JOURNAL_LOGICAL_BRANCH: env.logicalBranch, JOURNAL_PORT: String(env.ports[0]), JOURNAL_PORTS: env.ports.join(','),
      JOURNAL_PORT_COUNT: String(env.ports.length), JOURNAL_ENV_LOG_DIR: env.logDir, TMPDIR: env.tmpDir, TEMP: env.tmpDir, TMP: env.tmpDir };
  }
  // Starts a process in the environment as its own process group (POSIX), recorded as the environment's.
  spawnWorker(id, command, args = [], { env: extra = {} } = {}) {
    const env = this.record(id);
    const log = openSync(join(env.logDir, 'worker.log'), 'a', 0o600);
    const child = spawn(command, args, { cwd: env.path, env: { ...process.env, ...this.environmentVariables(id), ...extra }, detached: process.platform !== 'win32', stdio: ['ignore', log, log], windowsHide: true });
    this.markRunning(id, { pid: child.pid });
    return child;
  }

  // Memory interfaces (stubs of what the store needs; see the spec §10).
  contextRequest(id) { const env = this.record(id); return { projectId: env.projectId, logicalBranch: env.logicalBranch, environmentId: env.id, sessionId: env.sessionId, base: env.base }; }
  provenance(id) {
    const env = this.record(id);
    return { environmentId: env.id, sessionId: env.sessionId, logicalBranch: env.logicalBranch, base: env.base, result: env.result?.sha ?? null,
      applied: env.state === 'integrated' || (env.state === 'cleanup_pending' && !!env.integration?.commit) || (env.state === 'removed' && !!env.integration?.commit), integration: env.integration?.commit ?? null };
  }

  // ---- Result snapshot (spec §8.1) --------------------------------------------------------
  // Committed + uncommitted + untracked (not ignored) work as one commit whose parent is the
  // environment's HEAD, built in a temporary index so the worker's own staging area is untouched.
  // Idempotent: the same HEAD and tree give the same, existing result.
  snapshotEnvironment(id) {
    const env = this.record(id); const repo = this.repo(env.projectId);
    if (!existsSync(env.path)) { if (env.result) return this.view(env); fail('INVALID_STATE', 'The environment folder is gone and no result was captured'); }
    const head = git(env.path, ['rev-parse', 'HEAD']);
    const index = join(env.tmpDir, `snapshot-${process.pid}-${Date.now()}.index`);
    let tree;
    try {
      git(env.path, ['read-tree', head], { env: { GIT_INDEX_FILE: index } });
      git(env.path, ['add', '-A'], { env: { GIT_INDEX_FILE: index } });
      tree = git(env.path, ['write-tree'], { env: { GIT_INDEX_FILE: index } });
    } finally { rmSync(index, { force: true }); }
    git(repo, ['update-ref', REF(id, 'head'), head]);
    // Unchanged content on the same HEAD (or on the result itself, after cleanup pointed HEAD at it): the same result.
    if (env.result && env.result.tree === tree && (env.result.head === head || env.result.sha === head)) return this.view(env);
    const files = git(repo, ['diff-tree', '-r', '--name-status', '--no-renames', env.base, tree]).split('\n').filter(Boolean).map(line => { const [status, ...path] = line.split('\t'); return { status, path: path.join('\t') }; });
    const message = [`Journal result of environment ${id}`, '', `Journal-Environment: ${id}`, `Journal-Session: ${env.sessionId ?? '-'}`, `Journal-Logical-Branch: ${env.logicalBranch}`, `Journal-Base: ${env.base}`].join('\n');
    const sha = git(repo, ['commit-tree', tree, '-p', head, '-m', message], { env: JOURNAL_IDENTITY });
    git(repo, ['update-ref', REF(id, 'result'), sha]);
    return this.view(this.patch(id, { result: { sha, head, tree, files, at: this.now() } }));
  }

  // ---- Previewed Apply (spec §8.3) --------------------------------------------------------
  // A three-way merge of the result into the logical branch from the recorded base, computed in
  // the object store only; then what Apply would change in the checkout that has the branch, and
  // whether its uncommitted work overlaps. Nothing is written.
  previewApply(id) {
    const env = this.record(id); const repo = this.repo(env.projectId);
    if (!env.result) fail('NO_RESULT', 'Capture the result first (snapshotEnvironment)');
    const logicalHead = git(repo, ['rev-parse', '--verify', `refs/heads/${env.logicalBranch}^{commit}`]);
    const commitsSince = Number(git(repo, ['rev-list', '--count', `${env.base}..${logicalHead}`]));
    const baseOnBranch = git(repo, ['merge-base', '--is-ancestor', env.base, logicalHead], { allow: [1] }) === '';
    const merged = git(repo, ['merge-tree', '--write-tree', '--name-only', `--merge-base=${env.base}`, logicalHead, env.result.sha], { allow: [1] });
    const clean = typeof merged === 'string';
    const text = clean ? merged : merged.stdout;
    const [tree, ...rest] = text.split('\n'); const blank = rest.indexOf('');
    const conflictPaths = clean ? [] : rest.slice(0, blank === -1 ? rest.length : blank).filter(Boolean);
    const messages = blank === -1 ? [] : rest.slice(blank + 1);
    const conflicts = conflictPaths.map(path => ({ path, kind: conflictKind(messages, path) }));
    const changes = clean ? git(repo, ['diff-tree', '-r', '--name-status', '--no-renames', logicalHead, tree]).split('\n').filter(Boolean).map(line => { const [status, ...p] = line.split('\t'); return { status, path: p.join('\t') }; }) : [];
    const checkout = worktrees(repo).find(entry => entry.branch === `refs/heads/${env.logicalBranch}`) ?? null;
    const dirty = checkout ? dirtyPaths(checkout.path) : [];
    const blockedBy = changes.map(c => c.path).filter(path => dirty.includes(path));
    return { environmentId: id, logicalBranch: env.logicalBranch, base: env.base, logicalHead, result: env.result.sha, moved: commitsSince > 0 || !baseOnBranch, commitsSince, baseOnBranch,
      clean, conflicts, changes, tree: clean ? tree : null, checkout: checkout ? { dirty: dirty.length } : null, blockedBy, canApply: clean && blockedBy.length === 0,
      details: { checkoutPath: checkout?.path ?? null } };
  }

  // Applies a previewed result: one Apply per logical branch at a time; the checkout (if the branch
  // is checked out) is updated for exactly the changed paths, then the branch moves by
  // compare-and-swap. A race, a conflict or overlapping uncommitted work writes nothing.
  applyEnvironment(id, { message } = {}) {
    const env = this.record(id); const repo = this.repo(env.projectId);
    if (!['completed', 'conflict'].includes(env.state)) fail('INVALID_STATE', `An environment that is ${env.state} cannot be applied`, { state: env.state });
    const lock = acquireLock(join(this.root, 'locks'), `${short(env.projectId)}-${short(env.logicalBranch)}`, { alive: this.alive });
    if (!lock) fail('LOCKED', 'Another Apply to this branch is in progress');
    try {
      const preview = this.previewApply(id);
      if (!preview.clean) { this.transition(id, 'conflict', { conflict: { paths: preview.conflicts, against: preview.logicalHead, at: this.now() } }); fail('CONFLICT', 'The result conflicts with the branch', { conflicts: preview.conflicts }); }
      if (preview.blockedBy.length) fail('DIRTY_OVERLAP', 'Uncommitted changes in the checkout would be overwritten', { paths: preview.blockedBy });
      const subject = message ?? `Apply ${env.task ?? `environment ${id.slice(0, 8)}`}`;
      const body = [subject, '', `Journal-Environment: ${id}`, `Journal-Session: ${env.sessionId ?? '-'}`, `Journal-Base: ${env.base}`, `Journal-Result: ${env.result.sha}`].join('\n');
      const commit = git(repo, ['commit-tree', preview.tree, '-p', preview.logicalHead, '-m', body], { env: JOURNAL_IDENTITY });
      const checkout = preview.details.checkoutPath;
      // The checkout's own index lock (the lock Git itself takes) is held for the whole landing, so
      // a `git commit` there in the meantime fails cleanly instead of capturing half-applied files.
      // The new index is built in a side file and becomes the index only after the branch moved.
      const gitDir = checkout ? git(checkout, ['rev-parse', '--absolute-git-dir']) : null;
      const indexLock = checkout ? join(gitDir, 'index.lock') : null; const sideIndex = checkout ? join(gitDir, `journal-apply-${id}.index`) : null;
      // Intent first: the plan is durable before any working-tree or ref change.
      this.transition(id, 'integrating', { integration: { phase: 'planned', from: preview.logicalHead, commit, checkout, indexLock, sideIndex, at: this.now() } });
      if (checkout) {
        try { closeSync(openSync(indexLock, 'wx')); } catch { this.transition(id, 'completed', { integration: null }); fail('LOCKED', 'Git is busy in the checkout (index.lock exists); try again'); }
        copyFileSync(join(gitDir, 'index'), sideIndex);
        try { git(checkout, ['read-tree', '-m', '-u', preview.logicalHead, commit], { env: { GIT_INDEX_FILE: sideIndex } }); }
        catch (error) { rmSync(sideIndex, { force: true }); rmSync(indexLock, { force: true }); this.transition(id, 'completed', { integration: null }); fail('CHECKOUT_REFUSED', 'Git refused to update the checkout; nothing was applied', { reason: String(error.stderr ?? error.message).trim() }); }
      }
      this.patch(id, { integration: { ...this.record(id).integration, phase: 'files' } });
      this.hooks.afterFiles?.(this.record(id));
      this.hooks.beforeLand?.(this.record(id));
      const landed = git(repo, ['update-ref', '-m', `journal apply ${id}`, `refs/heads/${env.logicalBranch}`, commit, preview.logicalHead], { allow: [1, 128] });
      if (typeof landed !== 'string') {
        // The branch moved after the preview: put the files back; the real index was never changed.
        if (checkout) { git(checkout, ['read-tree', '-m', '-u', commit, preview.logicalHead], { env: { GIT_INDEX_FILE: sideIndex } }); rmSync(sideIndex, { force: true }); rmSync(indexLock, { force: true }); }
        this.transition(id, 'completed', { integration: null });
        fail('BRANCH_MOVED', 'The branch changed while applying; nothing was applied. Preview again.');
      }
      this.patch(id, { integration: { ...this.record(id).integration, phase: 'landed' } });
      this.hooks.afterLand?.(this.record(id));
      if (checkout) { renameSync(sideIndex, indexLock); renameSync(indexLock, join(gitDir, 'index')); }
      return this.view(this.transition(id, 'integrated', { conflict: null, integration: { ...this.record(id).integration, phase: 'landed', landedAt: this.now() } }));
    } finally { lock.release(); }
  }

  // ---- Conflict resolution in the environment (spec §9.1, §9.2) ---------------------------
  // Brings the logical branch's current state into the environment (never the other way), leaving
  // any conflict markers in the environment's files for its worker to resolve. The base moves to
  // that branch commit, so the next preview compares against it. The user's checkout is untouched.
  updateFromBranch(id) {
    const env = this.record(id); const repo = this.repo(env.projectId);
    if (!['ready', 'completed', 'conflict'].includes(env.state)) fail('INVALID_STATE', `An environment that is ${env.state} cannot be updated from its branch`, { state: env.state });
    const target = git(repo, ['rev-parse', `refs/heads/${env.logicalBranch}`]);
    // The worker's work, uncommitted included, becomes the environment's HEAD (its result commit),
    // so the merge never refuses over local changes and nothing is lost.
    const result = this.snapshotEnvironment(id).result.id;
    git(env.path, ['update-ref', '--no-deref', 'HEAD', result]); git(env.path, ['read-tree', result]);
    const merged = git(env.path, ['merge', '--no-ff', '--no-commit', target], { allow: [1], env: JOURNAL_IDENTITY });
    const conflicts = typeof merged === 'string' ? [] : git(env.path, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
    git(repo, ['update-ref', REF(id, 'base'), target]);
    return { environment: this.view(this.patch(id, { base: target, conflict: conflicts.length ? { paths: conflicts.map(path => ({ path, kind: 'content' })), against: target, at: this.now(), inEnvironment: true } : null })), conflicts };
  }

  // ---- Cleanup (spec §11) -----------------------------------------------------------------
  // Removes the worktree only when every check passes; otherwise cleanup_pending with the reason.
  // Never --force: the worktree is made clean by pointing its HEAD and index at the captured
  // result (identical to its files), so `git worktree remove` succeeds only if nothing changed.
  cleanupEnvironment(id) {
    const env = this.record(id); const repo = this.repo(env.projectId);
    if (!['integrated', 'abandoned', 'failed', 'cleanup_pending'].includes(env.state)) fail('INVALID_STATE', `An environment that is ${env.state} is not ready to clean up`, { state: env.state });
    const pending = reason => { this.transition(id, 'cleanup_pending', { cleanup: { reason, attempts: (env.cleanup?.attempts ?? 0) + 1, at: this.now() } }); return this.view(this.record(id)); };
    const live = env.processes.filter(p => this.alive(p.pid)); if (live.length) return pending(`processes still running: ${live.map(p => p.pid).join(', ')}`);
    if (!existsSync(env.path)) { this.forgetAdmin(repo, env); return this.view(this.transition(id, 'removed')); }
    const unsafe = this.unsafe(env, repo); if (unsafe) fail('UNSAFE_CLEANUP', unsafe);
    // The folder's content must be exactly the captured result (a failed one is captured now).
    const before = env.result; const after = this.snapshotEnvironment(id).result;
    if (before && before.sha !== after.id) return pending('the environment changed after its result was captured');
    const result = this.record(id).result;
    try {
      // First point HEAD and the index at the result (identical to the files), so the folder is clean.
      if (result) { git(env.path, ['update-ref', '--no-deref', 'HEAD', result.sha]); git(env.path, ['read-tree', result.sha]); }
      // Links Git does not track (inside ignored folders, such as node_modules) are deleted as links
      // here; tracked links are left to Git, which removes them as links.
      const tracked = new Set(git(env.path, ['ls-files', '-z'], { raw: true }).split('\0').filter(Boolean));
      for (const link of findLinks(env.path, { tracked })) removeLink(link);
      git(repo, ['worktree', 'unlock', env.path], { allow: [128] });
      this.remove(repo, env.path);
    } catch (error) {
      // A file held open (Windows), or anything Git refuses: keep everything, try again later.
      if (existsSync(env.path)) tryGit(repo, ['worktree', 'lock', '--reason', `journal env ${id}`, env.path]);
      return pending(error instanceof GitError ? String(error.stderr).trim().split('\n').at(-1) : `${error.code ?? ''} ${error.message}`.trim());
    }
    rmSync(env.tmpDir, { recursive: true, force: true }); rmSync(env.logDir, { recursive: true, force: true });
    return this.view(this.transition(id, 'removed', { cleanup: { removedAt: this.now() } }));
  }
  // The reasons this folder must not be removed by Journal, or null.
  unsafe(env, repo) {
    let real; try { real = realpathSync(env.path); } catch { return 'the folder cannot be resolved'; }
    if (real !== env.path || !inside(this.envRoot, real)) return 'the folder is not inside Journal\'s environments folder (or is reached through a link)';
    const entry = worktrees(repo).find(w => samePath(w.path, real));
    if (!entry) return 'Git does not list this folder as a worktree of the project';
    const admin = this.adminDir(env.path);
    if (!admin || samePath(admin, git(repo, ['rev-parse', '--absolute-git-dir']))) return 'the folder\'s Git metadata resolves to the main checkout';
    let marker = ''; try { marker = readFileSync(join(admin, MARKER), 'utf8').trim(); } catch { /* none */ }
    if (marker !== env.id) return 'the worktree was not created by Journal for this environment';
    return null;
  }
  // The folder is already gone: remove only this environment's own admin entry (marked), never a
  // repository-wide prune, which would also drop other missing worktrees (for example an unmounted drive).
  forgetAdmin(repo, env) {
    const common = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    for (const name of (() => { try { return readdirSync(join(common, 'worktrees')); } catch { return []; } })()) {
      const admin = join(common, 'worktrees', name); let marker = ''; let gitdir = '';
      try { marker = readFileSync(join(admin, MARKER), 'utf8').trim(); gitdir = readFileSync(join(admin, 'gitdir'), 'utf8').trim(); } catch { continue; }
      if (marker === env.id && samePath(dirname(gitdir), env.path)) rmSync(admin, { recursive: true, force: true });
    }
  }
  adminDir(path) { return tryGit(path, ['rev-parse', '--absolute-git-dir']); }

  // ---- Recovery ---------------------------------------------------------------------------
  // After a crash: finish or roll back what the durable record says was in progress.
  reconcile() {
    const report = [];
    for (const env of Object.values(this.records.load().environments)) {
      const repo = this.repos[env.projectId]; if (!repo) continue;
      if (env.state === 'creating') {
        const ok = existsSync(env.path) && this.adminDir(env.path) && tryGit(repo, ['rev-parse', '--verify', REF(env.id, 'base')]);
        if (ok) { const admin = this.adminDir(env.path); if (!existsSync(join(admin, MARKER))) writeFileSync(join(admin, MARKER), `${env.id}\n`); mkdirSync(env.tmpDir, { recursive: true }); mkdirSync(env.logDir, { recursive: true }); }
        this.transition(env.id, ok ? 'ready' : 'failed', ok ? {} : { error: 'creation did not finish' }); report.push([env.id, env.state, ok ? 'ready' : 'failed']); continue;
      }
      if (['running', 'waiting'].includes(env.state) && !env.processes.some(p => this.alive(p.pid))) { this.transition(env.id, 'ready', { processes: [] }); report.push([env.id, env.state, 'ready']); continue; }
      if (env.state === 'integrating') {
        const { from, commit, checkout, indexLock, sideIndex } = env.integration; const head = git(repo, ['rev-parse', `refs/heads/${env.logicalBranch}`]);
        const ours = indexLock && existsSync(indexLock) && sideIndex && existsSync(sideIndex);
        if (head === commit) {
          // Landed: finish moving the prepared index into place.
          if (ours) { renameSync(sideIndex, indexLock); renameSync(indexLock, join(dirname(indexLock), 'index')); }
          this.transition(env.id, 'integrated', { integration: { ...env.integration, phase: 'landed' } }); report.push([env.id, 'integrating', 'integrated']); continue;
        }
        // Not landed: put the files back with the side index, then drop it and the lock. The real index never changed.
        if (ours) { tryGit(checkout, ['read-tree', '-m', '-u', commit, from], { env: { GIT_INDEX_FILE: sideIndex } }); rmSync(sideIndex, { force: true }); rmSync(indexLock, { force: true }); }
        this.transition(env.id, 'completed', { integration: null }); report.push([env.id, 'integrating', 'completed']);
      }
    }
    return report;
  }

  async allocatePorts(id) {
    const taken = Object.values(this.records.load().environments).filter(env => env.state !== 'removed' && env.id !== id).map(env => env.ports[0]);
    const block = await allocateBlock(taken, { range: this.range, excluded: this.excluded, ...(this.probe ? { probe: this.probe } : {}) });
    return block.ports;
  }
  contained(path) { if (!inside(this.envRoot, resolve(path))) fail('UNSAFE_PATH', 'Environment paths must stay inside Journal\'s environments folder'); }

  // What callers see: no paths or refs unless they open details.
  view(env) {
    return { id: env.id, projectId: env.projectId, sessionId: env.sessionId, task: env.task, logicalBranch: env.logicalBranch, state: env.state, base: env.base,
      result: env.result ? { id: env.result.sha, files: env.result.files, at: env.result.at } : null, conflict: env.conflict, integration: env.integration ? { commit: env.integration.commit, phase: env.integration.phase } : null,
      cleanup: env.cleanup, error: env.error ?? null, ports: env.ports, createdAt: env.createdAt, updatedAt: env.updatedAt,
      details: { path: env.path, tmpDir: env.tmpDir, logDir: env.logDir, refs: { base: REF(env.id, 'base'), head: REF(env.id, 'head'), result: REF(env.id, 'result') } } };
  }
}

const inside = (root, path) => { const rel = relative(root, path); return !!rel && !rel.startsWith('..') && !isAbsolute(rel); };
const samePath = (a, b) => process.platform === 'win32' || process.platform === 'darwin' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
function conflictKind(messages, path) {
  const line = messages.find(text => text.includes(path) && text.startsWith('CONFLICT')) ?? '';
  const match = /^CONFLICT \(([^)]+)\)/.exec(line); return match ? match[1] : 'content';
}
// Paths with any uncommitted change (staged, unstaged or untracked) in a checkout.
function dirtyPaths(checkout) {
  const out = git(checkout, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { raw: true }).split('\0');
  const paths = [];
  for (let i = 0; i < out.length; i++) { const entry = out[i]; if (!entry) continue; paths.push(entry.slice(3)); if (/^[RC]/.test(entry)) paths.push(out[++i]); }
  return paths;
}
const changedPaths = (repo, from, to) => git(repo, ['diff-tree', '-r', '--name-only', '--no-renames', from, to]).split('\n').filter(Boolean);
