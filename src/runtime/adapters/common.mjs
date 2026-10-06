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

// The Story's structured fields (src/core/story): short, redacted and bounded, never content.
// A tool's one-line description as the provider sent it (Claude's Bash and Agent "description").
export const describe = value => typeof value === 'string' && value.trim() ? redact(value.trim().replace(/\s+/g, ' '), 120) || null : null;
const PLAN_STATUSES = new Set(['pending', 'in_progress', 'completed']);
// A plan's items (Claude's TodoWrite todos): titles and statuses only, at most 50.
export function planItems(list) {
  if (!Array.isArray(list)) return null;
  // Without an id an item is known by its title (a repeated title by its occurrence), not by its
  // position: inserting an item must not move work to another one.
  const seen = new Map();
  const items = list.slice(0, 50).map(item => {
    const value = object(item); const title = describe(value.content ?? value.subject ?? value.title);
    if (!title || !PLAN_STATUSES.has(value.status)) return null;
    const count = (seen.get(title) ?? 0) + 1; seen.set(title, count);
    return { id: str(value.id, 40) ?? `title:${title}${count > 1 ? `#${count}` : ''}`.slice(0, 160), title, status: value.status };
  }).filter(Boolean);
  return items;
}
// The files an apply_patch names in its headers (*** Add/Update/Delete File: path). Only the
// header lines are read; the patch content never leaves the hook.
const PATCH_HEADER = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm;
export function patchFiles(input, cwd) {
  const texts = Object.values(object(input)).filter(value => typeof value === 'string');
  if (typeof input === 'string') texts.push(input);
  const files = [];
  for (const text of texts) for (const match of text.matchAll(PATCH_HEADER)) {
    if (files.length >= 50) break;
    const path = relativeTo(cwd, match[2].trim()); if (path) files.push({ path, op: match[1].toLowerCase() });
  }
  return files.length ? files : null;
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
  'turn', 'status', 'source', 'agentId', 'parentNativeId', 'childId', 'description', 'plan', 'patchFiles', 'readPath']);
export function only(fields) {
  const line = {};
  for (const name of LINE_FIELDS) if (fields[name] !== undefined) line[name] = fields[name];
  return line;
}

// The parts of an observation line every normalized event keeps (normalize()).
export const carried = raw => ({ hookInvocationId: str(raw.hookInvocationId), event: raw.event, nativeId: str(raw.nativeId) ?? null, cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
  tool: str(raw.tool, 80), toolUseId: str(raw.toolUseId), command: typeof raw.command === 'string' ? raw.command : undefined,
  filePath: typeof raw.filePath === 'string' ? raw.filePath : undefined, background: raw.background, exit: raw.exit, interrupted: raw.interrupted, durationMs: raw.durationMs,
  description: typeof raw.description === 'string' ? raw.description.slice(0, 120) : undefined, readPath: typeof raw.readPath === 'string' ? raw.readPath.slice(0, 1000) : undefined,
  plan: raw.plan && typeof raw.plan === 'object' && !Array.isArray(raw.plan) ? raw.plan : undefined, patchFiles: Array.isArray(raw.patchFiles) ? raw.patchFiles.slice(0, 50) : undefined });

// A Windows hook command is the launcher's path unquoted, read the same way by PowerShell and cmd.
// Only letters, digits and _ . : \ - are allowed; anything else (spaces, & ; $ ` ( ) % ! and so on)
// could be split or expanded by a shell, so such a launcher is not registered (sessions stay unobserved).
export const plainWindowsPath = path => typeof path === 'string' && /^[\p{L}\p{N}_.:\\-]+$/u.test(path);
