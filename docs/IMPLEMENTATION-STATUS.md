# Journal implementation status

2 October 2026. Merged to `main`: the terminal-first slice (PR #1), native validation (PR #2), orientation, licensing and local validation (PR #3), and branding and layout (PR #4). Branch `claude/status-helper-and-usefulness` adds the status-update helper, usefulness trial round 1, and the durable multi-session runtime milestone. It is unmerged. Alpha; no public release.

Verification uses local checks on the user's Mac plus fixture-only GitHub Actions CI (macOS, Linux and experimental Windows). CI never uses provider logins. Authenticated native trials and the usefulness trial are manual and local.

## Implemented

**Runtime and sessions** ([architecture](ARCHITECTURE.md))
- A detached local runtime process (Electron in Node mode) owns all PTYs and native CLIs. It serves the app over a token-authenticated Unix socket or named pipe; one runtime runs per data directory.
- Up to four concurrent Claude Code or Codex sessions, each with provider, project, branch, baseline, task, state, native ID, PID identity, start time, last activity and survivors. Input, output, flow control and receipts are per session; only the visible session streams output.
- Renderer reload, app crash and **Keep running in background** on quit leave sessions running, and the next launch rediscovers them. **Stop sessions and quit** stops them gracefully. A runtime crash recovers sessions as `interrupted`, or `orphaned` when a verified process survives; delivery becomes `uncertain`, and prompts are never resent.
- Process ownership: signals go through the held PTY handle until exit. After a restart, a process is signalled only if its PID, start time and command hash all match. Stop sends SIGTERM to the PTY group, then SIGKILL after 3 s. Descendants are sampled; leftovers are reported and ended only on request.
- Claude per-launch hooks report working, idle and permission-waiting status, Bash commands with exit codes and durations, and edited files. Codex activity beyond Journal's own events is reported as unknown.

**Desktop UI**
- Session list: active sessions across projects plus recent sessions in this project, with provider, task, project, state, elapsed or last-activity time and an attention marker. Includes New session, switching (click, or ⌘1–4 on macOS and Alt+1–4 elsewhere), Interrupt, Stop, Resume, Close, and ending orphans or leftovers.
- Changes tab: working tree compared with the session's starting commit, with additions and deletions, new and pre-existing markers, per-file diffs (sensitive filenames hidden), opening in the default editor, and refresh.
- Activity tab: observed commands, test-command exit summary (exit status only), and a virtualized timeline.
- Knowledge tab: paged, filtered and searchable; flags possible conflicts on candidates.
- Light and dark themes, resizable sidebars, keyboard access and no decorative motion, all retained.

**Knowledge** ([orientation](PROJECT-ORIENTATION.md))
- Reviewed claims with evidence, immutable revisions and receipts, branch and checkout scope, freshness checks, briefs that orient every session, and exact resume with revalidation (unchanged from PRs #1–#4).
- The status-update helper drafts branch and overview updates from Git. Saving and approval are explicit, Git-range evidence goes stale when history is rewritten, and branch updates report drift.
- Retrieval uses FTS5 porter stemming with identifier and path aliases, area relevance by distinctive path segment, duplicate suppression that respects numbers and polarity, and conflict flags and warnings. Still lexical.

**Persistence and security**
- SQLite migrations (`user_version` 3) add a bounded `events` timeline and the alias/stemmed FTS index. Recovery markers are stored on sessions.
- No terminal output, prompts or tool results are persisted in timelines; command text is redacted. Runtime logs are bounded (512 KiB rotation) and redacted. Hook event files are bounded (1 MiB) and removed when a session ends.

**Repository**
- Fixture-only CI and an unsigned electron-builder configuration. A packaged macOS build was verified to start its runtime from `app.asar.unpacked`. Includes a manual release workflow (artifacts only), CONTRIBUTING, SECURITY, issue and PR templates, [ARCHITECTURE](ARCHITECTURE.md) and the [Windows audit](WINDOWS.md).

## Observed validation (this branch, local macOS)

| Check | Result |
| --- | --- |
| `npm test` | 87 passed, 0 failed: runtime protocol, HMAC handshake and impostor refusal, runtime lock and launch cap, unverified orphans, four sessions and isolation, reconnect, stop/interrupt/exit, runtime-crash recovery, orphan and PID-reuse refusal, hooks and redaction, cross-project knowledge isolation, partial metadata, status helper, retrieval, duplicates, conflicts, pagination, v1→v3 migration, diff baseline, glob/symlink/launchable-file refusal, process table and Windows shim handling, plus earlier coverage |
| `npm run check`, `npm run build` | Passed (the existing ~545 KiB chunk warning remains) |
| `npm run test:desktop` | 10 passed: earlier scenarios plus four real-PTY runtime scenarios (four sessions with reload and switching, app crash reconnect, runtime crash recovery, and keep-running quit with leftover cleanup and the changes view). The new scenarios passed 12/12 across three repetitions; a stale-snapshot race in the UI (an older store read replacing a newer status) was found by an intermittent failure and fixed with per-session versions. |
| `npm run dist:dir` | Unsigned `Journal.app` built; the packaged runtime started and exited cleanly |
| GitHub Actions | Not yet run: the branch could not be pushed because the local GitHub token lacks the `workflow` scope |

Earlier authenticated evidence still applies to launch, resume, permission and handoff behavior ([native validation](NATIVE-VALIDATION.md), [lifecycle follow-up](LIFECYCLE-AND-MEMORY-VALIDATION.md)). It was gathered before the runtime split. The new runtime uses the same launcher and arguments, but authenticated providers have **not** been rerun under it.

The [usefulness trial](USEFULNESS-TRIAL.md) was inconclusive: every condition passed every task. The knowledge thesis is MODIFY pending a harder round.

## Limits and next work

- An independent review of the runtime found 11 issues, including glob/symlink reads in the diff view, opening launchable files, a two-runtime race, locale-dependent process identity and token exposure to a squatting socket; all are fixed with regression tests.
- Real Claude Code and Codex have not been run under the new runtime: multi-session, keep-running and crash recovery are verified with fixture CLIs only. Codex interactive approvals, cancelling a running foreground tool, and Windows remain open.
- A runtime crash still ends terminals; only app or renderer loss is survivable. Descendants that daemonize between samples cannot be attributed; Windows descendant tracking is not implemented.
- Concurrent sessions in one checkout share a working tree, so the Changes view cannot attribute edits to a single agent. There is no worktree isolation.
- Retrieval is lexical; conflict detection is a heuristic flag. There is no automatic extraction.
- No signing, notarization, installer verification on Windows or Linux, auto-update or public release. Dependency and bundled-binary notices remain a release task.
- Windows: see [WINDOWS.md](WINDOWS.md). Nothing is verified on a real Windows machine.

Historical full roadmap: [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md).
