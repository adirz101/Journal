import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { text } from './validation.mjs';
import { realPath } from './paths.mjs';
import { gitEnv } from './git-env.mjs';

// Pathspecs stay as Git reads them here (check-ignore refuses literal pathspecs);
// callers that pass a path from outside add --literal-pathspecs themselves.
const projectEnv = () => { const env = gitEnv(); delete env.GIT_LITERAL_PATHSPECS; return env; };

export function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 4000, maxBuffer: 1024 * 1024, windowsHide: true, stdio: 'pipe', env: projectEnv() }).trim();
}

export function inspectProject(input) {
  const directory = realPath(text(input, 'project directory', 4096));
  if (!statSync(directory).isDirectory()) throw new Error('Select a project directory');
  let root;
  try { root = realPath(git(directory, ['rev-parse', '--show-toplevel'])); }
  catch { throw new Error('Select an existing Git checkout'); }
  const commonDir = realPath(resolve(root, git(root, ['rev-parse', '--git-common-dir'])));
  let head = null;
  try { head = git(root, ['rev-parse', '--verify', 'HEAD']); } catch { /* unborn branch */ }
  let branch = null;
  try { branch = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']); } catch { /* detached */ }
  return { root, commonDir, name: basename(root), branch, head };
}
