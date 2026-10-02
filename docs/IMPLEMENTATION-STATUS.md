# Journal implementation status

2 October 2026. Merged to `main`: the terminal-first slice (PR #1), native validation (PR #2), orientation and licensing (PR #3), branding and layout (PR #4), and the durable multi-session runtime with the status helper and usefulness trial round 1 (PR #5). Branch `claude/roadmap-completion` adds worktrees, Brain completion, the proposal inbox, data maintenance, release groundwork and the benchmark harness. Alpha; no public release.

Verification uses local checks on the user's Mac. Fixture-only GitHub Actions CI is written but staged in `ci/github-actions/`: **BLOCKED** until a GitHub token with the `workflow` scope can push it. CI never uses provider logins. Authenticated native trials and usefulness benchmarks are manual and local.

## Implemented

**Runtime and sessions** ([architecture](ARCHITECTURE.md))
- A detached local runtime (Electron in Node mode) owns all PTYs and native CLIs. It sits behind a local socket or named pipe with HMAC challenge-response, an exclusive lock and launch caps.
- Up to four concurrent sessions, with per-session input, output, flow control, receipts, versions and attention markers.
- Renderer reload, app crash and keep-running quit leave sessions running and are rediscovered. A runtime crash recovers sessions as interrupted or orphaned (verified or unverified), with uncertain delivery and no resend.
- Ownership: signals go through the held PTY handle, or after a restart through PID plus UTC start time; stop escalates SIGTERM to the group, then SIGKILL after 3 s. Leftover descendants are reported and ended only on request.

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
- SQLite (migrations v5): workspaces, proposals, audit, events and pinned claims.
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

## Observed validation (local macOS)

| Check | Result |
| --- | --- |
| `npm test` | 117 passed |
| `npm run check`, `npm run build` | Passed (the existing ~545 KiB chunk warning remains) |
| `npm run test:desktop` | 11 passed: real Electron, runtime and node-pty with fixture CLIs, covering four sessions, reload, app and runtime crash, keep-running quit, leftover cleanup, worktree creation, research mode, Unicode and ANSI, leaving a claim out, and the status helper |
| `npm run dist:dir` | Unsigned app builds; packaged runtime starts; notices bundled |
| GitHub Actions | BLOCKED (workflow scope) |

Earlier authenticated evidence ([native validation](NATIVE-VALIDATION.md), [lifecycle follow-up](LIFECYCLE-AND-MEMORY-VALIDATION.md)) predates the runtime split; authenticated providers have not been rerun under the runtime or in worktrees. The [usefulness trial](USEFULNESS-TRIAL.md) round 1 was inconclusive (MODIFY).

## Blocked or deferred

| Item | Status | Reason | Next human action |
| --- | --- | --- | --- |
| CI activation | BLOCKED | Token lacks the `workflow` scope | `gh auth refresh -h github.com -s workflow`, then move `ci/github-actions/*.yml` to `.github/workflows/` |
| Windows validation, Job Objects | BLOCKED | No Windows hardware; Job Objects need a native module | Run the [Windows checklist](WINDOWS.md) on Windows 11 |
| Signing and notarization | BLOCKED | Needs an Apple Developer ID and a Windows code-signing certificate | See [RELEASING](RELEASING.md) |
| Usefulness round 2 | BLOCKED | Needs a chosen repository, tasks and paid runs | Create a suite from `benchmarks/TEMPLATE.md` |
| Authenticated rerun under the runtime | DEFERRED | Requires the user's interactive provider sessions | Repeat `NATIVE-VALIDATION.md` trials in Journal |
| Model-assisted extraction | DEFERRED | Must not add hidden provider calls; needs an explicit provider and cost decision | Decide provider and budget; design is in IMPLEMENTATION-PLAN Phase 7 |
| Changed-path and diff-based proposals; evidence-grade ranking | NOT STARTED | Lower value than the delivered inbox and controls | — |
| Public pilot | BLOCKED | Needs real users | — |

Historical full roadmap and phase status: [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md).
