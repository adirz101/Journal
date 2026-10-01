import { execFileSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { text } from './validation.mjs';

export function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 4000, maxBuffer: 1024 * 1024, windowsHide: true, stdio: 'pipe', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } }).trim();
}

export function inspectProject(input) {
  const directory = realpathSync(text(input, 'project directory', 4096));
  if (!statSync(directory).isDirectory()) throw new Error('Select a project directory');
  let root;
  try { root = realpathSync(git(directory, ['rev-parse', '--show-toplevel'])); }
  catch { throw new Error('Select an existing Git checkout'); }
  const commonDir = realpathSync(resolve(root, git(root, ['rev-parse', '--git-common-dir'])));
  let head = null;
  try { head = git(root, ['rev-parse', '--verify', 'HEAD']); } catch { /* unborn branch */ }
  let branch = null;
  try { branch = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']); } catch { /* detached */ }
  return { root, commonDir, name: basename(root), branch, head };
}
