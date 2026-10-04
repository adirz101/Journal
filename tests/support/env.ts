import { existsSync, linkSync, mkdirSync, realpathSync, statSync, symlinkSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, posix, relative, win32 } from 'node:path';

// Test isolation: the only place a desktop spec or launch helper may read the real
// environment. Every Electron launch gets an environment built from an allow-list:
//   - PATH is the spec's fixture `bin` plus a `tools/` folder of links to the few system
//     tools Journal and the fixtures need (node, git, sh, bash, ps, env, sleep, and curl, which
//     Journal requires before it offers the official install command). No other system
//     folder is on PATH, so a real claude, codex or agent can never be found there.
//   - HOME and every per-user configuration folder point at a fixture home inside `root`.
//   - No provider credential or configuration variable (ANTHROPIC_*, OPENAI_*, CURSOR_*,
//     CODEX_*, CLAUDE_*) is passed.
//   - JOURNAL_TEST_PROVIDER_DIR names `root`: Journal (headless) refuses to probe or launch a
//     provider CLI whose real path is outside it (src/core/process.mjs testProviderAllowed).
// assertNoRealProviders then checks the result before any launch.
// tests/isolation.test.mjs fails if a spec or helper builds an environment any other way.

const POSIX_TOOLS = ['git', 'sh', 'bash', 'ps', 'env', 'sleep', 'curl'];
const WINDOWS_TOOLS = ['git', 'cmd', 'powershell', 'taskkill', 'tasklist', 'where'];
// What Electron, Chromium, Playwright, Git and the OS loader need; nothing provider-related.
const KEEP = [
  'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ', 'USER', 'LOGNAME', 'USERNAME',
  // Linux displays (xvfb-run in CI) and the session bus.
  'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
  // Windows system locations the loader and child processes rely on.
  'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'PATHEXT', 'SystemDrive', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
  'CommonProgramFiles', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
  // Journal's own test switches (JOURNAL_HEADLESS=0 shows the windows) and CI detection.
  'JOURNAL_HEADLESS', 'CI',
];
export const PROVIDER_VARIABLES = /^(?:ANTHROPIC|OPENAI|CURSOR|CODEX|CLAUDE)_/i;
export const PROVIDER_COMMANDS = ['claude', 'codex', 'agent', 'cursor-agent'];

const real = process.env;
const win = process.platform === 'win32';
const pathOf = (env: Record<string, string | undefined>) => env.PATH ?? env.Path ?? '';

// PATH lookup with PATHEXT on Windows, like Journal's resolveExecutable.
function lookup(name: string, pathValue: string, env: Record<string, string | undefined>): string | null {
  const extensions = win ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  for (const dir of pathValue.split(win ? ';' : delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(dir, name + extension);
      try { if (statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
    }
  }
  return null;
}

// The system tools, resolved once from the real PATH. node is the running Node itself.
let tools: Map<string, string> | null = null;
function systemTools(): Map<string, string> {
  if (tools) return tools;
  tools = new Map([[win ? 'node.exe' : 'node', process.execPath]]);
  for (const name of win ? WINDOWS_TOOLS : POSIX_TOOLS) {
    const path = lookup(name, pathOf(real), real);
    if (path) tools.set(win ? path.slice(dirname(path).length + 1) : name, path);
  }
  return tools;
}

// tools/ holds one link per tool (a hard link where Windows refuses symbolic links). Only when
// neither link can be made (Windows, another volume) is the tool's own folder used instead;
// assertNoRealProviders still checks every folder on the resulting PATH.
function toolFolders(root: string): string[] {
  const folder = join(root, 'tools'); mkdirSync(folder, { recursive: true });
  const fallback = new Set<string>();
  for (const [name, target] of systemTools()) {
    const link = join(folder, name);
    if (existsSync(link)) continue;
    try { symlinkSync(target, link, 'file'); } catch {
      try { linkSync(target, link); } catch { fallback.add(dirname(target)); }
    }
  }
  return [folder, ...fallback];
}

const inside = (folder: string, path: string): boolean => {
  try { const rel = relative(realpathSync(folder), realpathSync(path)); return !!rel && !rel.startsWith('..') && !isAbsolute(rel); }
  catch { return false; }
};

// Where Journal (and the official installers) look for a provider CLI besides PATH, relative to
// the environment's home: src/core/cursor.mjs knownLocations, and Claude's native installs.
export function knownProviderLocations(env: Record<string, string>): string[] {
  const home = env.HOME ?? env.USERPROFILE;
  if (!home) throw new Error('Test environment has no HOME');
  if (win) {
    const base = win32.join(env.LOCALAPPDATA ?? win32.join(home, 'AppData', 'Local'), 'cursor-agent');
    return [...['agent.exe', 'cursor-agent.exe', 'agent.cmd', 'cursor-agent.cmd'].map(name => win32.join(base, name)),
      win32.join(home, '.local', 'bin', 'claude.exe')];
  }
  return [...['agent', 'cursor-agent', 'claude'].map(name => posix.join(home, '.local', 'bin', name)), posix.join(home, '.claude', 'local', 'claude')];
}

// Throws unless every provider CLI this environment can reach (through its PATH or a known
// install location under its home) is inside `bin`. Also refuses provider variables and a
// HOME that is the real one.
export function assertNoRealProviders(env: Record<string, string>, bin: string): void {
  // CODEX_HOME and CLAUDE_CONFIG_DIR are set by fixtureEnv, and only to folders in the fixture home.
  const home = env.HOME ?? env.USERPROFILE ?? '';
  const ownFolder = (key: string) => (key === 'CODEX_HOME' || key === 'CLAUDE_CONFIG_DIR') && !relative(home, env[key]).startsWith('..') && !isAbsolute(relative(home, env[key]));
  const leaked = Object.keys(env).filter(key => PROVIDER_VARIABLES.test(key) && !ownFolder(key));
  if (leaked.length) throw new Error(`Test environment passes provider variables: ${leaked.join(', ')}`);
  for (const key of ['HOME', 'USERPROFILE']) {
    if (env[key] && real[key] && realpathSync(env[key]) === realpathSync(real[key])) throw new Error(`Test environment uses the real ${key}`);
  }
  const found: string[] = [];
  for (const name of PROVIDER_COMMANDS) { const path = lookup(name, pathOf(env), env); if (path) found.push(path); }
  for (const path of knownProviderLocations(env)) if (existsSync(path)) found.push(path);
  const outside = found.filter(path => !inside(bin, path));
  if (outside.length) throw new Error(`A provider CLI outside the fixture bin is reachable: ${outside.join(', ')}`);
}

export interface FixtureEnvOptions {
  // The spec's temporary folder: home/ and tools/ are created in it.
  root: string;
  // The fixture CLIs (may be empty or missing: then no provider is installed).
  bin: string;
  // The fixture home; defaults to root/home.
  home?: string;
  // Spec-specific variables (JOURNAL_DATA_DIR, JOURNAL_QUIT_POLICY, …). PATH, HOME and the
  // per-user folders cannot be overridden here.
  extra?: Record<string, string>;
}

// Also callable as fixtureEnv(root, bin, extra), the form the Phase 9 branch's specs use.
export function fixtureEnv(options: FixtureEnvOptions): Record<string, string>;
export function fixtureEnv(root: string, bin: string, extra?: Record<string, string>): Record<string, string>;
export function fixtureEnv(first: FixtureEnvOptions | string, second?: string, third?: Record<string, string>): Record<string, string> {
  const { root, bin, home = join(root, 'home'), extra = {} }: FixtureEnvOptions = typeof first === 'string' ? { root: first, bin: second ?? join(first, 'bin'), extra: third } : first;
  mkdirSync(bin, { recursive: true }); mkdirSync(home, { recursive: true });
  const env: Record<string, string> = {};
  for (const key of KEEP) { const value = real[key]; if (value !== undefined) env[key] = value; }
  for (const [key, value] of Object.entries(extra)) {
    if (/^(?:PATH|Path|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|XDG_[A-Z_]+_HOME|CODEX_HOME|CLAUDE_CONFIG_DIR|JOURNAL_TEST_PROVIDER_DIR)$/.test(key)) throw new Error(`fixtureEnv sets ${key} itself`);
    env[key] = value;
  }
  env.PATH = [bin, ...toolFolders(root)].join(win ? ';' : delimiter);
  env.HOME = home; env.USERPROFILE = home;
  env.LOCALAPPDATA = join(home, 'AppData', 'Local'); env.APPDATA = join(home, 'AppData', 'Roaming');
  env.XDG_CONFIG_HOME = join(home, '.config'); env.XDG_DATA_HOME = join(home, '.local', 'share'); env.XDG_CACHE_HOME = join(home, '.cache');
  env.CODEX_HOME = join(home, '.codex'); env.CLAUDE_CONFIG_DIR = join(home, '.claude');
  env.JOURNAL_TEST_PROVIDER_DIR = root;
  assertNoRealProviders(env, bin);
  return env;
}
