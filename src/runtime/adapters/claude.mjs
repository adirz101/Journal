import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { carried, commandText, object, only, relativeTo, str } from './common.mjs';

// Claude Code: per-launch hooks in a settings file passed with --settings; existing
// user and project hooks stay native. Claude has no turn key, so every event is the
// parent's and applies in arrival order, as before.
const EVENTS = Object.freeze(['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
const KINDS = { SessionStart: 'session-start', UserPromptSubmit: 'turn-start', PermissionRequest: 'permission-wait', Stop: 'turn-end',
  PreToolUse: 'tool-start', PostToolUse: 'tool-end', PostToolUseFailure: 'tool-end' };
const TIMEOUT_S = 3;
const FILE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

export default Object.freeze({
  provider: 'claude',
  events: EVENTS,
  // What the hook launcher prints: nothing.
  response: '',
  // The ID is preassigned (--session-id), never bound from a hook.
  bindsIdentity: false,
  // It reports a tool's start (PreToolUse) and a prompt's submission (UserPromptSubmit).
  toolStarts: true, turnStarts: true,
  // Per-hook timeout. Claude Code cancels a command hook at its timeout, discards its output and
  // does not block on it (code.claude.com/docs/en/hooks: "timeout", exit codes other than 2).
  hookTimeoutSeconds: TIMEOUT_S,
  // Its ID is checked when an event changes the state, as before.
  strictIdentity: false,
  // One hook group per event, every one running the same launcher command.
  register({ dir, session, command }) {
    const hooks = Object.fromEntries(EVENTS.map(event => [event, [{ hooks: [{ type: 'command', command, timeout: TIMEOUT_S }] }]]));
    const settingsFile = join(dir, `${session.id}.settings.json`);
    writeFileSync(settingsFile, JSON.stringify({ hooks }), { mode: 0o600 });
    return { settingsFile, files: [settingsFile], observes: { turns: true, approvals: true } };
  },
  // Hook payload -> observation line (in the hook process). Every event, PermissionRequest
  // included, carries tool_use_id, the Bash command and the file tools' path: the
  // pending-approval detail relies on them. Whether native PermissionRequest payloads
  // include tool_input is still to verify (docs/NATIVE-VALIDATION.md).
  // absolutePaths: the older hook form (hook.mjs <target> <token>) is read by an older runtime,
  // which resolves a relative path against the session's folder, not the hook's: it gets the
  // absolute path, as it always did.
  extract(event, { absolutePaths = false } = {}) {
    const tool = str(event.tool_name, 80); const input = object(event.tool_input); const response = object(event.tool_response);
    const line = { nativeId: str(event.session_id), event: event.hook_event_name, cwd: str(event.cwd, 4096), tool, toolUseId: str(event.tool_use_id) };
    if (tool === 'Bash') { line.command = commandText(String(input.command ?? '')); line.background = !!(input.run_in_background || response.backgroundTaskId); }
    if (FILE_TOOLS.includes(tool)) {
      const file = input.file_path ?? input.notebook_path ?? '';
      line.filePath = absolutePaths ? String(file).slice(0, 1000) : relativeTo(line.cwd, file);
    }
    if (event.hook_event_name === 'PostToolUseFailure') {
      const exit = String(event.error ?? '').match(/Exit code (\d+)/);
      line.exit = exit ? Number(exit[1]) : null; line.interrupted = !!event.is_interrupt;
    }
    if (event.hook_event_name === 'PostToolUse') line.interrupted = !!response.interrupted;
    if (Number.isFinite(event.duration_ms)) line.durationMs = event.duration_ms;
    return only(line);
  },
  // Observation line -> Journal's vocabulary (in the runtime).
  normalize(raw) {
    const kind = KINDS[raw?.event]; if (!kind) return null;
    return { ...carried(raw), kind, turn: null, child: false, childId: null, outcome: kind === 'turn-end' ? 'completed' : null, failed: raw.event === 'PostToolUseFailure' };
  },
});
