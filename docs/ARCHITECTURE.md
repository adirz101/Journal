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
- **Runtime:** a detached process started with the Electron binary in Node mode (`ELECTRON_RUN_AS_NODE=1`), so `node-pty` uses its Electron-built native module. It owns every PTY, native child process, output buffer, attach and flow-control state, and hook observation. It listens on a Unix socket in the data directory (or a hashed path under the temp directory when that path would be too long), or on a Windows named pipe. Both sides prove knowledge of the random token in `runtime.json` (mode 0600) with an HMAC challenge-response; the token never crosses the socket, so a process squatting on the path learns nothing and the app refuses it. An exclusive `runtime.lock` (owner PID plus process identity) guarantees one runtime per data directory; a runtime removes only the socket file it created. One app client at a time; a reconnecting app replaces a stale client. The app launches at most three runtimes in a row without a successful connection, then reports the failure.
- **Store worker:** synchronous SQLite, Git and evidence validation run in a worker thread so they never block PTY or UI handling. The app and the runtime each have one and share the same WAL database file.

## Lifecycle

| Event | Result |
| --- | --- |
| Renderer reload | Main asks the runtime to detach output streaming; the reloaded renderer re-attaches and repaints from the bounded buffer. Sessions continue. |
| Window close or app quit | With live sessions, Journal asks: **Stop sessions and quit** (graceful stop, then the runtime exits) or **Keep running in background** (the runtime keeps sessions, and the next launch rediscovers them). `JOURNAL_QUIT_POLICY=stop` or `keep` skips the prompt. |
| App crash | The runtime notices the client disconnect and keeps sessions. The next launch connects to the same runtime and lists live sessions. |
| Runtime crash | PTY masters close and native CLIs normally exit. The app reconnects, starting a new runtime if needed. The new runtime recovers sessions owned by any previous runtime: `interrupted`; `orphaned` when the recorded process still exists with the same identity; or `orphaned` and *unverified* when the PID is alive but its identity cannot be read (never signalled). Orphans block resume and ID confirmation for the same conversation and are rechecked every 5 s; once gone they become `interrupted`. Prompt delivery becomes `uncertain`, and nothing is resent. |
| Idle runtime | It exits after 60 s with no client and no live sessions. |
| Build mismatch | An idle runtime from another build is replaced. A busy one is kept, and the app shows a warning. A runtime speaking another protocol version is reported and never launched over. |

Session states: `starting`, `running` (activity `working` or `idle` when Claude hooks report it), `waiting` (permission request), `stopping`, `stopped`, `exited` (with exit code), `failed`, `interrupted`, `orphaned`. The UI shows `disconnected` for live sessions while the runtime connection is down, and marks ended sessions with a confirmed native ID as resumable.

## Process ownership

- Signals go through the live PTY handle Journal holds. Once the exit callback fires, Journal sends no further signals through that handle, so a reused PID is never targeted.
- **Stop:** SIGTERM to the PTY's process group (on Windows, ConPTY close through node-pty), then SIGKILL after a 3 s grace period only if the process has not exited.
- **Identity:** Journal records the PID and its start time (to the second, read asynchronously with `ps` under the C locale and UTC), once at launch and again on first output. The command line is not part of identity, because Node CLIs rewrite their process title; nothing about the prompt is stored. After a runtime restart, Journal signals a process only when its PID and start time still match (`signalVerified`). Ending an orphan signals its process group and records an end only after the process is gone.
- **Descendants:** the process table is sampled asynchronously every 5 s and right before stop (bounded to 1 s). Children that survive the agent are listed as leftovers, and ending them is an explicit, identity-verified action. A process that called `setsid` and was reparented between samples cannot be attributed.

## Data

One SQLite file with ordered, idempotent migrations (`PRAGMA user_version`, currently 7):

- `projects`, `memories`, `revisions` (immutable), and `receipts` (immutable packet, plus the exact launch prompt once delivered).
- `sessions`: provider, project, branch, baseline (HEAD plus files already dirty at start), native ID and confirmation, PID identity, runtime ID, last activity, survivors, recovery marker and archived flag.
- `events`: a bounded per-session timeline of at most 2,000 rows. Rows hold small metadata only: redacted command text, exit codes, durations and edited paths. No prompts, tool output or terminal output.
- `memory_fts`: FTS5 with `porter unicode61` over the statement plus an alias column built from identifiers and paths.
- `workspaces` (managed and imported worktrees), `proposals` (inbox, unique per project and fingerprint), `audit` (reviewer and maintenance actions), and a `pinned` flag on memories.

The Changes view runs Git with literal pathspecs, reads untracked files only when no path component is a symlink and the file stays inside the checkout, and serves diffs only for paths it listed. **Open** uses the system default application only for regular, non-executable, non-launchable files; anything else is revealed in the file manager.

Hook event files are redacted at write time, rotated once consumed, swept at runtime start, and report lost observation if they reach 1 MiB.

Terminal output exists only in runtime memory: 256 KiB per session in 8 KiB chunks, with 64 KiB of in-flight display credit per attached session. A gap marker discloses dropped history.

## Projects

A project is a primary Git checkout plus optional **additional folders**, with a Journal-only display name and pin (`src/core/projects.mjs`, migration v6). Renaming never touches the folder; pinned projects sort first in pin order, the rest by most recent open, deterministically. **Remove from Journal** never deletes files: by default it only hides the project and keeps its data (reopening the folder restores it); **Remove and delete Journal data** deletes the project's knowledge, sessions, receipts, timelines, proposals and workspace records from Journal's database (the audit log of actions is kept), and refuses while sessions run or Journal worktrees exist.

Additional folders may be separate Git repositories (inside or outside the primary), subfolders of another repository, or plain folders (including folders an enclosing repository ignores). Journal refuses duplicates, overlaps, folders containing the primary, folders already tracked by the primary, and other worktrees of the same repository (import those as workspaces). Identities are never merged: each folder keeps its own Git identity, has a deterministic per-project ID, and evidence records which folder it came from (`source.rootId`). Knowledge from a removed folder is kept but excluded as `folder-removed` until the same folder is added again. Branch scope applies only to the primary repository. Folders are context sources; a session runs in exactly one place, and a folder can be chosen explicitly as its workspace (`root:<id>`), keeping knowledge on the primary repository's branch.

## Session management and context menus

Sessions have user-owned fields (`displayName`, `pinned`/`pinSeq`, `archived`, `removed`; migration v7) written only through `updateSessionUser`; runtime status saves keep them, so a rename or archive can never be undone by a status update, and the native session ID, workspace and receipts are never changed by them. Default titles come from the initial task deterministically (`generateTitle`, no model call); resumes are titled `Resume · <name>`. Updates are single atomic SQL statements (`json_set` for user fields; status saves copy the stored user fields inside the same UPSERT), so the app and runtime processes cannot overwrite each other. Archiving hides a session from Recent; a running archived session keeps running and stays in Active (it uses a slot) with an archived badge. Removing hides a stopped session and deletes its timeline while keeping its receipts so exact resume still reconciles the native conversation; **Remove and delete history** also deletes its receipts (the existing purge, refused when other sessions continue the same native conversation). Removing a running session asks: stop and remove (waits for the exit and the leftover-process scan, and keeps the session if child processes survive), keep running and archive, or cancel. Removed sessions generate no proposals, and the UI never lets a stale snapshot bring a removed session back. Native context menus are built by `Menu.popup` in the main process from labels the renderer chooses; only the chosen item ID returns, and the renderer runs the same actions as its buttons.

Right-click menus on projects and sessions are native Electron menus (`Menu.popup`): the renderer sends labels and item IDs, main returns only the chosen ID, and the renderer runs the same actions as the buttons and dialogs. Reveal and copy actions resolve paths and native IDs from Journal's records, never from renderer input. Automated tests route menus through a hook that exists only in headless test runs.

## Workspaces

A session runs in the project's own checkout, a Journal-managed Git worktree, or an imported existing worktree (`src/core/workspaces.mjs`). Creating a worktree records an `intent` row before `git worktree add -b <branch> <path> <base>` runs; reconciliation turns unfinished intents into `ready` (Git finished) or `failed` (nothing or an unregistered folder, left untouched), and vanished worktrees into `missing`. Journal never uses `--force`, never stashes or copies uncommitted changes, and removes only clean, unlocked, idle managed worktrees (keeping the branch); imported worktrees are only forgotten, never deleted. Sessions resolve their cwd through a view that requires a registered worktree of the same Git common directory; context, baselines and diffs use that view, and resume reuses the original workspace. Research mode starts each CLI in its own read-only mode; the CLI can leave it in-session, so it is not enforcement. Workspace actions are recorded in the `audit` table.

## Knowledge maintenance

- **Proposal inbox** (`src/core/proposals.mjs`): after a session ends, the runtime derives proposals from explicit `Rule:`/`Decision:` lines in the task, passing test commands observed through hooks, and branches that moved. No model calls; fingerprints make it idempotent; accepting creates an unapproved candidate.
- **Selection controls**: pinned rules (still validated), leave-out for one task, mark incorrect, superseding replacements, branch-to-all-branches promotion proposals, environment qualifiers, category diversity, and per-claim selection reasons stored in receipts.
- **Data** (`src/core/maintenance.mjs`): integrity-checked online backups, an offline restore script, storage accounting, versioned Brain export of approved claims and import (imports become candidates), explicit session purge, and 90-day timeline retention. Knowledge is never pruned automatically.

## Provider observability

See [PROVIDERS.md](PROVIDERS.md) for versions and the full matrix.

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
