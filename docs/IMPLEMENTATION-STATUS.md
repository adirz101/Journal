# Journal implementation status

2 October 2026. Merged to `main`: the terminal-first slice (PR #1), native validation (PR #2), orientation and licensing (PR #3), branding and layout (PR #4), and the durable multi-session runtime with the status helper and usefulness trial round 1 (PR #5). Branch `claude/roadmap-completion` adds worktrees, Brain completion, the proposal inbox, data maintenance, release groundwork and the benchmark harness. Alpha; no public release.

Verification uses local checks on the user's Mac and fixture-only GitHub Actions (CI on macOS, Linux and experimental Windows; packaging and smoke tests on macOS and Windows). CI never uses provider logins. Authenticated native trials and usefulness benchmarks are manual and local.

## Implemented

**Runtime and sessions** ([architecture](ARCHITECTURE.md))
- A detached local runtime (Electron in Node mode) owns all PTYs and native CLIs. It sits behind a local socket or named pipe with HMAC challenge-response, an exclusive lock and launch caps.
- Up to four concurrent sessions, with per-session input, output, flow control, receipts, versions and attention markers.
- Renderer reload, app crash and keep-running quit leave sessions running and are rediscovered. A runtime crash recovers sessions as interrupted or orphaned (verified or unverified), with uncertain delivery and no resend.
- Ownership: signals go through the held PTY handle, or after a restart through PID plus UTC start time; stop escalates SIGTERM to the group, then SIGKILL after 3 s. Leftover descendants are reported and ended only on request.

**Projects**
- Display names (folders are never renamed), pinning with deterministic order, Remove from Journal (keep data, restorable) or Remove and delete Journal data, with explicit confirmation that files are not deleted.
- Additional folders per project (other Git repositories, subfolders of other repositories, plain folders) with their own identity; folder-aware evidence and validation; a folder can be a session's explicit workspace.

**Session management and menus**
- Rename (with reset to a deterministic default title), pin, archive/unarchive (running sessions keep running and stay in Active with an archived badge) and remove from Journal (never files; a running session is stopped first or archived instead; "Remove and delete history" also deletes receipts unless other sessions continue the same native conversation). User fields are written atomically so app and runtime updates cannot overwrite each other. Native session IDs, workspaces, receipts and exact resume are unaffected.
- Native right-click menus on projects (open, rename, pin, manage, add folder, reveal, copy path, remove) and sessions (open, rename, pin, archive, resume, interrupt, stop, reveal/copy workspace, copy native ID, remove), showing only actions that fit the current state.

**File explorer** ([design](FILE-EXPLORER-DESIGN.md))
- A collapsible right panel with a read-only Files tab that follows the session's workspace, with the project's additional folders as roots, Git decorations (including conflicts and folder summaries), a Changed filter, virtualized lazy listings, and keyboard navigation with type-ahead.
- Read-only preview with line numbers, line selection and search; sensitive, binary, large and non-UTF-8 files are handled without reading what must not be read.
- File and line references for the next task (recorded in receipts as paths and hashes) or a running session (typed only when Claude is known to be ready, otherwise copied), with change detection in the Context Inspector. No editing or file operations.

**Cursor provider** ([providers](PROVIDERS.md))
- Cursor Agent CLI (`agent`) as a third native provider: genuine-CLI detection (Cursor build version and help text; `cursor-agent` and the installers' locations when `PATH` has not caught up), not-installed, not-Cursor, unsupported-version and login-required states, and visible, confirmed installation and sign-in with Cursor's official commands. Journal never handles Cursor credentials.
- Sessions use a chat created with `create-chat` and open it with `--resume=<UUID>` (exact identity at launch and exact resume); Research maps to `--mode=ask` and Plan to `--mode=plan`; context, receipts, worktrees, references (always copied, never typed) and up to four mixed-provider sessions work as for Claude and Codex. Hooks are not used, so Cursor activity is unknown.
- Checked with an authenticated Cursor CLI 2026.10.01 on macOS: chat creation, first turn, exit hint and exact resume. **Manual validation remaining** in Journal's UI: the steps in [PROVIDERS.md](PROVIDERS.md#manual-validation-remaining-cursor-needs-the-users-cursor-login).

**Packaging and releases** ([releasing](RELEASING.md))
- macOS arm64 DMG (drag to Applications) and ZIP, Windows x64 per-user installer and portable EXE, from one version source (`package.json`, now `0.2.0-alpha.3`), with `SHA256SUMS.txt` and third-party notices. A package audit (allow-list) and a packaged smoke test (fixture CLIs) run on the built apps; the tag-triggered workflow creates a draft GitHub Release only. macOS packages are validated locally; Windows packages are built and smoke-tested by the release workflow on hosted Windows runners. macOS release builds are signed with a Developer ID and notarized; Windows builds are unsigned.
- Automatic updates (electron-updater, GitHub Releases feed) from 0.2.0-alpha.2: background download, **Restart to update** on request (never automatic), running-session choice before install, automatic checks switchable in Data and backups, Check for Updates… in the application menu, notify-only for the Windows portable build. Unit- and window-tested; an end-to-end update needs two published releases and is pending.

**Workspaces**
- Current checkout, Journal-managed worktrees from an explicit base, and imported worktrees, with intent persisted before Git side effects and reconciliation after crashes.
- No force, no stash, no transfer of uncommitted work. Removal refuses dirty, untracked, ignored, locked or in-use worktrees and keeps the branch; imported worktrees are never deleted.
- Context, baselines and diffs follow the session's workspace, and resume reuses it.
- Research mode starts Claude in plan mode or Codex in its read-only sandbox. It is a starting intent, not enforcement: both can be changed natively inside the session.

**Observability** ([providers](PROVIDERS.md))
- Claude per-launch hooks report status, permission waits, redacted Bash commands with working directory, exit code and duration, and edited paths. Codex activity beyond Journal's own events is unknown.
- Activity view with a test-command exit summary (exit status only) and a virtualized timeline. Changes view against the session's starting commit with safe diffs and Open-or-reveal.

**Knowledge**
- Reviewed claims with evidence, immutable revisions and receipts, checkout and exact-branch scope, freshness checks, and orientation briefs.
- Status-update helper with Git-range evidence, drift and age.
- Stemmed, alias-aware retrieval; area-segment relevance; duplicate suppression; conflict flags and warnings; category diversity; pinned rules; per-task leave-out; mark incorrect; superseding; branch-to-all-branches promotion proposals; environment qualifiers; selection reasons.
- Context inspector: task, checkout, route, what is not observable, each claim with reason, size and source, exclusions, and the exact text.
- Proposal inbox from explicit rule lines, passing test commands and moved branches. Deterministic, idempotent and review-gated.

**Data and security**
- SQLite (migrations v7): workspaces, proposals, audit, events, pinned claims, project settings and session user fields.
- Integrity-checked online backups, an offline restore script that keeps the previous database, storage and free-space reporting, a clear disk-full error, and a transaction fix that preserves the original SQLite error.
- Versioned Brain export of approved claims (JSON plus Markdown, checksum, redaction) and import (size and schema limits, checksum, candidates only, no automatic branch matching).
- Explicit session purge (refused when other sessions continue the same native conversation, so resume history stays correct) and 90-day timeline retention; knowledge is never pruned.
- Redaction before persistence, logs, hooks and export. Sensitive filenames are hidden. Diffs use literal pathspecs and refuse symlinks.

**Terminal**
- xterm with Unicode 11 widths, bounded per-session buffers (256 KiB) and display credit, gap disclosure, and repaint after reload or runtime reconnect.
- No raw output or keystroke persistence.

**Release and repository**
- Unsigned electron-builder configuration with `Journal-<version>-<os>-<arch>` artifacts and generated `THIRD_PARTY_NOTICES.md`, bundled and verified in a packaged macOS build.
- Staged release workflow with checksums and draft pre-releases; [RELEASING](RELEASING.md).
- CONTRIBUTING, SECURITY, templates, [ARCHITECTURE](ARCHITECTURE.md), [PROVIDERS](PROVIDERS.md) and the [Windows audit](WINDOWS.md).
- Benchmark harness with frozen suites, conditions A–D, Wilson intervals and GO/MODIFY criteria ([BENCHMARK](BENCHMARK.md)).

## UX redesign - Phase 0 (bug fixes)

Branch `claude/ux-redesign`; the plan is [docs/superpowers/plans/2026-10-04-ux-redesign.md](superpowers/plans/2026-10-04-ux-redesign.md). Phase 0 fixes six bugs before any redesign work:

- Previewing context no longer writes a receipt; the panel hides the receipt ID and immutability note for previews.
- Repo overview drafts survive very large repositories: a top-level listing without counts and a note replace the full scan, non-ASCII names are listed correctly, and dot-directories come last.
- Suggestions from a purged session can still be accepted. Purge detaches the session's suggestions (open, accepted and dismissed, keeping their state and note link) and scrubs the session ID from their notes and event link; notes remembered before a purge keep their original text because revisions are immutable.
- Claude's Needs approval state clears only when the prompt was actually answered: the asking tool completes, or the user answers in Journal's terminal with an answer key (digit, Enter, Esc, Ctrl+C) or Journal's Interrupt; pasted text never counts. Answering the only open prompt shows Working at once; with several open prompts (up to 100 are tracked), each answer settles one prompt at the next tool event. Parallel tools and subagents no longer hide an open prompt, provided Claude reports each tool's start before its permission request (to verify natively).
- Released builds have no Reload or DevTools in the View menu; `JOURNAL_DEVTOOLS=1` restores DevTools for support.
- Branch suggestions are remembered on the branch they came from (including worktree sessions) and refused if that branch was deleted or the suggestion has no branch. Revising or approving a branch note from another branch is refused with a message naming the branch.

Native checks still open (fixtures only so far; see [NATIVE-VALIDATION](NATIVE-VALIDATION.md) "To verify"): Working after approving a Bash permission in authenticated Claude Code; whether Claude fires PreToolUse before PermissionRequest for the same tool; whether `PermissionRequest` carries `tool_use_id` and `tool_input`; hook events after a denial with feedback; whether subagent hooks share the parent `session_id`; whether Claude shows a second permission prompt before the first is answered; whether Esc or Ctrl+C on a permission fires a hook.

Known follow-up (Phase 6): branch notes for a worktree's branch cannot yet be approved from the main checkout.

## UX redesign - Phase 1 (foundation)

Plan: [docs/superpowers/plans/2026-10-04-ux-redesign-phase-1.md](superpowers/plans/2026-10-04-ux-redesign-phase-1.md).

- Design tokens for both themes in `src/ui/tokens.css`; `styles.css` uses tokens only and the light theme comes from them. Every text color is at least 4.5:1 on every surface (tested), and the terminal takes its colors from the same values.
- JetBrains Mono (OFL-1.1, from `@fontsource/jetbrains-mono`, Latin and Latin Extended, 400/500/600 including italics) is bundled for code, paths, IDs and the terminal. Font subset decision: box-drawing, block and Braille glyphs are not in those subsets and fall back to the system monospace font (risk R1); the full font is reconsidered after real sessions. The app waits up to 1.5 s for the font; a terminal opened before it loads starts on the fallback stack and re-measures and refits once both weights have loaded.
- Nothing renders below 11 px; one 2 px focus ring on `:focus-visible` (an outline everywhere, so it survives forced colors; rows in scrolling lists draw it inside their edge); themed scrollbars; one input border token.
- Plain vocabulary (`src/ui/copy.ts`): Project memory, notes, Remember, Forget…, Continue, Stop, Read-only, Separate copy (worktree), What was sent. Core reasons and warnings are mapped in the renderer; receipt and packet text is unchanged. Technical terms stay in tooltips.
- Provider marks (Simple Icons, CC0) next to provider names, with attribution in the third-party notices. Open item D9a: the OpenAI mark (used for Codex) comes from Simple Icons 15.22.0 because later releases removed it; check the OpenAI brand page and the source before a release.
- App shortcuts are routed in the main process and work while the terminal has focus (BUG-7), and the router steps aside while a dialog is open (the renderer reports dialog state). Button labels, tooltips and `aria-keyshortcuts` show the same keys (the application menu does not list them). macOS: Cmd+N, Cmd+O, Cmd+1-4, Shift+Cmd+K, Cmd+E, Cmd+I, Option+Cmd+1-3. Windows and Linux: Ctrl+Shift+N, Ctrl+O (outside the terminal), Alt+1-4, Ctrl+Shift+K, Ctrl+Shift+E, Ctrl+Shift+B, Alt+Shift+1-3. Other terminal keys (Ctrl+C, Ctrl+R, Ctrl+O, Alt+letter…) go to the terminal; standard window keys such as Cmd+W (Ctrl+W on Windows and Linux) still belong to the app menu. Slot shortcuts are ignored while a switch is in progress.

Still open: the Windows items in [WINDOWS](WINDOWS.md) (shortcut pass, Alt menu-bar focus, ConPTY keys) need a real Windows machine; the Linux Ctrl+O desktop check runs for the first time in CI; the box-drawing check against real Claude Code and Codex sessions has not been done (fixtures only). The three-row terminal at 900x640 is fixed in Phase 3.

## UX redesign - Phase 2 (honest session model)

Plan: [docs/superpowers/plans/2026-10-04-ux-redesign-phase-2.md](superpowers/plans/2026-10-04-ux-redesign-phase-2.md).

- Stable slots: the runtime gives each live session a slot (1-4) that it keeps until it ends, across renderer reloads and when another session stops; the slot shortcuts (Cmd+1-4, Alt+1-4) follow these slots. A fifth start is refused with the `SLOTS_FULL` code, which crosses the preload bridge with the other error codes. Runtime protocol 4.
- Honest per-provider states (`sessionState.ts`): Claude reports Working, Needs approval (with the redacted command or path it asks about) and Your turn through its hooks; Codex and Cursor report no state, so Journal shows Running with the time of their last output ("output just now", "quiet 2m") and marks the status as limited, with a tooltip saying Journal sees output, not the agent's state.
- Next needs-you (Cmd+J, Ctrl+Shift+J on Windows and Linux; Ctrl+J stays with the terminal) jumps to the next session waiting for approval, then orphaned ones.
- Notifications: one OS notification per approval episode while the window is unfocused, with the session name (credentials redacted) and, only if the user opts in, the command. Clicking it selects that session, except while a dialog is open. The macOS Dock badge and the Windows taskbar flash count sessions waiting for approval and orphaned sessions. Headless test runs never reach the OS notification, badge or taskbar. The two preferences (notifications, include the command) are stored in `preferences.json`; they started as application-menu checkboxes and moved to Settings in Phase 3.

Native checks still open: see [NATIVE-VALIDATION](NATIVE-VALIDATION.md) "To verify" (packaged notifications and badge on macOS and Windows, the Windows portable build's toasts, Codex and Cursor idle repaints).

## UX redesign - Phase 3 (shell)

Plan: [docs/superpowers/plans/2026-10-04-ux-redesign-phase-3.md](superpowers/plans/2026-10-04-ux-redesign-phase-3.md). Boards B4, B10 and B11; fixture-only, no new provider behaviour.

- Sidebar: a project switcher (native menu: open, switch, pin order with a `Pinned` label, manage; it lists projects even when none is open, at most 28 because main caps menus at 40 items and 40-character IDs) with the current branch; New session; Active sessions by slot with a 4-slot meter; Recent grouped by day; Archived on request; a footer with Project memory (suggestion count in the accent colour), Settings and the runtime line. Right-click on the switcher acts on the current project.
- Settings (Cmd+, / Ctrl+,, also the app menu on macOS and the File menu elsewhere) holds Appearance, Notifications (the Phase 2 preferences, which left the menu), Updates and Data and backups.
- The main column has two views. New session holds the previous launch bar (task, references, Start buttons, Preview context, workspace and modes) and stays available with all four slots in use, where Start is disabled and says why. Session shows a header (title, provider and CLI version recorded at launch, workspace, mode, start time, state, Interrupt, Stop, Continue, Archive and a menu), Claude's attention banner, the terminal and a status bar (what was sent, changes since start, update notice, "Native permissions · Output not saved").
- Inspector with three tabs: Session (what the agent knows, then what it did: Claude's commands, edits and approvals from hooks; Codex and Cursor say their activity is not visible and keep "Show full timeline"), Files (Changed since start or All files; the explorer's own filter is now "Uncommitted") and Memory. Cmd+Option+1-3 / Alt+Shift+1-3 select tabs.
- Layout modes: wide (1440 px and over) docks a 264 px sidebar and a 384 px inspector; medium (1180-1439 px) keeps a 248 px sidebar and folds the inspector into a 44 px rail; narrow folds both into rails. Rail buttons open an overlay that never refits the terminal; Esc closes it only from inside, a pointer press elsewhere closes it too. Cmd+I / Ctrl+Shift+B toggles the inspector and Cmd+\ / Ctrl+Shift+\ the sidebar (Ctrl+\ stays with the terminal). Nothing here animates.
- Fixes found while finishing the phase: stored and live timeline events share a timestamp so they no longer show twice; the timeline is fetched again when the session's status or the runtime connection changes, so a runtime crash shows "Recovered after the runtime stopped"; the Changed view refreshes when shown and after Claude command-end events (shell commands change files without a file event); the update notice sits in the sidebar footer whenever no status bar is shown.
- Fixture results (local macOS): at 900x640 the terminal keeps at least 10 rows and at 1280x800 at least 100 columns, and opening the overlay does not refit it. Two long desktop specs have 120 s timeouts.

Native checks still open: see [NATIVE-VALIDATION](NATIVE-VALIDATION.md) "To verify" (the banner's command from a real `PermissionRequest`; Windows Settings and sidebar keys and the default window size).

## UX redesign - Phase 4 (composer)

Plan: [docs/superpowers/plans/2026-10-04-ux-redesign-phase-4.md](superpowers/plans/2026-10-04-ux-redesign-phase-4.md). Core (Group A) and the composer UI (Group B, below); fixture-only, no new provider behaviour.

- Spec amendments D3 and D4 are applied in Phase 4 (delegated by the user); master Phase 9 now applies only D1 and D2. D3: hashes are never cached across previews; the typing preview (`previewSelection`) reads SQLite only (no Git, no evidence reads, no writes) and shows notes as not yet checked, a full validating preview runs after about one second of idle and stores nothing, and a launch validates again. D4: the spec names the 24-term limit of `queryTerms`.
- `previewSelection` selects through the same stages as `prepareContext` (shared `selectCandidates` and `assemblePacket`), from stored records and the renderer's branch hint. Reference roots follow `resolveReferences`' rules from stored records (primary unless `root:`, a primary path from another copy is refused with the same message). Tests pin two literal packet snapshots (a checkout session, and an additional-folder session with a drifted branch update, an environment qualifier and the brief-limit and missing-brief warnings), show that the preview works with Git removed from `PATH`, that SQLite's change counter does not move, and that it selects what `prepareContext` selects when every source is current, for checkout, additional-folder and worktree sessions. It is about three times faster on a 600-note fixture (about 7 ms against 22 ms, local macOS).
- Receipts record the searched terms, and each selected note records the searched terms FTS matched (`selection.terms`, porter stemming, no prefixes; briefs none). Searched terms come from the task text and the referenced paths, so a term may be a path word absent from the task. Packets, `selection.reason` and older receipts are unchanged.
- `queryTermSpans` (renderer-safe `retrieval.mjs`) gives the UTF-16 ranges of every searched term in the task text, for underlines.

Group B, the composer (boards B5 and B13):

- New session is the composer: a task box, agent cards, a Build / Plan / Read-only switch with one line of help, the workspace with Manage, and one Start button ("Start Claude Code", Cmd+Enter on macOS and Ctrl+Enter elsewhere, handled in the form and ignored during IME composition). The three Start buttons, Preview context, the mode checkboxes, the provider line and the empty-terminal art are gone.
- Agent cards are radios (arrows, Home, End). They show the version and only what Journal knows: "Signed in" appears only with Cursor's own sign-in check, never for Claude or Codex (Phase 7 adds their `auth status`). Missing or signed-out agents stay selectable; Cursor's card offers Install… or Sign in…, and Cursor's status row shows below the cards while Cursor is chosen. The choice is remembered on this computer (`journal-agent`); the default is the first available agent.
- The mode never changes on its own. Choosing Codex with Plan selected keeps Plan, marks it unavailable and disables Start with "Codex has no plan mode. Choose Build or Read-only."; Cursor without `--mode` support blocks Plan and Read-only the same way. Launch flags per mode equal the previous `plan`/`research` flags; resume is unchanged.
- Start waits, and says why beside it, while the runtime reconnects, all four slots are taken, the agent is missing or needs sign-in, or the mode is unavailable. A start refused with `SLOTS_FULL` or `PROVIDER_MISSING` says so beside Start (and Cursor is checked again); other failures keep the error banner.
- "What the agent will know" sits beside the form (stacked under it below 760 px; 320 px wide in a narrow main column). It asks for `previewSelection` 250 ms after typing stops (one request in flight; a change meanwhile sends one more after the reply) and for a full check (`prepareContext`, nothing stored) after 1 s idle; tickets drop replies older than the newest input, and the full check wins over a selection reply for the same input. Inputs are exactly what Start sends (task, workspace, left-out notes, references). The meter shows notes of 12 and kilobytes of 6, with ≈ and "Sources are checked when you start" until the check, then "Sources checked". Notes are grouped as Every session knows and Relevant to your task, with "No remembered note matches this task yet." or, with no remembered task notes, the first-session copy. Not included lists counts by reason (out of date, other branch, left out by you · Restore). Inspect all runs the full check now and shows it in the inspector's Session tab; a preview shown there follows later checks, and leave-outs in either place are one state.
- Leave out: Backspace or Delete on a focused note (one tab stop per list, arrows move), or its Leave out button (revealed by hover or focus on fine pointers). Leave-outs and restores apply at once and ask for a new preview immediately. Preview errors (for example a credential-shaped task) show inside the preview, never in the global banner.
- The task box underlines the words the latest preview matched (`selection.terms`) on an aria-hidden mirror under the textarea; spans come from `queryTermSpans` on the current text, so an underline never lands on the wrong characters, and IME composition keeps the last underlines. The box grows from 3 to 8 rows, then scrolls with its mirror. Resting the pointer on an underline for 300 ms opens a non-modal card with the notes matching that word (fine pointers only); "N notes match" under the box opens the same card from the keyboard (Esc closes it and returns focus). Notes in the card and the preview are Phase 5's `NoteCard`; before the full check a file note says it is checked when you start, never that its file is unchanged.
- Motion: only the Start button's press (scale 0.97, 120 ms, none with reduced motion). Underlines, the card, the list and the meter never animate. Hover styles are gated to fine pointers.
- Tests: `tests/composer.test.mjs` (7), `tests/task-mirror.test.mjs` (4) and `tests/preview-scheduler.test.mjs` (6, including a request that never answers) cover the rules, the mirror segments and the scheduler; `tests/desktop-composer.spec.ts` (12) covers typing without receipts, underlines and the hover card, keyboard access to the card, the Codex Plan block, Cmd/Ctrl+Enter, Backspace and Delete leave-outs (focus stays in the preview), honest cards, the first-session state, Inspect all, preview errors, mirror alignment (wrapping, scrolling, right-to-left) and the 900x640 window. Desktop specs start sessions through `startSession` / `chooseMode` and inspect context through Inspect all.
- Fixture results (local macOS, 4 October 2026, with Phase 5's NoteCard seam merged): `npm test` 479 passed; `npm run check` and `npm run build` passed; `npx playwright test` 54 passed and 1 skipped (the Windows/Linux-only Ctrl+O test), twice in a row (2.9 and 3.0 minutes). Headless screenshots at 1440, 1024 and 900 px in both themes match boards B5 and B13 apart from the deviations below.
- Deviations: the inspector stays docked beside the composer (decision 3), so at 1440 px the preview is 320 px and the agent cards stack their contents; Phase 5's NoteCard names its button "Leave out" (the inspector's preview keeps "Leave out for this task") and each row's button is a tab stop besides the row; the hover card sits under the hovered word's line rather than lower; "+ Reference @" is Phase 8.

Native checks still open: see [NATIVE-VALIDATION](NATIVE-VALIDATION.md) "To verify" (each mode with real CLIs, the Cursor card against `cursor-agent status`, Windows Ctrl+Enter and Delete, the mirror under ClearType and Windows scaling).

## Observed validation (local macOS)

| Check | Result |
| --- | --- |
| `npm test` | 455 passed (4 October 2026, Phase 3 branch with Phase 6 core merged) |
| `npm run check`, `npm run build` | Passed (the large-chunk warning remains: the main chunk is now 716 kB) |
| `npm run test:desktop` | 42 passed, 1 skipped (the Linux-only Ctrl+O check), twice in a row (headless, 4 October 2026, Phase 3 branch after the review fixes): real Electron, runtime and node-pty with fixture CLIs, covering the sidebar, Settings, the session header and status bar, the inspector, layout modes and small windows, notifications, updates, four sessions, reload, app and runtime crash, keep-running quit, leftover cleanup, worktree creation, research mode, Unicode and ANSI, leaving a claim out, the status helper, external branch switches, project management, right-click menus, the file explorer, keyboard shortcuts while the terminal has focus (slots, focus, new session, panel tabs) and the Cursor provider (install, sign-in, launch, resume) |
| `npm run dist:dir` | Observed 4 October 2026 on an Apple M4 Pro (arm64), macOS 27.0.1, with `DEVELOPER_DIR` set to Xcode (needs Xcode 26 or later, see [RELEASING](RELEASING.md)): the unsigned app builds; `release:audit` passes (301 packed and 54 unpacked files, including the bundled JetBrains Mono font files); `smoke:packaged` passes |
| GitHub Actions | Active since 4 October 2026 (the `workflow` scope was granted): fixture CI on macOS, Linux and experimental Windows; results per GitHub Actions |

Earlier authenticated evidence ([native validation](NATIVE-VALIDATION.md), [lifecycle follow-up](LIFECYCLE-AND-MEMORY-VALIDATION.md)) predates the runtime split; authenticated providers have not been rerun under the runtime or in worktrees. The [usefulness trial](USEFULNESS-TRIAL.md) round 1 was inconclusive (MODIFY).

## Blocked or deferred

| Item | Status | Reason | Next human action |
| --- | --- | --- | --- |
| Windows validation, Job Objects | BLOCKED | No Windows hardware; Job Objects need a native module | Run the [Windows checklist](WINDOWS.md) on Windows 11 |
| Signing and notarization | BLOCKED | Needs an Apple Developer ID and a Windows code-signing certificate | See [RELEASING](RELEASING.md) |
| Usefulness round 2 | BLOCKED | Needs a chosen repository, tasks and paid runs | Create a suite from `benchmarks/TEMPLATE.md` |
| Authenticated rerun under the runtime | DEFERRED | Requires the user's interactive provider sessions | Repeat `NATIVE-VALIDATION.md` trials in Journal |
| Model-assisted extraction | DEFERRED | Must not add hidden provider calls; needs an explicit provider and cost decision | Decide provider and budget; design is in IMPLEMENTATION-PLAN Phase 7 |
| Changed-path and diff-based proposals; evidence-grade ranking | NOT STARTED | Lower value than the delivered inbox and controls | — |
| Public pilot | BLOCKED | Needs real users | — |

Historical full roadmap and phase status: [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md).
