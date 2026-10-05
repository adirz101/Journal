import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cursorJournalInstalled } from '../../core/cursor-hooks.mjs';
import { carried, commandText, finite, object, only, plainWindowsPath, relativeTo, str } from './common.mjs';

// Cursor Agent CLI hooks (docs/superpowers/plans/2026-10-05-codex-cursor-hooks.md, 3.2 and 4.6).
// Level 1 (every launch whose CLI lists --plugin-dir): a plugin in Journal's data folder, passed
// with --plugin-dir, registering only after-type and lifecycle events. No before* hook, no
// preToolUse and no subagentStart (permission steps): Journal never decides anything.
// Level 2 (opt-in, src/core/cursor-hooks.mjs): entries for stop and afterAgentResponse in the
// user's ~/.cursor/hooks.json. Cursor fires those turn events only when the user's or the project's
// own hooks.json defines them (natively observed with 2026.10.01), so the plugin does not register
// them: they would never fire from it alone, and with level 2 they would arrive twice.
const PLUGIN_EVENTS = Object.freeze(['sessionStart', 'sessionEnd', 'postToolUse', 'postToolUseFailure', 'afterShellExecution', 'afterMCPExecution', 'afterFileEdit', 'subagentStop']);
export const USER_FILE_EVENTS = Object.freeze(['stop', 'afterAgentResponse']);
const EVENTS = Object.freeze([...PLUGIN_EVENTS, ...USER_FILE_EVENTS]);
const TIMEOUT_S = 5;
// The plugin's own name and folder. Without "version": 1 in hooks/hooks.json the CLI loads the
// plugin but silently runs none of its hooks (natively observed, 2026.10.01).
export const PLUGIN_NAME = 'journal-observer';
export function pluginFiles(command) {
  const hooks = Object.fromEntries(PLUGIN_EVENTS.map(event => [event, [{ command, timeout: TIMEOUT_S }]]));
  return { manifest: `${JSON.stringify({ name: PLUGIN_NAME, version: '1.0.0', description: 'Journal session observer: reports lifecycle events to Journal and never changes a decision.' }, null, 2)}\n`,
    hooks: `${JSON.stringify({ version: 1, hooks }, null, 2)}\n` };
}
// The hook command Cursor runs through the user's shell ($SHELL -ilc on macOS and Linux,
// PowerShell on Windows, unverified). Windows: a plain unquoted path reads the same in every
// shell; a launcher path with spaces is not registered there.
export function cursorHookCommand(command, launcher, platform) {
  if (platform !== 'win32') return command;
  return plainWindowsPath(launcher) ? `${launcher} cursor` : null;
}
const writeIfChanged = (file, content) => {
  let current = null; try { current = readFileSync(file, 'utf8'); } catch { /* new */ }
  if (current === content) return;
  const temp = `${file}.${process.pid}.tmp`; writeFileSync(temp, content, { mode: 0o600 }); renameSync(temp, file);
};
const KINDS = { sessionStart: 'session-start', sessionEnd: 'session-end', postToolUse: 'tool-end', postToolUseFailure: 'tool-end', afterShellExecution: 'tool-end',
  afterMCPExecution: 'tool-end', afterFileEdit: 'tool-end', subagentStop: 'child-end', stop: 'turn-end', afterAgentResponse: 'turn-progress' };
const STATUSES = { completed: 'completed', aborted: 'interrupted', error: 'error' };
const TURNLESS = new Set(['session-start', 'session-end']);

export default Object.freeze({
  provider: 'cursor',
  events: EVENTS,
  // Cursor parses hook output as JSON: {} sets no field.
  response: '{}',
  // The chat is created before launch (create-chat): its ID is known and must match. When it could
  // not be created (the exit-banner fallback), the first parent event binds it, as for Codex.
  bindsIdentity: true,
  // No tool start and no turn start (beforeSubmitPrompt is a permission step Journal never registers):
  // a submitted prompt leaves the state unknown until the next event.
  toolStarts: false, turnStarts: false,
  // Per-hook timeout for the Phase 3 registration. Cursor documents a per-hook `timeout` (seconds,
  // platform default) and that crashes, timeouts and exit codes other than 2 fail open unless the
  // hook sets failClosed, which Journal never does (cursor.com/docs/hooks). Whether its timer also
  // covers the `$SHELL -ilc` start (profiles) is unverified.
  hookTimeoutSeconds: 5,
  // Every parent event's ID is checked against the session's (Claude: only on a state change, as before).
  strictIdentity: true,
  // The plugin folder sits next to the launcher (Journal's data folder) and is the same for every
  // launch: the per-launch target and token travel in the environment.
  register({ command, launcher, platform = process.platform, hooksEnabled = null, home }) {
    if (hooksEnabled !== true || typeof launcher !== 'string' || typeof home !== 'string') return null;
    const hook = cursorHookCommand(command, launcher, platform); if (!hook) return null;
    const dir = join(dirname(launcher), 'cursor-plugin');
    mkdirSync(join(dir, '.cursor-plugin'), { recursive: true, mode: 0o700 }); mkdirSync(join(dir, 'hooks'), { recursive: true, mode: 0o700 });
    const files = pluginFiles(hook);
    writeIfChanged(join(dir, '.cursor-plugin', 'plugin.json'), files.manifest); writeIfChanged(join(dir, 'hooks', 'hooks.json'), files.hooks);
    // Turn end and interruption are observable only with level 2 (Journal's entries in the user's
    // hooks.json); approval waits never are (Cursor has no event for them).
    return { args: ['--plugin-dir', dir], files: [], observes: { turns: cursorJournalInstalled(home, hook), approvals: false } };
  },
  extract(event) {
    const input = object(event.tool_input);
    const cwd = str(event.cwd, 4096) ?? (Array.isArray(event.workspace_roots) ? str(event.workspace_roots[0], 4096) : null);
    const line = { nativeId: str(event.conversation_id) ?? str(event.session_id), event: event.hook_event_name, cwd, turn: str(event.generation_id),
      status: Object.hasOwn(STATUSES, event.status) ? event.status : undefined, parentNativeId: str(event.parent_conversation_id), childId: str(event.subagent_id),
      tool: str(event.tool_name, 80), toolUseId: str(event.tool_use_id), durationMs: finite(event.duration) ?? undefined };
    const command = event.hook_event_name === 'afterShellExecution' ? event.command : input.command;
    if (command !== undefined) line.command = commandText(command);
    if (event.hook_event_name === 'afterFileEdit') line.filePath = relativeTo(cwd, event.file_path);
    return only(line);
  },
  // A parent_conversation_id or a sub-agent ID marks a child. A stop without a known
  // status cannot be given an outcome and is dropped.
  normalize(raw) {
    const kind = KINDS[raw?.event]; if (!kind || !str(raw.nativeId)) return null;
    const outcome = kind === 'turn-end' ? STATUSES[raw.status] ?? null : null;
    // A turn end without a known outcome or without its turn key is dropped (it could finish any turn).
    if (kind === 'turn-end' && (!outcome || !str(raw.turn))) return null;
    const child = kind.startsWith('child-') || !!str(raw.parentNativeId) || !!str(raw.childId);
    return { ...carried(raw), kind, turn: TURNLESS.has(kind) ? null : str(raw.turn), child, childId: child ? str(raw.childId) ?? (str(raw.parentNativeId) ? str(raw.nativeId) : null) : null,
      outcome, failed: raw.event === 'postToolUseFailure' };
  },
});
