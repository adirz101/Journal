import { execFileSync } from 'node:child_process';
import { relative, resolve, sep } from 'node:path';
import { gitEnv } from './git-env.mjs';
import { listGitWorktrees } from './workspaces.mjs';
import { realPath } from './paths.mjs';
import { text } from './validation.mjs';

// Branches of one repository working tree (the checkout, a worktree or an added
// Git folder) and switching between them. Rules:
// - refs are read with for-each-ref and a NUL-separated format, never human porcelain;
// - a switch is a plain `git switch` (or `git switch -c <name> --track <remote>/<name>` for a
//   remote-only branch): never --force, --discard-changes, --merge, stash, reset or clean;
// - Git's own refusal (changes that would be overwritten, a merge in progress) leaves the
//   working tree as it was and is reported in plain words.

export const BRANCH_LIMIT = 2000;
const FIELDS = ['%(refname)', '%(refname:short)', '%(objectname)', '%(upstream:short)', '%(upstream:track,nobracket)', '%(committerdate:unix)', '%(contents:subject)', '%(symref)'];
const FORMAT = `${FIELDS.join('%00')}%00%1e`;

function git(cwd, args, { timeout = 15000 } = {}) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv() });
}
const quiet = action => { try { return action(); } catch { return null; } };
const canonical = path => { try { return realPath(path); } catch { return resolve(path); } };
export const inside = (parent, child) => { const rel = relative(parent, child); return rel === '' || (!!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel)); };

function refs(root, pattern, limit) {
  const out = git(root, ['for-each-ref', `--count=${limit + 1}`, '--sort=-committerdate', `--format=${FORMAT}`, pattern]);
  const rows = [];
  for (const record of out.split('\u0000\u001e')) {
    const fields = record.replace(/^\r?\n/, '').split('\u0000');
    if (fields.length < FIELDS.length || !fields[0]) continue;
    const [ref, short, commit, upstream, track, date, subject, symref] = fields;
    rows.push({ ref, short, commit, upstream: upstream || null, track: track || null, date: Number(date) ? new Date(Number(date) * 1000).toISOString() : null, subject: subject.slice(0, 200), symref: symref || null });
  }
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

// The working tree's current branch (null when detached or unborn), and HEAD.
export function currentBranch(root) {
  const branch = quiet(() => git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim()) || null;
  const head = quiet(() => git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).trim()) || null;
  return { branch, head, detached: !branch && !!head };
}

// Local branches first (current first, then most recent commit), then remote-tracking branches
// that no local branch tracks. A branch checked out in another worktree names its path.
export function listBranches(root, { limit = BRANCH_LIMIT } = {}) {
  const here = canonical(root); remoteCache = { root: null, names: [] }; // remotes are read once per listing
  const { branch, head, detached } = currentBranch(here);
  const elsewhere = new Map();
  for (const entry of listGitWorktrees(here)) if (entry.branch && entry.path !== here && !entry.bare) elsewhere.set(entry.branch, entry.path);
  const locals = refs(here, 'refs/heads', limit);
  const remotes = refs(here, 'refs/remotes', limit);
  const tracked = new Set(locals.rows.map(row => row.upstream).filter(Boolean));
  const local = locals.rows.map(row => ({ kind: 'local', name: row.short, commit: row.commit, upstream: row.upstream, track: row.track, date: row.date, subject: row.subject,
    current: row.short === branch, worktree: elsewhere.get(row.short) ?? null }));
  local.sort((a, b) => Number(b.current) - Number(a.current));
  const localNames = new Set(local.map(row => row.name));
  const remote = remotes.rows.filter(row => !row.symref && !row.ref.endsWith('/HEAD') && !tracked.has(row.short)).map(row => {
    const name = localName(here, row.short);
    return { kind: 'remote', name: row.short, localName: name, commit: row.commit, upstream: null, track: null, date: row.date, subject: row.subject, current: false,
      // A local branch of the same name that tracks something else: switching would not create it.
      worktree: null, conflict: name && localNames.has(name) ? name : null };
  });
  return { branch, head, detached, local, remote, truncated: locals.truncated || remotes.truncated };
}

// The local name `git switch` would create for a remote-tracking branch: the part after the
// remote's name (remote names may contain a slash, so the configured remotes decide).
let remoteCache = { root: null, names: [] };
function localName(root, short) {
  if (remoteCache.root !== root) remoteCache = { root, names: (quiet(() => git(root, ['remote']).split(/\r?\n/).filter(Boolean)) ?? []).sort((a, b) => b.length - a.length) };
  const remote = remoteCache.names.find(name => short.startsWith(`${name}/`));
  return remote ? short.slice(remote.length + 1) : null;
}

// Git's refusal, in plain words. Git already left the working tree untouched.
export function switchFailure(stderr, target) {
  const lines = String(stderr ?? '').split(/\r?\n/);
  const files = (after) => { const start = lines.findIndex(line => after.test(line)); if (start < 0) return []; const out = []; for (const line of lines.slice(start + 1)) { if (!/^\s+\S/.test(line)) break; out.push(line.trim()); } return out; };
  const list = names => names.length ? `${names.slice(0, 5).join(', ')}${names.length > 5 ? ` and ${names.length - 5} more` : ''}` : null;
  const changed = files(/local changes to the following files would be overwritten/i);
  if (changed.length || /local changes .* would be overwritten/i.test(stderr)) return `Not switched to ${target}: your uncommitted changes${changed.length ? ` to ${list(changed)}` : ''} would be overwritten. Commit or set them aside yourself, then try again. Nothing was changed.`;
  const untracked = files(/untracked working tree files would be (?:overwritten|removed)/i);
  if (untracked.length || /untracked working tree files would be/i.test(stderr)) return `Not switched to ${target}: untracked files${untracked.length ? ` (${list(untracked)})` : ''} are in the way of files on ${target}. Move or commit them, then try again. Nothing was changed.`;
  if (/resolve your current index first|you are in the middle of|merge is in progress|unmerged/i.test(stderr)) return `Not switched to ${target}: a merge, rebase or conflict is in progress in this repository. Finish or abort it first. Nothing was changed.`;
  if (/is already (?:checked out|used by worktree) at/i.test(stderr)) return `Not switched to ${target}: it is checked out in another worktree.`;
  const reason = lines.map(line => line.replace(/^(?:fatal|error):\s*/, '').trim()).filter(Boolean).slice(-2).join(' ').slice(0, 300);
  return `Git did not switch to ${target}${reason ? `: ${reason}` : ''}.`;
}

// Switches the working tree at root to a local branch, or creates the local tracking branch of a
// remote-only one. Returns what happened. Throws with a plain message when it refuses.
export function switchBranch(root, request) {
  const here = canonical(root);
  const kind = request?.kind === 'remote' ? 'remote' : request?.kind === 'local' ? 'local' : null;
  if (!kind) throw new Error('Choose a branch to switch to');
  const name = text(request.name, 'branch', 250);
  if (name.startsWith('-') || quiet(() => git(here, ['check-ref-format', `refs/${kind === 'local' ? 'heads' : 'remotes'}/${name}`])) === null) throw new Error('Invalid branch name');
  const before = currentBranch(here);
  if (kind === 'local') {
    if (quiet(() => git(here, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}^{commit}`])) === null) throw new Error(`Branch ${name} no longer exists`);
    if (before.branch === name) return { branch: name, head: before.head, previous: before.branch, created: false, unchanged: true };
    const other = listGitWorktrees(here).find(entry => entry.branch === name && entry.path !== here && !entry.bare);
    if (other) throw Object.assign(new Error(`Not switched: ${name} is checked out in another worktree (${other.path}). Git allows a branch in one worktree at a time.`), { worktree: other.path });
    run(here, ['switch', '--no-guess', name], name);
    const after = currentBranch(here);
    return { branch: after.branch, head: after.head, previous: before.branch, created: false, unchanged: false };
  }
  if (quiet(() => git(here, ['rev-parse', '--verify', '--quiet', `refs/remotes/${name}^{commit}`])) === null) throw new Error(`Remote branch ${name} no longer exists. Fetch from a terminal to update it.`);
  remoteCache = { root: null, names: [] };
  const local = localName(here, name);
  if (!local) throw new Error(`Journal could not tell which remote ${name} belongs to`);
  if (quiet(() => git(here, ['check-ref-format', '--branch', local])) === null) throw new Error('Invalid branch name');
  if (quiet(() => git(here, ['rev-parse', '--verify', '--quiet', `refs/heads/${local}`])) !== null) throw new Error(`Not switched: a local branch named ${local} already exists. Switch to it instead.`);
  run(here, ['switch', '--no-guess', '-c', local, '--track', name], local);
  const after = currentBranch(here);
  return { branch: after.branch, head: after.head, previous: before.branch, created: true, from: name, unchanged: false };
}

function run(root, args, target) {
  try { git(root, args, { timeout: 120000 }); }
  catch (error) {
    if (error.code === 'ETIMEDOUT' || error.signal) throw new Error(`Git took too long to switch to ${target}. Check the repository in a terminal.`);
    throw new Error(switchFailure(error.stderr || error.message, target));
  }
}
