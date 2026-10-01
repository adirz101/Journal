// Observer only: appends small, bounded metadata for Journal's activity view.
// No prompt text, tool output or file contents; never makes approval decisions.
import { appendFileSync, statSync } from 'node:fs';
import { redact } from '../core/validation.mjs';
const [target, token] = process.argv.slice(2);
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure'];
const FILE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
let input = ''; let oversized = false;
process.stdin.setEncoding('utf8');
// Tool payloads (for example Write content) can be large; keep only the prefix
// needed to read the event and drop anything that does not parse.
process.stdin.on('data', chunk => { if (input.length + chunk.length > 4 * 1024 * 1024) oversized = true; else input += chunk; });
process.stdin.on('end', () => {
  try {
    if (oversized || !target || !token || !process.env.JOURNAL_SESSION_ID) return;
    try { if (statSync(target).size > 1024 * 1024) return; } catch { /* first event */ }
    const event = JSON.parse(input);
    if (!EVENTS.includes(event.hook_event_name)) return;
    const tool = typeof event.tool_name === 'string' ? event.tool_name.slice(0, 80) : null;
    const response = event.tool_response && typeof event.tool_response === 'object' ? event.tool_response : {};
    const observation = { token, id: process.env.JOURNAL_SESSION_ID, nativeId: event.session_id, event: event.hook_event_name, cwd: event.cwd, at: Date.now(),
      tool, toolUseId: typeof event.tool_use_id === 'string' ? event.tool_use_id.slice(0, 100) : null };
    if (tool === 'Bash') {
      observation.command = redact(String(event.tool_input?.command ?? ''), 600);
      observation.background = !!(event.tool_input?.run_in_background || response.backgroundTaskId);
    }
    if (FILE_TOOLS.includes(tool)) observation.filePath = String(event.tool_input?.file_path ?? event.tool_input?.notebook_path ?? '').slice(0, 1000);
    if (event.hook_event_name === 'PostToolUseFailure') {
      const exit = String(event.error ?? '').match(/Exit code (\d+)/);
      observation.exit = exit ? Number(exit[1]) : null; observation.interrupted = !!event.is_interrupt;
    }
    if (event.hook_event_name === 'PostToolUse') observation.interrupted = !!response.interrupted;
    if (Number.isFinite(event.duration_ms)) observation.durationMs = event.duration_ms;
    appendFileSync(target, `${JSON.stringify(observation)}\n`, { mode: 0o600 });
  } catch { /* Observation failures never stop the native agent. */ }
});
