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
| Developer tools | Released builds have no Reload or DevTools in the View menu; set `JOURNAL_DEVTOOLS=1` to add Toggle Developer Tools for support. Development builds keep the default View menu. |
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

One SQLite file with ordered, idempotent migrations (`PRAGMA user_version`, currently 8):

- `projects`, `memories`, `revisions` (immutable), and `receipts` (immutable packet, plus the exact launch prompt once delivered).
- `sessions`: provider, project, branch, baseline (HEAD plus files already dirty at start), native ID and confirmation, PID identity, runtime ID, last activity, survivors, recovery marker and archived flag.
- `events`: a bounded per-session timeline of at most 2,000 rows. Rows hold small metadata only: redacted command text, exit codes, durations and edited paths. No prompts, tool output or terminal output.
- `memory_fts`: FTS5 with `porter unicode61` over the statement plus an alias column built from identifiers and paths.
- `workspaces` (managed and imported worktrees), `proposals` (inbox, unique per project and fingerprint), `audit` (reviewer and maintenance actions), a `pinned` flag on memories, and each note's latest approval time and revision.
- `deliveries`: one row per note in a launch that reached the agent (`submitted` or `uncertain`; previews, prepared and failed launches never count), written in the same transaction as the receipt's state. "Sent to N sessions" counts distinct native conversations at query time, joining the session's current native ID, so a resume chain counts once. Purging a session deletes its rows; removing (hiding) it keeps them. Receipt bodies are never rewritten for this.

The Changes view runs Git with literal pathspecs, reads untracked files only when no path component is a symlink and the file stays inside the checkout, and serves diffs only for paths it listed. **Open** uses the system default application only for regular, non-executable, non-launchable files; anything else is revealed in the file manager.

Hook event files are redacted at write time, rotated once consumed, swept at runtime start, and report lost observation if they reach 1 MiB.

Terminal output exists only in runtime memory: 256 KiB per session in 8 KiB chunks, with 64 KiB of in-flight display credit per attached session. A gap marker discloses dropped history.

## Projects

A project is a primary Git checkout plus optional **additional folders**, with a Journal-only display name and pin (`src/core/projects.mjs`, migration v6). Renaming never touches the folder; pinned projects sort first in pin order, the rest by most recent open, deterministically. **Remove from Journal** never deletes files: by default it only hides the project and keeps its data (reopening the folder restores it); **Remove and delete Journal data** deletes the project's knowledge, sessions, receipts, timelines, proposals and workspace records from Journal's database (the audit log of actions is kept), and refuses while sessions run or Journal worktrees exist.

Additional folders may be separate Git repositories (inside or outside the primary), subfolders of another repository, or plain folders (including folders an enclosing repository ignores). Journal refuses duplicates, overlaps, folders containing the primary, folders already tracked by the primary, and other worktrees of the same repository (import those as workspaces). Identities are never merged: each folder keeps its own Git identity, has a deterministic per-project ID, and evidence records which folder it came from (`source.rootId`). Knowledge from a removed folder is kept but excluded as `folder-removed` until the same folder is added again. Branch scope applies only to the primary repository. Folders are context sources; a session runs in exactly one place, and a folder can be chosen explicitly as its workspace (`root:<id>`), keeping knowledge on the primary repository's branch.

## Session management and context menus

Sessions have user-owned fields (`displayName`, `pinned`/`pinSeq`, `archived`, `removed`; migration v7) written only through `updateSessionUser`; runtime status saves keep them, so a rename or archive can never be undone by a status update, and the native session ID, workspace and receipts are never changed by them. Default titles come from the initial task deterministically (`generateTitle`, no model call); resumes are titled `Resume · <name>`. Updates are single atomic SQL statements (`json_set` for user fields; status saves copy the stored user fields inside the same UPSERT), so the app and runtime processes cannot overwrite each other. Archiving hides a session from Recent; a running archived session keeps running and stays in Active (it uses a slot) with an archived badge. Removing hides a stopped session and deletes its timeline while keeping its receipts so exact resume still reconciles the native conversation; **Remove and delete history** also deletes its receipts (the existing purge, refused when other sessions continue the same native conversation). Removing a running session asks: stop and remove (waits for the exit and the leftover-process scan, and keeps the session if child processes survive), keep running and archive, or cancel. Remove and purge also wait (up to 30 seconds after exit) while the leftover-process scan may still be running, and refuse while leftovers are recorded; a late runtime save never recreates a purged session, and the runtime's in-memory copies never override user-owned fields in the UI. Removed sessions generate no proposals, and the UI never lets a stale snapshot bring a removed session back. Native context menus are built by `Menu.popup` in the main process from labels the renderer chooses; only the chosen item ID returns, and the renderer runs the same actions as its buttons.

Right-click menus on projects and sessions are native Electron menus (`Menu.popup`): the renderer sends labels and item IDs, main returns only the chosen ID, and the renderer runs the same actions as the buttons and dialogs. Reveal and copy actions resolve paths and native IDs from Journal's records, never from renderer input. Automated tests route menus through a hook that exists only in headless test runs.

## File explorer

The right panel's **Files** tab is a read-only explorer ([design](FILE-EXPLORER-DESIGN.md)). It follows the selected session's workspace (its checkout or worktree; a session in an additional folder shows the checkout plus that folder) or any root the user picks, and shows the primary repository plus the project's additional folders as top-level roots. Worktrees are alternatives, never shown side by side.

- **Roots** resolve from Journal's records only (`store.fileRoots`/`fileRoot`: `checkout`, a ready worktree of this project, or `root:<id>`); the renderer names a root key and a relative path, never an absolute path.
- **Reads** (`src/core/files.mjs`) run asynchronously in the main process: listings load per expanded folder (5000 entries per folder), `.git` is never listed, every path component is checked with `lstat` (links and junctions are shown but never followed) and containment is re-checked with `realpath`. Previews read with `O_NOFOLLOW` and refuse sensitive paths (`isSensitivePath`, checked on the requested and the canonical path) without reading them; diffs are for single files only; binary files (NUL in the first 8 KB), files over 5 MB (not read) and over 1 MB (no highlighting) are bounded; invalid UTF-8 is shown with replacement characters and a notice.
- **Git status** (`src/core/git-status.mjs`) is one `git --no-optional-locks status --porcelain=v2 -z --untracked-files=normal --ignored=matching` per root, so untracked and ignored folders stay collapsed. It reports modified, added, untracked, deleted, renamed (with source), type changes, submodules and conflicts, and summarises folders by the highest-priority descendant (deletions and ignored entries do not mark parents). Diffs are against HEAD. The Changes tab keeps its own question (what changed since the session started).
- **Watching** (`src/desktop/watch.mjs`): `fs.watch` with `recursive` on the shown primary root only while the Files tab is open (macOS and Windows; Linux refreshes on focus and on request). Events under `node_modules` are dropped and `.git` events only refresh status (index, HEAD, refs); folders are batched every 150 ms and Git status refreshes 750 ms after a burst (at least every 3 s during continuous writes), after agent turns, commands and edits, on window focus and when HEAD moves. Resolved roots are cached in main for 5 s and cleared on any project, folder or workspace change.
- **Projects** never share explorer state: the panel is keyed by project, previews accept only their latest request, and next-task references carry their project ID and are dropped on a project switch (the store refuses a reference from another project).
- **Preview** is CodeMirror 6, read-only and loaded on first use: line numbers (click or Shift-click to select lines), selection, in-file search, visible control and bidirectional characters, and syntax classes themed by CSS. Nothing is rendered as HTML.
- **References** are paths, ranges and hashes, never file contents. *Add to next task* validates and fingerprints the file (`describeReference`), shows it as a chip, and `prepareContext` records it in the receipt (`references`) and the packet ("Referenced by the user"); referenced folders and files also select area-scoped knowledge for that area. A primary-repository reference must come from the same checkout or worktree the session runs in. *Reference in session* types `@path`, `@path#L10-20` or `@folder/` (Claude Code) as a bracketed paste without Enter, only when Claude hooks report the agent idle at its prompt for at least 750 ms; while it works (a permission prompt can open before its hook is observed), during a permission request, before readiness is known, and always for Codex (`path (lines 10-20)`), the reference is copied to the clipboard instead. Either way a `reference` timeline event records the path, range and hash; the Context Inspector shows references for the task and during the session, with whether each still matches.
- **External actions**: reveal and copy resolve from records; *Open in editor* launches an editor found on PATH (`code`, `cursor`, `zed`, `subl`, or `JOURNAL_EDITOR`) without a shell, falls back to the default app for passive documents, and otherwise reveals. Sensitive files and links are only revealed.

## Workspaces

A session runs in the project's own checkout, a Journal-managed Git worktree, or an imported existing worktree (`src/core/workspaces.mjs`). Creating a worktree records an `intent` row before `git worktree add -b <branch> <path> <base>` runs; reconciliation turns unfinished intents into `ready` (Git finished) or `failed` (nothing or an unregistered folder, left untouched), and vanished worktrees into `missing`. Journal never uses `--force`, never stashes or copies uncommitted changes, and removes only clean, unlocked, idle managed worktrees (keeping the branch); imported worktrees are only forgotten, never deleted. Sessions resolve their cwd through a view that requires a registered worktree of the same Git common directory; context, baselines and diffs use that view, and resume reuses the original workspace. Research mode starts each CLI in its own read-only mode; the CLI can leave it in-session, so it is not enforcement. Workspace actions are recorded in the `audit` table.

## Knowledge maintenance

- **Proposal inbox** (`src/core/proposals.mjs`): after a session ends, the runtime derives proposals from explicit `Rule:`/`Decision:` lines in the task, passing test commands observed through hooks, and branches that moved. No model calls; fingerprints make it idempotent; accepting creates an unapproved candidate.
- **Selection controls**: pinned rules (still validated), leave-out for one task, mark incorrect, superseding replacements, branch-to-all-branches promotion proposals, environment qualifiers, category diversity, and per-claim selection reasons stored in receipts.
- **Data** (`src/core/maintenance.mjs`): integrity-checked online backups, an offline restore script, storage accounting, versioned Brain export of approved claims and import (imports become candidates), explicit session purge, and 90-day timeline retention. Knowledge is never pruned automatically.

## Cursor provider

Cursor's adapter (`src/core/cursor.mjs`, with launch arguments in `agents.mjs`) uses only documented CLI commands. Detection accepts an executable only if `--version` is a Cursor build and `--help` names Cursor; it looks for `agent` and `cursor-agent` on `PATH`, then in the installers' locations, and reports which documented features the build has (`--resume`, `create-chat`, `--mode`). The runtime finds the CLI again at each launch, runs `create-chat` in the session's working directory and launches `agent --resume=<UUID>` with Journal's prompt, so the native ID is known before the CLI starts; if the chat cannot be created, the exit hint is kept for confirmation, as for Codex. Install and sign-in run in the main process in a pseudo-terminal shown in a dialog (`src/desktop/processes.mjs`); the install command is a constant chosen per platform, shown verbatim and run only after a native confirmation, and nothing from these processes is written to disk. The sign-in check keeps only signed in, signed out or unknown.

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
