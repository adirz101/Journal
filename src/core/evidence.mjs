import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, openSync, closeSync, fstatSync, readSync, constants } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { git } from './project.mjs';
import { commitsSince, isAncestor, isCommit } from './status.mjs';
import { relativePath, refuseCredentials, text } from './validation.mjs';

export const isSensitivePath = path => path.split('/').some(p => p === '.git' || /^\.env(?:\.|$)/i.test(p) || /^(?:auth|credentials|secrets?)(?:\.|$)/i.test(p) || /\.(?:pem|p12|pfx|key)$/i.test(p) || /^(?:id_rsa|id_ed25519|\.npmrc|\.netrc|\.pypirc)$/i.test(p));

function sourceFile(root, path) {
  path = relativePath(path);
  if (isSensitivePath(path)) {
    throw new Error('Sensitive files cannot be used as evidence');
  }
  const full = resolve(root, path);
  const canonical = realpathSync(full);
  const rel = relative(root, canonical);
  if (rel.startsWith(`..${sep}`) || rel === '..' || rel.startsWith(sep)) throw new Error('Source escapes checkout');
  // Reject every symlink component, not just the leaf.
  let current = root;
  for (const part of path.split('/')) {
    current = resolve(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error('Symlink evidence is not supported');
  }
  const stat = lstatSync(full);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Evidence must be a regular file under 1 MiB');
  const fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > 1024 * 1024) throw new Error('Source changed during validation');
    try { git(root, ['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', path]); }
    catch { throw new Error('Evidence must be a tracked project file'); }
    if (realpathSync(full) !== canonical || lstatSync(full).isSymbolicLink()) throw new Error('Source changed during validation');
    const buffer = Buffer.alloc(1024 * 1024 + 1); let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length); if (!count) break; length += count;
    }
    const after = fstatSync(fd);
    const current = lstatSync(full);
    if (length > 1024 * 1024 || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || current.dev !== opened.dev || current.ino !== opened.ino || realpathSync(full) !== canonical) throw new Error('Source changed or grew during capture');
    bytes = buffer.subarray(0, length);
  } finally { closeSync(fd); }
  if (bytes.includes(0)) throw new Error('Binary evidence is not supported');
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return { path, content, contentHash: createHash('sha256').update(bytes).digest('hex') };
}

export function captureEvidence(project, input) {
  if (!input || typeof input !== 'object') throw new Error('Knowledge requires a source');
  if (input.kind === 'user') {
    const note = text(input.note, 'user source'); refuseCredentials(note);
    return { kind: 'user', note, capturedAt: new Date().toISOString() };
  }
  if (input.kind === 'git') {
    // A Git range is evidence that the described commits exist in this history.
    // Base is optional for an overview of the current checkout.
    if (!project.head) throw new Error('Git evidence requires a commit');
    const base = input.base ?? null;
    if (base !== null && (!isCommit(project.root, base) || !isAncestor(project.root, base))) throw new Error('Git evidence base must be a commit in the current history');
    return { kind: 'git', base, head: project.head, commitCount: base ? commitsSince(project.root, base) : null, capturedAt: new Date().toISOString() };
  }
  if (input.kind !== 'file') throw new Error('Invalid source kind');
  const file = sourceFile(project.root, input.path);
  const lines = file.content.split(/\r?\n/);
  const startLine = input.startLine ?? 1; const endLine = input.endLine ?? startLine;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > lines.length || endLine - startLine >= 30) {
    throw new Error('Select 1–30 existing source lines');
  }
  const excerpt = lines.slice(startLine - 1, endLine).join('\n');
  if (excerpt.length > 4000) throw new Error('Source excerpt is too large');
  refuseCredentials(excerpt);
  return { kind: 'file', path: file.path, contentHash: file.contentHash, excerpt, startLine, endLine, commit: project.head, capturedAt: new Date().toISOString() };
}

export function validateEvidence(project, source, cache, scope = 'branch') {
  if (source.kind === 'user') return true;
  if (source.kind === 'git') {
    // A branch update describes this branch's history: it goes stale when that
    // history is rewritten or reset. A repo overview stays valid on every
    // branch of the checkout while its commit still exists in the repository.
    const key = `git:${scope}:${source.head}`;
    const check = () => isCommit(project.root, source.head) && (scope === 'checkout' || isAncestor(project.root, source.head));
    if (!cache) return check();
    if (!cache.has(key)) cache.set(key, check());
    return cache.get(key);
  }
  if (cache?.has(source.path)) return cache.get(source.path) === source.contentHash;
  try {
    const hash = sourceFile(project.root, source.path).contentHash; cache?.set(source.path, hash);
    return hash === source.contentHash;
  } catch { cache?.set(source.path, null); return false; }
}
