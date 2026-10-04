import { join } from 'node:path';
import { resolveExecutable, runFile, testProviderAllowed } from './process.mjs';
import { cursorState, findCursor, installCommand } from './cursor.mjs';

// Journal-owned adapter for the documented interactive CLI arguments.
// https://code.claude.com/docs/en/cli-reference
// https://developers.openai.com/codex/cli/reference/
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CODEX_RESUME_MARKER = 'To continue this session, run';
export const PROVIDERS = ['claude', 'codex', 'cursor'];
export const PROVIDER_NAMES = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' };

export function buildAgentLaunch(request) {
  const { provider, nativeId, resume, prompt, settingsFile, research = false, plan = false, executable } = request;
  if (!PROVIDERS.includes(provider)) throw new Error('Unknown agent provider');
  if ((resume || nativeId) && !UUID.test(nativeId ?? '')) throw new Error('An exact native session ID is required');
  if (provider === 'cursor') {
    // A pre-created (or confirmed) chat is always opened by its exact ID; never
    // "resume latest" or --continue. Ask mode is Cursor's read-only mode.
    if (!executable) throw new Error('Cursor CLI is not installed');
    const mode = research ? ['--mode=ask'] : plan ? ['--mode=plan'] : [];
    return { executable, argv: [...(nativeId ? [`--resume=${nativeId}`] : []), ...mode, ...(prompt ? ['--', prompt] : [])] };
  }
  if (plan && provider === 'codex') throw new Error('Codex has no plan mode; use Read-only instead');

  const sessionArgs = provider === 'codex'
    ? (resume ? ['resume', nativeId] : [])
    : (resume ? ['--resume', nativeId] : nativeId ? ['--session-id', nativeId] : []);
  const settingsArgs = provider === 'claude' && settingsFile ? ['--settings', settingsFile] : [];
  // Research mode starts each CLI in its own stricter mode. It is an intent,
  // not enforcement: the user can leave plan mode or approve escalation natively.
  const researchArgs = !research && !plan ? [] : provider === 'claude' ? ['--permission-mode', 'plan'] : ['--sandbox', 'read-only'];
  return { executable: provider, argv: [...sessionArgs, ...researchArgs, ...settingsArgs, ...(prompt ? ['--', prompt] : [])] };
}

export function captureCodexId(output) {
  // Native banner is a hint, never a trusted acknowledgment or auto-resume authorization.
  const clean = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  // Current Codex prints a colon/newline before the command; retain the older
  // inline form too. Validate the latest banner, even if its ID is malformed.
  const marker = CODEX_RESUME_MARKER;
  const offset = clean.lastIndexOf(marker);
  if (offset < 0) return null;
  const candidate = clean.slice(offset + marker.length).match(/^:?\s+codex resume\s+(\S+)/)?.[1];
  return UUID.test(candidate) ? candidate : null;
}

// What Journal can observe per provider in this terminal-first mode. Anything
// not listed is unknown and shown as unknown, never inferred.
export const CAPABILITIES = {
  claude: { exactResume: 'preassigned --session-id; --resume <UUID>', identity: 'known at launch; hook UUID mismatch requires confirmation',
    observer: 'per-launch hooks', status: ['working', 'idle', 'waiting for permission'], commands: 'Bash command text, exit code, duration (foreground only)', fileEdits: true, interrupt: 'Ctrl+C to the PTY' },
  codex: { exactResume: 'codex resume <UUID> after confirming the exit-banner hint', identity: 'hint from exit banner; confirmation required',
    observer: 'none', status: ['running', 'exited'], commands: 'unknown', fileEdits: false, interrupt: 'Ctrl+C to the PTY' },
  cursor: { exactResume: 'chat created with create-chat before launch, then --resume=<UUID>', identity: 'known at launch; exit-banner hint needs confirmation if the chat could not be created first',
    observer: 'none', status: ['running', 'exited'], commands: 'unknown', fileEdits: false, interrupt: 'Ctrl+C to the PTY', modes: 'Research: --mode=ask (read-only); Plan: --mode=plan' },
};

// ----- Phase 7: install, sign-in and status commands -----
// Constant per provider: the renderer names a provider, never an executable or argv.
// Install commands are the official ones, checked against these pages on 4 October 2026
// (docs/PROVIDERS.md); a command that could not be confirmed, or that would need a
// change Journal never makes (Codex's Windows command bypasses the execution policy),
// is null and the row offers the install page instead.
const deepFreeze = value => { if (value && typeof value === 'object') { for (const inner of Object.values(value)) deepFreeze(inner); Object.freeze(value); } return value; };
export const PROVIDER_COMMANDS = deepFreeze({
  claude: { executable: 'claude', login: ['auth', 'login'], authStatus: ['auth', 'status', '--json'],
    install: { posix: { display: 'curl -fsSL https://claude.ai/install.sh | bash', needs: 'curl' }, win32: { display: 'irm https://claude.ai/install.ps1 | iex' } },
    installPage: 'https://code.claude.com/docs/en/setup' },
  codex: { executable: 'codex', login: ['login'], authStatus: ['login', 'status'],
    install: { posix: { display: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', needs: 'curl' }, win32: null },
    installPage: 'https://developers.openai.com/codex/cli' },
  // Cursor's install command and status check live in cursor.mjs (installCommand, cursorAuth).
  cursor: { executable: 'agent', login: ['login'], authStatus: null, install: null, installPage: 'https://cursor.com/docs/cli/installation' },
});

// The install command to run for a provider on this platform, or null (offer the install page).
// POSIX: bash without startup files; Windows: PowerShell without a profile and without
// changing the execution policy. Never elevated. installEnv (cursor.mjs) removes BASH_ENV/ENV.
export function installFor(provider, platform = process.platform, env = process.env, { find = name => resolveExecutable(name, env, platform) } = {}) {
  if (provider === 'cursor') return installCommand(platform, env);
  const entry = PROVIDER_COMMANDS[provider]?.install?.[platform === 'win32' ? 'win32' : 'posix'];
  if (!entry) return null;
  if (entry.needs && !find(entry.needs)) return null;
  if (platform === 'win32') {
    const shell = join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return { display: entry.display, file: shell, args: ['-NoProfile', '-NonInteractive', '-Command', entry.display] };
  }
  // pipefail: a failed download (curl) fails the run instead of bash exiting 0 on empty input.
  return { display: entry.display, file: '/bin/bash', args: ['--noprofile', '--norc', '-o', 'pipefail', '-c', entry.display] };
}

// The display strings the renderer shows (AgentInfo.commands).
export function commandsFor(provider, platform = process.platform, env = process.env) {
  const table = PROVIDER_COMMANDS[provider];
  return { login: [table.executable, ...table.login].join(' '), install: installFor(provider, platform, env)?.display ?? null, installPage: table.installPage };
}

// Every row before anything has run: main starts with these and nothing runs synchronously.
export function initialAgents(platform = process.platform, env = process.env) {
  return PROVIDERS.map(provider => ({ provider, state: 'checking', available: false, version: null, path: null, auth: 'unchecked', supports: {},
    commands: commandsFor(provider, platform, env), capabilities: CAPABILITIES[provider] }));
}

const lastLine = text => String(text ?? '').trim().split('\n').at(-1)?.trim() || null;

// Installed or not, which version, and (with probes) whether this build documents a
// sign-in command and a status check. Help is read once (Codex: once more for
// `login --help`); a probe runs only when the help lists the subcommand, so an
// unknown subcommand never reaches a CLI that could read it as a prompt.
export async function detectProvider(provider, env = process.env, { runner = runFile, probes = true, platform = process.platform, ...options } = {}) {
  if (provider === 'cursor') return detectCursor(env, { platform, ...options, ...(runner !== runFile ? { runner } : {}) });
  if (!Object.hasOwn(PROVIDER_COMMANDS, provider)) throw new Error('Unknown agent provider');
  // A test run's guard: a CLI outside its fixture folder is not installed (never run).
  const found = resolveExecutable(provider, env, platform);
  const path = found && testProviderAllowed(found, env) ? found : null;
  const row = { provider, state: 'missing', available: false, version: null, path, auth: 'unchecked', supports: { login: false, authStatus: false },
    commands: commandsFor(provider, platform, env), capabilities: CAPABILITIES[provider] };
  if (!path) return row;
  let version;
  try { version = lastLine(await runner(path, ['--version'], env, { platform, timeout: 4000 })); } catch { return row; }
  const ready = { ...row, state: 'ready', available: true, version };
  if (!probes) return ready;
  const help = async args => { try { return String(await runner(path, args, env, { platform, timeout: 4000 })); } catch { return ''; } };
  const top = await help(['--help']);
  if (provider === 'claude') {
    const auth = /^\s+auth\b/m.test(top);
    return { ...ready, supports: { login: auth, authStatus: auth } };
  }
  const login = /^\s+login\b/m.test(top);
  const status = login && /^\s+status\b/m.test(await help(['login', '--help']));
  return { ...ready, supports: { login, authStatus: status } };
}

// Signed in or out, parsed in memory: only the conclusion leaves these functions.
// stdout and stderr can hold an email, an organization or a masked key, so they are
// never logged, stored, sent or put in an error.
export function parseClaudeAuth({ stdout } = {}) {
  try { const data = JSON.parse(String(stdout ?? '')); return typeof data?.loggedIn === 'boolean' ? (data.loggedIn ? 'signed-in' : 'signed-out') : 'unknown'; }
  catch { return 'unknown'; }
}
export function parseCodexAuth({ stdout, stderr, code } = {}) {
  // An exit code alone never decides: the line must say it.
  const lines = `${stdout ?? ''}\n${stderr ?? ''}`.split(/\r?\n/).map(line => line.trim());
  if (lines.some(line => line.startsWith('Not logged in'))) return 'signed-out';
  if (code === 0 && lines.some(line => line.startsWith('Logged in'))) return 'signed-in';
  return 'unknown';
}

// 'unchecked' when no probe may run (missing, or the help does not document a status
// check); otherwise 'signed-in', 'signed-out' or 'unknown'. Never throws.
export async function probeAuth(row, env = process.env, { runner = runFile, platform = process.platform } = {}) {
  const args = PROVIDER_COMMANDS[row?.provider]?.authStatus;
  if (!args || !row.available || !row.path || row.supports?.authStatus !== true) return 'unchecked';
  try {
    let result;
    try {
      const output = await runner(row.path, args, env, { platform, timeout: 8000, stdin: 'ignore', output: 'both' });
      result = typeof output === 'string' ? { stdout: output, stderr: '', code: 0 } : { stdout: String(output?.stdout ?? ''), stderr: String(output?.stderr ?? ''), code: 0 };
    }
    catch (error) {
      // Timeouts, spawn errors and signals: nothing was concluded.
      if (error?.timedOut || error?.killed || typeof error?.code !== 'number') return 'unknown';
      result = { stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? ''), code: error.code };
    }
    return row.provider === 'claude' ? parseClaudeAuth(result) : parseCodexAuth(result);
  } catch { return 'unknown'; }
}

// Cursor's row: installed and genuine, which documented features it has, and
// (after cursorAuth) whether it is signed in.
export async function detectCursor(env = process.env, options = {}) {
  const found = await findCursor(env, options);
  return { provider: 'cursor', ...cursorState(found), version: found.version, path: found.path, onPath: found.onPath, impostor: found.impostor ?? null,
    unlaunchable: found.unlaunchable ?? null, supports: found.supports, auth: 'unchecked', commands: commandsFor('cursor', options.platform ?? process.platform, env), capabilities: CAPABILITIES.cursor };
}
