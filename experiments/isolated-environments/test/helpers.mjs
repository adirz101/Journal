import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { EnvironmentManager } from '../src/environments.mjs';

// A real temporary repository: main, and feature/auth checked out in the user's checkout.
export function fixture(t, options = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'jenv-')));
  const repo = join(root, 'project'); mkdirSync(repo);
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=User', '-c', 'user.email=user@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n*.log\n');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'api.js'), lines('api', 10)); writeFileSync(join(repo, 'src', 'form.js'), lines('form', 10)); writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init');
  git(repo, 'checkout', '-q', '-b', 'feature/auth');
  const manager = (extra = {}) => new EnvironmentManager({ dataRoot: join(root, 'data'), repos: { p1: repo }, probe: async () => true, ...options, ...extra });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, repo, git, manager, data: join(root, 'data') };
}
export const lines = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n';
export const edit = (text, line, value) => { const all = text.split('\n'); all[line - 1] = value; return all.join('\n'); };
export async function expectCode(promiseOrFn, code) {
  try { await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn); } catch (error) { if (error.code === code) return error; throw error; }
  throw new Error(`Expected ${code}`);
}
