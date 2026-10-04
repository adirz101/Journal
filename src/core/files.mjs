import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { isSensitivePath } from './evidence.mjs';
import { gitEnv } from './git-env.mjs';
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

// run() settles with both the error and whatever was written; git() keeps output
// it got even when Git then failed (diffs), listFiles() decides for itself.
// gitEnv() drops GIT_DIR, GIT_INDEX_FILE and the other variables that would point
// Git at another repository than the folder named with -C.
const run = (gitRoot, args, maxBuffer) => new Promise(resolve => {
  execFile('git', ['-C', gitRoot, ...args], { encoding: 'utf8', timeout: 8000, maxBuffer, windowsHide: true, env: gitEnv() },
    (error, stdout) => resolve({ error, stdout: stdout ?? '' }));
});
const git = (gitRoot, args, maxBuffer = MAX_DIFF_BYTES * 4) => run(gitRoot, args, maxBuffer).then(({ error, stdout }) => { if (error && !stdout) throw error; return stdout; });

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

// Open-file search (Phase 8). The listing comes from git ls-files only (tracked
// and untracked, never ignored); there is no directory walk, and no file is read.
// Sensitive paths are dropped here and again by previewFile when a hit is opened.
export const MAX_LISTED_FILES = 200_000;
const MAX_LISTING_BYTES = 64 * 1024 * 1024;
const MAX_QUERY = 200; const MAX_TOKENS = 8; const MAX_RANKED_PATH = 1024;

// Git runs in the root folder itself (-C root.path), so ls-files prints paths
// relative to the root and lists only below it: no prefix is stripped, and a
// prefix spelled in another case (case-insensitive file systems) cannot hide
// every entry. Tracked entries come with their mode (--stage) so submodule
// gitlinks (mode 160000), which are folders of another repository rather than
// files, are left out; untracked entries come from a second, parallel run.
export async function listFiles(root) {
  if (!root?.git || !root.gitRoot) return { available: false, reason: 'not-git' };
  // isSensitivePath is per segment, so a repository-relative path is sensitive exactly
  // when the root's prefix or the root-relative path is: the prefix is checked once.
  const prefix = (root.prefix ?? '').replace(/\/$/, '');
  if (prefix && isSensitivePath(prefix)) return { available: true, paths: [], truncated: false };
  const folder = root.path ?? root.gitRoot;
  const [cached, others] = await Promise.all([run(folder, ['ls-files', '-z', '--stage'], MAX_LISTING_BYTES),
    run(folder, ['ls-files', '-z', '--others', '--exclude-standard'], MAX_LISTING_BYTES)]);
  // A listing cut short by the size or time limit is used up to its last complete
  // entry and reported as truncated, with the reason. Any other failure is reported
  // without Git's message, which may name paths outside this root.
  const cut = ({ error, stdout }) => !error ? null : !stdout ? 'failed' : error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'size' : error.killed === true ? 'timeout' : 'failed';
  const parts = [{ ...cached, staged: true, cut: cut(cached) }, { ...others, staged: false, cut: cut(others) }];
  if (parts.some(part => part.cut === 'failed')) return { available: false, reason: 'failed' };
  return parseListing(parts.map(({ stdout, staged, cut }) => ({ output: stdout, staged, cut })));
}

// ls-files -z output (one string, or parts { output, staged, cut }) to
// root-relative paths, in order: duplicates dropped (a path can be both cached
// and modified, or listed per conflict stage), gitlinks dropped (staged parts),
// sensitive paths dropped, and names the explorer cannot address (control
// characters, backslashes, over 1024 characters) skipped. Stops at
// MAX_LISTED_FILES. cut ('timeout' or 'size'): the output was cut off, so its
// last entry may be incomplete.
// It runs in main, which also routes every key press: entries are read in slices
// with a yield between them, and the sensitivity of each folder is decided once
// (a Map per listing), so an entry only tests its own name.
// Result: { available, paths, truncated, truncatedBy?: 'timeout' | 'size' | 'limit' }.
const PARSE_SLICE = 10_000;
const STAGED_ENTRY = /^([0-7]{6}) [0-9a-f]+ \d\t/;
const yieldToLoop = () => new Promise(resolve => setImmediate(resolve));
export async function parseListing(input, { cut = null } = {}) {
  const parts = typeof input === 'string' ? [{ output: input, staged: false, cut }] : input;
  const seen = new Set(); const paths = []; const folders = new Map();
  const sensitiveFolder = folder => { let verdict = folders.get(folder); if (verdict === undefined) { verdict = isSensitivePath(folder); folders.set(folder, verdict); } return verdict; };
  let truncatedBy = parts.find(part => part.cut)?.cut ?? null; let count = 0;
  outer: for (const { output, staged } of parts) {
    // The text after the final NUL is empty, or a cut-off entry: never used.
    for (let from = 0, end = output.indexOf('\0'); end >= 0; from = end + 1, end = output.indexOf('\0', from)) {
      if (++count % PARSE_SLICE === 0) await yieldToLoop();
      let path = output.slice(from, end);
      if (staged) { const meta = STAGED_ENTRY.exec(path); if (!meta || meta[1] === '160000') continue; path = path.slice(meta[0].length); }
      if (!path || seen.has(path)) continue;
      seen.add(path);
      const slash = path.lastIndexOf('/');
      if ((slash > 0 && sensitiveFolder(path.slice(0, slash))) || isSensitivePath(path.slice(slash + 1))) continue;
      try { treePath(path); } catch { continue; }
      if (paths.length === MAX_LISTED_FILES) { truncatedBy = 'limit'; break outer; }
      paths.push(path);
    }
  }
  return truncatedBy ? { available: true, paths, truncated: true, truncatedBy } : { available: true, paths, truncated: false };
}

// Main's open-file listings: one entry per root key, kept ttl ms and at most max
// roots (the least recently used is dropped). At most one listing runs per key at
// a time, even across clear(): a new run waits for the previous one to finish.
// A watcher change marks the entry stale instead of dropping it: searches keep
// getting the stale list while one refresh runs, the refresh starts only after
// any run in flight has finished and at most once per refreshMs, and a change
// during a run leaves the result stale, so the next search refreshes again.
// clear() (a workspace or folder change, where a key may now name another
// folder) drops every list: the next search waits for a new one.
export class ListingCache {
  constructor({ list = listFiles, ttl = 30_000, max = 4, refreshMs = 1500, now = Date.now } = {}) {
    this.list = list; this.ttl = ttl; this.max = max; this.refreshMs = refreshMs; this.now = now;
    this.entries = new Map(); this.running = new Map();
  }
  // A promise of the listing for key; root is resolved by the caller for this request.
  get(key, root) {
    let entry = this.entries.get(key);
    if (entry) this.entries.delete(key);
    else entry = { result: null, at: 0, stale: false, generation: 0, run: null, lastStart: -Infinity, timer: null };
    this.entries.set(key, entry); entry.root = root;
    while (this.entries.size > this.max) this.forget(this.entries.keys().next().value);
    if (entry.result && !entry.stale && this.now() - entry.at < this.ttl) return Promise.resolve(entry.result);
    if (!entry.result) return entry.run ?? this.start(key, entry);
    // A stale or expired list is served while its refresh loads.
    if (!entry.run) {
      const wait = entry.lastStart + this.refreshMs - this.now();
      if (wait <= 0) void this.start(key, entry);
      else if (!entry.timer) { entry.timer = setTimeout(() => { entry.timer = null; if (this.entries.get(key) === entry && !entry.run) void this.start(key, entry); }, wait); entry.timer.unref?.(); }
    }
    return Promise.resolve(entry.result);
  }
  // A watcher batch for key: what was listed may be out of date.
  invalidate(key) { const entry = this.entries.get(key); if (entry) { entry.stale = true; entry.generation++; } }
  clear() { for (const key of [...this.entries.keys()]) this.forget(key); }
  forget(key) { const entry = this.entries.get(key); if (entry?.timer) clearTimeout(entry.timer); this.entries.delete(key); }
  start(key, entry) {
    const previous = this.running.get(key); const generation = entry.generation;
    const run = (async () => {
      if (previous) await previous;
      entry.lastStart = this.now();
      try { return await this.list(entry.root); } catch { return { available: false, reason: 'failed' }; }
    })();
    const settled = run.then(result => {
      if (this.running.get(key) === settled) this.running.delete(key);
      entry.run = null;
      if (this.entries.get(key) !== entry) return result; // cleared meanwhile: delivered, not kept
      // A failed run is not kept; a stale list (if any) stays and is refreshed later.
      if (!result.available && result.reason === 'failed') { if (!entry.result) this.entries.delete(key); return result; }
      entry.result = result; entry.at = this.now(); entry.stale = entry.generation !== generation;
      return result;
    });
    this.running.set(key, settled); entry.run = settled;
    return settled;
  }
}

// Lower-cased copies of listings, kept while main keeps the listing itself.
const lowered = new WeakMap();
const lower = path => { const value = path.toLowerCase(); return value.length === path.length ? value : Array.from(path, c => { const l = c.toLowerCase(); return l.length === c.length ? l : c; }).join(''); };
// A segment starts at the start, after / - _ . or a space, or at a camelCase boundary.
const isSeparator = c => c === 47 || c === 45 || c === 95 || c === 46 || c === 32;
const segmentStart = (path, i) => {
  if (i === 0) return true;
  const before = path.charCodeAt(i - 1); const at = path.charCodeAt(i);
  return isSeparator(before) || (at >= 65 && at <= 90 && ((before >= 97 && before <= 122) || (before >= 48 && before <= 57)));
};

// Positions of one candidate placement, reused across paths (tokens are at most 200 characters).
const candidate = new Int32Array(MAX_QUERY); const chosen = new Int32Array(MAX_QUERY);
function scorePlacement(path, base, positions, length) {
  let score = 0;
  for (let k = 0; k < length; k++) {
    const i = positions[k]; score += 1;
    if (segmentStart(path, i)) score += k === 0 ? 10 : 6;
    if (i >= base) score += 2;
    if (k > 0) { const gap = i - positions[k - 1] - 1; score += gap === 0 ? 5 : -Math.min(gap, 12); }
  }
  if (positions[0] >= base && positions[length - 1] - positions[0] === length - 1) score += 12; // contiguous in the basename
  return score;
}

// The best score of one token in a path, or null when it is not a subsequence;
// the winning positions are left in chosen. Candidates: each contiguous
// occurrence (at most 16), else a greedy subsequence from each of the first 16
// occurrences of its first character, tightened back from its end.
let best = null; let bestStart = -1;
function keep(score, length) {
  if (best === null || score > best || (score === best && candidate[0] < bestStart)) { best = score; bestStart = candidate[0]; for (let k = 0; k < length; k++) chosen[k] = candidate[k]; }
}
function placeToken(path, low, base, token) {
  const length = token.length; best = null; bestStart = -1;
  for (let at = low.indexOf(token), n = 0; at >= 0 && n < 16; at = low.indexOf(token, at + 1), n++) {
    for (let k = 0; k < length; k++) candidate[k] = at + k;
    keep(scorePlacement(path, base, candidate, length), length);
  }
  if (best !== null) return best;
  // Subsequences start at the first occurrence of the first character or at a segment start.
  const first = token[0];
  for (let start = low.indexOf(first), n = 0; start >= 0 && n < 8; start = low.indexOf(first, start + 1)) {
    if (n && !segmentStart(path, start)) continue;
    n++; candidate[0] = start; let i = start;
    for (let k = 1; k < length; k++) { i = low.indexOf(token[k], i + 1); if (i < 0) return best; candidate[k] = i; }
    for (let k = length - 2; k >= 0; k--) candidate[k] = low.lastIndexOf(token[k], candidate[k + 1] - 1);
    keep(scorePlacement(path, base, candidate, length), length);
  }
  return best;
}

// The total score of a path for all tokens, or null; with positions, the matched indexes are collected.
const isSubsequence = (low, token) => {
  if (low.indexOf(token) >= 0) return true;
  for (let k = 0, i = -1; k < token.length; k++) { i = low.indexOf(token[k], i + 1); if (i < 0) return false; }
  return true;
};
function scorePath(path, low, tokens, positions = null) {
  // Most paths fail some token: check them all cheaply before scoring any.
  for (const token of tokens) if (!isSubsequence(low, token)) return null;
  const base = path.lastIndexOf('/') + 1; let score = 0;
  for (const token of tokens) {
    const place = placeToken(path, low, base, token); if (place === null) return null;
    score += place; if (positions) for (let k = 0; k < token.length; k++) positions.push(chosen[k]);
  }
  return score - path.length / 16; // shorter paths first
}

const merge = positions => {
  const spans = [];
  for (const i of [...new Set(positions)].sort((a, b) => a - b)) { const last = spans.at(-1); if (last && last[1] === i) last[1] = i + 1; else spans.push([i, i + 1]); }
  return spans;
};
const pathOrder = new Intl.Collator('en', { numeric: true });
const better = (a, b) => b.score - a.score || pathOrder.compare(a.path, b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

// A ranking in progress: tokens, the best hits so far and the match count.
// Lower-cased paths are kept per listing (a WeakMap on main's cached array) and
// filled as they are first needed.
function rankState(paths, query, limit) {
  const tokens = String(query ?? '').slice(0, MAX_QUERY).toLowerCase().split(/\s+/).filter(Boolean).slice(0, MAX_TOKENS);
  if (!tokens.length || !Array.isArray(paths)) return null;
  let lows = lowered.get(paths); if (!lows) { lows = new Array(paths.length); lowered.set(paths, lows); }
  return { tokens, lows, limit: Math.max(1, Math.min(100, Math.trunc(limit) || 50)), top: [], total: 0 };
}
function rankRange(state, paths, from, to) {
  const { tokens, lows, limit, top } = state;
  for (let p = from; p < to; p++) {
    const path = paths[p]; if (typeof path !== 'string' || path.length > MAX_RANKED_PATH) continue;
    const low = lows[p] ?? (lows[p] = lower(path));
    const score = scorePath(path, low, tokens); if (score === null) continue;
    state.total++;
    if (top.length === limit && score < top[limit - 1].score) continue;
    const hit = { path, low, score };
    if (top.length === limit && better(hit, top[limit - 1]) >= 0) continue;
    let lo = 0; let hi = top.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (better(hit, top[mid]) < 0) hi = mid; else lo = mid + 1; }
    top.splice(lo, 0, hit); if (top.length > limit) top.pop();
  }
}
// Positions are collected again for the hits shown only.
const rankResult = state => ({ total: state.total,
  hits: state.top.map(({ path, low, score }) => { const positions = []; scorePath(path, low, state.tokens, positions); return { path, score: Math.round(score * 100) / 100, spans: merge(positions) }; }) });

// Pure and deterministic: every whitespace-separated token must match as a
// subsequence (case-insensitive), in any order. Higher scores first (basename,
// segment-start and contiguous matches; shorter paths), then path order.
// spans are [start, end) ranges of matched characters in path, merged.
export function rankFiles(paths, query, limit = 50) {
  const state = rankState(paths, query, limit); if (!state) return { hits: [], total: 0 };
  rankRange(state, paths, 0, paths.length);
  return rankResult(state);
}

// searchFiles runs in the main process, which also routes every key press: it
// ranks in slices and yields between them, so a broad query over a large
// listing never blocks input for more than a few milliseconds at a time.
const RANK_SLICE = 20_000;
export async function searchFiles(root, query, { limit = 50, list = listFiles } = {}) {
  const listing = await list(root);
  if (!listing.available) return { available: false, reason: listing.reason === 'not-git' ? 'not-git' : 'failed', hits: [], total: 0, truncated: false };
  const { paths } = listing;
  // A truncated listing says why (Git ran out of time, its output passed 64 MiB, or the
  // 200,000-file cap) and how many files are searched.
  const truncation = listing.truncated ? { truncated: true, truncatedBy: listing.truncatedBy ?? 'limit', listed: paths.length } : { truncated: false };
  const state = rankState(paths, query, limit);
  if (!state) return { available: true, hits: [], total: 0, ...truncation };
  for (let from = 0; from < paths.length; from += RANK_SLICE) {
    if (from) await yieldToLoop();
    rankRange(state, paths, from, Math.min(paths.length, from + RANK_SLICE));
  }
  return { available: true, ...rankResult(state), ...truncation };
}
