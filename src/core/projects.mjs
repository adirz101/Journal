import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { basename, relative, sep } from 'node:path';
import { git } from './project.mjs';
import { text } from './validation.mjs';

// Additional project folders are context sources with their own identity.
// Journal never merges Git identities: each folder keeps its own repository
// (or none), and evidence records which folder it came from.

const inside = (parent, child) => { const rel = relative(parent, child); return rel === '' || (!!rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel)); };
const quiet = action => { try { return action(); } catch { return null; } };

// Deterministic per project and path, so re-adding a folder restores the
// identity its earlier evidence refers to.
export const rootId = (projectId, path) => createHash('sha256').update(`${projectId}\u0000${path}`).digest('hex').slice(0, 12);

export function classifyFolder(project, input) {
  let path;
  try { path = realpathSync(text(input, 'folder path', 4096)); } catch { throw new Error('That folder does not exist'); }
  if (!statSync(path).isDirectory()) throw new Error('Choose a folder, not a file');
  if (path === project.root) throw new Error('This is already the project\'s primary repository');
  if (inside(path, project.root)) throw new Error('This folder contains the primary repository; add the primary repository\'s siblings instead');
  for (const root of project.roots ?? []) {
    if (root.path === path) throw new Error('This folder is already part of the project');
    if (inside(root.path, path) || inside(path, root.path)) throw new Error(`This folder overlaps ${root.path}, which is already part of the project`);
  }
  let toplevel = quiet(() => realpathSync(git(path, ['rev-parse', '--show-toplevel'])));
  // A folder its enclosing repository ignores is not part of that repository.
  if (toplevel && toplevel !== path && quiet(() => { git(toplevel, ['check-ignore', '-q', relative(toplevel, path)]); return true; })) toplevel = null;
  const commonDir = toplevel ? quiet(() => realpathSync(git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']))) : null;
  const nested = inside(project.root, path);
  if (toplevel && commonDir === project.commonDir) {
    throw new Error(nested ? 'This folder is already inside the primary repository' : 'This is another worktree of the same repository; import it under Workspaces instead');
  }
  const branch = toplevel ? quiet(() => git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'])) : null;
  return { id: rootId(project.id, path), path, name: basename(path), kind: toplevel ? 'git' : 'folder', gitRoot: toplevel, commonDir, nested, branch, addedAt: new Date().toISOString() };
}

// Current state of a stored folder (it may have been moved or deleted).
export function folderStatus(root) {
  let exists = false; try { exists = statSync(root.path).isDirectory(); } catch { /* missing */ }
  const branch = exists && root.kind === 'git' ? quiet(() => git(root.path, ['symbolic-ref', '--quiet', '--short', 'HEAD'])) : null;
  const head = exists && root.kind === 'git' ? quiet(() => git(root.path, ['rev-parse', 'HEAD'])) : null;
  return { ...root, exists, currentBranch: branch, head };
}
