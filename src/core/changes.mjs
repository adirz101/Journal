import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { isSensitivePath } from './evidence.mjs';
import { relativePath } from './validation.mjs';

// Read-only Git views for a session: what changed in the checkout since the
// session started. Concurrent sessions in one checkout share a working tree,
// so changes are attributed to the checkout, never to one agent.

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_FILES = 500; const MAX_DIFF = 200 * 1024;
const raw = (root, args, maxBuffer = 8 * 1024 * 1024) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 8000, maxBuffer, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' } });
const quiet = (action, fallback) => { try { return action(); } catch { return fallback; } };

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
  const canonical = realpathSync(current); const rel = relative(realpathSync(root), canonical);
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

export function sessionChanges(project, session) {
  const base = session.baseline?.head ?? session.head ?? EMPTY_TREE;
  if (base !== EMPTY_TREE && !quiet(() => raw(project.root, ['cat-file', '-e', `${base}^{commit}`]) === '', false)) {
    return { base, available: false, reason: 'The session baseline commit is no longer in this repository.', files: [] };
  }
  const preexisting = new Set(session.baseline?.dirty ?? []);
  const files = [];
  const scope = project.pathPrefix ? ['--', project.pathPrefix] : [];
  const numstat = quiet(() => raw(project.root, ['diff', '--numstat', '-z', '-M', base, ...scope]), '').split('\0');
  for (let i = 0; i < numstat.length && files.length < MAX_FILES; i++) {
    const record = numstat[i]; if (!record) continue;
    const [added, deleted, path] = record.split('\t');
    let name = path; let from = null;
    if (path === '') { from = numstat[++i]; name = numstat[++i]; }
    if (!name) continue;
    files.push({ path: name, from, additions: added === '-' ? null : Number(added), deletions: deleted === '-' ? null : Number(deleted), binary: added === '-', untracked: false });
  }
  for (const path of quiet(() => raw(project.root, ['ls-files', '--others', '--exclude-standard', '-z', ...scope]).split('\0').filter(Boolean), [])) {
    if (files.length >= MAX_FILES) break;
    const lines = untrackedLines(project.root, path);
    files.push({ path, from: null, additions: lines, deletions: 0, binary: lines === null, untracked: true });
  }
  // A folder inside a larger repository shows only its own paths.
  if (project.pathPrefix) for (let i = files.length - 1; i >= 0; i--) if (!files[i].path.startsWith(project.pathPrefix)) files.splice(i, 1);
  for (const file of files) { file.preexisting = preexisting.has(file.path); file.sensitive = isSensitivePath(file.path); }
  const head = project.head;
  return {
    base, available: true, head, branch: project.branch, headMoved: !!head && head !== (session.baseline?.head ?? session.head),
    commitsSince: base !== EMPTY_TREE && head ? Number(quiet(() => raw(project.root, ['rev-list', '--count', `${base}..HEAD`]).trim(), 0)) : 0,
    files, truncated: files.length >= MAX_FILES,
    additions: files.reduce((sum, f) => sum + (f.additions ?? 0), 0), deletions: files.reduce((sum, f) => sum + (f.deletions ?? 0), 0),
    preexistingCount: session.baseline?.dirtyCount ?? 0, sharedCheckout: true, folderPrefix: project.pathPrefix || null,
  };
}

// Opening is limited to listed, regular, non-executable files.
export function openableFile(project, session, path) {
  path = relativePath(path);
  if (!sessionChanges(project, session).files.some(file => file.path === path)) throw new Error('File is not in this session\'s changes');
  const full = safeFile(project.root, path); if (!full) throw new Error('File is not a regular file inside the project');
  const stat = lstatSync(full);
  // Allowlist of passive document types; everything else is only revealed.
  const passive = /\.(?:md|markdown|txt|text|log|json|jsonc|ya?ml|toml|ini|cfg|conf|csv|tsv|diff|patch|png|jpe?g|gif|webp|bmp|pdf)$/i.test(path);
  return { path: full, open: stat.isFile() && !(stat.mode & 0o111) && passive };
}

export function fileDiff(project, session, path) {
  path = relativePath(path);
  if (project.pathPrefix && !path.startsWith(project.pathPrefix)) throw new Error('File is not in this session\'s changes');
  if (isSensitivePath(path)) return { path, hidden: true, text: '' };
  // Only paths this view listed; never an arbitrary request.
  if (!sessionChanges(project, session).files.some(file => file.path === path)) throw new Error('File is not in this session\'s changes');
  const base = session.baseline?.head ?? session.head ?? EMPTY_TREE;
  let text = quiet(() => raw(project.root, ['diff', '--no-color', '--no-ext-diff', base, '--', path], MAX_DIFF * 4), '');
  if (!text) {
    const tracked = quiet(() => { raw(project.root, ['ls-files', '--error-unmatch', '--literal-pathspecs', '--', path]); return true; }, false);
    const full = !tracked && untrackedLines(project.root, path) !== null ? safeFile(project.root, path) : null;
    if (full) text = readFileSync(full, 'utf8').split('\n').map(line => `+${line}`).join('\n');
  }
  return { path, hidden: false, truncated: text.length > MAX_DIFF, text: text.slice(0, MAX_DIFF) };
}
