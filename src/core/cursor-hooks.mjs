import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Cursor level 2 (docs/superpowers/plans/2026-10-05-codex-cursor-hooks.md, 4.6): Journal's entries
// for `stop` and `afterAgentResponse` in the user's own ~/.cursor/hooks.json. Cursor fires those turn
// events only when the user's or the project's hooks.json defines them (observed with 2026.10.01).
//
// Nothing here writes without an explicit, reviewed plan: plan*() returns the exact before and
// after text; apply() writes only that plan, and only if the file is still exactly as it was
// read. Entries are Journal's when their command runs Journal's hook launcher for `cursor`; every
// other entry, field and event stays. Outside Journal the launcher finds no session and answers {}.
export const CURSOR_FILE_EVENTS = Object.freeze(['stop', 'afterAgentResponse']);
const TIMEOUT_S = 5;

export const cursorHooksPath = home => join(home, '.cursor', 'hooks.json');
const hash = text => createHash('sha256').update(text ?? '').digest('hex');
// Journal's entry is exactly the command Journal generates for Cursor (never a similar-looking one
// of the user's own). If Journal's data folder moves, older entries no longer match and stay.
export const isJournalEntry = (entry, command) => !!entry && typeof entry === 'object' && typeof command === 'string' && command.length > 0 && entry.command === command;

// The file as it is now: missing, ok (a parsed object), or a reason Journal will not touch it.
// The text is never returned to logs; the caller shows it only in the review dialog.
export function readCursorHooks(home) {
  const path = cursorHooksPath(home);
  let stat; try { stat = lstatSync(path); } catch (error) { return error?.code === 'ENOENT' ? { path, state: 'missing', text: null, hash: hash(null) } : { path, state: 'unreadable' }; }
  if (stat.isSymbolicLink()) return { path, state: 'symlink' };
  if (!stat.isFile()) return { path, state: 'unreadable' };
  let text; try { text = readFileSync(path, 'utf8'); } catch { return { path, state: 'unreadable' }; }
  let data; try { data = JSON.parse(text); } catch { return { path, state: 'invalid', hash: hash(text) }; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { path, state: 'invalid', hash: hash(text) };
  // Cursor ignores a file without a positive integer version. Adding one would switch on the
  // user's dormant hooks, so such a file is left alone.
  if (!Number.isInteger(data.version) || data.version < 1) return { path, state: 'no-version', hash: hash(text) };
  if (data.hooks !== undefined && (!data.hooks || typeof data.hooks !== 'object' || Array.isArray(data.hooks))) return { path, state: 'invalid', hash: hash(text) };
  return { path, state: 'ok', text, data, hash: hash(text) };
}

// Whether Journal's entries are present for every turn event (the runtime reads this at launch).
export function cursorJournalInstalled(home, command) {
  const file = readCursorHooks(home); if (file.state !== 'ok') return false;
  return CURSOR_FILE_EVENTS.every(event => Array.isArray(file.data.hooks?.[event]) && file.data.hooks[event].some(entry => isJournalEntry(entry, command)));
}

const render = data => `${JSON.stringify(data, null, 2)}\n`;
const refused = (file, action) => ({ action, path: file.path, refused: file.state });

// The exact change that adds Journal's entries (once each; any older Journal entry is replaced).
export function planCursorInstall(home, command) {
  const file = readCursorHooks(home);
  if (file.state !== 'ok' && file.state !== 'missing') return refused(file, 'install');
  if (typeof command !== 'string' || !/journal-hook(?:\.cmd)?'? cursor$/.test(command)) return { action: 'install', path: file.path, refused: 'no-launcher' };
  const data = file.state === 'ok' ? structuredClone(file.data) : { version: 1 };
  data.hooks = data.hooks ?? {};
  for (const event of CURSOR_FILE_EVENTS) {
    const kept = Array.isArray(data.hooks[event]) ? data.hooks[event].filter(entry => !isJournalEntry(entry, command)) : [];
    data.hooks[event] = [...kept, { command, timeout: TIMEOUT_S }];
  }
  const after = render(data);
  return { action: 'install', path: file.path, before: file.text ?? null, after, baseHash: file.hash, changed: after !== file.text };
}

// The exact change that removes only Journal's entries (an event left empty loses its key).
export function planCursorRemove(home, command) {
  const file = readCursorHooks(home);
  if (file.state === 'missing') return { action: 'remove', path: file.path, before: null, after: null, baseHash: file.hash, changed: false };
  if (file.state !== 'ok') return refused(file, 'remove');
  const data = structuredClone(file.data);
  for (const event of Object.keys(data.hooks ?? {})) {
    if (!Array.isArray(data.hooks[event])) continue;
    const kept = data.hooks[event].filter(entry => !isJournalEntry(entry, command));
    if (kept.length !== data.hooks[event].length) { if (kept.length) data.hooks[event] = kept; else delete data.hooks[event]; }
  }
  const after = render(data);
  return { action: 'remove', path: file.path, before: file.text, after, baseHash: file.hash, changed: after !== file.text };
}

// Writes exactly a reviewed plan: refused if the file changed since it was read, became a symlink,
// or the plan was refused. Atomic (a temporary file, then rename); an existing file keeps its mode.
export function applyCursorPlan(home, plan) {
  if (!plan || plan.refused || typeof plan.after !== 'string' || !plan.changed) return { applied: false, reason: plan?.refused ?? 'nothing-to-change' };
  const file = readCursorHooks(home);
  if (file.path !== plan.path) return { applied: false, reason: 'changed' };
  if (file.state !== 'ok' && file.state !== 'missing') return { applied: false, reason: file.state };
  if (file.hash !== plan.baseHash) return { applied: false, reason: 'changed' };
  mkdirSync(join(home, '.cursor'), { recursive: true, mode: 0o700 });
  let mode = 0o600; try { mode = statSync(plan.path).mode & 0o777; } catch { /* new file */ }
  const temp = `${plan.path}.journal-${process.pid}.tmp`;
  writeFileSync(temp, plan.after, { mode, flag: 'wx' }); renameSync(temp, plan.path);
  return { applied: true };
}
