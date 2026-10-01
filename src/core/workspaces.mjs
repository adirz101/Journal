import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { inspectProject } from './project.mjs';
import { text } from './validation.mjs';

// Workspaces: the project's own checkout, Journal-managed Git worktrees, and
// imported existing worktrees. Rules:
// - intent is persisted before any Git side effect, then reconciled;
// - Journal never forces, stashes, transfers uncommitted changes or deletes
//   an imported worktree; removal refuses anything dirty, untracked or ignored;
// - a session runs only in a registered worktree of the same repository.

const run = (cwd, args, { timeout = 30000, allowFail = false } = {}) => {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' } });
  } catch (error) { if (allowFail) return null; throw new Error(String(error.stderr || error.message).trim().split('\n').slice(-2).join(' ').slice(0, 400)); }
};
const canonical = path => { try { return realpathSync(path); } catch { return resolve(path); } };

export function listGitWorktrees(root) {
  const entries = []; let current = null;
  for (const line of (run(root, ['worktree', 'list', '--porcelain'], { allowFail: true }) ?? '').split('\n')) {
    if (line.startsWith('worktree ')) { current = { path: canonical(line.slice(9)), head: null, branch: null, detached: false, bare: false, locked: false, prunable: false }; entries.push(current); }
    else if (!current) continue;
    else if (line.startsWith('HEAD ')) current.head = line.slice(5);
    else if (line.startsWith('branch ')) current.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') current.detached = true;
    else if (line === 'bare') current.bare = true;
    else if (line.startsWith('locked')) current.locked = true;
    else if (line.startsWith('prunable')) current.prunable = true;
  }
  return entries;
}

export function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9._/-]+/g, '-').replace(/\/+/g, '/').replace(/^[-./]+|[-./]+$/g, '').slice(0, 60) || 'work';
}

export function validateBranchName(root, branch) {
  branch = text(branch, 'branch name', 200);
  if (run(root, ['check-ref-format', '--branch', branch], { allowFail: true }) === null) throw new Error('Invalid branch name');
  if (run(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true }) !== null) throw new Error(`Branch ${branch} already exists; choose another name or import its worktree`);
  return branch;
}

export function resolveBase(root, base) {
  base = text(base, 'base', 200);
  if (/^-/.test(base)) throw new Error('Invalid base');
  const commit = run(root, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { allowFail: true })?.trim();
  if (!commit) throw new Error(`Base ${base} is not a commit in this repository`);
  return commit;
}

// What a new worktree will not contain, and other conservative warnings.
export function creationNotices(project) {
  const notices = [];
  const dirty = (run(project.root, ['status', '--porcelain=v1', '--untracked-files=normal'], { allowFail: true }) ?? '').split('\n').filter(Boolean).length;
  if (dirty) notices.push(`${dirty} uncommitted or untracked change${dirty === 1 ? '' : 's'} in the current checkout will not be in the new worktree. Journal does not stash or copy them.`);
  if (existsSync(join(project.root, '.gitmodules'))) notices.push('This repository has submodules. They are not initialized in the new worktree; Journal does not run submodule commands.');
  if ((run(project.root, ['config', '--bool', 'core.sparseCheckout'], { allowFail: true }) ?? '').trim() === 'true') notices.push('Sparse checkout is enabled; the new worktree may contain more files than this checkout.');
  if ((run(project.root, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'], { allowFail: true }) ?? '').trim()) notices.push('Ignored files (for example dependencies or build output) are not copied into the new worktree.');
  return notices;
}

export function plannedPath(worktreeRoot, project, branch, id) {
  return resolve(worktreeRoot, `${slugify(project.name)}-${project.id.slice(0, 8)}`, `${slugify(branch).replaceAll('/', '-')}-${id.slice(0, 6)}`);
}

// Runs the Git side effect for a persisted intent. Never uses --force.
export function addWorktree(project, workspace) {
  mkdirSync(resolve(workspace.path, '..'), { recursive: true, mode: 0o700 });
  if (existsSync(workspace.path)) throw new Error('The planned worktree path already exists; nothing was changed');
  run(project.root, ['worktree', 'add', '-b', workspace.branch, workspace.path, workspace.base], { timeout: 120000 });
}

export function registered(project, path) {
  const target = canonical(path);
  // A registered entry whose folder is gone (prunable) is not a usable worktree.
  return listGitWorktrees(project.root).find(entry => entry.path === target && !entry.prunable && existsSync(entry.path)) ?? null;
}

// Reasons a managed worktree must not be removed; empty means removable.
export function removalBlockers(project, workspace, liveSessions) {
  const reasons = [];
  if (workspace.kind !== 'managed') reasons.push('Only worktrees Journal created can be removed from Journal. Imported worktrees are never deleted.');
  if (liveSessions.length) reasons.push(`${liveSessions.length} session${liveSessions.length === 1 ? ' is' : 's are'} still running in it.`);
  const entry = registered(project, workspace.path);
  if (!entry) reasons.push('It is no longer a registered worktree of this repository.');
  else {
    if (entry.locked) reasons.push('It is locked.');
    const status = run(workspace.path, ['status', '--porcelain=v1', '--ignored', '--untracked-files=all'], { allowFail: true });
    if (status === null) reasons.push('Its Git status could not be read.');
    else {
      const lines = status.split('\n').filter(Boolean);
      const count = prefix => lines.filter(line => line.startsWith(prefix)).length;
      const unmerged = lines.filter(line => /^(?:DD|AU|UD|UA|DU|AA|UU)/.test(line)).length;
      const ignored = count('!!'); const untracked = count('??'); const changed = lines.length - ignored - untracked;
      if (unmerged) reasons.push(`${unmerged} unmerged path${unmerged === 1 ? '' : 's'}.`);
      if (changed - unmerged > 0) reasons.push(`${changed - unmerged} uncommitted change${changed - unmerged === 1 ? '' : 's'}.`);
      if (untracked) reasons.push(`${untracked} untracked file${untracked === 1 ? '' : 's'}.`);
      if (ignored) reasons.push(`${ignored} ignored path${ignored === 1 ? '' : 's'} (for example build output) would be deleted.`);
    }
  }
  return reasons;
}

export function removeWorktree(project, workspace) {
  run(project.root, ['worktree', 'remove', workspace.path], { timeout: 120000 });
}

// A read-only view of the project at a workspace path. The workspace must be
// a registered worktree of the same repository (same Git common directory).
export function workspaceView(project, workspace) {
  if (!workspace) return project;
  if (workspace.state !== 'ready') throw new Error(`Workspace ${workspace.branch ?? basename(workspace.path)} is ${workspace.state}`);
  const entry = registered(project, workspace.path);
  if (!entry) throw new Error('This workspace is no longer a registered worktree of the project');
  const info = inspectProject(workspace.path);
  if (info.commonDir !== project.commonDir) throw new Error('Workspace belongs to another repository');
  return { ...project, root: info.root, branch: info.branch, head: info.head, workspaceId: workspace.id };
}
