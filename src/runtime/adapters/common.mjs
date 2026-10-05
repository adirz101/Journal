import { isAbsolute, relative } from 'node:path';
import { redact } from '../../core/validation.mjs';

// Shared helpers for the provider adapters. Both the hook script (in the agent's
// hook process) and the runtime import them, so they stay small and dependency-free.

// The vocabulary every adapter maps its provider's events to (normalize()).
// tool-start is Claude's PreToolUse; turn-progress is in-turn evidence without a
// more specific meaning (Cursor's afterAgentResponse).
export const KINDS = Object.freeze(['session-start', 'turn-start', 'turn-progress', 'tool-start', 'tool-end', 'permission-wait', 'turn-end', 'session-end', 'child-start', 'child-end']);
export const OUTCOMES = Object.freeze(['completed', 'interrupted', 'error']);

// A bounded string, or null for anything else.
export const str = (value, max = 100) => typeof value === 'string' && value ? value.slice(0, max) : null;
export const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
export const finite = value => Number.isFinite(value) ? value : null;

// Command text as the provider sent it (a string, or an argv array), redacted and bounded.
export function commandText(value) {
  const text = Array.isArray(value) ? value.filter(part => typeof part === 'string').join(' ') : typeof value === 'string' ? value : '';
  return redact(text, 600);
}

// A file path relative to the hook's working directory ('..' parts allowed: the runtime
// decides whether it is inside the session's folder). '' when missing, as before.
export function relativeTo(cwd, file) {
  if (typeof file !== 'string' || !file) return '';
  const path = isAbsolute(file) && typeof cwd === 'string' && isAbsolute(cwd) ? relative(cwd, file) || '.' : file;
  return path.slice(0, 1000);
}

// The fields every observation line may carry, whatever the provider. Anything a
// provider sends beyond these (prompts, assistant text, tool output, transcript
// paths, model parameters, account details) never reaches the events file.
export const LINE_FIELDS = Object.freeze(['nativeId', 'event', 'cwd', 'tool', 'toolUseId', 'command', 'background', 'filePath', 'exit', 'interrupted', 'durationMs',
  'turn', 'status', 'source', 'agentId', 'parentNativeId', 'childId']);
export function only(fields) {
  const line = {};
  for (const name of LINE_FIELDS) if (fields[name] !== undefined) line[name] = fields[name];
  return line;
}

// The parts of an observation line every normalized event keeps (normalize()).
export const carried = raw => ({ event: raw.event, nativeId: str(raw.nativeId) ?? null, cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
  tool: str(raw.tool, 80), toolUseId: str(raw.toolUseId), command: typeof raw.command === 'string' ? raw.command : undefined,
  filePath: typeof raw.filePath === 'string' ? raw.filePath : undefined, background: raw.background, exit: raw.exit, interrupted: raw.interrupted, durationMs: raw.durationMs });

// A Windows hook command is the launcher's path unquoted, read the same way by PowerShell and cmd.
// Only letters, digits and _ . : \ - are allowed; anything else (spaces, & ; $ ` ( ) % ! and so on)
// could be split or expanded by a shell, so such a launcher is not registered (sessions stay unobserved).
export const plainWindowsPath = path => typeof path === 'string' && /^[\p{L}\p{N}_.:\\-]+$/u.test(path);
