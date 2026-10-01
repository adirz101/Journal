# Local lifecycle and retrieval follow-up

1 October 2026. User-authorized work on separate branch `codex/terminal-lifecycle-validation`, based on PR #2 head `985149d`. No merge, hosted runners, CI or scheduled tests. Later user steering made [project orientation](PROJECT-ORIENTATION.md) the primary product outcome.

## Review and process lifecycle

The PR #2 review case is fixed: capture selects the latest explicit resume marker before validating its command and UUID. Empty/partial banners no longer select an older UUID. A later malformed banner also revokes an older unconfirmed hint across callbacks. Parser and runtime regressions failed before the respective fixes and passed afterward. Confirmation is still required.

The real Electron/native-node-pty lifecycle fixture starts a bounded 45-second Node child and records its PID/readiness/heartbeat. Interrupt reached the fixture CLI, which forwarded SIGINT; the child exited while its parent remained. Stop and normal application exit ended their CLI/child pairs. OS probes verified process disappearance. Reopening retained receipt prompt/items, marked possible delivery uncertain, and launched nothing automatically. Explicit resume reused the same UUID without task or keystroke replay. No production termination change was needed for these ordinary owned-child cases.

Fixture development initially failed because of inherited ESM mode and later because retained output was mistaken for a new launch. The fixture now sets its own CommonJS boundary and waits for the new launch record. Failure cleanup checks a unique fixture path in a remaining PID's command before signalling it. Detached/signal-resistant daemons, app crashes and Windows are not proven by these cases.

## Actual native command

Codex 0.154.0, existing ChatGPT login, invocation-only user-selected `gpt-5.6-luna`, unchanged native workspace permissions, reused disposable project/isolated Journal data. Untrusted hooks remained untrusted; the existing configured local MCP server failed at startup. One bounded task requested only `node native-wait.mjs` with no edits, agents or network tools.

The command printed `JOURNAL_COMMAND_READY`, recorded PID `38901` and updated a heartbeat every 250 ms with a 45-second expiry. Codex reported an active background terminal while its conversation was idle. Journal Interrupt sent Ctrl+C, ending the native CLI. The last heartbeat was 29,102 ms after command start, before expiry, with no later writes. A host PID probe subsequently returned `ESRCH`. No cancellation marker was written, so the exact termination signal is unknown. An earlier sandboxed probe caught all errors and is excluded as disappearance evidence; the host probe checked the actual OS error.

This is observed background-command stopping **with CLI exit**, not universal foreground-tool cancellation while retaining an active conversation. The previous trial separately observed inference interruption and exact resume.

Journal session `b8958ba1-125c-4ebe-acd1-0a061c19b91e`, receipt `b459f897-105c-4be3-bd18-7eff5a22f3d5`: exited, native code 0, UUID `01a0f68f-86dd-7ba3-871b-6ccccda553cc`, `nativeIdConfirmed=false`. The fresh app displayed the same UUID from the actual multiline exit banner and required confirmation. This closes the previous automatic-hint observation gap. The native CLI and app were closed; trial files and raw output remain ignored.

## Frozen offline retrieval pilot

Run `npm run pilot:memory` manually. It creates two disposable Git projects and a real SQLite store, measures retrieval, deletes those checkouts/store and writes sanitized labels to ignored `.cache/memory-pilot/result.json`. No providers or model requests. Corpus: 28 human-authored synthetic commerce/desktop policies, 20 task queries, relevance labels frozen before running. SHA-256: `0e37ed6f5d92750164a0008dd96cfe5c5665852b7be1078d93a7d6c5b15732d3`.

| Measure | Before grammar filter | After grammar filter |
| --- | --- | --- |
| Relevant hits / expected | 23 / 25 | 23 / 25 |
| Supplied claims | 63 | 58 |
| Strict precision | 36.5% | 39.7% |
| Recall | 92% | 92% |
| Planted stale/wrong-scope/unapproved/withdrawn claims supplied | 0 | 0 |
| Empty packets for negative tasks | 1 / 2 | 2 / 2 |

A marketing task matched unrelated policies solely through `the`. A small English grammar-word filter now runs before the 16-term limit, with case normalization/deduplication. A real SQLite regression failed before the fix and passed afterward; meaningful domain terms still retrieve the rule, and grammar prefixes do not consume the cap. This pilot corpus has no project briefs: its task-relevance labels exclude the separately intentional orientation layer.

Lexical OR still supplies adjacent/generic claims; strict labels may count adjacent useful policies as extras. The two misses come from a paraphrase lacking the required area path. This is a small diagnostic, not a general benchmark or proof of saved time, avoided mistakes, improved model quality or superiority over curated AGENTS.md/native memory. Those require a consented recurring-task comparison.

Remaining native gaps: Codex interactive allow/deny under a suitable native profile, broader foreground tools, crash cleanup, detached/signal-resistant descendants and Windows. No protections were weakened to manufacture approvals. Broader extraction/search changes remain later work.

Final parent verification: 47 core tests, typecheck, production build and all three local Electron/native-PTY scenarios passed. Build retains its roughly 545 KiB chunk warning. A fresh read-only reviewer found no actionable issues and independently passed 45 agent/knowledge/terminal tests; the reviewer did not run the GUI or observe native trials.
