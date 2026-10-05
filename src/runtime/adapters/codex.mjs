import { carried, commandText, object, only, plainWindowsPath, str } from './common.mjs';

// Codex: lifecycle hooks (docs/superpowers/plans/2026-10-05-codex-cursor-hooks.md, 3.1 and 4.6).
// Every supported launch registers Journal's hooks with `-c hooks.<Event>=[…]`: the session-flags
// config layer, which adds to (never replaces) the user's own hooks. Codex asks the user to trust
// them once in its own review screen; Journal never bypasses or writes that trust. Until they are
// trusted Codex skips them, and the session becomes unobserved by the first-prompt rule.
const EVENTS = Object.freeze(['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'Stop', 'Interrupt', 'SessionEnd', 'SubagentStart', 'SubagentStop']);
export const CODEX_EVENTS = EVENTS;
// The first Codex version with each hook event (openai/codex tags containing the change). An event
// an older Codex does not know is never registered: an unknown hook key must not reach its config.
// Hook trust and the startup review arrived in 0.131, so nothing is registered below it.
const MIN_VERSION = [0, 131, 0];
const SINCE = Object.freeze({ SubagentStart: [0, 133, 0], SubagentStop: [0, 133, 0], SessionEnd: [0, 145, 0], Interrupt: [0, 150, 0] });
// Per-hook timeouts in seconds (plan 4.2). Codex clamps SessionEnd and Interrupt to at most 3 s.
// Changing a value changes the hook's definition, so Codex would ask for trust again: keep them fixed.
const TIMEOUTS = Object.freeze({ UserPromptSubmit: 5, PermissionRequest: 5, Stop: 5 });
const timeoutFor = event => TIMEOUTS[event] ?? 3;

// "codex-cli 0.159.3" -> [0, 159, 3]; null when no version can be read.
export function codexVersion(text) {
  const match = typeof text === 'string' ? /(\d+)\.(\d+)\.(\d+)/.exec(text) : null;
  return match ? match.slice(1, 4).map(Number) : null;
}
const atLeast = (version, min) => { for (let i = 0; i < 3; i++) if (version[i] !== min[i]) return version[i] > min[i]; return true; };
// The hook events registered for a Codex version, in a fixed order (Codex's trust key includes
// the event, the group and the handler index, so the shape never changes between launches).
export function codexEvents(version) {
  if (!version || !atLeast(version, MIN_VERSION)) return [];
  return EVENTS.filter(event => !SINCE[event] || atLeast(version, SINCE[event]));
}
// One `-c` override per event: a TOML inline array with one group and one command handler.
// JSON string escaping is valid TOML basic-string escaping for the command text.
// TOML basic strings forbid DEL and lone surrogates, which JSON.stringify would pass through.
export function tomlString(text) {
  if (typeof text !== 'string' || !text.isWellFormed()) return null;
  return JSON.stringify(text).replace(/\x7f/g, '\\u007f');
}
export function codexHookArgs(events, command) {
  const value = tomlString(command); if (!value) return [];
  return events.flatMap(event => ['-c', `hooks.${event}=[{hooks=[{type="command",command=${value},timeout=${timeoutFor(event)}}]}]`]);
}
const KINDS = { SessionStart: 'session-start', UserPromptSubmit: 'turn-start', PermissionRequest: 'permission-wait', PostToolUse: 'tool-end',
  Stop: 'turn-end', Interrupt: 'turn-end', SessionEnd: 'session-end', SubagentStart: 'child-start', SubagentStop: 'child-end' };
// Session events are not part of a turn, even when the payload names one.
const TURNLESS = new Set(['session-start', 'session-end']);
// Shell tools whose tool_input.command is a command line. Any other tool's input is never kept:
// apply_patch's input is the patch itself (file content). Tool names are unverified natively.
const SHELL_TOOLS = /^(?:bash|shell|local_shell|exec_command|unified_exec|container\.exec)$/i;

export default Object.freeze({
  provider: 'codex',
  events: EVENTS,
  response: '',
  // A new launch has no ID until Codex reports one: the first parent event binds it.
  bindsIdentity: true,
  // No PreToolUse is registered: an approval is settled by its own tool's end or an answer key.
  toolStarts: false, turnStarts: true,
  // Codex's approval prompt also takes letter shortcuts (unverified natively: NATIVE-VALIDATION.md).
  answerKeys: /^[a-zA-Z]$/,
  // Per-hook timeout for the Phase 2 registration (plan 4.2: 3 s, 5 s for UserPromptSubmit,
  // PermissionRequest and Stop). Codex enforces it and a timeout is non-blocking: the run is
  // marked "timeout" and nothing is decided (codex-rs/hooks/src/engine/command_runner.rs,
  // rust-v0.159.3); SessionEnd and Interrupt are clamped to at most 3 s (engine/discovery.rs).
  hookTimeoutSeconds: 5,
  // Every parent event's ID is checked against the session's (Claude: only on a state change, as before).
  strictIdentity: true,
  // Returns the `-c` arguments for this launch, or null (the launch is then unchanged and the
  // session unobserved): an unknown or too old Codex version, hooks turned off in Codex
  // (`codex features list`), or, on Windows, a launcher path with spaces. Codex runs a hook
  // command through the user's shell (PowerShell or cmd on Windows), and a plain unquoted path
  // is read the same way by both; a quoted one is not. Windows is unverified natively.
  register({ session, command, launcher, platform = process.platform, hooksEnabled = null }) {
    if (hooksEnabled === false) return null;
    const events = codexEvents(codexVersion(session?.cliVersion));
    if (!events.length) return null;
    let hook = command;
    if (platform === 'win32') { if (!plainWindowsPath(launcher)) return null; hook = `${launcher} codex`; }
    const args = codexHookArgs(events, hook); if (!args.length) return null;
    return { args, files: [], observes: { turns: true, approvals: true } };
  },
  extract(event) {
    const input = object(event.tool_input); const response = object(event.tool_response);
    const line = { nativeId: str(event.session_id), event: event.hook_event_name, cwd: str(event.cwd, 4096), turn: str(event.turn_id),
      agentId: str(event.agent_id), source: typeof event.source === 'string' && /^[a-z_-]{1,20}$/.test(event.source) ? event.source : undefined,
      tool: str(event.tool_name, 80), toolUseId: str(event.tool_use_id) };
    if (input.command !== undefined && SHELL_TOOLS.test(line.tool ?? '')) line.command = commandText(input.command);
    if (Number.isInteger(response.exit_code)) line.exit = response.exit_code;
    return only(line);
  },
  // Sub-agent events carry the parent's session_id plus agent_id: they are children.
  normalize(raw) {
    const kind = KINDS[raw?.event]; if (!kind || !str(raw.nativeId)) return null;
    // A turn end without its turn key could finish any turn: dropped.
    if (kind === 'turn-end' && !str(raw.turn)) return null;
    const child = kind.startsWith('child-') || !!str(raw.agentId);
    return { ...carried(raw), kind, turn: TURNLESS.has(kind) ? null : str(raw.turn), child, childId: child ? str(raw.agentId) : null,
      outcome: raw.event === 'Interrupt' ? 'interrupted' : raw.event === 'Stop' ? 'completed' : null, failed: false };
  },
});
