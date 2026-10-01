# Review fixes and local-only verification implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline. The user authorized fixes and continuous execution; no additional planning approval is required.

**Goal:** Fix PR #1's four reproduced defects and the local reproduction of terminal reload failure, translate Hebrew project files to English, and remove hosted/scheduled testing.

**Architecture:** Keep the existing Electron/React/SQLite/PTY stack. A native conversation may span multiple Journal launch rows, so resume uses the latest delivered receipt for the exact project/provider/native UUID. Each resume treats the current packet as a replacement for earlier Journal knowledge and names exclusions using the identifiers actually delivered. UI confirmation state belongs to one selected session.

**Tech Stack:** Existing Node >=24, Electron, React, node:sqlite, node-pty, xterm.js and Playwright. No new dependencies.

**Spec:** `docs/TERMINAL-FIRST-SPEC.md`; user corrections: local manual tests only, no CI or nightly tests, English repository documents.

## Global constraints

Keep native settings/permissions, exact-ID resume, immutable receipts, source admission and output limits. No dev3 code, paid inference or trust/login acceptance. Do not recreate HANDOFF.md. Disable hosted workflow before pushing; remove its file and document local-only verification. Update existing PR #1 without merging.

## Review focus

- A withdrawal must refer to the memory ID and revision number visible in prior native input.
- An older sidebar row must not revert native context history or miss later delivered knowledge.
- Failed launches must not replace the last submitted/uncertain native receipt; other providers/projects must not share it.
- A new/changed session must not inherit another session's confirmation field.
- Narrow windows and renderer reload must preserve retained output and suppress historical device replies.

## Tasks

1. **Resume context** — `src/core/{terminal,store,store-worker}.mjs`, `src/desktop/store-client.mjs`, `tests/{terminal,storage-worker}.test.mjs`: fail regressions for visible withdrawal IDs, ancestor resume, provider/project filtering and failed delivery; add `latestNativeReceipt(projectId, provider, nativeId)` and reconcile current packet against that receipt. Always explain replacement semantics at resume, including an empty current packet. Check literal launch receipts and no task replay.
2. **Session confirmation and terminal reload** — `src/ui/{App,TerminalPane}.tsx`, `tests/desktop.spec.ts`: fail the new-Codex stale-ID scenario through real Electron/PTY; reproduce narrow-window reload before choosing the smallest fix. Reset confirmation state when session changes and validate output/reload/device replies.
3. **SQLite fixture cleanup** — `tests/knowledge.test.mjs`: make reopened-handle cleanup finish before directory removal, preserving restart assertions. Verify locally; report that Windows was not rerun.
4. **English/local-only documentation** — translate and rename `docs/EXECUTIVE-SUMMARY.he.md`, fix links and deleted handoff references, preserve multilingual test data using Unicode escapes, remove `.github/workflows/ci.yml`, and update AGENTS/README/spec/status/ADRs/roadmap to prohibit CI/nightly. Scan tracked project text for Hebrew and hosted test configuration.
5. **Finish** — run local core suite, typecheck, build and real desktop acceptance. Get a focused clean-context review. Commit/push to existing PR only after verifying Actions remains disabled; update PR validation/findings without starting cloud jobs.

## Execution evidence

- Context regressions failed before the fix and passed afterward: delivered IDs, ancestor resume, latest-delivery query and exclusion of failed launches/other projects/providers.
- The new-Codex acceptance regression reproduced the old UUID in the new field before the UI fix; session-keyed drafts now pass.
- Narrow-window reload reproduced the previous failure at 900×640. The xterm buffer retained the first line; hidden width-cache measurement elements produced repeated-character DOM text. Keyboard scrolling now verifies retained history, followed by live input and exactly one device response. No emulator behavior change was needed.
- Reopened SQLite is closed in `finally` before fixture teardown. Windows was not rerun; all current checks used the user's Mac.
- Local final checks: 37 core tests, typecheck, production build and one Electron/native-PTY desktop scenario passed. Build retains its existing roughly 545 KiB chunk warning.
- English executive summary replaces the Hebrew file. Authored project sources scanned without Hebrew characters; escaped multilingual fixtures retain their runtime data.
- GitHub workflow state confirmed `disabled_manually`; both historical runs completed, with no active runs. The workflow file is removed.
- Fresh review reproduced a failed-first-launch fallback that incorrectly supplied undelivered history. A regression failed locally before removal of the fallback. Resume now uses only submitted/uncertain history. The reviewer reran four related tests and confirmed no remaining actionable findings; the complete local suite and desktop acceptance passed after the correction.
