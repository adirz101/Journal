import { mkdirSync, symlinkSync, existsSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';

// A child environment that can never reach a real provider CLI or login: PATH holds only
// the fixture CLIs, a private folder with a `node` link, and the system tools; HOME is a new
// empty folder under `root`. Node's own install folder is not on PATH, because it often holds
// real `claude` or `codex` installs (Homebrew, npm -g).
const PROVIDERS = ['claude', 'codex', 'agent', 'cursor-agent'];
export function fixtureEnv(root: string, bin: string, extra: Record<string, string> = {}): Record<string, string> {
  const tools = resolve(root, 'tools'); const home = resolve(root, 'home');
  mkdirSync(tools, { recursive: true }); mkdirSync(home, { recursive: true });
  if (!existsSync(resolve(tools, 'node'))) symlinkSync(process.execPath, resolve(tools, 'node'));
  const system = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  for (const dir of system) for (const name of PROVIDERS) if (existsSync(resolve(dir, name))) throw new Error(`${dir}/${name} would be reachable from the test PATH`);
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
    PATH: [bin, tools, ...system].join(delimiter), HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: resolve(home, '.config'), ...extra };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CURSOR_CONFIG_DIR']) delete env[name];
  return env;
}
