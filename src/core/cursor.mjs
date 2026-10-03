import { execFile, execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';
import { launchTarget, resolveExecutable } from './process.mjs';

// Cursor Agent CLI ("agent", legacy alias "cursor-agent") as a native provider.
// Only documented commands and flags are used:
// https://cursor.com/docs/cli/reference/parameters
// https://cursor.com/docs/cli/installation
// Journal never reads, copies or stores Cursor credentials: login runs in
// Cursor's own flow, and the status check keeps only signed in / signed out.

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Cursor builds are named by date and commit, for example 2026.10.01-e373342.
const VERSION = /\b(\d{4}\.\d{1,2}\.\d{1,2}-[0-9a-f]{6,})\b/;

// Official install commands, shown verbatim and run only after confirmation.
export function installCommand(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const shell = join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const command = "irm 'https://cursor.com/install?win32=true' | iex";
    // No profile scripts; the user's execution policy is left as it is.
    return { display: command, file: shell, args: ['-NoProfile', '-NonInteractive', '-Command', command] };
  }
  const command = 'curl https://cursor.com/install -fsS | bash';
  // No startup files: --noprofile/--norc, and BASH_ENV/ENV are removed by the caller.
  return { display: command, file: '/bin/bash', args: ['--noprofile', '--norc', '-c', command] };
}
export const installEnv = env => { const next = { ...env }; delete next.BASH_ENV; delete next.ENV; delete next.ELECTRON_RUN_AS_NODE; return next; };

// Where the official installers put the CLI, for when PATH has not caught up.
export function knownLocations(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === 'win32') {
    const base = win32.join(env.LOCALAPPDATA ?? win32.join(home, 'AppData', 'Local'), 'cursor-agent');
    return ['agent.exe', 'cursor-agent.exe', 'agent.cmd', 'cursor-agent.cmd'].map(name => win32.join(base, name));
  }
  return [join(home, '.local', 'bin', 'agent'), join(home, '.local', 'bin', 'cursor-agent')];
}

const runSync = (path, args, env) => {
  const target = launchTarget(path, args, { env });
  return execFileSync(target.file, target.args, { timeout: 8000, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, NO_OPEN_BROWSER: '1' } });
};

// What one executable is: Cursor (and which documented features it has) or not.
// Any program called "agent" could be on PATH, so a Cursor build version and
// Cursor's own help text are both required.
const inspected = new Map();
export function inspectCursor(path, env = process.env, run = runSync) {
  let mtime = 0; try { mtime = statSync(path).mtimeMs; } catch { /* checked below */ }
  const key = `${path}\u0000${mtime}`; if (inspected.has(key)) return inspected.get(key);
  let result;
  try {
    const version = String(run(path, ['--version'], env)).trim().match(VERSION)?.[1] ?? null;
    const help = String(run(path, ['--help'], env));
    const cursor = !!version && /\bcursor\b/i.test(help);
    result = { path, version, cursor, supports: { resume: /--resume\b/.test(help), createChat: /\bcreate-chat\b/.test(help), mode: /--mode\b/.test(help), login: /\blogin\b/.test(help) } };
  } catch { result = { path, version: null, cursor: false, supports: {} }; }
  if (inspected.size > 50) inspected.clear();
  inspected.set(key, result); return result;
}

// PATH first (agent, then cursor-agent), then the documented install locations.
export function findCursor(env = process.env, { platform = process.platform, home = homedir(), run = runSync } = {}) {
  const onPath = ['agent', 'cursor-agent'].map(name => resolveExecutable(name, env, platform)).filter(Boolean);
  const candidates = [...new Set([...onPath, ...knownLocations(platform, env, home).filter(path => existsSync(path))])];
  let impostor = null;
  for (const path of candidates) {
    const info = inspectCursor(path, env, run);
    if (info.cursor) return { ...info, onPath: onPath.includes(path) };
    impostor ??= path;
  }
  return { path: null, version: null, cursor: false, supports: {}, onPath: false, impostor };
}

// The provider row shown in Journal. Login state is added by cursorAuth.
export function cursorState(found) {
  if (!found.path) return { state: found.impostor ? 'not-cursor' : 'missing', available: false };
  if (!found.supports.resume || !found.supports.createChat) return { state: 'unsupported', available: false };
  return { state: 'ready', available: true };
}

// Signed in or not, from `agent status` (exit codes are not documented, and the
// output can include the account email: only the conclusion leaves this function).
export function parseAuth(output) {
  const text = String(output ?? '');
  try {
    const data = JSON.parse(text);
    const flags = ['authenticated', 'isAuthenticated', 'loggedIn', 'isLoggedIn', 'signedIn'].map(key => data?.[key]).filter(value => typeof value === 'boolean');
    if (flags.length) return flags[0] ? 'signed-in' : 'signed-out';
    if (typeof data?.status === 'string') return parseAuth(data.status);
  } catch { /* plain text */ }
  if (/not\s+(?:logged|signed)\s+in|partially authenticated|unauthenticated|login required/i.test(text)) return 'signed-out';
  if (/(?:logged|signed)\s+in\b|authenticated as/i.test(text)) return 'signed-in';
  return 'unknown';
}
export function cursorAuth(path, env = process.env, timeout = 20000) {
  const once = args => new Promise(resolve => {
    const target = launchTarget(path, args, { env });
    execFile(target.file, target.args, { timeout, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024, env: { ...env, NO_OPEN_BROWSER: '1' } },
      (error, stdout, stderr) => resolve(error && !stdout ? null : `${stdout}\n${stderr}`));
  });
  return once(['status', '--format', 'json']).then(json => { const state = json === null ? 'unknown' : parseAuth(json); return state !== 'unknown' ? state : once(['status']).then(parseAuth); });
}

// A new, empty chat whose ID is known before launch (documented `create-chat`),
// created in the session's working directory. Null when it cannot be created.
export function createChat(path, cwd, env = process.env, timeout = 20000) {
  return new Promise(resolve => {
    const target = launchTarget(path, ['create-chat'], { env });
    execFile(target.file, target.args, { cwd, timeout, encoding: 'utf8', windowsHide: true, maxBuffer: 16384, env: { ...env, NO_OPEN_BROWSER: '1' } }, (error, stdout) => {
      const id = String(stdout ?? '').trim().split(/\s+/).at(-1);
      resolve(!error && UUID.test(id) ? id.toLowerCase() : null);
    });
  });
}

// The exit hint "To resume this session: agent --resume=<id>" (older builds:
// cursor-agent). A hint only; the user confirms it before any resume.
export function captureCursorId(output) {
  const clean = String(output).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const offset = clean.lastIndexOf('To resume this session'); if (offset < 0) return null;
  const candidate = clean.slice(offset).match(/^To resume this session:?\s+(?:cursor-)?agent\s+--resume[= ]["']?([^\s"']+)/)?.[1];
  return UUID.test(candidate ?? '') ? candidate.toLowerCase() : null;
}
export const CURSOR_RESUME_MARKER = 'To resume this session';
