import { execFileSync } from 'node:child_process';
import { launchTarget, resolveExecutable } from './process.mjs';
import { cursorState, findCursor } from './cursor.mjs';

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
  if (plan && provider === 'codex') throw new Error('Codex has no plan mode; use Research for its read-only sandbox');

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

export function detectAgents(env = process.env, options = {}) {
  return [...['claude', 'codex'].map(provider => {
    const path = resolveExecutable(provider, env);
    try {
      if (!path) throw new Error('not found');
      const target = launchTarget(path, ['--version'], { env });
      const version = execFileSync(target.file, target.args, { timeout: 4000, encoding: 'utf8', windowsHide: true, maxBuffer: 16384, stdio: 'pipe' });
      return { provider, available: true, version: version.trim().split('\n').at(-1), path, capabilities: CAPABILITIES[provider] };
    } catch { return { provider, available: false, version: null, path, capabilities: CAPABILITIES[provider] }; }
  }), detectCursor(env, options)];
}

// Cursor's row: installed and genuine, which documented features it has, and
// (after cursorAuth) whether it is signed in. Login is checked asynchronously.
export function detectCursor(env = process.env, options = {}) {
  const found = findCursor(env, options);
  return { provider: 'cursor', ...cursorState(found), version: found.version, path: found.path, onPath: found.onPath, impostor: found.impostor ?? null,
    supports: found.supports, auth: 'unchecked', capabilities: CAPABILITIES.cursor };
}
