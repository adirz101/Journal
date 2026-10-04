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
- JetBrains Mono (OFL-1.1, from `@fontsource/jetbrains-mono`, Latin and Latin Extended, 400/500/600 including italics) is bundled for code, paths, IDs and the terminal. Font subset decision: box-drawing, block and Braille glyphs are not in those subsets and fall back to the system monospace font (risk R1); the full font is reconsidered after real sessions.
- Nothing renders below 11 px; one 2 px focus ring on `:focus-visible`; themed scrollbars; one input border token.
- Plain vocabulary (`src/ui/copy.ts`): Project memory, notes, Remember, Archive, Forget..., Continue, Stop, Read-only, Separate copy (worktree), What was sent. Core reasons and warnings are mapped in the renderer; receipt and packet text is unchanged. Technical terms stay in tooltips.
- Provider marks (Simple Icons, CC0) next to provider names, with attribution in the third-party notices. Open item D9a: the OpenAI mark (used for Codex) comes from Simple Icons 15.22.0 because later releases removed it; check the OpenAI brand page and the source before a release.
- App shortcuts are routed in the main process and work while the terminal has focus (BUG-7), and the router steps aside while a dialog is open (the renderer reports dialog state). Menu and button labels, tooltips and `aria-keyshortcuts` show the same keys. macOS: Cmd+N, Cmd+O, Cmd+1-4, Shift+Cmd+K, Cmd+E, Cmd+I, Option+Cmd+1-3. Windows and Linux: Ctrl+Shift+N, Ctrl+O (outside the terminal), Alt+1-4, Ctrl+Shift+K, Ctrl+Shift+E, Ctrl+Shift+B, Alt+Shift+1-3. Every other key goes to the terminal. Slot shortcuts are ignored while a switch is in progress.

Still open: the Windows items in [WINDOWS](WINDOWS.md) (shortcut pass, Alt menu-bar focus, ConPTY keys) need a real Windows machine; the Linux Ctrl+O desktop check runs for the first time in CI; the box-drawing check against real Claude Code and Codex sessions has not been done (fixtures only); the terminal shows three rows at 900x640 with widened sidebars until Phase 3 moves the composer.

## Observed validation (local macOS)

| Check | Result |
| --- | --- |
| `npm test` | 282 passed |
| `npm run check`, `npm run build` | Passed (the existing ~545 KiB chunk warning remains) |
| `npm run test:desktop` | 17 passed, 1 skipped (headless): real Electron, runtime and node-pty with fixture CLIs, covering four sessions, reload, app and runtime crash, keep-running quit, leftover cleanup, worktree creation, research mode, Unicode and ANSI, leaving a claim out, the status helper, external branch switches, project management, right-click menus, the file explorer, keyboard shortcuts while the terminal has focus and the Cursor provider (install, sign-in, launch, resume) |
| `npm run dist:dir` | Unsigned app builds (needs Xcode 26 selected, see [RELEASING](RELEASING.md)); package audit passes with the bundled JetBrains Mono font files; packaged smoke test passes |
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
