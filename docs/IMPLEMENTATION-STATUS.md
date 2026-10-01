# Journal implementation status

1 October 2026. First terminal-only slice merged in [PR #1](https://github.com/adirz101/Journal/pull/1), commit `eebb9e3`. Native validation is in [PR #2](https://github.com/adirz101/Journal/pull/2). Repo overview/branch updates and local validation follow-up are on separate branch `codex/terminal-lifecycle-validation`, based on PR #2. A working foundation for the larger roadmap; no public release.

All current verification is manual and local on the user's computer. GitHub Actions was disabled before these fixes, and its workflow file removed. No CI, hosted runners, nightly tests or scheduled verification.

## Implemented

- [Project orientation](PROJECT-ORIENTATION.md): current approved repo overview plus exact-branch progress/next-step updates precede task-specific knowledge for every Journal-launched session, including empty tasks and resume. Source freshness, explicit admission, immutable revisions, checkout/branch boundaries and shared packet budgets remain enforced. Status is reviewed content; there is no automatic extraction from terminal output.

- Original CLI launcher: literal argv, inherited settings/login/permission prompts, Claude preassigned UUID and scoped observer hooks, Codex resume UUID requiring human confirmation. No latest-session fallback or permission bypass.
- Electron sandboxed React cockpit with node-pty/xterm, project/session navigation, input/resize/interrupt/stop, flow control, renderer reconnect and explicit resume. One active terminal.
- SQLite WAL/FTS5: manual candidates, admission/rejection/withdrawal, immutable revisions, exact branch/checkout and area scope, source revalidation and bounded retrieval. Evidence is a bounded tracked UTF-8 excerpt and whole-file hash or explicit user source note.
- Immutable knowledge receipts and exact launch-prompt snapshot, with prepared/submitted/failed/uncertain delivery. Revalidate at launch even after preview. Resume uses the latest delivered receipt for the same project/provider/native UUID, including when selecting an ancestor launch. Exclusions use the delivered memory ID/revision; current packets explicitly replace earlier Journal claims. Empty tasks are never repeated. Native history can retain older context.
- Worker-thread SQLite/Git/evidence service and bounded PTY history/display credit. Interrupted deliveries recover as uncertain. No raw terminal/keystroke persistence.
- Keyboard access, labeled controls/focus, readable responsive layout, pointer-gated hover and no decorative motion library.

No dev3 vendor, code or checkout is retained. The old source audit remains historical research. No Superset ELv2 code was copied. Journal's original code is licensed under the [Apache License 2.0](../LICENSE), with project attribution in [NOTICE](../NOTICE). Dependency and bundled-binary notices remain a release task.

## Observed validation

Local macOS, Node 25.6.1; Electron 44.5.1 with Node 24.21.0; node-pty 1.1.0 rebuilt for Electron. Results below are local checks, not a guarantee of native provider behavior.

| Check | Observed result | Coverage |
| --- | --- | --- |
| `npm ci` | Passed | Clean install, Electron download and native node-pty postinstall rebuild |
| `npm test` | 47 passed, 0 failed | Prior evidence/resume/bounds coverage plus latest incomplete banner revocation, grammar-only relevance exclusion, always-supplied project overview/current-branch update, freshness/admission/limits and history |
| `npm run check` | Passed | Renderer and desktop acceptance TypeScript |
| `npm run build` | Passed | Production renderer; roughly 545 KiB minified chunk warning, no build failure |
| `npm run test:desktop` | Three scenarios passed | Real Electron/native PTY with controlled fixture CLIs: original handoff/reload/flood/security coverage; OS-verified running-child interrupt/stop/app-exit and exact restart/resume; UI admission of repo overview/branch updates and empty-task delivery to both providers |
| `npm run smoke:agents` | Both native CLIs launched and produced output | Startup only; no input, trust acceptance, login or task submission |

Native versions: Claude Code 2.1.284, Codex CLI 0.154.0. The earlier startup smoke involved no model requests. The subsequent [authenticated native trial](NATIVE-VALIDATION.md) completed a real Codex fixture task, manually reviewed knowledge handoff to Claude, exact native resume for both providers, Claude one-time permission refusal/approval, and Codex inference interruption. Provider replies and host file inspection corroborated outcomes separately from submitted transport receipts.

Codex's inherited model was unsupported for the user's ChatGPT login. The user selected `gpt-5.6-luna` for this short trial only; a temporary invocation wrapper supplied it without changing permanent model settings or production launcher arguments. Native trust/settings/integrations remained inherited. Claude's permission trial used its native manual mode. Codex's existing custom workspace profile did not present interactive approvals, leaving that specific native check open.

The trial exposed Codex 0.154.0's new multiline resume banner. Capture now recognizes this and the older inline banner while requiring UUID validation and explicit user confirmation. Two parser regressions and a chunked runtime regression verify the fix; the live trial confirmed the UUID manually, so fresh native automatic-hint capture is not claimed.

The [follow-up](LIFECYCLE-AND-MEMORY-VALIDATION.md) subsequently observed fresh native automatic-hint capture and stopped a running Codex background command with CLI exit. It passed ordinary owned-child lifecycle fixtures without changing production termination. Incomplete latest banners now clear older unconfirmed hints. The frozen offline 28-claim/20-task pilot supplied no planted stale/wrong-scope/unapproved claims, but exposed incidental English grammar matches. A bounded filter fixed unrelated-task injection; recall stayed 23/25 and strict precision improved from 36.5% to 39.7%. This task-only corpus has no orientation briefs; it does not measure model usefulness or saved time.

Independent read-only review identified pathspec wildcard bypass, stale results hiding valid knowledge, repeated initial tasks, historical device-query input, evidence races and synchronous storage delaying PTY handling. Fixes were checked locally. Regressions cover source races/wildcards, retrieval crowding, task-repeat avoidance, hook identity ambiguity, late shutdown callbacks and exact launch receipts. Desktop acceptance covers replay and flood. The reviewer did not independently rerun the final fixes.

The subsequent clean PR review found four issues: exclusion notices used undelivered revision UUIDs, ancestor resume missed later deliveries, a new Codex session inherited another session's confirmation input, and a reopened SQLite test connection outlived directory cleanup. These are corrected with local regression coverage. The previous desktop reload failure was reproduced locally at 900×640: xterm retained its history, but the test incorrectly required the first line to remain visible. Acceptance now scrolls with Shift+PageUp/PageDown and verifies history plus live input; hidden font-measurement text is not terminal output. Windows cleanup now closes the connection before removing files; the Windows-specific lock behavior has not been rerun locally.

The executive summary is translated into English, with its research-stage scope preserved. Authored project text is English; Unicode fixtures use escapes to preserve the same multilingual byte/argv checks.

A fresh review of these fixes reproduced one additional edge case: a failed first launch could supply undelivered history through a fallback. The fallback is removed; a regression verifies that an empty-task resume of a manually confirmed failed row supplies no historical query or exclusion notice. The reviewer independently reran that regression and three related context tests, confirmed the correction, and reported no remaining actionable findings in this scope. The parent reran all 37 core tests and local desktop acceptance after the correction.

## Limits and next work

- Remaining native checks: Codex interactive allow/deny under a suitable native profile, broader foreground tools, crash cleanup, detached/signal-resistant descendants and Windows. Background-command stopping with CLI exit and ordinary owned-child fixtures do not establish universal process cleanup. Keep additional native requests bounded with invocation-only trial settings.
- Main product goal is repo understanding/current status in every new Journal session. The reviewed orientation layer implements this delivery contract. Next: reduce the burden of maintaining status with evidence-backed update proposals, and evaluate real recurring tasks against curated instructions. Automatic admission/extraction is not implemented.
- No hosted testing is configured or active. The POSIX desktop fixture is skipped on Windows; manual checks on a local Windows machine must verify install/build, discovery, quoting and native interaction before advertising support.
- PTY survives renderer reload, not app exit/crash. Volatile output loses older history with visible gaps. Runtime sidecar and concurrent terminals remain later work.
- Lexical retrieval with finite caps; area paths must appear in the task. No embeddings, automatic extraction, cross-worktree promotion, background jobs, cloud or chat. Recent UI lists are bounded rather than fully paginated.
- Whole-file fingerprints conservatively invalidate evidence after any edit. Freshness is not semantic proof. Credential checks use finite patterns; reviewed content, source excerpts, tasks and receipts are durable local content, not automatic redaction.
- No installer, signing, updates or provider-support/redistribution claim. Historical full roadmap: `IMPLEMENTATION-PLAN.md`; current scope: `TERMINAL-FIRST-SPEC.md`.

Run `npm ci` then `npm run dev`. See README for the knowledge/resume workflow.
