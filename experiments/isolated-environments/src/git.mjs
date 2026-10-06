import { execFileSync } from 'node:child_process';

// Git for the prototype: argument lists only (no shell), a cleaned environment so an inherited
// GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE can never point a command at another repository, and a
// fixed identity for the commits Journal itself writes (result snapshots, Apply commits).
const INHERITED = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES'];
export function gitEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of INHERITED) delete env[key];
  return { ...env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...extra };
}

export class GitError extends Error {
  constructor(args, status, stdout, stderr) { super(`git ${args.join(' ')} failed (${status}): ${String(stderr).trim().split('\n').at(-1) ?? ''}`); this.status = status; this.stdout = stdout; this.stderr = stderr; this.args = args; }
}

// Runs git in cwd; returns stdout (trimmed unless raw). allow: exit codes that are answers, not errors.
export function git(cwd, args, { env = {}, allow = [], raw = false, input } = {}) {
  try {
    const out = execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: gitEnv(env), stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], input, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    return raw ? out : out.trim();
  } catch (error) {
    if (allow.includes(error.status)) return { status: error.status, stdout: raw ? String(error.stdout) : String(error.stdout ?? '').trim(), stderr: String(error.stderr ?? '') };
    throw new GitError(args, error.status, error.stdout, error.stderr);
  }
}
export const tryGit = (cwd, args, options) => { try { return git(cwd, args, options); } catch { return null; } };

// The identity of commits Journal writes. Real implementation: the user's identity with a trailer (open question 2).
export const JOURNAL_IDENTITY = { GIT_AUTHOR_NAME: 'Journal', GIT_AUTHOR_EMAIL: 'journal@localhost', GIT_COMMITTER_NAME: 'Journal', GIT_COMMITTER_EMAIL: 'journal@localhost' };

export function gitVersion() {
  const text = execFileSync('git', ['--version'], { encoding: 'utf8', env: gitEnv() });
  const match = /(\d+)\.(\d+)/.exec(text); return match ? [Number(match[1]), Number(match[2])] : [0, 0];
}
export const atLeast = ([major, minor], [needMajor, needMinor]) => major > needMajor || (major === needMajor && minor >= needMinor);

// `git worktree list --porcelain`, parsed.
export function worktrees(repo) {
  const out = git(repo, ['worktree', 'list', '--porcelain'], { raw: true });
  const list = []; let current = null;
  for (const line of out.split('\n')) {
    if (!line) { if (current) list.push(current); current = null; continue; }
    const [key, ...rest] = line.split(' '); const value = rest.join(' ');
    if (key === 'worktree') current = { path: value, locked: null, detached: false, branch: null, head: null, prunable: false };
    else if (!current) continue;
    else if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = value;
    else if (key === 'detached') current.detached = true;
    else if (key === 'locked') current.locked = value || '';
    else if (key === 'prunable') current.prunable = true;
  }
  if (current) list.push(current);
  return list;
}
