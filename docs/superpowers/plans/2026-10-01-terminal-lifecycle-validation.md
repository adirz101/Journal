# Terminal lifecycle validation and review follow-up

User authorized local validation and any necessary implementation on a separate branch. Branch `codex/terminal-lifecycle-validation` starts at PR #2 head `985149d`; PR #2 stays unchanged. Scope remains terminal-only, original Journal code, English files, manual local checks and no CI or nightly jobs.

## Tasks

- [x] Reproduce and fix incomplete latest Codex banner selection and stale stored hints with failing-then-passing regressions. Retain explicit UUID confirmation.
- [x] Exercise real Electron/native node-pty with controlled fixture providers that start a long-running child. Verify interrupt, stop and normal app exit, process disappearance, immutable receipts, reopen and exact-ID resume without input replay. Track only explicitly owned fixture processes; bounded timers and identity-checked cleanup avoid killing unrelated processes.
- [x] Investigate lifecycle outcomes before implementation. Ordinary child cases passed; no production termination change, runtime sidecar or concurrency model was needed.
- [x] Run one bounded real native Codex command cancellation check. Command readiness was observed before Interrupt; background command stopped with CLI exit. Native protections stayed inherited; exact signal remains unknown.
- [x] Evaluate retrieval against 28 frozen synthetic claims / 20 labelled tasks in two fixtures, including stale/branch/conflicting/noisy facts. Record limits separately from model usefulness. Fix incidental grammar injection with a red/green regression.
- [x] Implement user-requested repo overview/current-branch updates before task context. Real Git/SQLite and UI/native-PTY fixtures verify empty/unrelated tasks, branch switching, admission/freshness/revisions/budgets.
- [x] Run `npm test` (47 passed), `npm run check`, `npm run build`, `npm run test:desktop` (3 passed) locally. Record English outcomes/limits. No CI or scheduled verification.
- [x] Obtain one fresh final branch review and prepare a reviewable PR; no merge. Reviewer found no actionable issues and independently passed 45 agents/knowledge/terminal tests. Parent final suite passed 47 core tests, check/build and all three local desktop scenarios.

## Rulings and evidence

- Ruling: use a new branch in the current checkout as explicitly requested, rather than creating another worktree or pausing for planning approval. Previous PR commits are dependencies, not changes to be merged implicitly.
- Ruling: reuse the approved tiny native fixture and invocation-only `gpt-5.6-luna` selection for one bounded command-cancellation trial. No permanent model or approval-profile changes.
- Native permission denial/approval was demonstrated in Claude. Codex's current custom workspace profile automatically refuses explicit escalations. Do not weaken native protections to manufacture an interactive approval result.
- Ruling: the frozen pilot reproduced unrelated injection from incidental English grammar words. Apply a bounded stopword filter with a failing-then-passing regression, rather than changing area rules or adding semantic retrieval.
- User steering: the primary goal is repo understanding and current status in every conversation, with per-branch updates. Implement current approved checkout/branch `brief` entries before lexical task knowledge, including empty tasks; retain evidence/admission/budgets. See `docs/PROJECT-ORIENTATION.md`. This conditional implementation was explicitly authorized on this separate branch.
- Native command became a background tool while the model was idle. Ctrl+C exited the CLI and its command stopped before expiry; do not claim all foreground tools preserve an active conversation on cancellation.
