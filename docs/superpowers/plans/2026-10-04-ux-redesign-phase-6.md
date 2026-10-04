# Journal UX redesign, Phase 6: Session end loop

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Read `AGENTS.md` first. Group B reads `/Users/azechary/Downloads/skills-main/skills/emil-design-eng/SKILL.md` before any UI edit, and `review-animations/SKILL.md` before merging. If the collection is missing, say so; don't claim you applied it.

**Goal:** Phase 6 of [the UX redesign](2026-10-04-ux-redesign.md) (tasks 6.1–6.5; F17, F18, F19; decisions D1, D11, D12; BUG-8; BUG-9 verification). When a session ends, the main column shows what happened, what is worth keeping, which notes the session put out of date, and how to continue. A session that exits with an error leads with its retained terminal output, or says honestly that the output is gone.

**Design source:** `…/scratchpad/journal-mock/src/WrapUp.body.html` (board 6), `StaleCatch.body.html` (board 14, including the resolved state with Undo) and `States.body.html` panel 5 ("Session exited with an error"). The mock's `Continue ⌘R` becomes `Continue ⌘↵` (D8) and its `Archive` becomes `Forget…` (Phase 1 vocabulary).

**User decisions that apply:** D1 (approved 4 October 2026): one-click Remember when the full statement is on screen, audited with a distinct `via`; the two-step flow stays in the Memory tab for edits. D11 and D12 follow the master-plan recommendations.

**Checks after every commit:** `npm test`, `npm run check`, `npm run build`. Group B, and Group A's terminal/runtime commits, also run `npm run test:desktop` (hidden windows, Electron-native node-pty; check the exit status). Everything here is fixture acceptance. Phase 6 doesn't change provider argv, native settings, permissions or exact-ID resume. Authenticated native behaviour (a real Claude exit, a real Codex exit banner) goes to `docs/NATIVE-VALIDATION.md` as a manual item.

**Out of scope:** range-level freshness (D2 stays file-level, worded "file changed"); `rememberDraft` and first-run `via: 'first-run'` (Phase 7); a "N notes to check" extra on sidebar rows (it would need a Git scan per row; the wrap-up shows it instead); persisting terminal output (never).

---

## 0. Groups, order and file ownership

```
A0 contract commit (Group A implementer, on claude/ux-redesign)
 ├── Group A  core + runtime: snapshot, buffers, summary, remember, stale catch, reaffirm, IPC (worktree p6a)
 └── Group B  renderer: WrapUp, StaleCatchCard, suggestions, hand-off, exit-error view       (worktree p6b)
merge A → B (B rebases on A and reruns all four checks)
```

- **Group A can start now.** It needs only merged code: Phase 2 (identity source, slots, error codes) and Phase 5 Group A (`insights.mjs`, migration v8, `approved_at`).
- **Group B starts after Phase 3 Group B** (`SessionHeader`, `useSessionData`, the two main views), **Phase 4 Group B** (`Composer` state in App) **and Phase 5 B0** (`NoteCard` contract) have merged. It rebases on Phase 5 Group B if that merged meanwhile, because both edit `KnowledgePanel.tsx`.
- **A0 goes first** (section 1): types, copy keys, IPC names with working stubs, and the CSS section marker, so B can build against stable shapes.

| File | Owner | Others may touch |
|---|---|---|
| `src/core/store.mjs` (`proposeMemory` split, `setMemoryStatus`, `wrongBranch`, `listProposals`, new `rememberProposals`, `reaffirmMemory`, `sessionSummary`/`staleNotesForSession` wrappers) | A | — |
| `src/core/insights.mjs` (`sessionSummary`, `staleNotesForSession`), `src/core/hunks.mjs` (new), `src/core/evidence.mjs` (export `readEvidenceFile`) | A | — |
| `src/core/terminal.mjs` (exit snapshot, retained-buffer policy), `src/runtime/runtime.mjs` (proposals event) | A | — |
| `src/core/store-methods.mjs`, `src/desktop/main.mjs` (Phase 6 actions only), `src/desktop/preload.cjs` (one `for … allowed.add` line) | A0, then A | — |
| `tests/session-end.test.mjs` (new), `tests/proposals.test.mjs`, `tests/insights.test.mjs`, `tests/terminal.test.mjs`, `tests/runtime.test.mjs`, `tests/storage-worker.test.mjs` | A | — |
| `src/ui/types.ts` (`SessionSummary`, `StaleNote`, `Session.changeStats`), `src/ui/copy.ts` (`wrapUp` object) | A0 | B may fix wording |
| `src/ui/WrapUp.tsx`, `StaleCatchCard.tsx`, `wrapUpModel.ts`, `useWrapUp.ts` (new) | B | — |
| `src/ui/App.tsx` (main region: ended-session view, hand-off), `TerminalPane.tsx` (`onUnavailable`, copy handle), `KnowledgePanel.tsx` (other-branch action gate), `noteCardModel.ts` (one helper) | B | Phase 5 B owns `KnowledgePanel`/`noteCardModel`; B adds one helper and one condition |
| `src/ui/styles.css` (new section `/* === Phase 6: session end === */`) | B | — |
| `tests/wrap-up.test.mjs`, `tests/desktop-wrap-up.spec.ts` (new), `tests/support/ui.ts` (`showTerminal` helper), specs that read an ended session's terminal | B | — |

---

## 1. A0: the contract commit (before forking)

### 1.1 Types (`src/ui/types.ts`; core returns exactly these)

```ts
export interface ChangeStats { available: boolean; additions: number; deletions: number; files: number; preexisting: number;
  paths: { path: string; from: string | null }[]; truncated: boolean; at: string; reason?: string }
export interface Session { /* … */ changeStats?: ChangeStats | null; exitCode?: number | null; signal?: string | null }
export interface SessionSummary {
  status: SessionStatus; exitCode: number | null; signal: string | null; durationMs: number | null;
  changes: ChangeStats | null;                     // the end snapshot (D11); null when none was taken
  tests: { passed: number; failed: number; unknown: number; commands: string[] } | null;   // null for Codex and Cursor
  identity: { nativeId: string | null; confirmed: boolean; source: Session['nativeIdSource']; mismatch: boolean };
  suggestions: number;                             // open suggestions of this session and its resume chain
}
export interface DiffLine { kind: ' ' | '-' | '+'; old: number | null; new: number | null; text: string }
export interface StaleNote {
  note: Memory; path: string; renamedTo: string | null;
  hunks: { lines: DiffLine[] }[] | null;           // note coordinates on the old side
  before: { startLine: number; lines: string[] } | null;   // fallback: the saved excerpt …
  after: { startLine: number; lines: string[] } | null;    // … and the current lines at the same place
  suggestedRange: { startLine: number; endLine: number } | null;  // where the cited lines are now, if they moved
  reaffirm: { allowed: boolean; reason: null | 'wrong-branch' | 'separate-copy' | 'file-missing' } ;
  workspaceId: string | null;                      // the view to reaffirm in
}
export interface StaleCatch { available: boolean; notes: StaleNote[]; truncated: boolean }
```

### 1.2 IPC (`main.mjs`, `preload.cjs`, `store-methods.mjs`)

| Action | Main handler | Notes |
|---|---|---|
| `sessionSummary` | `({ id }) => store.sessionSummary(id)` | SQL only, no Git |
| `staleNotes` | `({ sessionId }) => store.staleNotesForSession(sessionId)` | Git and hashing, bounded |
| `proposals` (changed) | `({ projectId, sessionId }) => store.listProposals(projectId, 'open', sessionId ? { sessionId } : {})` | unchanged without `sessionId` |
| `rememberProposals` | `({ ids }) => store.rememberProposals(ids, { via: 'wrap-up' })` | `via` is fixed in main; the renderer can't choose it |
| `reaffirmMemory` | `({ id, startLine, endLine, workspaceId }) => store.reaffirmMemory(id, { startLine, endLine, workspaceId: workspaceId ?? null })` | — |

Forget keeps the existing `setMemoryStatus(id, 'archived')` action and its native confirmation. `preload.cjs` gains one line: `for (const action of ['sessionSummary', 'staleNotes', 'rememberProposals', 'reaffirmMemory']) allowed.add(action);`. `STORE_METHODS` gains `sessionSummary`, `staleNotesForSession`, `rememberProposals` and `reaffirmMemory`.

**Stubs (replaced in Group A):** `sessionSummary` returns the shape from the session row (`changes: session.changeStats ?? null`, `tests: null`, `suggestions: 0`); `staleNotesForSession` returns `{ available: true, notes: [], truncated: false }`; `rememberProposals` loops `acceptProposal` + `setMemoryStatus` without atomicity; `reaffirmMemory` throws `Not available yet`.

### 1.3 Copy (`src/ui/copy.ts`, new `wrapUp` object)

`exited(code, duration)` "Exited 0 after 18m"; `stopped(duration)` "Stopped after 11m"; `interrupted` "Interrupted"; `couldNotStart` "Couldn't start"; `showTerminal` / `showSummary` "Show terminal" / "Back to summary"; `changes`, `openDiff`, `changesTip` "Changes in this checkout since the session started, counted when it ended. Other sessions in the same checkout are included."; `testsRun`, `testsHidden(provider)` "Not visible for Codex"; `continueCard` "Continue this conversation"; identity lines (section 3.1); `worthKeeping` "Worth keeping from this session?"; `nothingKept` "Nothing is kept unless you choose. Remembered notes reach future sessions where they apply."; `looking` "Looking for suggestions…"; `noSuggestions` "No suggestions from this session."; `explainer` (B4); `remember`, `rememberAll(n)`, `edit` "Edit…", `dismiss`, `finishDraft` "Finish draft"; `staleHead(path, n)` "This session changed process.mjs. 1 note is based on it."; `staleBody` "Until you check it, the note is left out of new sessions, so no agent gets an outdated note."; `updateNote` "Update note…", `stillTrue` "Still true", `forget` (existing), `stillTrueHelp` "“Still true” records that you checked it against this change."; resolved texts (B5); `handoff` "Continue with another agent. It gets the same project memory."; `notSaved` "Terminal output is kept in memory only while Journal's runtime runs. It was not saved and is no longer available."; `lastOutput` "Last thing in the terminal"; `copyOutput` "Copy output".

The copy scanner's banned words (`stale`, `approved`, `knowledge`, …) stay out of every `.tsx` string; codes live in `wrapUpModel.ts`.

### 1.4 CSS section

Append `/* === Phase 6: session end === */` to `styles.css` with four blank lines around it.

---

## 2. Group A: core and runtime

### A1. End snapshot (D11) and the proposals event (`terminal.mjs`, `runtime.mjs`)

- In `exited()`, after `persist`, start `entry.changeSnapshot = (async () => { … })()`:
  - `const changes = await this.store.sessionChanges(session.id)` (worker call; Git runs off the runtime thread);
  - `session.changeStats = summarizeChanges(changes)`: `{ available, additions, deletions, files: files.length, preexisting: files.filter(f => f.preexisting).length, paths: files.filter(f => !f.preexisting).slice(0, 200).map(({ path, from }) => ({ path, from })), truncated: changes.truncated || files.length > 200, at, reason }`;
  - `this.persist(session, true); this.emitStatus(session)`. Errors set `changeStats = { available: false, reason, … zeros }`.
- `changeStats` is runtime-owned and lives on `entry.session`, so every later save (survivor scan, release) carries it. It is never recomputed. `dispose` awaits `changeSnapshot` alongside `survivorScan`.
- Failed starts and recovered (`interrupted`) sessions get no snapshot; `sessionSummary` returns `changes: null` and the card says "Changes: open the Files tab" (live).
- **Runtime:** the end hook in `runtime.mjs` sends `{ type: 'proposals', projectId, sessionId, count }` **always**, including `count: 0`, so the wrap-up can stop its placeholder at the real moment. Existing listeners ignore `sessionId` and refetch as today.

### A2. Retained-buffer policy (BUG-8, `terminal.mjs`)

- `export const RETAINED_EXITED = 8`. After an entry exits, `this.trimExited()`:
  - candidates = exited entries ordered by `session.endedAt`, oldest first;
  - skip an entry that is `attached` (someone is viewing it) or whose `survivorScan` or `changeSnapshot` is still pending (dispose must still await them);
  - delete the oldest candidates until at most 8 exited entries remain. A skipped entry is trimmed on a later exit.
- `release(id)` is unchanged. `attach` on a trimmed ID returns `{ chunks: [], gap: true, lastSequence: 0 }` as today. That exact triple (no entry) is how the renderer tells "released" from "exited with no output" (`since(0)` on an empty buffer gives `gap: false`).
- Bound: 4 live + 8 exited × 256 KiB ≈ 3 MiB.

### A3. `sessionSummary` (`insights.mjs`; `store.sessionSummary(id)` wraps it)

- Reads the session row, its events (`listEvents(id, 2000)`) and an open-suggestion count. No Git, no hashing.
- `durationMs = endedAt − createdAt` (null when either is missing).
- `tests`: Claude only. Pair `command-start` events with `body.test === true` to their `command-end` by `toolUseId`; count `succeeded`, `failed`, and the rest as `unknown`. `commands` = distinct start commands, first 3, each cut to 60 characters (event commands are already redacted). Codex and Cursor return `null`.
- `identity`: `{ nativeId, confirmed: nativeIdConfirmed, source: nativeIdSource ?? null, mismatch: !!identityMismatch }`.
- `suggestions`: the count from A5's session filter.

### A4. Remember in one step (D1) and approval in a worktree view (`store.mjs`)

**Split `proposeMemory`** into three internal methods, keeping its public behaviour byte for byte:
- `prepareMemory(projectId, input, { branch, view })`: all validation, Git checks, `captureEvidence(view ?? project, …)` and conflict lookup. Returns `item` plus `expected` (the previous `current_revision` or `null`). No writes, so Git and file I/O never run inside `BEGIN IMMEDIATE`.
- `writeMemory(item, expected)`: the three inserts, **without** a transaction. It first checks `SELECT current_revision FROM memories WHERE id=?` equals `expected` (or that no row exists) and throws `This note changed while you were checking it; try again` otherwise.
- `approveMemory(memory, { via })`: the SQL of today's `setMemoryStatus('active')` branch (status, `approved_at`/`approved_revision`, supersedes, `branch-status` link), plus `this.audit('memory-active', { id, revision, reason: null, supersedes, ...(via ? { via } : {}) })`. No transaction.
- `proposeMemory` = `prepareMemory` + `transaction(() => writeMemory(…))`. `setMemoryStatus('active')` = checks + `transaction(() => approveMemory(memory, {}))`.

**Approval view for worktree branches** (the Phase 0 task 0.6 follow-up):
- `approvalView(memory)`: the primary project when the note isn't branch-scoped or `project.branch === memory.branch`; otherwise `workspaceView` of the first `ready` workspace whose **live** branch (from `workspaceView`, not the stored field) equals `memory.branch`; otherwise the primary project (which reports `wrong-branch`).
- `setMemoryStatus('active')` validates with `this.validation(approvalView(memory), memory)`. Notes with `source.rootId` always use the primary project (folders are project-level).
- `wrongBranch(…, 'approve')` drops the "remembering it from there is not available yet" clause. Revise keeps it: revising from a worktree is still not offered.

**`listProposals(projectId, state, { sessionId } = {})`:**
- With `sessionId`: the session must belong to the project. Walk `resumedFrom` up to 20 hops (each a `getSession`; stop at a missing or purged row) and match `json_extract(body,'$.evidence.sessionId') IN (SELECT value FROM json_each(?))`. The expression is exactly `proposals_session`'s.
- Each row gains `earlier: true` when its session isn't `sessionId` itself. Fingerprints are unique per project, so a resumed session never re-creates a suggestion; it shows the earlier one, marked "Suggested earlier in this conversation".

**`rememberProposals(ids, { via })`:**
- `via` must be `'wrap-up'` (Phase 7 adds `'first-run'` through `rememberDraft`). `ids`: 1–5 distinct strings ≤ 100 characters, else `Choose 1 to 5 suggestions`.
- **Prepare every item first, outside the transaction.** For each ID, the `acceptProposal` checks (open; not `branch-status`; branch present; session present), then `prepareMemory(… , { branch, view: approvalView })`. Refuse the whole batch when:
  - any item `conflicts` with a remembered note: `"<first 60 chars>" may conflict with a remembered note. Review it in Memory.`;
  - a branch item has no view on its branch: `wrongBranch(projectId, branch, 'approve')`;
  - two items in the batch are duplicates of each other (`isDuplicate`).
- **Then one transaction** writes every item (`writeMemory`), marks each proposal `accepted` with `memoryId` and `handledAt`, audits `proposal-accepted` with `{ id, memoryId, kind, via }`, re-reads the candidate and approves it (`approveMemory(memory, { via })`). Any throw rolls everything back.
- Returns the active notes. Single "Remember" calls it with one ID.

### A5. The out-of-date catch (`insights.mjs` `staleNotesForSession`, `hunks.mjs`)

**Changed paths:** from `session.changeStats.paths` (each `path`, plus `from` for a rename). Files that were already changed when the session started are left out: this session can't be said to have changed them. Without a snapshot, use live `sessionChanges` with the same filter and `available: true`; a removed workspace gives `{ available: false }`.

**The view** is where the session ran:
- primary checkout or worktree: `store.view(projectId, workspaceId)`; notes with `rootId === null` match, paths compare as-is;
- an additional folder (`root:<id>`): the primary project; only notes with `source.rootId === <id>` match, and the changed path loses the folder's `pathPrefix` first.

**Matching notes** (active only, `source.kind === 'file'`, at most 20, newest first):
- the path equals a changed `path` or a rename's `from` (then `renamedTo` is set);
- branch-scoped notes only when `memory.branch === view.branch`;
- `store.validation(view, note, cache) === 'stale'`.

**`reaffirm.allowed`**: `false` with `file-missing` when the file no longer exists (renamed or deleted: Update note… or Forget); `separate-copy` for an all-branches note caught in a worktree session (the main checkout's file may still match; it can be checked there after a merge); `wrong-branch` can't occur here but is kept for the reaffirm path. Otherwise `true`, with `workspaceId` = the session's worktree for branch notes and `null` for all-branches notes.

**Hunks (`hunks.mjs`, pure parsing plus two Git readers):**
- `committedMatches(root, commit, path, hash)`: `git cat-file blob <commit>:<path>` (raw bytes, `maxBuffer` 1 MiB + 1) hashed with SHA-256, compared with `contentHash`.
- When it matches: `git diff --no-color --no-ext-diff --no-textconv -U3 <commit> -- <path>` in the view root (`GIT_LITERAL_PATHSPECS=1`, 8 s timeout, 200 KiB cap). `parseHunks(text)` reads `@@ -a,b +c,d @@` headers and numbers every line on both sides. Keep hunks with a removed line in `[startLine, endLine]`, or an insertion point in `[startLine − 1, endLine]`. At most 3 hunks of 40 lines; each line cut to 300 characters.
- Otherwise (captured from uncommitted content, a folder without Git, or the commit is gone): `readEvidenceFile` (exported from `evidence.mjs`, the same symlink, size, binary and sensitive-path rules) gives the current file. `before` = the saved excerpt at `startLine`; `after` = the current lines at the same range, clamped.
- `suggestedRange`: if the excerpt's lines occur exactly once in the current file at another position, that range; else from the hunks, the old range shifted by the line deltas of the hunks before it, clamped to 30 lines; else `null`.

### A6. `reaffirmMemory(id, { startLine, endLine, workspaceId = null })` (`store.mjs`)

- The note must be active with a `file` source, else `Only a remembered note based on a file can be marked still true`.
- **View:** `rootId` notes use the primary project and require `workspaceId === null`. Branch notes use `view(projectId, workspaceId)`, which must be the primary checkout or a `ready` worktree, and its branch must equal `memory.branch`, else `wrongBranch(…, 'approve')`. All-branches notes require `workspaceId === null`, else `Check this note from the main checkout`.
- `validation(view, memory)` must be `stale`, else `This note's file is unchanged; there is nothing to check`.
- `prepareMemory(projectId, { memoryId: id, statement, category, scope, area, environment, source: { kind: 'file', rootId, path, startLine ?? old, endLine ?? old } }, { branch: memory.scope === 'branch' ? memory.branch : null, view })`. Statement, category, scope, area, environment and `supersedes` carry over unchanged. The 1–30 line rule applies.
- One transaction: `writeMemory` (revision n+1; the row briefly becomes `candidate` inside the transaction only), then `approveMemory(fresh, { via: 'reaffirm' })`. Pinning is kept (the `pinned` column isn't touched). History keeps revision n.

### A7. BUG-9: verify, don't rebuild

Phase 2 (`f51059c`) already persists `identityMismatch` (`observe()` sets it and saves; `confirmNativeId` clears it; `recover()` spreads the stored row, so it survives a restart; `nativeIdConfirmed` stays false, so `launch` refuses to resume with `ID_UNCONFIRMED`). Add one test that proves the restart path (A8). No code change unless it fails.

### A8. Tests (Group A)

`tests/session-end.test.mjs` (new; the existing `fixture(t)` helpers):
- `the end snapshot is kept when the checkout changes later`: a fake PTY session writes 3 lines to `a.txt`, exits; `getSession().changeStats` is `{ additions: 3, files: 1 }`; append 5 lines; `sessionSummary().changes.additions === 3` while `sessionChanges().additions === 8`.
- `files changed before the start are counted but not listed`: a dirty `b.txt` at start → `preexisting: 1`, `paths` excludes it.
- `sessionSummary counts Claude test commands and hides them for Codex`: events `command-start {test:true}` × 3 with ends `succeeded, succeeded, failed` → `{ passed: 2, failed: 1 }`, `commands` length ≤ 3; a Codex session → `tests: null`.
- `sessionSummary identity states`: `preassigned-observed` confirmed; Codex `exit-banner` unconfirmed; mismatch → `{ confirmed: false, mismatch: true }`; after `confirmNativeId` → `source: 'user'`, `mismatch: false`.
- `listProposals filters by session and its resume chain`: proposals from A and from B (`resumedFrom: A`) → `sessionId: B` lists both with `earlier` on A's; another session's proposal is absent; a foreign project's session throws.
- `rememberProposals remembers three at once`: 3 open rules → 3 notes `active`, 3 proposals `accepted` with `memoryId`, audits `proposal-accepted` × 3 and `memory-active` × 3 with `via: 'wrap-up'`, `approved_at` set.
- `one bad suggestion leaves the batch unchanged`: IDs `[open, open, dismissed]` → throws `already handled`; the two open ones stay `open`; no new memories, revisions, FTS rows or audits (count before and after).
- `rememberProposals refuses six, duplicates, a branch update and a conflict`: each throws; nothing changes.
- `a worktree branch suggestion is remembered in that worktree's view`: create a ready worktree on `feature/x`, a session there with `test-command` → `rememberProposals` succeeds; the note is `active`, `branch: 'feature/x'`; with the worktree removed it throws the plain `check out that branch` message.
- `setMemoryStatus approves a worktree-branch candidate in the worktree's view` and `still refuses when no copy has the branch`.
- `staleNotesForSession flags a note on a file the session changed`: note on `src/a.js:3–5` at HEAD; the session edits line 4 → one item, `hunks[0].lines` has `-` on old line 4 and `+` on new line 4; a note on an untouched file is absent.
- `a rename's old path is caught`: `git mv a.js b.js` during the session → `renamedTo: 'b.js'`, `reaffirm.allowed: false`, reason `file-missing`.
- `an additional folder's notes map through its path prefix`.
- `hunks outside the note's lines are left out`; `an insertion just above the range counts`.
- `a note saved from uncommitted content uses the excerpt fallback`: `hunks: null`, `before.lines` = excerpt, `after.lines` = current lines.
- `a moved excerpt suggests its new range`: insert 10 lines above → `suggestedRange` shifted by 10.
- `an all-branches note in a worktree session cannot be reaffirmed there` (`separate-copy`).
- `the catch is capped at 20 notes` (`truncated: true`).
- `reaffirmMemory adds revision n+1 and remembers it`: `revision` n+1, `status: 'active'`, new `contentHash`, `memoryHistory` length n+1 with revision n intact, audit `memory-active` `via: 'reaffirm'`, pin kept; `validation` now `current`.
- `reaffirmMemory refuses a current note, another branch and the wrong copy`.
- `reaffirmMemory takes a new line range` (and refuses 31 lines).
- `proposeMemory behaves as before the split`: the existing `knowledge.test.mjs` suite passes unchanged (no edits to its assertions).

`tests/terminal.test.mjs`:
- `a ninth exited session releases the oldest buffer`: nine fake sessions exit in order; `attach(first)` → `{ chunks: [], gap: true, lastSequence: 0 }`; `attach(second)` replays its output.
- `an attached exited buffer outlives older detached ones`.
- `an entry with a pending survivor scan is not trimmed`.
- `the change snapshot is saved at exit and survives later saves` (survivor scan persists after it; `changeStats` is still there).
- `an identity mismatch survives a runtime restart` (BUG-9): mismatch, exit, new manager `recover()` → stored `identityMismatch: true`, `nativeIdConfirmed: false`; `start({ resumeId })` rejects with `ID_UNCONFIRMED`.

`tests/runtime.test.mjs`: `the proposals event names the session and reports zero`.
`tests/storage-worker.test.mjs`: the four new methods round-trip through the worker.

### Group A acceptance

- A batch Remember is all-or-nothing, audited with `via`, and refused for conflicts, branch updates and branches no copy has checked out.
- A worktree-branch note can be remembered without switching the main checkout.
- The catch finds notes on files the session changed, with hunks in the note's own line numbers, in at most one Git diff per note and 20 notes.
- `reaffirmMemory` never edits a revision; history grows by one.
- At most 8 exited buffers stay in memory.
- All four checks pass.

---

## 3. Group B: renderer

### B1. `wrapUpModel.ts` (pure; `node --test` imports it directly)

- `endedView(session)`: `'wrap-up'` for `exited`, `stopped`, `failed` and `interrupted`; `null` for live and `orphaned` (orphans keep today's view with its leftover-process actions).
- `exitLine(session, summary)`: `exited(code, dur)`, `stopped(dur)`, `interrupted`, `couldNotStart`; signal exits read "Ended by <signal> after 3m". Durations: `<1m`, `Nm`, `Nh Mm`.
- `isErrorExit(session)`: `status === 'exited' && exitCode !== 0` or `status === 'failed'`.
- `identityLine(identity, provider)` → `{ text, tone, canContinue, needsConfirm }`:

| State | Text |
|---|---|
| `preassigned-observed` | `Same conversation · ID confirmed by Claude` |
| `preassigned` | `ID set by Journal at start; Claude didn't report it back` (still continuable: Claude took the ID as its argument) |
| `create-chat` | `Chat created by Journal before the start` |
| `exit-banner`, unconfirmed | `From Codex's exit message · confirm before continuing` (amber, `needsConfirm`) |
| `user` | `Confirmed by you` |
| `mismatch` | `Claude reported a different conversation. Confirm the ID before continuing.` (amber, `needsConfirm`) |
| no ID | `No conversation ID yet` (`needsConfirm` for Codex) |

- `testsLine(tests, provider)`: `3 passed`, `2 passed · 1 failed` (failed in `--red` text, not amber), `No test commands seen`, or `testsHidden(provider)`.
- `rememberable(proposal)`: `kind !== 'branch-status'`, no `conflicts`, branch suggestions only when `branchReachable(branch, project, workspaces)`. `rememberAllIds(list)`: the rememberable IDs when there are 2–5 of them, else `null` (the button is hidden).
- `noteActions(note, project, workspaces)` → `{ revise: boolean, approve: boolean }`: for `scope === 'branch' && branch !== project.branch`, `revise: false` and `approve` only when a ready workspace is on that branch. **This is the helper `KnowledgePanel` uses (B8).** It lives here and is re-exported from `noteCardModel.ts`.
- `handoffPrefill(session, receipt, referenceEvents, provider)` → `{ task, references, provider, mode, workspaceId }`: `task = receipt?.query ?? ''`; references = the receipt's `references` plus `inserted` reference events, de-duplicated by `rootKey/path/range`, mapped to `FileReference` inputs (no hashes), capped at `MAX_REFERENCES`; `mode` from the session (`research` → `read-only`, `plan` → `plan`, else `build`), never raised; `workspaceId` the session's when it still exists in `workspaces`, else `''`.
- `createStagedActions({ delayMs: 10000, setTimeout, clearTimeout })` → `{ stage(key, commit), undo(key), flushAll(), pending(key) }`. A staged commit runs after 10 s, on `flushAll()` (view unmount, session switch) or never if undone.

### B2. `useWrapUp.ts`

- On select of an ended session (and on its `status` event while selected): `sessionSummary`, `proposals({ projectId, sessionId })`, then `staleNotes({ sessionId })`. Each reply is dropped if the session changed meanwhile (ticket).
- **Suggestions placeholder:** while the session ended less than 3 s ago and no `proposals` event with this `sessionId` has arrived, `looking: true`. The event (any `count`) refetches and clears it; after 3 s it clears anyway.
- `staleNotes` runs once per session per app run (cached by `sessionId` + `changeStats.at`), and again after a Still true, Forget or Update note save.
- `status` events with a newer `changeStats` refetch the summary only.

### B3. `WrapUp.tsx` (board 6)

Rendered by the Session view in place of `TerminalPane` when `endedView(session)` and the user hasn't chosen Show terminal (per-session state in App, not stored). `SessionHeader` stays above it (Phase 3), so title, provider and workspace aren't repeated.

```
<section aria-labelledby="wrapup-title" class="wrap-up">
  header: <h2 id="wrapup-title" tabIndex=-1>{exitLine}</h2>  [Show terminal]  [Continue ⌘↵ (primary)]
  (error exit) <ExitErrorPanel/> (B7)
  <StaleCatchCard/> × n   (above suggestions, when present)
  suggestions block (B4)
  cards row: Changes · Tests run · Continue this conversation
  hand-off row (B6)
</section>
```

- **Continue ⌘↵** is App's existing resume (`start(session.provider, session)`). Disabled with a visible reason when `!identityLine.canContinue` ("Confirm the conversation ID first"), when slots are full or busy. The confirm-ID row (today's `resume-id`) moves into the Continue card when `needsConfirm`.
- **Changes card:** `+a −d · n files` from `summary.changes`; `· m already changed before the start` when `preexisting`; "Open diff" selects the Files tab on `Changed` (live). `title` = `changesTip`. Without a snapshot: "Open the Files tab to see changes".
- **Tests run card:** `testsLine`; up to 3 commands in mono, `·`-separated.
- **Continue card:** the short ID (`c7d2…81af`, full ID in `title`, Copy button from today's `copySessionNativeId`) and `identityLine`.
- **Keys:** ⌘↵ / Ctrl+Enter = Continue; ⇧⌘↵ / Ctrl+Shift+Enter = Remember all when shown. Handled by one `keydown` listener on `window` while the wrap-up is mounted, only when focus is inside the wrap-up or on `body`, no `dialog[open]` exists, and `!event.isComposing`. Not routed through `shortcuts.mjs`: no terminal has focus in this view. Buttons carry `aria-keyshortcuts` and `<kbd aria-hidden>`.
- **Focus:** when the selected session ends while focus was in its terminal, focus moves to the `h2` (`tabIndex=-1`), because the terminal it was in disappears. Selecting an ended session from the sidebar leaves focus on the row.
- **Announcements:** one polite `role="status"` line, "Session ended. 2 suggestions." after the first summary load. Never per refetch.

### B4. Suggestions

- **Heading** `worthKeeping`, sub-line `nothingKept`, and on the right `Remember all n ⇧⌘↵` when `rememberAllIds` isn't null.
- **First-time explainer** (above the list, once): "These are suggestions. I picked them from what you said and what passed in this session. Remember the useful ones and the next agent starts with them; dismiss the rest." with **Got it**. Shown when there's at least one suggestion and `localStorage['journal-seen-suggestions']` isn't `'1'`; Got it or any Remember/Dismiss sets it. Every storage access is wrapped in try/catch; without storage it shows each time, which is harmless.
- **Each suggestion** is a `NoteCard variant="memory"`-styled card built from the proposal (category, statement, the source line: "You stated this rule in the task" / "Seen in this session's test commands", scope "applies to all branches" / "only on ⑂ branch", `Suggested earlier in this conversation` when `earlier`). `actions`:
  - **Remember** → `rememberProposals({ ids: [id] })`; the card is replaced by a one-line "Remembered. It goes to new sessions where it applies." with **Open in Memory**.
  - **Edit…** → `acceptProposal` (a note waiting for review, as today), then `KnowledgeForm` revising that note. Cancel leaves it under Memory → Needs review, and the card says so. This is the two-step path D1 keeps.
  - **Dismiss** → staged 10 s with **Undo** (a dismissed suggestion is never suggested again).
  - Not rememberable: a conflict shows "May conflict with a remembered note" and **Review in Memory** instead of Remember; an unreachable branch shows "Only on ⑂ feature/x. Check out that branch to remember it" with Remember disabled.
- **Branch update** (`branch-status`): its own card "Where this branch stands" with **Finish draft**, which opens today's status helper (`proposeStatusUpdate('branch')` → `KnowledgeForm` with `draft`). Never in Remember all.
- **Remember all n** → one `rememberProposals({ ids })`. On refusal (atomic) the error shows inline under the heading and nothing changes.
- `looking` → a quiet "Looking for suggestions…" line, no spinner. None after → `noSuggestions`.

### B5. `StaleCatchCard.tsx` (board 14)

- **Lead:** `staleHead(file, n)` and `staleBody`, amber left rule (`--amb` on `--ambsoft`, the existing tokens).
- **Left:** `NoteCard variant="memory"` with trust lines (Phase 5), the evidence line reading `Check needed · file changed`.
- **Right:** "What changed in process.mjs:41 +1 −1", the hunks as a `<table>` of rows with old/new numbers, `-`/`+` marks and text (mono, `dir="ltr"`). Removed and added lines use the diff colours from `ChangesPanel`; screen readers get "removed"/"added" visually hidden labels. Fallback mode shows "Saved lines" / "Now" blocks. `renamedTo` shows "Renamed to b.js" with no diff.
- **Actions:**
  - **Update note…** → `KnowledgeForm` revising the note, with `initialSource` = path and `suggestedRange ?? old range`. Saving creates a revision waiting for review (two-step, unchanged).
  - **Still true** (when `reaffirm.allowed`) → if `suggestedRange` differs from the saved range, a compact inline range row ("The cited lines moved. Lines [41]–[58]", two number inputs, prefilled) must be confirmed first. Then staged 10 s with **Undo**; the commit calls `reaffirmMemory({ id, startLine, endLine, workspaceId })`.
  - **Forget…** → `setMemoryStatus(id, 'archived')`, which shows the existing native confirmation. A cancel returns `null` and leaves the card as it was. Forget has **no Undo** (it can't be reversed; the confirmation is the safeguard).
  - When `!reaffirm.allowed`, Still true is replaced by the reason: `separate-copy` "Changed in this separate copy only. Check it from the main checkout after you merge."; `file-missing` "The file was moved or deleted. Update the note or forget it."
- **Resolved state** replaces the actions in place (no animation): "Marked still true. Checked against this change; new sessions get it again." + Undo (while staged); "Note updated. Your edited version goes to new sessions after you review it."; "Note forgotten. No new session will get it. It stays in History."
- `stillTrueHelp` sits under the actions.

### B6. Hand-off (D12)

- Row: `handoff` text plus one button per **other** provider that is available (`ProviderMark` + name), and **New session with this task** for the same provider.
- Click → `newSession()`, then set the Composer state from `handoffPrefill`: `task`, `references`, `provider`, `mode`, `workspaceId`; `disabled` cleared. Focus lands in the task field with the caret at the end. **No start.** The Composer's live preview shows what this agent would get; only remembered notes travel, because selection reads only active notes.
- A mode the new agent doesn't support stays selected and blocks Start with Phase 4's reason (never silently raised to Build).
- A reference that no longer resolves shows the Composer's existing per-chip error and can be removed.

### B7. Exit-error variant (F19) and `TerminalPane`

- **When `isErrorExit`:** the wrap-up leads with "Session exited with an error", then `lastOutput` above a read-only `TerminalPane live={false}` 240 px high, and actions **Show terminal** (full height), **Continue**, **Copy output**. Suggestions and cards follow ("No suggestions from this session. Changes: none." when empty).
- **`TerminalPane` changes** (small, owned by B):
  - `onUnavailable?(): void`, called when `attach` returns `chunks.length === 0 && gap && lastSequence === 0`. The wrap-up then replaces the pane with `notSaved` (`role="note"`). Show terminal shows the same message.
  - `handleRef?: Ref<{ copyText(maxLines?: number): string }>` reading the last 500 lines of the xterm buffer. Copy output writes it with `navigator.clipboard.writeText` and confirms "Copied" in the status line. Nothing is stored.
- **Show terminal** for any ended session switches the main column to today's read-only `TerminalPane` with **Back to summary**. A released buffer shows `notSaved`.

### B8. Other-branch notes (master 6.2 follow-up)

`KnowledgePanel` uses `noteActions(note, project, workspaces)` for every card, not only under the Other branches toggle: Revise is hidden on another branch's notes; Remember (approve) shows only when a ready separate copy has that branch checked out (A4 makes that work). The backend still refuses with a message naming the branch. App passes `workspaces` (already loaded for the Composer).

### B9. App wiring

- Session view: `endedView(session) && !showTerminal[session.id]` → `WrapUp`; otherwise today's `TerminalPane`.
- `proposals` events with a `sessionId` go to `useWrapUp`; App's `useProposals` refetch is unchanged.
- Switching session or project calls the staged-actions `flushAll()` (commits pending Still true / Dismiss), so leaving never loses a choice. Quitting within the 10 s drops it, which is safe: the note stays left out and the catch shows again.
- `tests/support/ui.ts` gains `showTerminal(page)`: clicks Show terminal if the wrap-up is visible. Every spec that reads an ended session's terminal output calls it first.

### B10. Styles and motion (emil-design-eng applied)

- **No entrance animation** for the wrap-up, the cards or resolved states. A session ends several times a day, often from the keyboard (Stop, Ctrl+C), and the view replaces the terminal in place.
- Hover styles only in `@media (hover:hover) and (pointer:fine)`; explicit transition properties (`background-color`, `border-color`, 120 ms) on buttons only; none under `prefers-reduced-motion: reduce`.
- Dense, readable: the cards row is a 3-column grid that wraps to 1 column below 760 px (container query); diff text 12 px mono; the wrap-up column `max-width: 960px` and scrolls.
- Focus rings use the shared 2 px outline; forced colors map the amber rule to `Highlight`.
- Windows: shortcuts read `Ctrl+Enter` / `Ctrl+Shift+Enter` from the platform shortcut labels; nothing here is Apple-only.

### B11. Tests (Group B)

`tests/wrap-up.test.mjs` (unit):
- `exitLine covers exit codes, signals, stops, interruptions and failed starts`.
- `identityLine for each source and the mismatch` (table above; `canContinue` false for mismatch and unconfirmed Codex).
- `rememberAllIds is hidden for one or more than five and skips branch updates and conflicts`.
- `noteActions hides Revise on another branch and allows approve only with a copy on it`.
- `handoffPrefill copies task, references and mode, never raises the mode, drops a removed workspace`.
- `staged actions commit after 10 s, never after Undo, and at once on flushAll` (`mock.timers`).
- `isErrorExit`; `endedView` keeps orphans out.

`tests/desktop-wrap-up.spec.ts` (fixture CLI with commands `write <file> <text>`, `exit-with <n>`, `print <text>`):
- `ending a session shows the wrap-up with its counts`: task `rule: Release tags must be signed by CI`, `write a.txt …`, `exit-with 0` → heading `Exited 0 after <1m`, `+1 −0 · 1 file`, the suggestion card; Show terminal shows the output; Back to summary returns.
- `Remember puts the note in Memory at once`: Remember → Memory tab lists it as remembered (not Needs review); Project memory badge drops by one.
- `Remember all remembers every suggestion` (two rule lines in the task).
- `Edit adds the suggestion for review`.
- `Dismiss can be undone for ten seconds` (Undo restores the card; no `dismissProposal` call observed via a main hook, following `__journalMenuHook`).
- `the explainer shows once`.
- `hand-off fills the composer without starting`: Codex button → New session view, task field holds the task, Codex selected; live session count unchanged.
- `a session that changed a note's file shows the catch`: add a note on `src/a.js:1–2` via the form, start, `write src/a.js …`, exit → card with the hunk; Still true → resolved line; after 10 s (clock advanced via `page.clock`) the Memory card shows `file unchanged`.
- `Forget asks first and cancel keeps the note` (dialog stubbed).
- `an error exit leads with the last output`: `print boom`, `exit-with 3` → "Session exited with an error", replay contains `boom`; Copy output puts it on the clipboard.
- `a released buffer says it was not saved`: nine sessions exit; selecting the first shows `notSaved`.
- `Continue is disabled until a Codex ID is confirmed`.
- `notes for another branch hide Revise`.

### Group B acceptance

- Board 6, 14 and States panel 5 are matched with the agreed wording.
- Every action is reachable by keyboard; ⌘↵ / Ctrl+Enter continues; nothing animates.
- One-click Remember appears only where the full statement is visible; edits stay two-step.
- No terminal output is persisted; the not-saved message appears exactly when the runtime has no buffer.

---

## 4. Phase verification and status

- Run `npm test && npm run check && npm run build && npm run test:desktop` after each merge (A, then B) and record the counts.
- Update `docs/IMPLEMENTATION-STATUS.md` ("UX redesign, Phase 6": F17–F19, D1 implemented with `via`, D11, D12, BUG-8 fixed, BUG-9 verified) and `docs/ARCHITECTURE.md` (retained-buffer bound, `changeStats`, `hunks.mjs`).
- Add to `docs/NATIVE-VALIDATION.md`: a real Claude exit shows `ID confirmed by Claude`; a real Codex exit shows the exit-banner line and needs confirmation; a real Claude test command fills Tests run.

---

## 5. Decisions

1. **The snapshot stores paths, not only totals** (`changeStats.paths`, ≤ 200), because F18 needs the changed set after the checkout moves on. It is taken once by the runtime and never recomputed.
2. **Files already changed before the session started are excluded from the catch.** The session can't be said to have changed them; Memory's Check needed still lists such notes.
3. **Undo is a 10 s staged commit**, used for Still true and Dismiss, flushed on leaving the view. Remember has no Undo (Forget it from Memory). Forget keeps its native confirmation and has no Undo, because forgetting can't be reversed.
4. **Suggestions that may conflict with a remembered note are not one-click.** They go to Memory for review; D1 requires the full picture on screen, and a conflict is not on screen.
5. **`via` is set by the main process** (`'wrap-up'` here, `'reaffirm'` in core). The renderer can't label its own audit entries.
6. **Branch updates never join Remember all**; they keep their draft helper ("Finish draft").
7. **Edit… means "add for review, then revise".** Cancelling leaves a note waiting for review, and the card says so.
8. **Worktree branches:** approval runs in the view of a ready separate copy on that branch. Revising still needs the main checkout, so Revise stays hidden on other-branch notes.
9. **All-branches notes caught in a worktree session can't be marked still true there** (`separate-copy`), so a worktree's unmerged edit never rewrites the evidence the main checkout relies on.
10. **The proposals event is always sent with `sessionId`**, including zero, so the placeholder ends on the real event.
11. **Every ended session (not orphans) opens on the wrap-up**; Show terminal is one click away. Specs that read an ended terminal call `showTerminal(page)`.
12. **Hand-off is built in the renderer** from the session receipt and reference events App already has; no core call. It never starts a session.
13. **Released vs empty buffer** is told apart by the exact `attach` reply for a missing entry; no new runtime method.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| `writeMemory` validation done outside the transaction races another writer | `expected` revision check inside the transaction; the approval path re-reads the candidate inside it |
| Splitting `proposeMemory` changes behaviour | it is a move, not a rewrite; the existing `knowledge.test.mjs` and `proposals.test.mjs` suites must pass unedited before anything else lands |
| Git diff on a large or binary file | 1 MiB evidence limit, 200 KiB diff cap, `--no-textconv`, 8 s timeout, 20 notes, one diff per note; errors fall back to `before`/`after` |
| The snapshot races the 1.5 s proposal generation or a fast app quit | both run independently; `dispose` awaits `changeSnapshot`; a missing snapshot falls back to live changes, labelled |
| Trimming a buffer the user is about to open | attached entries are never trimmed; 8 is generous for a 4-slot app; the not-saved message is honest |
| Many desktop specs read an ended session's terminal | the `showTerminal` helper; B audits `getByText` on terminal output after Stop/exit in every spec |
| Phase 5 B and Phase 6 B both edit `KnowledgePanel.tsx` | Phase 6 B adds one helper call and rebases on Phase 5 B if it merged first |
| `useWrapUp` fetches compete with terminal load | summary is SQL-only; stale notes once per session; replies dropped on switch |
| A staged Still true is lost on quit | safe by design: the note stays left out and the catch shows again |
| D1 audit truthfulness | `via` set in main; the batch is atomic; tests count audits |

---

## 7. Corrections to the master plan

1. **Task 6.1 snapshot shape:** `{additions, deletions, files}` becomes `changeStats` with `paths`, `preexisting`, `available` and `at` (decision 1). It is taken in `terminal.mjs` through the worker's `sessionChanges`, as planned.
2. **Task 6.2 "a duplicate fingerprint from a resumed session is reported as already suggested":** fingerprints are unique per project, so no duplicate row exists. `listProposals` follows the resume chain and marks the earlier suggestion `earlier`; the test asserts that instead.
3. **Task 6.2 atomicity:** the refactor is three internal steps (`prepareMemory`, `writeMemory`, `approveMemory`) so Git and file I/O stay outside `BEGIN IMMEDIATE`, with an expected-revision check.
4. **Task 6.2 worktree follow-up:** approval only; revising from a worktree stays out of scope. `wrongBranch`'s "not available yet" wording is removed for approval.
5. **Task 6.3 location:** the Git readers and the hunk parser go in a new `src/core/hunks.mjs`; `insights.mjs` keeps the query. Matching excludes files already dirty at start (decision 2). `reaffirmMemory` gains `workspaceId`.
6. **Task 6.3 "Archive":** the button is **Forget…** with the existing confirmation and no Undo (decision 3). Undo applies to Still true (and Dismiss in the suggestions).
7. **Task 6.4:** the proposals event always carries `sessionId` (decision 10); conflicting suggestions and branch updates are excluded from one-click Remember (decisions 4, 6).
8. **Task 6.5:** trimming skips attached and scan-pending entries; `TerminalPane` gains `onUnavailable` and a copy handle.
9. **BUG-9** was fixed in Phase 2 (task 2.5, commit `f51059c`). Phase 6 adds only a restart test; section 4.2's "2, 6" means "fixed in 2, verified in 6".
10. **IPC list (section 4.3):** `staleNotesForSession` is exposed as `staleNotes`; `proposals` gains `sessionId`.
