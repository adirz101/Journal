import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, openSync, closeSync, fstatSync, readSync, constants } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { git } from './project.mjs';
import { commitsSince, isAncestor, isCommit } from './status.mjs';
import { relativePath, refuseCredentials, text } from './validation.mjs';

export const isSensitivePath = path => path.split('/').some(p => p === '.git' || /^\.env(?:\.|$)/i.test(p) || /^(?:auth|credentials|secrets?)(?:\.|$)/i.test(p) || /\.(?:pem|p12|pfx|key|kdbx|keystore|jks)$/i.test(p) || /^(?:id_rsa|id_ed25519|id_ecdsa|id_dsa|\.npmrc|\.netrc|\.pypirc|\.pgpass|\.htpasswd|\.git-credentials|\.dockercfg)$/i.test(p));

// The folder a source belongs to: the primary checkout (rootId null; worktree
// views replace project.root with the worktree) or one of the project's
// additional folders. Null when that folder was removed from the project.
export function evidenceRoot(project, rootId) {
  if (!rootId) return { path: project.root, git: true };
  const root = (project.roots ?? []).find(entry => entry.id === rootId);
  return root ? { path: root.path, git: root.kind === 'git' } : null;
}

function sourceFile(root, path, { tracked = true } = {}) {
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
    // Non-Git folders cannot prove a file is tracked; the other checks still apply.
    if (tracked) { try { git(root, ['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', path]); }
    catch { throw new Error('Evidence must be a tracked project file'); } }
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
  if (input.kind === 'user' || input.kind === 'import') {
    const note = text(input.note, `${input.kind} source`); refuseCredentials(note);
    return { kind: input.kind, note, capturedAt: new Date().toISOString() };
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
  const root = evidenceRoot(project, input.rootId ?? null);
  if (!root) throw new Error('That folder is no longer part of this project');
  const file = sourceFile(root.path, input.path, { tracked: root.git });
  const lines = file.content.split(/\r?\n/);
  const startLine = input.startLine ?? 1; const endLine = input.endLine ?? startLine;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > lines.length || endLine - startLine >= 30) {
    throw new Error('Select 1–30 existing source lines');
  }
  const excerpt = lines.slice(startLine - 1, endLine).join('\n');
  if (excerpt.length > 4000) throw new Error('Source excerpt is too large');
  refuseCredentials(excerpt);
  const commit = !input.rootId ? project.head : root.git ? (() => { try { return git(root.path, ['rev-parse', 'HEAD']); } catch { return null; } })() : null;
  return { kind: 'file', ...(input.rootId ? { rootId: input.rootId } : {}), path: file.path, contentHash: file.contentHash, excerpt, startLine, endLine, commit, capturedAt: new Date().toISOString() };
}

export function validateEvidence(project, source, cache, scope = 'branch') {
  if (source.kind === 'user' || source.kind === 'import') return true;
  if (source.kind === 'git') {
    // A branch update describes this branch's history: it goes stale when that
    // history is rewritten or reset. A repo overview stays valid on every
    // branch of the checkout while some branch, remote or tag still contains its commit.
    const key = `git:${scope}:${source.head}`;
    const gitRoot = evidenceRoot(project, null).path;
    const reachable = () => { try { return !!git(gitRoot, ['for-each-ref', '--count=1', '--contains', source.head, 'refs/heads', 'refs/remotes', 'refs/tags']); } catch { return false; } };
    const check = () => isCommit(gitRoot, source.head) && (scope === 'checkout' ? reachable() : isAncestor(gitRoot, source.head));
    if (!cache) return check();
    if (!cache.has(key)) cache.set(key, check());
    return cache.get(key);
  }
  const root = evidenceRoot(project, source.rootId ?? null);
  if (!root) return false; // the folder was removed from the project
  const key = `file:${root.path}\u0000${source.path}`;
  if (cache?.has(key)) return cache.get(key) === source.contentHash;
  try {
    const hash = sourceFile(root.path, source.path, { tracked: root.git }).contentHash; cache?.set(key, hash);
    return hash === source.contentHash;
  } catch { cache?.set(key, null); return false; }
}
