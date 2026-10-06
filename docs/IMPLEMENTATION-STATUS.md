# Journal implementation status

5 October 2026. Alpha; no public release.

## Summary

**What shipped.** Before the redesign, `main` received the terminal-first slice, native validation, orientation and licensing, branding and layout, and the durable multi-session runtime (PRs #1-#5); `claude/roadmap-completion` added worktrees, the proposal inbox, data maintenance, release groundwork and the benchmark harness (see [Implemented before the redesign](#implemented-before-the-redesign)). The UX redesign ([plan](superpowers/plans/2026-10-04-ux-redesign.md)) is complete on branch `claude/ux-redesign`, Phases 0 to 9:

- six bug fixes (Phase 0) and a foundation of design tokens for both themes, a bundled monospace font, plain vocabulary and app shortcuts that work while the terminal has focus (Phase 1);
- honest per-provider session states, stable slots, Next needs-you and approval notifications (Phase 2);
- the shell: sidebar, Settings, session header and status bar, a three-tab inspector and wide, medium and narrow layouts (Phase 3);
- the composer with agent cards, Build / Plan / Read-only and a live preview of what the agent will know (Phase 4);
- memory trust: where a note came from, whether its file still matches and how many sessions it was sent to (Phase 5);
- the wrap-up when a session ends: suggestions, the out-of-date catch, Continue and hand-off (Phase 6);
- first run: Welcome, agent rows with install and sign-in, Getting to know your project, the first-note moment (Phase 7);
- the command palette, open-file and the failure states: runtime banner, crash recovery, "can't start" and slots full (Phase 8);
- polish and verification: Git environment isolation, reload, keyboard walkthroughs with accessibility audits, motion and performance checks, docs, packaging, terminal colours, test isolation from real provider CLIs, and (part 2) the palette and failure states' accessibility pass and a recovery page for a crashed window (Phase 9).

No provider argv, native setting or permission, exact-ID resume, reviewed evidence or immutable receipt contract changed. Everything was accepted with fixture CLIs.

**Tests** (local macOS, Node 25.6.1, 5 October 2026, branch `claude/ux-redesign-p9b`): `npm test` 640 passed; `npm run check` and `npm run build` passed; the full `npx playwright test` 144 passed and 1 skipped (the Windows/Linux-only Ctrl+O check), exit 0, twice in a row (7.3 minutes each), headless, after the review fixes. Every desktop spec builds its environment with `fixtureEnv` and `tests/isolation.test.mjs` passes, so no test reached a real provider CLI, login or provider request.

**What still needs a human** (the checklist is [NATIVE-VALIDATION](NATIVE-VALIDATION.md#to-verify) "To verify"):

- real, signed-in Claude Code, Codex and Cursor sessions in the redesigned app: approvals and the banner's command, hook order, sign-in and install flows, crash recovery and Continue, terminal colours;
- Windows 11 hardware: the [Windows checklist](WINDOWS.md), Ctrl+Shift and Alt keys, toasts, High Contrast and scaling;
- VoiceOver and NVDA by ear (names and live regions were checked in the DOM, not spoken);
- usability round 2 with real people on the built app (the board B15 script plus terminal feel and real approvals);
- packaged builds: notifications and badge, the Windows portable build's toasts, an end-to-end update across two releases, Windows code signing;
- the open brand item D9a (the OpenAI mark used for Codex comes from an older Simple Icons release);
- reviewing and merging `claude/ux-redesign` into `main`, which has moved on since (for example PR #19's licence change).

Verification uses local checks on the user's Mac and fixture-only GitHub Actions (CI on macOS and experimental Windows, Linux dropped on 5 October 2026; packaging and smoke tests on macOS and Windows). CI never uses provider logins. Authenticated native trials and usefulness benchmarks are manual and local.


## Branch switcher (5 October 2026, branch `claude/branch-switcher`)

Requested by the user: change branch, see and search every branch, and handle projects with several repositories.

- **One repository at a time.** The picker opens on a repository root by its key: the checkout, a ready worktree or an added Git folder (`root:<id>`). Its title names the repository; a **Repository** list (shown when the project has more than one working tree) switches between them, each with its current branch. Worktrees of the primary repository are separate working trees and listed separately.
- **Listing** (`src/core/branches.mjs`): `git for-each-ref` with a NUL-separated format, most recent commit first, at most 2000 local and 2000 remote refs (it says when it cut). Local branches first (current first), then remote-tracking branches no local branch tracks; `origin/HEAD` is left out. Each shows ahead/behind and the last commit's age; a branch checked out in another worktree is shown but unavailable and names that worktree when Journal knows it (from `git worktree list --porcelain`).
- **Switching**: `git switch --no-guess <branch>`, or `git switch --no-guess -c <name> --track <remote>/<name>` for a remote-only branch after a confirmation. Never `--force`, `--discard-changes`, `--merge`, stash, reset or clean. Refused, with the tree untouched, when a session (starting, running, waiting, stopping or orphaned, of any project) runs in that working tree (by record or by its cwd's Git top level), when the branch is in another worktree, when a local branch of a remote branch's name already exists, and when Git refuses (changes that would be overwritten, untracked files in the way, a merge in progress), in plain words. Detached HEAD shows and can switch to a branch. Each switch is audited (`branch-switched`); the stored checkout and worktree records follow, and main clears its root and file-listing caches.
- **Interface.** The Files tab's branch button beside the root picker, **Switch Branch…** on a Git root's context menu, the branch in the session header (for the checkout or a worktree) and **Switch branch…** in the command palette. Same combobox and listbox pattern as the palette (one tab stop for the list, `aria-activedescendant`, Enter waits for a list still loading, Escape returns focus); no animation. After a switch the project, workspaces, Files roots and notes reload, and the result is announced.
- **Tests.** `tests/branches.test.mjs` (real repositories with a bare origin, worktrees and an added Git folder), `tests/branch-model.test.mjs` (filtering, grouping, keys) and `tests/desktop-branches.spec.ts` (keyboard search and switch across repositories, tracking-branch confirmation, Git's refusal, refusal while a session runs). Windows not run locally.

## Codex and Cursor lifecycle hooks (5 October 2026, branch `claude/provider-hooks`)

Plan: [2026-10-05-codex-cursor-hooks.md](superpowers/plans/2026-10-05-codex-cursor-hooks.md). Uncommitted at the time of writing.

- **Shared observer.** Provider adapters (`src/runtime/adapters/`) register per-launch hooks and normalize payloads. One launcher at `<data>/hooks/journal-hook` runs every hook, always exits 0 and prints only the neutral response (nothing, or `{}` for Cursor); per-launch target and token travel in the environment, so the command is the same for every launch (Codex trusts hooks by their definition).
- **Turns and identity.** Events bind to the launch, the native ID and the turn (Codex `turn_id`, Cursor `generation_id`). Late, duplicate and out-of-order events never finish a newer turn; one outcome per turn (interrupted > error > completed, no time window); children never bind identity, end the parent's turn or clear its approval wait.
- **Observation state.** `observation` (pending, live, unobserved, lost) with `lastObserved`. Silence never marks observation lost; unavailable needs positive evidence. On exit and on a quit that stops sessions, the observer drains final events (Codex can first report its ID in SessionEnd) within a bounded deadline; drained events record only identity and the clean end.
- **Codex.** `-c hooks.<Event>=…` per event from 0.131 (events by version), skipped when `codex features list` shows hooks off; the first launch shows Codex's own hook review. States: Working, Needs approval, Your turn, interrupted.
- **Cursor.** A per-launch plugin (`--plugin-dir`, `"version": 1`) when the CLI lists the flag: activity and the clean end. **Cursor turn status** in Settings shows the exact change to `~/.cursor/hooks.json` (entries for `stop` and `afterAgentResponse`) and makes it only on confirmation; Remove takes out only Journal's entries. Approval waits are not observable.
- **Interface.** Session states, Needs you, the approval banner and notifications follow what each session's hooks report (`observes`); the composer explains how Journal follows Codex and Cursor.
- **Tests (fixture only).** Adapter mapping and hygiene, launcher safety, turn rules, observation transitions, the exit and shutdown drains, Codex and Cursor end to end through the runtime with fixture CLIs, the reviewed Cursor file change, and the Settings flow against a fixture home. `tests/isolation.test.mjs` now also forbids Electron's home path, which ignores `HOME`.
- **Native.** Observed on 5 October 2026 with Codex 0.159.3 and Cursor 2026.10.01 in a throwaway repository (plan section 3); the integrated feature itself is not yet checked natively (see NATIVE-VALIDATION.md, To verify).

## Implemented before the redesign

**Runtime and sessions** ([architecture](ARCHITECTURE.md))
- A detached local runtime (Electron in Node mode) owns all PTYs and native CLIs. It sits behind a local socket or named pipe with HMAC challenge-response, an exclusive lock and launch caps.
- Up to four concurrent sessions, with per-session input, output, flow control, receipts, versions and attention markers.
- Renderer reload, a crashed window (Reload on its recovery page, Phase 9), app crash and keep-running quit leave sessions running and are rediscovered. A runtime crash recovers sessions as interrupted or orphaned (verified or unverified), with uncertain delivery and no resend.
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
- Sessions use a chat created with `create-chat` and open it with `--resume=<UUID>` (exact identity at launch and exact resume); Research maps to `--mode=ask` and Plan to `--mode=plan`; context, receipts, worktrees, references (always copied, never typed) and up to four mixed-provider sessions work as for Claude and Codex. Since 5 October 2026 a per-launch plugin reports Cursor's activity (see Codex and Cursor lifecycle hooks below).
- Checked with an authenticated Cursor CLI 2026.10.01 on macOS: chat creation, first turn, exit hint and exact resume. **Manual validation remaining** in Journal's UI: the steps in [PROVIDERS.md](PROVIDERS.md#manual-validation-remaining-cursor-needs-the-users-cursor-login).

**Packaging and releases** ([releasing](RELEASING.md))
- macOS arm64 DMG (drag to Applications) and ZIP, Windows x64 per-user installer and portable EXE, from one version source (`package.json`, now `0.1.0-alpha`, the first public release; the earlier 0.2.0-alpha.2 and alpha.3 drafts were never published), with `SHA256SUMS.txt` and third-party notices. A package audit (allow-list) and a packaged smoke test (fixture CLIs) run on the built apps; the tag-triggered workflow creates a draft GitHub Release only. macOS packages are validated locally; Windows packages are built and smoke-tested by the release workflow on hosted Windows runners. macOS release builds are signed with a Developer ID and notarized; Windows builds are unsigned.
- Automatic updates (electron-updater, GitHub Releases feed) from 0.1.0-alpha: background download, **Restart to update** on request (never automatic), running-session choice before install, automatic checks switchable in Data and backups, Check for Updates… in the application menu, notify-only for the Windows portable build. Unit- and window-tested; an end-to-end update needs two published releases and is pending.

**Workspaces**
- Current checkout, Journal-managed worktrees from an explicit base, and imported worktrees, with intent persisted before Git side effects and reconciliation after crashes.
- No force, no stash, no transfer of uncommitted work. Removal refuses dirty, untracked, ignored, locked or in-use worktrees and keeps the branch; imported worktrees are never deleted.
- Context, baselines and diffs follow the session's workspace, and resume reuses it.
- Research mode starts Claude in plan mode or Codex in its read-only sandbox. It is a starting intent, not enforcement: both can be changed natively inside the session.

**Observability** ([providers](PROVIDERS.md))
- Claude per-launch hooks report status, permission waits, redacted Bash commands with working directory, exit code and duration, and edited paths. Codex and Cursor report through their own hooks since 5 October 2026 (see Codex and Cursor lifecycle hooks below).
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
- Licensing: source-available under the Elastic License 2.0 since 4 October 2026 (previously Apache-2.0); `package.json` uses the SPDX identifier `Elastic-2.0`.
- CONTRIBUTING, SECURITY, templates, [ARCHITECTURE](ARCHITECTURE.md), [PROVIDERS](PROVIDERS.md) and the [Windows audit](WINDOWS.md).
- Benchmark harness with frozen suites, conditions A–D, Wilson intervals and GO/MODIFY criteria ([BENCHMARK](BENCHMARK.md)).

## UX redesign

Branch `claude/ux-redesign`; the master plan is [docs/superpowers/plans/2026-10-04-ux-redesign.md](superpowers/plans/2026-10-04-ux-redesign.md), with a detailed plan per phase beside it. Each phase was built on its own branch, reviewed independently, fixed and merged; the record below describes the merged result. The UI skills from the local collection (`emil-design-eng`, `review-animations`) were read and applied for every screen. Native checks still open for each phase are in [NATIVE-VALIDATION](NATIVE-VALIDATION.md#to-verify).

### Phase 0: bug fixes

- Previewing context no longer writes a receipt; the panel hides the receipt ID and immutability note for previews.
- Repo overview drafts survive very large repositories (a top-level listing without counts and a note replace the full scan); non-ASCII names are listed correctly and dot-directories come last.
- Suggestions from a purged session can still be accepted: purge detaches them (keeping their state and note link) and scrubs the session ID from their notes and event link.
- Claude's Needs approval clears only when the prompt was answered: the asking tool completes, or the user answers in Journal's terminal with an answer key (digit, Enter, Esc, Ctrl+C) or Journal's Interrupt; pasted text never counts. With several open prompts (up to 100 are tracked) each answer settles one at the next tool event.
- Released builds have no Reload or DevTools in the View menu; `JOURNAL_DEVTOOLS=1` restores DevTools for support.
- Branch suggestions are remembered on the branch they came from and refused if that branch was deleted or the suggestion has none; revising or approving a branch note from another branch is refused with a message naming the branch. Branch notes for a worktree's branch are remembered in the view of a ready separate copy on that branch (Phase 6).

### Phase 1: foundation

- Design tokens for both themes (`src/ui/tokens.css`); `styles.css` uses tokens only. Every text colour is at least 4.5:1 on every surface (`tests/tokens.test.mjs`), and the terminal, the runtime's colour answers and the window background take their colours from the same values.
- JetBrains Mono (OFL-1.1, Latin and Latin Extended, 400/500/600 with italics) is bundled for code, paths, IDs and the terminal. Box-drawing, block and Braille glyphs fall back to the system monospace font (risk R1); the app waits up to 1.5 s for the font and a terminal opened earlier refits once it loads.
- Nothing renders below 11 px; one 2 px focus ring on `:focus-visible` (an outline, so it survives forced colours); themed scrollbars; one input border token.
- Plain vocabulary (`src/ui/copy.ts`): Project memory, notes, Remember, Forget…, Continue, Stop, Read-only, Separate copy (worktree), What was sent. Technical terms stay in tooltips; receipt and packet text is unchanged. `tests/copy.test.mjs` enforces it, with no exclamation marks, emoji or double spaces and first person only in onboarding, empty states and explanations.
- Provider marks (Simple Icons, CC0) next to provider names. Open item D9a: the OpenAI mark (used for Codex) comes from Simple Icons 15.22.0 because later releases removed it; check the OpenAI brand page before a release.
- App shortcuts are routed in the main process and work while the terminal has focus (BUG-7); the router steps aside while a dialog is open. Labels, tooltips and `aria-keyshortcuts` show the same keys. Other terminal keys (Ctrl+C, Ctrl+R, Ctrl+K, Ctrl+P, Alt+letter…) go to the terminal. The table is in the [README](../README.md#keyboard-shortcuts).

### Phase 2: honest session model

- Stable slots: each live session keeps its slot (1-4) until it ends, across reloads and when another stops; the slot keys follow them. A fifth start is refused with `SLOTS_FULL`. Runtime protocol 4.
- Honest states (`sessionState.ts`): Claude reports Working, Needs approval (with the redacted command or path) and Your turn through its hooks; Codex and Cursor sessions show the states their hooks report (see Codex and Cursor lifecycle hooks below); without a live observer Journal shows Running with the time of their last output ("output just now", "quiet 2m") and marks it Limited status.
- Next needs-you (⌘J, Ctrl+Shift+J) jumps to the next session waiting for approval, then orphaned ones.
- One OS notification per approval episode while the window is unfocused (the command only if the user opts in); clicking it selects the session. The Dock badge and the Windows taskbar flash count sessions waiting for approval and orphaned sessions. Headless test runs never reach the OS notification, badge or taskbar. The preferences live in Settings.

### Phase 3: shell

- Sidebar: project switcher (native menu, at most 28 projects listed) with the current branch, New session, Active sessions by slot with a 4-slot meter, Recent by day, Archived on request, and a footer with Project memory (suggestion count), Settings and the runtime line.
- Settings (⌘, / Ctrl+,): Appearance, Notifications, Updates, Data and backups.
- Session view: a header (title, provider and CLI version at launch, workspace, mode, start time, state, Interrupt, Stop, Continue, Archive, a menu), Claude's attention banner, the terminal and a status bar (what was sent, changes since start, update notice, "Native permissions · Output not saved").
- Inspector tabs Session (what the agent knows, then what it did), Files (Changed since start or All files) and Memory, with ⌥⌘1-3 / Alt+Shift+1-3.
- Layouts: wide (1440 px and over) docks a 264 px sidebar and a 384 px inspector; medium keeps the sidebar and folds the inspector into a rail; narrow folds both. Rail buttons open an overlay that never refits the terminal. ⌘I / Ctrl+Shift+B and ⌘\ / Ctrl+Shift+\ toggle them. Nothing animates.
- At 900x640 the terminal keeps at least 10 rows and at 1280x800 at least 100 columns.

### Phase 4: composer

- New session is the composer: a task box, agent cards (radios), Build / Plan / Read-only with one line of help, the workspace with Manage, and one Start button (⌘↵ / Ctrl+Enter, ignored during IME composition).
- Agent cards show the version and only what Journal knows: "Signed in" or "Sign in needed" only when the agent's own status check answered, "Sign-in unknown" when it could not conclude, and one action (Install…, Install page… or Sign in…). The choice is remembered on this computer.
- The mode never changes on its own: Codex with Plan disables Start with "Codex has no plan mode. Choose Build or Read-only."; Cursor without `--mode` support blocks Plan and Read-only. Launch flags per mode equal the previous `plan`/`research` flags.
- Start waits, and says why beside it, while the runtime reconnects, all slots are taken, the agent is missing or needs sign-in, or the mode is unavailable. After `PROVIDER_MISSING` the composer checks that agent again.
- "What the agent will know": `previewSelection` 250 ms after typing stops (SQLite only: no Git, no evidence reads, no writes) and a full check (`prepareContext`, nothing stored) after 1 s idle, with tickets so a stale reply never wins. Notes are grouped as Every session knows and Relevant to your task, with a meter, Not included by reason and Inspect all. It stacks under the form below 764 px; beside it the form keeps at least 420 px (a layout regression with wide stored panels was fixed and has a test).
- Leave out: Backspace or Delete on a focused note, or its button; one roving tab stop per list. Live regions (the preview error, the reason beside Start, "N notes match") stay mounted and only their text changes.
- The task box underlines the words the latest preview matched (`selection.terms`, `queryTermSpans`), on an aria-hidden mirror; a hover card (fine pointers) and "N notes match" (keyboard) show the matching notes.
- Spec amendments D3 (no hash cache across previews; the typing preview reads SQLite only) and D4 (the 24-term limit) were applied here; receipts record the searched terms per note. `previewSelection` is about three times faster than `prepareContext` on a 600-note fixture.
- Motion: only Start's press (scale 0.97, 120 ms; never for a keyboard press since Phase 9). Rendering is memoized so terminal events do not re-render the composer.
- Deviations: the inspector stays docked beside the composer; the hover card sits under the hovered line; Add reference… (Phase 8) shows no key.

### Phase 5: memory trust

- Migration v8: `approved_at`, `approved_revision`, a `deliveries` table written when a receipt first moves to `submitted` or `uncertain`, and indexes for linked suggestions. `memoryOrigins`, `deliveryCounts` and `memoryChecks` answer where a note came from, how many distinct conversations it was sent to (resumes count once; previews and failed launches never count) and which notes' files changed.
- `NoteCard` shows a note everywhere (Memory, the Session tab, the composer, the wrap-up): its origin ("You remembered this today, from the session '…' ›"), what a file note is based on and whether the file still matches ("file unchanged since you saved it", or amber "Check needed · file changed"), and "Sent to N sessions". A removed session never shows its title.
- Memory tab: search and Add, category chips with counts, status tabs, Check needed (scanned in 50-note chunks on one app-wide queue, at most one call in flight, capped at 1000) and Other branches. Filters reset when the project changes.
- Nothing animates; hover styles are behind `(hover: hover) and (pointer: fine)`; forced colours keep pressed chips visible.

### Phase 6: session end

- An ended session (exited, stopped, failed to start or interrupted) opens on a wrap-up in place of its terminal: how it ended and after how long, the notes the session put out of date, suggestions, Changes, Tests run, Continue this conversation and the hand-off row. Show terminal brings the read-only terminal back.
- One-click Remember (decision D1) on a suggestion whose whole statement is on screen; Remember all (2 to 5) is one atomic call; Edit… opens the note form; Dismiss waits 10 s with Undo. Nothing is remembered without a click.
- The out-of-date catch shows each remembered note on a file the session changed, with the change in the note's own line numbers and Update note… / Still true / Forget…. Still true is staged for 10 s with Undo and sends the file hash that was shown (`expectedHash`); a cut change keeps Still true disabled until the whole change from the note's own base is shown (`staleNoteDiff`). Cards are keyed by note and file hash. Focus moves to Undo (or the resolved line) when a card resolves, and Undo returns it to Still true, or to the card's heading when Still true can no longer be pressed.
- Continue (⌘↵ / Ctrl+Enter) needs a confirmed conversation ID without a mismatch; ⇧⌘↵ / Ctrl+Shift+Enter is Remember all. The keys act only with focus in the wrap-up or nowhere, with no dialog or IME composition.
- An error exit (non-zero code, a signal, a failed start) leads with the last output in a read-only terminal and Copy output; node-pty reports a kill as exit code 0 with a signal, so a signal counts as an error and is named.
- Hand-off (D12): one button per other ready agent, and New session with this task, fill the composer with the task, references, mode (never raised), workspace and the chosen agent. Nothing starts.
- No entrance or resolution animation. Deviations: suggestions use board 6's row layout rather than `NoteCard`; the error panel carries Show terminal and Continue.

### Phase 7: first run

- Provider detection starts when main loads and never delays the runtime or the first window; each provider is checked once at a time, and again after an install or sign-in ends. Install and sign-in run constant commands from `PROVIDER_COMMANDS` in a visible terminal, only after the user asks (POSIX installs under `bash -o pipefail`). The Cursor runner moved to the shared `runFile`: stdin ignored, a timeout ends the whole process group or tree.
- Welcome (board 1): the mascot, **Open a project…** (⌘O / Ctrl+O), the three agent rows ("Signed in" only after a clean probe; one action each; Check again reads Checking… and keeps focus) and the local-only line. A folder dropped on Welcome or the sidebar opens like the open dialog; Windows network paths are refused.
- Getting to know your project (board 2): offered once per project after the project renders; two cards with the whole draft and **Working on now**, **Next** and **Rules to keep** (and **Purpose** when the README has no purpose line); **Remember both** sends exactly what the cards show and is refused if HEAD or the branch moved (with **Draft again**). The project is marked shown only once the screen has painted.
- First-note moment (board 12): once per install, never for an install that had notes; the one budgeted animation (opacity and scale from 0.96 in 280 ms, the mascot tilting from -8°), removed by reduced motion. It never takes focus.
- Sparse states ("No sessions yet.", "A familiar place to work", the Session tab's empty "What it did") and first-person copy only in onboarding.

### Phase 8: palette and failure states

- Command palette (⌘K, ⇧⌘P as an alias; Ctrl+Shift+P elsewhere) and open-file (⌘P; Ctrl+Shift+O). One input, the only tab stop, as a WAI-ARIA combobox over a grouped listbox with `aria-activedescendant`. Groups: Sessions, Quiet sessions to check (Codex and Cursor quiet for 2 minutes, empty query only), Actions (a blocked one keeps its reason) and Project memory. `>` lists actions only. No results offers New session with this task and Add as a note. Nothing in the palette starts a session, approves a note or writes to a terminal; terminal input is held from the key until the dialog is open (an Enter typed straight after never reaches the agent).
- Open-file: `git ls-files` only (never ignored, sensitive paths dropped, no file read, 200,000-file cap that says why it was cut), cached per root for 30 s, refreshed by the watcher, parsed and ranked in slices; it searches the Files tab's current root and its additional folders, previews the chosen file in the Files tab, and from the composer's Add reference… adds it as a reference.
- Runtime banner: "Lost connection to the session runtime" with **Reconnect now** (`RuntimeClient.retryNow()` wakes the pause between attempts and resets the three-launch counter).
- Crash recovery: the runtime reports `recovery` in its hello until `acknowledgeRecovery`; the panel lists the interrupted sessions with Continue (exact resume, only when clicked), Confirm ID… or Review, leftovers, and Done. Nothing is resent.
- "Can't start" card above Start for a missing, unsupported or signed-out agent or a failed start, with Open terminal (or Install…), Copy command and Check again; "Nothing was sent" only where nothing can have been. The runtime resolves the Claude or Codex executable before preparing context, so a missing one records no receipt or session.
- Slots full: "4 of 4 running. Stop or finish one to start another. You can still write the task now."; New session stays available.
- Deviations: `searchFiles` ranks in slices instead of a worker (a query matching every path takes about 70 ms in all, longest block about 12 ms); there is no runtime launch-delay test hook.

### Test isolation (found in the Phase 8 review)

18 of 23 desktop specs used to inherit the real PATH and HOME, and Cursor detection ran without the probe gate, so on the user's Mac some specs ran the real `agent`, `claude --version` or `codex --version` (and two early runs briefly started the installed Codex and Cursor in a fixture project). Since then every desktop spec and launch script builds its environment with `fixtureEnv({ root, bin, extra })` from `tests/support/env.ts` (an allow-listed environment, a fixture-only PATH plus links to node, git, sh, bash, ps, env, sleep and curl, a fixture HOME, no provider variables), `assertNoRealProviders` checks it, and Journal itself refuses in headless runs to probe or launch a provider CLI outside `JOURNAL_TEST_PROVIDER_DIR`. `tests/isolation.test.mjs` enforces it, and [AGENTS.md](../AGENTS.md) has the rule. Uncommitted screenshot helpers in other worktrees' `.cache` folders still spread `process.env`; do not run them as they are.

### Terminal colours and the dev sandbox warning

- Claude Code ignores the light appearance unless its theme is Auto; in Auto it asks OSC 11 and waits for DA1 with no timeout. Journal now answers OSC 10/11/12 in the runtime with its terminal colours as soon as the query is read, answers DA1 only while no window is attached, sets `COLORFGBG` at launch, sends mode-2031 theme reports when the appearance changes, and names itself as the terminal (`TERM_PROGRAM=Journal`). Native settings are untouched; Settings explains how to make Claude follow the appearance. Terminal reports pass while a dialog is open; typed keys are still dropped. A lost renderer (`render-process-gone`) detaches like a reload, so attach counts stay right.
- The macOS `sandbox_extension_issue_file failed` line is printed by macOS's sandbox library, not by Journal; harmless and documented in [CONTRIBUTING](../CONTRIBUTING.md#a-sandbox-warning-on-macos).

### Phase 9 part 1: polish and verification

- Git environment: every Git runner, and the agent's launch environment, drop `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY` and `GIT_COMMON_DIR`, so an inherited value cannot point Journal or the agent at another repository.
- Reload reopens the project that was showing (the shown project is remembered when it renders, and an older refresh that answers late cannot show or remember another project).
- Keyboard walkthroughs (`tests/desktop-keyboard.spec.ts`, `tests/support/a11y.ts`) of the three board B15 tasks and of every dialog, with an audit in both themes at each step: every control and region named, text at 4.5:1 (3:1 large), a focus ring that changes against `blur()`, is opaque and reaches 3:1, and no live region in the terminal. Fixes: focus moves to Undo or the resolved line in the catch; Open a project focuses the task box; ⌥⌘2 / Alt+Shift+2 always moves focus into Files (the keyboard's way out of the terminal, which keeps Tab), without stealing focus later; Claude's attention banner is in a status region that stays mounted.
- Motion (`review-animations`): four motions remain, pinned by `tests/styles.test.mjs` (the first-note entrance and tilt, Start's press, the wrap-up buttons' hover colour); nothing animates on a keyboard action; every hover rule is gated to fine pointers; reduced motion removes all animations and transitions. Verdict: approve.
- Performance (`tests/desktop-performance.spec.ts` on a React profiling build): during a 2 MB/s terminal flood no long animation frame and no live-region change; typing p95 about 2-5 ms; the preview about 300 ms after the last key; 2 `activity` events 5 s apart; the largest React commit per session switch p50 0.4-0.5 ms (target under 16 ms). Timing bounds are asserted only with `JOURNAL_PERF_STRICT=1`; test windows are hidden, so on-screen paint is not measured.
- Docs: README screens, workflow, shortcut table and a fixture screenshot (`scripts/readme-screenshot.mjs`); decision D1 applied to [TERMINAL-FIRST-SPEC](TERMINAL-FIRST-SPEC.md) and [PROJECT-ORIENTATION](PROJECT-ORIENTATION.md) (D2 is not approved: freshness stays file-level); [PROVIDERS](PROVIDERS.md) updated.
- Packaging: `dist:dir` passes with `DEVELOPER_DIR` pointing at Xcode 26; `release:audit` excludes type declarations and fails a React profiling bundle; `smoke:packaged` runs isolated and follows the Welcome screen.

### Phase 9 part 2: palette and states accessibility, window crash, leftovers

Branch `claude/ux-redesign-p9b`. Fixture acceptance only; no contract above changed.

- **Accessibility and keyboard pass** (`tests/desktop-a11y-states.spec.ts`, 4 tests). The audit now also requires names on comboboxes, listboxes and open dialogs, and a dialog, region, section, listbox or combobox counts as named only through `aria-labelledby`, `aria-label` or a `<label>`, never its content (review I3; a spec shows an unnamed dialog, listbox and two comboboxes are reported). The focus check reads the palette search row's ring. Covered: the palette (empty, actions only, no results) and open-file (empty, a match, no match): input named like the dialog, `aria-expanded`, `aria-autocomplete=list`, a description of the keys, a named listbox, every option in a named group, the active option the only selected one and marked by more than text colour, one tab stop, Tab staying in the input, Escape and the toggle key returning focus to the terminal, and no live-region change while the terminal floods behind the palette. Also the runtime banner and Reconnect now, crash recovery (Continue, Confirm ID…, Done), the "can't start" card and slots full, in both themes. Fixes:
  - The runtime banner sits in a status region that stays mounted, so it is announced when it appears; Reconnecting… keeps focus (`aria-disabled`, not `disabled`).
  - The recovery panel stays a region and an always-present status region says once "The session runtime stopped unexpectedly. N sessions were interrupted. Nothing was resent…".
  - When the banner, the recovery panel or one of its rows goes with focus inside, focus moves to the panel's next control or to the session (the terminal, the wrap-up heading or the task box), never to the page. Continue waits with `aria-disabled` while another action runs.
  - The "can't start" card's Check again reads Checking… and keeps focus; when the card goes, focus moves to Start (or the task box). The spec fails without this.
  - The palette's file note ("No file name matches…") is one status region that stays mounted.
- **A crashed window** (`render-process-gone` other than a clean exit or a quit) used to stay blank until Journal restarted. Main now shows a static page (`src/desktop/crash-page.mjs`): "Something went wrong", "Journal’s window stopped unexpectedly; running sessions were not affected." and **Reload**, focused on load. It has no script (its CSP allows inline styles only), uses the chosen appearance with colours kept equal to the tokens (`CRASH_COLORS`, `tests/tokens.test.mjs`), and nothing animates. Reload submits to a reserved `.invalid` address that main's `will-navigate` handler cancels, like every navigation, before loading the app again. Nothing reloads without the user asking, and the page never loads twice without a finished load in between (review fixes below). The lost renderer still detaches first, so the reloaded app reopens the project and reattaches its sessions; nothing is resent. `tests/desktop-renderer-crash.spec.ts` (4 tests with the review fix) crashes the renderer with `forcefullyCrashRenderer` in both themes and checks the page (focus ring, names, contrast, background, no animation), Reload by keyboard, the project and both sessions back, typing reaching the same agent process, an unchanged launch ledger, a second crash, and that other navigations stay refused. `tests/copy.test.mjs` checks its voice, one next step and no script.
- **Leftovers.** The Undo → heading fallback in the catch (part 1, M2) has a spec in `tests/desktop-keyboard.spec.ts`: while Still true is staged, the catch reloads with the same file and now says the note cannot be marked still true here; Undo focuses the card's heading. It fails without the fallback. The status document's other open items were checked: the Phase 6 hand-off now preselects the agent (done since Phase 4); the agent environment's Git variables (done in part 1); the remaining ones need a person or a design decision and are listed under [Blocked or deferred](#blocked-or-deferred).
- **Default agent.** One full desktop run failed the first-run keyboard walkthrough because the composer had chosen Codex: bootstrap answered while Claude Code was still being checked, and later detection never moved the default back. The default now follows detection in agent order (bootstrap and each providers event) until the user takes over, and an agent still being checked holds its place (see review I2 below).
- **Review fixes** (independent review of part 2):
  - I1, the crash page could loop: loading it needs a new renderer, and with `launch-failed`, `integrity-failure` or a sustained out-of-memory that renderer fails too. The decision is now a pure helper (`rendererGoneAction` in `crash-page.mjs`, `tests/crash-page.test.mjs`): the page loads only after a page had finished loading since the last loss and when the lost renderer was not the crash page itself; otherwise (and always for `launch-failed` or `integrity-failure`) a native message box offers Reload or Quit, once at a time. Headless runs never show it (`__journalCrashDialog` answers for a test). A quitting or destroyed window gets nothing. A desktop test crashes the crash page and checks one message box and Reload.
  - I2, the automatic default could switch agents under the user (after a refused start, Claude's error stayed beside "Start Codex"; or the label changed after typing began). `defaultProvider` stops at the first agent in order that is still being checked; the user takes the choice over by choosing a card, starting a session (not a resume) or editing the task box, and a hand-off or a remembered agent counts as chosen; an automatic change clears the start error. `tests/desktop-default-agent.spec.ts` (3 tests, with a Claude fixture that answers `--version` after 2.5 s): the default holds Claude Code and the Start label never names Codex (fails on the previous code); a chosen card, a remembered agent and a hand-off survive later providers events; a refused Claude start keeps Claude chosen with its error, and ⌘↵ starts nothing (fails on the previous code).
  - I3: the audit names containers only by `aria-labelledby`, `aria-label` or a `<label>` (above); every real screen passed it unchanged.
  - M2: waiting buttons with `aria-disabled` (Reconnecting…, Checking…, a busy Continue) look unavailable without fading the focus ring and ignore hover (`tests/styles.test.mjs`). M3: the crash page's Reload is described by its sentence (`aria-describedby`). M6: no page for a quitting window or destroyed contents.
- **Docs.** This record, the README's screens (the window-crash page) and verification paragraph, and the [To verify](NATIVE-VALIDATION.md#to-verify) checklist regrouped by area without duplicates.

### Terminal keys, file drops and readability

Branch `claude/terminal-and-readability`. Fixture acceptance only.

- **macOS editing keys** in the terminal (`src/ui/terminalKeys.ts`): ⌘⌫ deletes to the start of the line (`^U`), ⌘← and ⌘→ go to its start and end (`^A`, `^E`), ⌥⌫ deletes the previous word (`^W`), ⌥← and ⌥→ move by word (`ESC b`, `ESC f`). Windows and Linux keys are unchanged. `tests/terminal-keys.test.mjs`; `tests/desktop-terminal-keys.spec.ts` checks the exact bytes the agent receives, that pasted text arrives, and that typing and plain arrows are unchanged.
- **File drops** onto the terminal and **Reference in Session for Codex**: see [PROVIDERS](PROVIDERS.md#file-references-in-the-terminal). `store.referenceForPath` maps a dropped absolute path to the session's own root or an added folder; `tests/explorer.test.mjs`, `tests/turns.test.mjs`, `tests/file-drag.test.mjs` and `tests/desktop-terminal-drop.spec.ts` (a synthetic drop: Finder and File Explorer drops need a person).
- **Readability**: the type scale moved up one step (caption 12, meta 13, body 14, title 17, screen 23 px); secondary text in the dark theme is lighter (`--tx3` #99A2B0, still within the token contrast tests); the file tree has 30 px rows, chevrons and file and folder icons. Badges, counts and keycaps stay at 11 px. The terminal's own colours are unchanged.
- **Sidebar menu**: New session and Search sit in their own menu at the top of the sidebar, above the project switcher (the collapsed sidebar has the same order). Search opens the command palette and shows its key (⌘K, Ctrl+Shift+P). `tests/desktop-palette.spec.ts`.
- **Small fixes**: the empty Memory tab shows the notebook icon used for Project memory instead of a ◇ character; the agent cards' state line uses the caption size so "Signed in · version" fits at the larger scale.

### The Story (Session tab)

Branch `claude/session-story`. Fixture acceptance only. "What it did" became a deterministic Story: no model, the same events always give the same rows, and titles come from a fixed vocabulary or the agent's own plan. The raw commands, exits, durations and the timeline are under Details. Rules, examples and limitations: [STORY.md](STORY.md).

- **Engine** (`src/core/story/`, pure functions):
  - a shell reader;
  - a classifier with fixed categories;
  - result attribution (what one exit status proves, so a piped `npm test | tail` is never called passed);
  - grouping into turns and phases, or into the agent's plan items when there are any.
- **Collection:**
  - Claude: command descriptions, Read paths, sub-agent descriptions and plan snapshots;
  - Codex: commands with their exit codes and `apply_patch` header paths, recorded for the first time;
  - Cursor: commands (exit unknown) and file edits.

  No prompt, reply, tool output or file content is kept. The store accepts two new event kinds, `tool` and `plan`.
- **Tests:**
  - `tests/story.test.mjs`: 16 tests, with a real Claude session on this repository as a fixture, and Codex and Cursor fixtures built from their documented payloads;
  - collection tests in `tests/turns.test.mjs`;
  - `tests/desktop-story.spec.ts`: two end-to-end tests through the real hook launcher.

### Changes in other worktrees

Branch `claude/changes-other-worktrees`. Files → Changed compared only the session's own checkout, so an agent working in a Git worktree inside it showed nothing (`.worktrees/name`, usually ignored by the checkout). Found on a real session: 28 edits and most commands ran there.

- **Which trees:** the view now also lists every other Git working tree inside the checkout that the session's own recorded file edits or commands were in (`nestedTrees` in `src/core/changes.mjs`). These are the outermost folders with their own `.git` below the checkout: worktrees, nested repositories, submodules.
- **Paths:** their files keep their project paths (`.worktrees/name/...`); diffs and Open run Git in that tree.
- **Base:** Journal did not record that tree's commit at the start. So the base is the parent of the oldest first-parent commit there written after the session started and not on the main branch (`origin/HEAD`, else `origin/main`, `main` or `master`), or HEAD.
  - A rebase onto a newer main does not count main's commits.
  - A session whose commits were already merged into the main branch shows only its uncommitted changes there.
- **Display:** the view names each tree with its branch and the commits made there since the session started.
- **Tests:** `tests/changes-trees.test.mjs`.

## Verification

| Check | Result |
| --- | --- |
| `npm test` | 640 passed (local macOS, Node 25.6.1, 5 October 2026, `claude/ux-redesign-p9b`), including `tests/isolation.test.mjs` |
| `npm run check`, `npm run build` | Passed (the build's large-chunk warning remains) |
| `npx playwright test` | 144 passed, 1 skipped (the Windows/Linux-only Ctrl+O check), exit 0, twice in a row (7.3 minutes each), headless, after the review fixes (before them: 139 passed and 1 skipped, twice). Earlier full runs in this part: one failed the first-run keyboard walkthrough (the default-agent race, fixed above), one failed a first-run spec on a selector the recovery announcement collided with (fixed by making it a `div`) |
| `npm run dist:dir`, `release:audit`, `smoke:packaged` | Passed in Phase 9 part 1 (5 October 2026) with `DEVELOPER_DIR` set to Xcode 26 (305 packed and 59 unpacked files); not rerun in part 2 |
| GitHub Actions | Fixture CI on macOS and experimental Windows (Linux dropped on 5 October 2026); desktop suite sharded; results per GitHub Actions |

Each phase's final results were taken twice in a row before merging. Timing-sensitive tests that once failed under heavy load (`tests/process.test.mjs` hard deadline, `tests/files-search.test.mjs` slices) were rewritten to assert structure (`settledBy`, units of work between yields) instead of wall-clock time.

Earlier authenticated evidence ([native validation](NATIVE-VALIDATION.md), [lifecycle follow-up](LIFECYCLE-AND-MEMORY-VALIDATION.md)) predates the runtime split; authenticated providers have not been rerun under the runtime, in worktrees or in the redesigned app. The [usefulness trial](USEFULNESS-TRIAL.md) round 1 was inconclusive (MODIFY).

## Blocked or deferred

| Item | Status | Reason | Next human action |
| --- | --- | --- | --- |
| Native checks of the redesign | OPEN | Needs the user's signed-in CLIs | Work through [To verify](NATIVE-VALIDATION.md#to-verify) |
| Windows validation, Job Objects | BLOCKED | No Windows hardware; Job Objects need a native module | Run the [Windows checklist](WINDOWS.md) and the Windows 11 items in To verify |
| VoiceOver and NVDA | OPEN | Needs a person listening | The VoiceOver and NVDA items in To verify |
| Usability round 2 | OPEN | Needs real people and the built app | The board B15 script plus terminal feel and real approvals; compare with the mockup round |
| Merge into `main` | OPEN | Needs review; `main` has moved on (PR #19) | Review `claude/ux-redesign`, merge `main` into it, rerun the checks |
| Windows code signing | BLOCKED | Needs a Windows code-signing certificate | See [RELEASING](RELEASING.md) |
| End-to-end update | BLOCKED | Needs two published releases | Publish two pre-releases and update between them |
| OpenAI mark (D9a) | OPEN | Later Simple Icons releases removed it | Check the OpenAI brand page before a release |
| Box-drawing glyphs (R1) | OPEN | The bundled font subset lacks them | Compare real Claude Code and Codex sessions; decide on the full font |
| Large renderer chunk | DEFERRED | Code splitting is not small | Split the renderer bundle when it matters for start-up |
| Usefulness round 2 | BLOCKED | Needs a chosen repository, tasks and paid runs | Create a suite from `benchmarks/TEMPLATE.md` |
| Authenticated rerun under the runtime | DEFERRED | Requires the user's interactive provider sessions | Repeat `NATIVE-VALIDATION.md` trials in Journal |
| Model-assisted extraction | DEFERRED | Must not add hidden provider calls; needs an explicit provider and cost decision | Decide provider and budget; design is in IMPLEMENTATION-PLAN Phase 7 |
| Changed-path and diff-based proposals; evidence-grade ranking | NOT STARTED | Lower value than the delivered inbox and controls | — |
| Public pilot | BLOCKED | Needs real users | — |

Historical full roadmap and phase status: [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md).
