# ADR 002 — Terminal-first foundation

Date: 1 October 2026. User authorized investigation followed directly by implementation, with terminal-only agent interaction. This supersedes the stack and structured-chat assumptions in the earlier proposal, not its knowledge validity rules.

## Source inspection

Inspected dev3 checkout `ff63aa8a5ab7982f5b56672dd488ed49e06b607b` (2267 source files). Sources: `src/shared/agent-adapters/{claude,codex}.ts`, `src/bun/pane-session-capture.ts`, `src/bun/task-terminal-backend.ts`, `src/bun/terminal-backend/native-backend.ts`, `src/bun/native-terminal-registry/shell-launch.ts`, `src/bun/codex-config.ts`, `package.json`, LICENSE and NOTICE. Snapshot is available at https://github.com/h0x91b/dev-3.0/tree/ff63aa8a5ab7982f5b56672dd488ed49e06b607b.

Extending dev3 retains its working shell but couples Journal to Electrobun/Bun, task management, shared task DTOs, native host image staging, coordinator/registry and application configuration. Extracting its full native backend brings those dependencies too. The user subsequently rejected any dev3 vendoring or code reuse and explicitly allowed original implementation or reuse from another source. No dev3 code is retained. Write Journal's narrow launcher against official CLI contracts, and reuse independent PTY/emulator libraries. Do not copy code from other agent workspaces.

## Decision

Electron + React/Vite + node-pty + xterm.js + Node SQLite/FTS5. Mature existing PTY/emulator libraries replace the provisional Rust/PTY plan. Native CLIs run directly with inherited login/settings; no SDK, app-server chat, new agent loop, token extraction or global hook/config edits. No bypass-permission flags.

Claude gets a preassigned UUID and optional per-launch lifecycle observer hooks. Codex ID can be reported by its exact resume banner or explicitly supplied by the user; terminal-derived IDs need confirmation before targeted resume. Never use `--last` or `--continue`. Automatic trusted Codex hooks are deferred rather than overwriting existing native hook settings or bypassing hook trust.

Knowledge goes in the visible initial CLI prompt, together with the user-supplied task. Record exact immutable packets and included revisions. Transport acceptance is not model acknowledgment. On resume revalidate, and include the current packet with explicit notice that older context can remain in native history. No invisible repository instruction files. Single active terminal, one checkout at a time. Renderer reload reconnects to the owned PTY; application exit terminates it; app restart offers explicit native-session resume, never replays input.

## Validation limits

Installed executables: Claude Code 2.1.284 and Codex CLI 0.154.0. Version/help inspection is not a successful authenticated run. Native Windows quality and provider account policy are not proved by upstream code. All current checks run manually on the user's local computer; CI and nightly testing are disabled. Native Windows install/build/core and interactive smoke require a local Windows machine before advertising support. No release/signing/cloud in this slice. Native terminal output stays volatile; persisted knowledge is explicitly reviewed. No raw keystroke or PTY transcript capture.

Primary references: [node-pty](https://github.com/microsoft/node-pty), [xterm flow control](https://xtermjs.org/docs/guides/flowcontrol/), [Claude CLI](https://code.claude.com/docs/en/cli-reference), [Claude hooks](https://code.claude.com/docs/en/hooks), [Codex CLI](https://developers.openai.com/codex/cli/reference/).
