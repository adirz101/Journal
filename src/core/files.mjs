import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { isSensitivePath } from './evidence.mjs';
import { realPath } from './paths.mjs';

// Read-only file access for the explorer. Roots are absolute paths resolved
// from Journal's records (never from the renderer); everything below takes a
// relative path, rejects any symlink component and re-checks containment.

export const MAX_DIRECTORY_ENTRIES = 5000;
export const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;
export const MAX_HIGHLIGHT_BYTES = 1024 * 1024;
export const MAX_DIFF_BYTES = 200 * 1024;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const BINARY_SNIFF = 8000;

// A path inside a root, with forward slashes. Unlike knowledge evidence paths,
// names may keep characters the platform allows (a colon on macOS), but never
// control characters, traversal or another root.
export function treePath(value, allowEmpty = false, platform = process.platform) {
  if (typeof value !== 'string' || value.length > 1024 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid file path');
  if (value === '') { if (allowEmpty) return ''; throw new Error('Invalid file path'); }
  if (value.startsWith('/') || value.includes('\\') || (platform === 'win32' && value.includes(':')) || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid file path');
  return value;
}

const inside = (root, path) => { const rel = relative(root, path); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel)); };
const parts = path => path ? path.split('/') : [];

// Every component of path below root must exist and none may be a link
// (junctions report as links on Windows). Returns the absolute path.
// The canonical name is checked for sensitivity too, so case differences or
// Windows short names (ENV~1) cannot reach a sensitive file.
const sensitiveCanonical = (realRoot, realPath) => isSensitivePath(relative(realRoot, realPath).split(sep).join('/'));
async function resolveInside(root, path, { sensitive = false } = {}) {
  let current = root;
  for (const part of parts(path)) { current = join(current, part); if ((await lstat(current)).isSymbolicLink()) throw new Error('Links are not followed'); }
  const realRoot = await realpath(root); const real = await realpath(current);
  if (!inside(realRoot, real)) throw new Error('Path escapes its folder');
  if (!sensitive && sensitiveCanonical(realRoot, real)) throw new Error('Sensitive files cannot be read');
  return current;
}
function resolveInsideSync(root, path) {
  let current = root;
  for (const part of parts(path)) { current = join(current, part); if (lstatSync(current).isSymbolicLink()) throw new Error('Links are not followed'); }
  const realRoot = realPath(root); const real = realPath(current);
  if (!inside(realRoot, real)) throw new Error('Path escapes its folder');
  if (sensitiveCanonical(realRoot, real)) throw new Error('Sensitive files cannot be referenced');
  return current;
}

// An entry to reveal or hand to an editor: its folder is reached without
// links; the entry itself may be a link (revealing shows the link, not its target).
export async function locate(root, path) {
  path = treePath(path, true);
  const segments = parts(path); const folder = await resolveInside(root, segments.slice(0, -1).join('/'), { sensitive: true });
  const full = segments.length ? join(folder, segments.at(-1)) : folder;
  return { full, stat: await lstat(full) };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export async function listDirectory(root, path = '', limit = MAX_DIRECTORY_ENTRIES) {
  path = treePath(path, true);
  const full = await resolveInside(root, path, { sensitive: true });
  const dirents = await readdir(full, { withFileTypes: true });
  const entries = [];
  for (const dirent of dirents) {
    // Git metadata is never browsed (a worktree's .git is a file).
    if (dirent.name === '.git') continue;
    const child = path ? `${path}/${dirent.name}` : dirent.name;
    const type = dirent.isSymbolicLink() ? 'symlink' : dirent.isDirectory() ? 'directory' : dirent.isFile() ? 'file' : 'other';
    entries.push({ name: dirent.name, path: child, type, sensitive: isSensitivePath(child) });
  }
  entries.sort((a, b) => ((a.type === 'directory') === (b.type === 'directory') ? collator.compare(a.name, b.name) : a.type === 'directory' ? -1 : 1));
  return { path, entries: entries.slice(0, limit), total: entries.length, truncated: entries.length > limit };
}

function lineEndings(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length; const lf = (text.match(/\n/g) ?? []).length - crlf;
  return !crlf && !lf ? 'none' : crlf && lf ? 'mixed' : crlf ? 'crlf' : 'lf';
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const rangeHash = (text, startLine, endLine) => sha256(text.split(/\r?\n/).slice(startLine - 1, endLine).join('\n'));

// Reads one regular file with O_NOFOLLOW and checks it did not change while
// being read. Returns null for kinds that are never read (sensitive, large).
async function readRegular(root, path) {
  const full = await resolveInside(root, path);
  const stat = await lstat(full);
  if (!stat.isFile()) throw new Error('Not a regular file');
  if (stat.size > MAX_PREVIEW_BYTES) return { stat, bytes: null };
  const handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error('The file changed while it was opened');
    const buffer = Buffer.alloc(Math.min(opened.size, MAX_PREVIEW_BYTES) + 1); let length = 0;
    while (length < buffer.length) { const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length); if (!bytesRead) break; length += bytesRead; }
    const after = await handle.stat();
    if (length > MAX_PREVIEW_BYTES || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error('The file changed while it was read; try again');
    return { stat: opened, bytes: buffer.subarray(0, length) };
  } finally { await handle.close(); }
}

export function decodeText(bytes) {
  let text; let invalidUtf8 = false;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { text = new TextDecoder('utf-8').decode(bytes); invalidUtf8 = true; }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { text, invalidUtf8 };
}

export async function previewFile(root, path) {
  path = treePath(path);
  if (isSensitivePath(path)) return { path, kind: 'sensitive' };
  const { stat, bytes } = await readRegular(root, path);
  if (!bytes) return { path, kind: 'too-large', size: stat.size };
  const contentHash = sha256(bytes);
  if (bytes.subarray(0, BINARY_SNIFF).includes(0)) return { path, kind: 'binary', size: stat.size, contentHash };
  const { text, invalidUtf8 } = decodeText(bytes);
  return { path, kind: 'text', size: stat.size, contentHash, text, invalidUtf8, highlight: stat.size <= MAX_HIGHLIGHT_BYTES, eol: lineEndings(text), lineCount: text ? text.split(/\r?\n/).length : 0 };
}

// Hashes a file (and a line range) synchronously, for references recorded in
// receipts. Directories have no fingerprint.
export function fingerprintSync(root, path, startLine = null, endLine = null) {
  path = treePath(path);
  if (isSensitivePath(path)) throw new Error('Sensitive files cannot be referenced');
  const full = resolveInsideSync(root, path);
  const stat = lstatSync(full);
  const ranged = startLine !== null && startLine !== undefined;
  if (stat.isDirectory()) { if (ranged) throw new Error('Folders have no lines'); return { kind: 'folder', contentHash: null, rangeHash: null }; }
  if (!stat.isFile()) throw new Error('Only files and folders can be referenced');
  if (stat.size > MAX_PREVIEW_BYTES) { if (ranged) throw new Error('Lines of files over 5 MiB cannot be referenced'); return { kind: 'file', contentHash: null, rangeHash: null }; }
  const fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    const opened = fstatSync(fd); if (opened.ino !== stat.ino || opened.dev !== stat.dev || !opened.isFile()) throw new Error('The file changed while it was opened');
    if (opened.size > MAX_PREVIEW_BYTES) throw new Error('The file grew past 5 MiB while it was opened');
    bytes = Buffer.alloc(opened.size); let length = 0;
    while (length < bytes.length) { const count = readSync(fd, bytes, length, bytes.length - length, length); if (!count) break; length += count; }
    bytes = bytes.subarray(0, length);
  } finally { closeSync(fd); }
  const contentHash = sha256(bytes);
  if (!ranged) return { kind: 'file', contentHash, rangeHash: null };
  if (bytes.subarray(0, BINARY_SNIFF).includes(0)) throw new Error('Lines of binary files cannot be referenced');
  const { text } = decodeText(bytes); const total = text.split(/\r?\n/).length;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > total) throw new Error('Those lines are not in the file');
  return { kind: 'lines', contentHash, rangeHash: rangeHash(text, startLine, endLine) };
}

const git = (gitRoot, args, maxBuffer = MAX_DIFF_BYTES * 4) => new Promise((resolve, reject) => {
  execFile('git', ['-C', gitRoot, ...args], { encoding: 'utf8', timeout: 8000, maxBuffer, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' } },
    (error, stdout) => error && !stdout ? reject(error) : resolve(stdout));
});

// The working-tree diff of one file against HEAD (what the explorer's
// decorations describe). Untracked files are shown as wholly added.
export async function headDiff(root, gitRoot, prefix, path) {
  path = treePath(path);
  if (isSensitivePath(path)) return { path, hidden: true, text: '' };
  // One file only: a folder path would diff everything below it, sensitive files included.
  const full = await resolveInside(root, path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (full) { if (!(await lstat(full)).isFile()) throw new Error('Diffs are shown for single files only'); }
  else {
    // A deleted file: the index or HEAD must know exactly this one path (a staged deletion is only in HEAD).
    await resolveInside(root, path.split('/').slice(0, -1).join('/')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    const exact = output => output.split('\0').filter(Boolean).join('\0') === `${prefix}${path}`;
    const known = exact(await git(gitRoot, ['ls-files', '-z', '--', `${prefix}${path}`]).catch(() => ''))
      || exact(await git(gitRoot, ['ls-tree', '-z', '--name-only', 'HEAD', '--', `${prefix}${path}`]).catch(() => ''));
    if (!known) throw new Error('This file no longer exists');
  }
  const head = await git(gitRoot, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(out => out.trim(), () => '');
  let text = await git(gitRoot, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', head || EMPTY_TREE, '--', `${prefix}${path}`]).catch(() => '');
  if (!text) {
    const tracked = await git(gitRoot, ['ls-files', '--', `${prefix}${path}`]).then(out => !!out.trim(), () => false);
    if (!tracked) {
      const preview = await previewFile(root, path).catch(() => null);
      if (preview?.kind === 'text') text = `+++ ${path} (untracked)\n${preview.text.split(/\r?\n/).map(line => `+${line}`).join('\n')}`;
    }
  }
  return { path, hidden: false, truncated: text.length > MAX_DIFF_BYTES, text: text.slice(0, MAX_DIFF_BYTES) };
}
