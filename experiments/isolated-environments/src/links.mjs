import { lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Links (symlinks, and on Windows directory junctions, which Node reports as symbolic links) that
// tools leave in an environment, for example pnpm's node_modules. Before a worktree is removed,
// each link that Git does not track is deleted as a link, never followed: its target survives.
// Tracked symlinks are left to Git, which removes them as links itself.
export function findLinks(root, { tracked = new Set(), skip = ['.git'] } = {}) {
  const links = []; const stack = [root];
  while (stack.length) {
    const dir = stack.pop(); let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = join(dir, entry.name); const rel = relative(root, full).split(sep).join('/');
      if (dir === root && skip.includes(entry.name)) continue;
      let stat; try { stat = lstatSync(full); } catch { continue; }
      if (stat.isSymbolicLink()) { if (!tracked.has(rel)) links.push(full); continue; }
      if (stat.isDirectory()) stack.push(full);
    }
  }
  return links.sort();
}

// Deletes one link without touching its target: unlink, or for a Windows directory junction or
// directory symlink, rmdir (which removes the link itself and never recurses).
export function removeLink(path) {
  const stat = lstatSync(path);
  if (!stat.isSymbolicLink()) throw new Error(`Not a link: ${path}`);
  try { unlinkSync(path); }
  catch (error) { if (error.code === 'EPERM' || error.code === 'EISDIR') rmdirSync(path); else throw error; }
}
