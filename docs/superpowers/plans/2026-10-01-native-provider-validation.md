# Native provider validation plan

**Goal:** Validate Journal's first terminal-only slice against the user's real installed Claude Code and Codex on the local Mac.

**Spec:** `docs/TERMINAL-FIRST-SPEC.md`; next work in `docs/IMPLEMENTATION-STATUS.md`. User authorized continuation after merging PR #1.

**Approach:** Use the actual Electron app, existing native CLI arguments/settings and a disposable Git fixture inside `.cache/native-validation/`. Drive only known fixture actions through the native terminal. Keep trials bounded and record observed behavior separately from transport receipts. User-selected trial model overrides may be scoped to invocation without changing permanent settings.

## Constraints

- Manual local verification only; no CI, hosted runners or nightly jobs.
- Preserve native settings, authentication and permission prompts. No permission bypass flags or global configuration edits.
- Do not read credential files, hidden reasoning or native transcript storage. If authentication is unavailable, report it without changing accounts.
- Use only a tiny fixture project and safe read/write operations within it. No user source code or network tools in test tasks. Limit attempts rather than retrying inference indefinitely.
- Native resume must target a confirmed UUID; never use latest-session selection. Reviewed knowledge and receipts stay immutable.
- Temporary raw terminal buffers are for local observation only; committed evidence contains sanitized outcomes, relevant version/ID metadata, fixture hashes and limitations.

## Execution

- [x] Inspect installed CLI help/version and filtered authentication status.
- [x] Create a committed fixture, isolated Journal data directory and small source-backed approved rule with a distinctive marker.
- [x] Launch Journal with real native providers. Observe trust prompts and any other prerequisites before responding.
- [x] Submit a bounded fixture task to Codex; observe context use, requested safe file change, completion and native UUID.
- [x] Test a native permission refusal and one safe approval when the existing provider settings present a prompt. Verified in Claude manual mode; Codex automatic refusals remain an explicit interactive-approval gap.
- [x] Stop and resume the exact native conversation with a new marker; verify retained conversation and refreshed Journal context without repeating the first task. Codex inference interruption observed; running-tool cancellation remains unverified.
- [x] Approve a source-backed lesson from the fixture; switch to Claude and request a bounded review of the actual result. Verify cross-provider knowledge use and exact Claude resume.
- [x] Investigate any mismatch using a minimal reproduction before changing production code. Fix multiline Codex banner parsing with failing-then-passing regressions and a chunked runtime check.
- [x] Record observed results and outstanding gaps in `docs/NATIVE-VALIDATION.md` and current status. Run required local checks; retain ignored fixture for future bounded checks.

## Expected evidence

Actual provider reply/output and fixture file contents must corroborate a completed task; a submitted receipt alone does not. Resumed output must acknowledge prior conversation and new input. A permission result requires the visible native prompt and its result. Missing prompts, quota/auth/network failures and interrupted delivery remain explicit gaps.
