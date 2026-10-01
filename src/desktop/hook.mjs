// Observer only: no tool/prompt payload persistence and no approval decisions.
import { writeFileSync, renameSync } from 'node:fs';
const [target, token] = process.argv.slice(2);
let input = ''; let oversized = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { if (input.length + chunk.length > 16384) oversized = true; else input += chunk; });
process.stdin.on('end', () => {
  try {
    if (oversized || !target || !token || !process.env.JOURNAL_SESSION_ID) return;
    const event = JSON.parse(input);
    if (!['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop'].includes(event.hook_event_name)) return;
    const observation = { token, id: process.env.JOURNAL_SESSION_ID, nativeId: event.session_id, event: event.hook_event_name, cwd: event.cwd, at: Date.now() };
    writeFileSync(`${target}.tmp`, JSON.stringify(observation), { mode: 0o600 }); renameSync(`${target}.tmp`, target);
  } catch { /* Observation failures never stop the native agent. */ }
});
