# Journal architecture

A practical map for contributors. For the product contract, see [TERMINAL-FIRST-SPEC.md](TERMINAL-FIRST-SPEC.md). For what is verified, see [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md).

## Processes

```
Renderer (React, sandboxed)  ──IPC──>  Electron main (app)  ──local socket + token──>  Runtime (Node mode)
  src/ui/*                             src/desktop/main.mjs                            src/runtime/runtime.mjs
                                       ├─ StoreClient → worker → SQLite                ├─ TerminalManager (≤ 4 PTYs)
                                       └─ RuntimeClient                                ├─ Observers (Claude hooks)
                                                                                       └─ StoreClient → worker → SQLite
```

- **Renderer:** UI only. Context isolation, sandbox, CSP, no Node, and no navigation or remote content. Every request goes through `window.journal.request(action, input)`, which `preload.cjs` allowlists and `main.mjs` validates against the sender frame.
- **Electron main:** windows, dialogs, knowledge and project operations (through the store worker), and a `RuntimeClient`. It never owns a PTY.
- **Runtime:** a detached process started with the Electron binary in Node mode (`ELECTRON_RUN_AS_NODE=1`), so `node-pty` uses its Electron-built native module. It owns every PTY, native child process, output buffer, attach and flow-control state, and hook observation. It listens on a Unix socket in the data directory (or a hashed path under the temp directory when that path would be too long), or on a Windows named pipe. Clients must present the random token from `runtime.json` (mode 0600). One runtime runs per data directory, and one app client at a time; a reconnecting app replaces a stale client.
- **Store worker:** synchronous SQLite, Git and evidence validation run in a worker thread so they never block PTY or UI handling. The app and the runtime each have one and share the same WAL database file.

## Lifecycle

| Event | Result |
| --- | --- |
| Renderer reload | Main asks the runtime to detach output streaming; the reloaded renderer re-attaches and repaints from the bounded buffer. Sessions continue. |
| Window close or app quit | With live sessions, Journal asks: **Stop sessions and quit** (graceful stop, then the runtime exits) or **Keep running in background** (the runtime keeps sessions, and the next launch rediscovers them). `JOURNAL_QUIT_POLICY=stop` or `keep` skips the prompt. |
| App crash | The runtime notices the client disconnect and keeps sessions. The next launch connects to the same runtime and lists live sessions. |
| Runtime crash | PTY masters close and native CLIs normally exit. The app reconnects, starting a new runtime if needed. The new runtime recovers sessions owned by any previous runtime: `interrupted`, or `orphaned` when the recorded process still exists with the same identity. Prompt delivery becomes `uncertain`, and nothing is resent. |
| Idle runtime | It exits after 60 s with no client and no live sessions. |
| Build mismatch | An idle runtime from another build is replaced. A busy one is kept, and the app shows a warning. |

Session states: `starting`, `running` (activity `working` or `idle` when Claude hooks report it), `waiting` (permission request), `stopping`, `stopped`, `exited` (with exit code), `failed`, `interrupted`, `orphaned`. The UI shows `disconnected` for live sessions while the runtime connection is down, and marks ended sessions with a confirmed native ID as resumable.

## Process ownership

- Signals go through the live PTY handle Journal holds. Once the exit callback fires, Journal sends no further signals through that handle, so a reused PID is never targeted.
- **Stop:** SIGTERM to the PTY's process group (on Windows, ConPTY close through node-pty), then SIGKILL after a 3 s grace period only if the process has not exited.
- **Identity:** at launch, Journal records the PID, the process start time and a SHA-256 prefix of the command line. The prefix keeps prompt text out of process metadata. After a runtime restart, Journal signals a process only when all three still match (`signalVerified`).
- **Descendants:** the process table is sampled every 5 s and right before stop. Children that survive the agent are listed as leftovers, and ending them is an explicit, identity-verified action. A process that called `setsid` and was reparented between samples cannot be attributed.

## Data

One SQLite file with ordered, idempotent migrations (`PRAGMA user_version`, currently 3):

- `projects`, `memories`, `revisions` (immutable), and `receipts` (immutable packet, plus the exact launch prompt once delivered).
- `sessions`: provider, project, branch, baseline (HEAD plus files already dirty at start), native ID and confirmation, PID identity, runtime ID, last activity, survivors, recovery marker and archived flag.
- `events`: a bounded per-session timeline of at most 2,000 rows. Rows hold small metadata only: redacted command text, exit codes, durations and edited paths. No prompts, tool output or terminal output.
- `memory_fts`: FTS5 with `porter unicode61` over the statement plus an alias column built from identifiers and paths.

Terminal output exists only in runtime memory: 256 KiB per session in 8 KiB chunks, with 64 KiB of in-flight display credit per attached session. A gap marker discloses dropped history.

## Provider observability

| | Claude Code | Codex |
| --- | --- | --- |
| Exact resume | Preassigned `--session-id`, `--resume <UUID>` | `codex resume <UUID>` after confirming the exit-banner hint |
| Status | Per-launch hooks: working, idle, waiting for permission | Running or exited only |
| Commands and exit codes | Bash commands with exit code and duration (foreground only; background commands report unknown) | Unknown |
| File edits | Edit, Write, MultiEdit and NotebookEdit paths | Visible only through the Changes view (Git) |
| Interrupt | Ctrl+C to the PTY | Ctrl+C to the PTY |

Journal never installs global hooks, changes provider settings, reads credentials or passes permission-bypass flags. Hooks are added per launch through `--settings` and only observe.

## Knowledge

`prepareContext` selects approved briefs (repo overview and current-branch update) first, then task-relevant claims ranked by stemmed lexical matching over statements and aliases. It filters by project, branch, admission, evidence freshness and area relevance, suppresses duplicates, and warns about possible conflicts. Packets are capped at 12 claims and 6,000 bytes. Each session gets its own immutable receipt. Resume revalidates the packet and names any previously delivered claims that are now excluded.

## Where to start

- Terminal and session behavior: `src/core/terminal.mjs` (tested with fake PTYs in `tests/terminal.test.mjs` and `tests/runtime.test.mjs`).
- Runtime protocol and recovery: `src/runtime/` and `src/desktop/runtime-client.mjs`.
- Process ownership: `src/core/process.mjs`.
- Knowledge: `src/core/store.mjs`, `retrieval.mjs`, `evidence.mjs` and `status.mjs`.
- UI: `src/ui/App.tsx` and the panels beside it.
- End-to-end tests: `tests/desktop*.spec.ts` (real Electron, runtime and node-pty with fixture CLIs).
