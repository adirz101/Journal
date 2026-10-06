import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { isSensitivePath } from './evidence.mjs';
import { relativePath } from './validation.mjs';
import { realPath } from './paths.mjs';
import { gitEnv } from './git-env.mjs';

// Read-only Git views for a session: what changed in the checkout since the
// session started. Concurrent sessions in one checkout share a working tree,
// so changes are attributed to the checkout, never to one agent.
//
// Other Git working trees inside the checkout (a worktree in an ignored folder such as
// .worktrees/name, a nested repository or a submodule) are listed too when the session's own
// recorded edits or commands were in them: the checkout's Git never sees inside them.

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_FILES = 500; const MAX_DIFF = 200 * 1024;
const raw = (root, args, maxBuffer = 8 * 1024 * 1024) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 8000, maxBuffer, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: gitEnv() });
const quiet = (action, fallback) => { try { return action(); } catch { return fallback; } };

const MAX_TREES = 8;
// The other working trees under root that hold any of the given absolute paths: for each path,
// the nearest folder below root (never root itself) with its own .git entry.
export function nestedTrees(root, paths) {
  const top = realPath(root); const found = new Map();
  for (const path of paths) {
    if (found.size >= MAX_TREES) break;
    let current = quiet(() => realPath(path), null); if (!current) continue;
    const rel = relative(top, current); if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
    // From the path up to (not including) the checkout's root.
    let tree = null;
    for (let dir = current; dir !== top && dir.startsWith(top + sep); dir = dirname(dir)) if (existsSync(resolve(dir, '.git'))) tree = dir;
    if (tree) { const prefix = `${relative(top, tree).split(sep).join('/')}/`; if (!found.has(prefix)) found.set(prefix, tree); }
  }
  // The outermost tree holding each path wins (its inner trees are its own concern); sorted for a stable order.
  return [...found].filter(([prefix]) => ![...found.keys()].some(other => other !== prefix && prefix.startsWith(other))).sort(([a], [b]) => a.localeCompare(b)).map(([prefix, path]) => ({ prefix, root: path }));
}

// A nested tree's base. Journal did not record its commit when the session started, so the base
// is the parent of the oldest commit the session could have made there: walking the branch's
// first-parent history from HEAD, the commits written (author date) after the session started that
// are not on the repository's main branch (origin/HEAD, else origin/main, main or master). A
// rebase onto a newer main brings main's commits along with new commit dates; they are not the
// session's. With no such commit the base is HEAD (only uncommitted changes are listed).
const MAIN_REFS = ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master'];
export function treeBase(root, since) {
  const head = quiet(() => raw(root, ['rev-parse', '--verify', '-q', 'HEAD']).trim(), '');
  const start = Date.parse(since ?? '');
  if (!head) return EMPTY_TREE;
  if (!Number.isFinite(start)) return head;
  const main = MAIN_REFS.map(ref => ({ ref, hash: quiet(() => raw(root, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]).trim(), '') })).find(entry => entry.hash);
  const own = main ? new Set(quiet(() => raw(root, ['rev-list', 'HEAD', `^${main.hash}`]).trim().split('\n').filter(Boolean), [])) : null;
  let base = head;
  for (const line of quiet(() => raw(root, ['log', '--first-parent', '-n', '500', '--format=%H %at %P', 'HEAD']).trim().split('\n').filter(Boolean), [])) {
    const [hash, at, parent] = line.split(' ');
    if (Number(at) * 1000 < start || (own && !own.has(hash))) break;
    base = parent || EMPTY_TREE;
  }
  return base;
}
function treeChanges(tree, session, room) {
  const base = treeBase(tree.root, session.createdAt);
  const files = listChanges(tree.root, base, [], room).map(file => ({ ...file, path: `${tree.prefix}${file.path}`, from: file.from ? `${tree.prefix}${file.from}` : null, tree: tree.prefix.slice(0, -1) }));
  const head = quiet(() => raw(tree.root, ['rev-parse', 'HEAD']).trim(), '');
  return { info: { path: tree.prefix.slice(0, -1), branch: quiet(() => raw(tree.root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), null) || null, base, head,
    commitsSince: base !== EMPTY_TREE && head ? Number(quiet(() => raw(tree.root, ['rev-list', '--count', `${base}..HEAD`]).trim(), 0)) : 0, files: files.length }, files };
}

// Paths with uncommitted changes, so pre-existing edits are labelled later.
export function checkoutBaseline(project) {
  // A folder inside a larger repository is limited by pathspec before any cap applies.
  const scope = project.pathPrefix ? ['--', project.pathPrefix] : [];
  const entries = quiet(() => raw(project.root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', ...scope]).split('\0').filter(Boolean), []);
  const dirty = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]; dirty.push(entry.slice(3));
    if (/^[RC]/.test(entry)) i++; // rename/copy source follows
  }
  return { head: project.head, branch: project.branch, dirty: dirty.slice(0, 200), dirtyCount: dirty.length, capturedAt: new Date().toISOString() };
}

// A regular file inside the checkout, reached without any symlink component.
function safeFile(root, path) {
  let current = root;
  for (const part of path.split('/')) { current = resolve(current, part); if (lstatSync(current).isSymbolicLink()) return null; }
  const canonical = realPath(current); const rel = relative(realPath(root), canonical);
  return rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep) ? canonical : null;
}

function untrackedLines(root, path) {
  try {
    const full = safeFile(root, path); if (!full) return null;
    const stat = lstatSync(full);
    if (!stat.isFile() || stat.size > 1024 * 1024) return null;
    const bytes = readFileSync(full); if (bytes.includes(0)) return null;
    const text = bytes.toString('utf8'); return text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
  } catch { return null; }
}

export function sessionChanges(project, session, nested = []) {
  const base = session.baseline?.head ?? session.head ?? EMPTY_TREE;
  if (base !== EMPTY_TREE && !quiet(() => raw(project.root, ['cat-file', '-e', `${base}^{commit}`]) === '', false)) {
    return { base, available: false, reason: 'The session baseline commit is no longer in this repository.', files: [] };
  }
  const preexisting = new Set(session.baseline?.dirty ?? []);
  const scope = project.pathPrefix ? ['--', project.pathPrefix] : [];
  const files = listChanges(project.root, base, scope, MAX_FILES);
  // A folder inside a larger repository shows only its own paths.
  if (project.pathPrefix) for (let i = files.length - 1; i >= 0; i--) if (!files[i].path.startsWith(project.pathPrefix)) files.splice(i, 1);
  for (const file of files) file.preexisting = preexisting.has(file.path);
  // Other working trees the session worked in (never for a folder of a larger repository).
  const trees = [];
  for (const tree of project.pathPrefix ? [] : nested) {
    if (files.length >= MAX_FILES) break;
    const result = treeChanges(tree, session, MAX_FILES - files.length);
    trees.push(result.info); files.push(...result.files.map(file => ({ ...file, preexisting: false })));
  }
  for (const file of files) file.sensitive = isSensitivePath(file.path);
  const head = project.head;
  return {
    base, available: true, head, branch: project.branch, headMoved: !!head && head !== (session.baseline?.head ?? session.head),
    commitsSince: base !== EMPTY_TREE && head ? Number(quiet(() => raw(project.root, ['rev-list', '--count', `${base}..HEAD`]).trim(), 0)) : 0,
    files, truncated: files.length >= MAX_FILES, trees,
    additions: files.reduce((sum, f) => sum + (f.additions ?? 0), 0), deletions: files.reduce((sum, f) => sum + (f.deletions ?? 0), 0),
    preexistingCount: session.baseline?.dirtyCount ?? 0, sharedCheckout: true, folderPrefix: project.pathPrefix || null,
  };
}

// Changed (against base, with renames) and untracked files of one working tree, at most room.
function listChanges(root, base, scope, room) {
  const files = [];
  const numstat = quiet(() => raw(root, ['diff', '--numstat', '-z', '-M', base, ...scope]), '').split('\0');
  for (let i = 0; i < numstat.length && files.length < room; i++) {
    const record = numstat[i]; if (!record) continue;
    const [added, deleted, path] = record.split('\t');
    let name = path; let from = null;
    if (path === '') { from = numstat[++i]; name = numstat[++i]; }
    if (!name) continue;
    files.push({ path: name, from, additions: added === '-' ? null : Number(added), deletions: deleted === '-' ? null : Number(deleted), binary: added === '-', untracked: false });
  }
  for (const path of quiet(() => raw(root, ['ls-files', '--others', '--exclude-standard', '-z', ...scope]).split('\0').filter(Boolean), [])) {
    if (files.length >= room) break;
    const lines = untrackedLines(root, path);
    files.push({ path, from: null, additions: lines, deletions: 0, binary: lines === null, untracked: true });
  }
  return files;
}

// Where a listed path lives: the checkout, or a nested tree (its root, the path inside it, its base).
function locate(project, session, nested, path) {
  const tree = project.pathPrefix ? null : nested.find(entry => path.startsWith(entry.prefix));
  if (!tree) return { root: project.root, path, base: session.baseline?.head ?? session.head ?? EMPTY_TREE };
  return { root: tree.root, path: path.slice(tree.prefix.length), base: treeBase(tree.root, session.createdAt) };
}

// Opening is limited to listed, regular, non-executable files.
export function openableFile(project, session, path, nested = []) {
  path = relativePath(path);
  if (!sessionChanges(project, session, nested).files.some(file => file.path === path)) throw new Error('File is not in this session\'s changes');
  const full = safeFile(project.root, path); if (!full) throw new Error('File is not a regular file inside the project');
  const stat = lstatSync(full);
  // Allowlist of passive document types; everything else is only revealed.
  const passive = /\.(?:md|markdown|txt|text|log|json|jsonc|ya?ml|toml|ini|cfg|conf|csv|tsv|diff|patch|png|jpe?g|gif|webp|bmp|pdf)$/i.test(path);
  // Sensitive files (for example secrets.json) are only revealed, never opened.
  return { path: full, open: stat.isFile() && !(stat.mode & 0o111) && passive && !isSensitivePath(path) };
}

export function fileDiff(project, session, path, nested = []) {
  path = relativePath(path);
  if (project.pathPrefix && !path.startsWith(project.pathPrefix)) throw new Error('File is not in this session\'s changes');
  if (isSensitivePath(path)) return { path, hidden: true, text: '' };
  // Only paths this view listed; never an arbitrary request.
  if (!sessionChanges(project, session, nested).files.some(file => file.path === path)) throw new Error('File is not in this session\'s changes');
  const where = locate(project, session, nested, path);
  let text = quiet(() => raw(where.root, ['diff', '--no-color', '--no-ext-diff', where.base, '--', where.path], MAX_DIFF * 4), '');
  if (!text) {
    const tracked = quiet(() => { raw(where.root, ['ls-files', '--error-unmatch', '--literal-pathspecs', '--', where.path]); return true; }, false);
    const full = !tracked && untrackedLines(where.root, where.path) !== null ? safeFile(where.root, where.path) : null;
    if (full) text = readFileSync(full, 'utf8').split('\n').map(line => `+${line}`).join('\n');
  }
  return { path, hidden: false, truncated: text.length > MAX_DIFF, text: text.slice(0, MAX_DIFF) };
}
