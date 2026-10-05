// Observer only: appends small, bounded metadata for Journal's activity view.
// No prompt text, assistant text, tool output, file contents, transcript paths,
// model parameters or account details; never makes approval decisions. Run by
// the hook launcher (src/runtime/observers.mjs), which always exits 0, discards
// this script's output and prints the provider's neutral response itself.
//
// Bounds: this script exits after 1.5 s whatever happens. Before it starts (launcher, shell,
// interpreter start-up) the bound is the launcher's watchdog on macOS and Linux and, on every
// platform, the timeout registered with the provider (adapters: hookTimeoutSeconds).
//
// Usage: hook.mjs <provider>. Per-launch values come from the agent's environment:
// JOURNAL_SESSION_ID, JOURNAL_HOOK_TARGET (the events file) and JOURNAL_HOOK_TOKEN.
// The older form hook.mjs <target> <token> (Claude only) is still read, for sessions
// of a runtime started before this version.
import { appendFileSync, statSync } from 'node:fs';
import { adapterFor } from '../runtime/adapters/index.mjs';

const MAX_INPUT = 4 * 1024 * 1024;
const MAX_FILE = 1024 * 1024;
// A hook that cannot finish in time gives up silently; the launcher has its own limit too.
setTimeout(() => process.exit(0), 1500).unref();

const args = process.argv.slice(2);
const legacy = args.length >= 2 && !adapterFor(args[0]);
const provider = legacy ? 'claude' : args[0];
const target = legacy ? args[0] : process.env.JOURNAL_HOOK_TARGET;
const token = legacy ? args[1] : process.env.JOURNAL_HOOK_TOKEN;
const adapter = adapterFor(provider);

let input = ''; let oversized = false;
process.stdin.setEncoding('utf8');
// Tool payloads (for example Write content) can be large; anything over the cap is dropped.
process.stdin.on('data', chunk => { if (oversized || input.length + chunk.length > MAX_INPUT) { oversized = true; input = ''; } else input += chunk; });
process.stdin.on('end', () => {
  try {
    if (oversized || !adapter || !target || !token || !process.env.JOURNAL_SESSION_ID) return;
    try { if (statSync(target).size > MAX_FILE) return; } catch { /* first event */ }
    const event = JSON.parse(input);
    if (!adapter.events.includes(event?.hook_event_name)) return;
    const line = { token, id: process.env.JOURNAL_SESSION_ID, provider, ...adapter.extract(event, { absolutePaths: legacy }), at: Date.now() };
    appendFileSync(target, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch { /* Observation failures never stop the native agent. */ }
});
