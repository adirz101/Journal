# Journal implementation status

1 October 2026. First terminal-only slice on `codex/terminal-first`, based on `1bb07cb`, published in [draft PR #1](https://github.com/adirz101/Journal/pull/1). A working foundation for the larger roadmap. No merge or public release.

All current verification is manual and local on the user's computer. GitHub Actions was disabled before these fixes, and its workflow file removed. No CI, hosted runners, nightly tests or scheduled verification.

## Implemented

- Original CLI launcher: literal argv, inherited settings/login/permission prompts, Claude preassigned UUID and scoped observer hooks, Codex resume UUID requiring human confirmation. No latest-session fallback or permission bypass.
- Electron sandboxed React cockpit with node-pty/xterm, project/session navigation, input/resize/interrupt/stop, flow control, renderer reconnect and explicit resume. One active terminal.
- SQLite WAL/FTS5: manual candidates, admission/rejection/withdrawal, immutable revisions, exact branch/checkout and area scope, source revalidation and bounded retrieval. Evidence is a bounded tracked UTF-8 excerpt and whole-file hash or explicit user source note.
- Immutable knowledge receipts and exact launch-prompt snapshot, with prepared/submitted/failed/uncertain delivery. Revalidate at launch even after preview. Resume uses the latest delivered receipt for the same project/provider/native UUID, including when selecting an ancestor launch. Exclusions use the delivered memory ID/revision; current packets explicitly replace earlier Journal claims. Empty tasks are never repeated. Native history can retain older context.
- Worker-thread SQLite/Git/evidence service and bounded PTY history/display credit. Interrupted deliveries recover as uncertain. No raw terminal/keystroke persistence.
- Keyboard access, labeled controls/focus, readable responsive layout, pointer-gated hover and no decorative motion library.

No dev3 vendor, code or checkout is retained. The old source audit remains historical research. No Superset ELv2 code was copied. No newly assigned license for Journal's original code; choosing the distribution license and release notices remains a release task.

## Observed validation

Local macOS, Node 25.6.1; Electron 44.5.1 with Node 24.21.0; node-pty 1.1.0 rebuilt for Electron. Results below are local checks, not a guarantee of native provider behavior.

| Check | Observed result | Coverage |
| --- | --- | --- |
| `npm ci` | Passed | Clean install, Electron download and native node-pty postinstall rebuild |
| `npm test` | 37 passed, 0 failed | Literal argv; real Git/SQLite evidence, scope, revisions and restart; latest native context and visible exclusion IDs; worker failure/recovery; output/input bounds and shutdown callbacks |
| `npm run check` | Passed | Renderer and desktop acceptance TypeScript |
| `npm run build` | Passed | Production renderer; roughly 545 KiB minified chunk warning, no build failure |
| `npm run test:desktop` | One scenario passed | Real Electron/native PTY with safe fixture CLIs: file knowledge, admission, Claude→Codex handoff, exact resume, isolated resume-ID drafts, keystrokes, 2.2 MB flood, interrupt, small-window reload/keyboard scrollback/device-query replay suppression, preload rejection, app restart/persistence |
| `npm run smoke:agents` | Both native CLIs launched and produced output | Startup only; no input, trust acceptance, login or task submission |

Native versions: Claude Code 2.1.284, Codex CLI 0.154.0. Claude reached a checkout trust prompt before its normal header; Codex displayed a native header. An earlier startup also detected Codex's trust prompt; the repeat did not. Absence of a detected auth prompt is not verification of account state. There were no paid model requests. Safe fixtures do not prove an authenticated provider turn.

Independent read-only review identified pathspec wildcard bypass, stale results hiding valid knowledge, repeated initial tasks, historical device-query input, evidence races and synchronous storage delaying PTY handling. Fixes were checked locally. Regressions cover source races/wildcards, retrieval crowding, task-repeat avoidance, hook identity ambiguity, late shutdown callbacks and exact launch receipts. Desktop acceptance covers replay and flood. The reviewer did not independently rerun the final fixes.

The subsequent clean PR review found four issues: exclusion notices used undelivered revision UUIDs, ancestor resume missed later deliveries, a new Codex session inherited another session's confirmation input, and a reopened SQLite test connection outlived directory cleanup. These are corrected with local regression coverage. The previous desktop reload failure was reproduced locally at 900×640: xterm retained its history, but the test incorrectly required the first line to remain visible. Acceptance now scrolls with Shift+PageUp/PageDown and verifies history plus live input; hidden font-measurement text is not terminal output. Windows cleanup now closes the connection before removing files; the Windows-specific lock behavior has not been rerun locally.

The executive summary is translated into English, with its research-stage scope preserved. Authored project text is English; Unicode fixtures use escapes to preserve the same multilingual byte/argv checks.

A fresh review of these fixes reproduced one additional edge case: a failed first launch could supply undelivered history through a fallback. The fallback is removed; a regression verifies that an empty-task resume of a manually confirmed failed row supplies no historical query or exclusion notice. The reviewer independently reran that regression and three related context tests, confirmed the correction, and reported no remaining actionable findings in this scope. The parent reran all 37 core tests and local desktop acceptance after the correction.

## Limits and next work

- Authenticated native turn, permission allow/deny, real-provider exact resume and knowledge use remain unverified end to end. Next task: a small trusted fixture checkout, safe distinctive task, native deny/allow, interrupt/resume and provider handoff. Preserve native permissions; record observation without credentials or hidden reasoning.
- No hosted testing is configured or active. The POSIX desktop fixture is skipped on Windows; manual checks on a local Windows machine must verify install/build, discovery, quoting and native interaction before advertising support.
- PTY survives renderer reload, not app exit/crash. Volatile output loses older history with visible gaps. Runtime sidecar and concurrent terminals remain later work.
- Lexical retrieval with finite caps; area paths must appear in the task. No embeddings, automatic extraction, cross-worktree promotion, background jobs, cloud or chat. Recent UI lists are bounded rather than fully paginated.
- Whole-file fingerprints conservatively invalidate evidence after any edit. Freshness is not semantic proof. Credential checks use finite patterns; reviewed content, source excerpts, tasks and receipts are durable local content, not automatic redaction.
- No installer, signing, updates or provider-support/redistribution claim. Historical full roadmap: `IMPLEMENTATION-PLAN.md`; current scope: `TERMINAL-FIRST-SPEC.md`.

Run `npm ci` then `npm run dev`. See README for the knowledge/resume workflow.
