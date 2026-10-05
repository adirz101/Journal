# Journal UX redesign, Phase 5: Memory trust

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Read `AGENTS.md` first. Group B reads `/Users/azechary/Downloads/skills-main/skills/emil-design-eng/SKILL.md` before any UI edit. If the collection is missing, say so; don't claim you applied it.

**Goal:** Phase 5 of [the UX redesign](2026-10-04-ux-redesign.md) (tasks 5.1–5.3, F15, F16, decision D6). Every note shows where it came from, when you remembered it, what it is based on, whether that file still matches and how many conversations it was sent to. The Memory tab gets category filters with counts, search, an "Other branches" filter and a "Check needed" total.

**Design source:** `…/scratchpad/journal-mock/src/TaskMatch.body.html` (hover card: `Lesson · matches windows worktrees · sent to 4 sessions`, `src/core/workspaces.mjs:132 · File unchanged · Leave out ⌫`) and `WrapUp.body.html` (Memory panel: `All 24 · Project and branch 2 · Decisions 7 · Rules 6 · Lessons 6 · Conventions 3`, cards with `sent to N`, `Out of date`, a branch chip). The wording below replaces the mock's, as agreed with the user.

**Agreed wording (copy keys in `copy.trust`, section 3.2):**

| Line | Text |
|---|---|
| Session origin | `You remembered this <when>, from the session '<title>' (<provider>) ›` |
| Manual | `You added this on <date>` |
| Git draft | `Drafted from Git (<base>..<head>), remembered by you` |
| Removed or purged session | `From a removed session (<provider>, <date>)` |
| Evidence, current | `Based on <path>:<a–b> · file unchanged since you saved it` |
| Evidence, changed | amber `Check needed · file changed` |
| Deliveries | `Sent to N sessions` (N = distinct conversations, D6). Never "used". |

**D6 (user-decided):** count distinct native conversations, keyed by `provider` + `nativeId` and falling back to the session ID. Count `submitted` and `uncertain` deliveries, per note across all its revisions.

**Checks after every commit:** `npm test`, `npm run check`, `npm run build`. Group B also runs `npm run test:desktop` (hidden windows, Electron-native node-pty; check the exit status). Everything here is fixture-only. Phase 5 adds no provider behaviour.

**Out of scope:** one-click Remember and per-session suggestions (Phase 6); the out-of-date catch with hunks and "Still true" (Phase 6, `staleNotesForSession` joins `insights.mjs` then); the composer hover card itself (Phase 4 renders it with this phase's `NoteCard`); exporting delivery counts (the Brain export carries no receipts and gains none).

---

## 0. Groups, order and file ownership

```
Group A  core: migration v8, insights.mjs, listMemoryPage, IPC   (worktree p5a, can start NOW)
Group B  renderer: NoteCard, Memory tab, Session tab cards        (worktree p5b, after Phase 3 merges)
         B0 seam commit lands first, so Phase 4 can build its hover card on NoteCard
```

- **Group A touches no renderer file.** It can run now, in parallel with Phase 3, branched from `claude/ux-redesign`. It merges as soon as its checks pass.
- **Group B starts after Phase 3 Group B (the `MemoryTab`) has merged** and after Group A has merged. It rebases on both. Its first commit, B0, lands on `claude/ux-redesign` alone, so Phase 4's hover card and Phase 6's wrap-up can import the contract.

| File | Owner | Notes |
|---|---|---|
| `src/core/store.mjs`: `migrate` (step 8), `updateReceiptState`, `setMemoryStatus`, `removeProject`, `listMemoryPage`, three new delegating methods | A | Phase 4 task 4.1 edits `prepareContext`, a different method; rebase, don't reformat |
| `src/core/insights.mjs` (new) | A | Phase 6 later adds `staleNotesForSession` and `sessionSummary` |
| `src/core/maintenance.mjs`: `purgeSession`, `storageInfo` table list | A | — |
| `src/core/store-methods.mjs` | A | append three names at the end |
| `src/desktop/main.mjs` (`actions`), `src/desktop/preload.cjs` | A | preload: add a **separate statement** after the allow-list line, so Phase 3's edits to that one long line don't conflict (section 2.5) |
| `tests/insights.test.mjs` (new), `tests/knowledge.test.mjs`, `tests/maintenance.test.mjs`, `tests/retrieval.test.mjs` (version assertion), `tests/storage-worker.test.mjs` | A | — |
| `docs/ARCHITECTURE.md` (storage paragraph, "currently 7" → 8) | A | — |
| `src/ui/NoteCard.tsx`, `noteCardModel.ts`, `useNoteTrust.ts`, `useMemoryChecks.ts` (new) | B | B0 creates `NoteCard.tsx` and `noteCardModel.ts` with the full contract |
| `src/ui/KnowledgePanel.tsx`, `MemoryTab.tsx`, `ContextPanel.tsx` (delivered list only) | B | Phase 4 owns `ContextPreview.tsx`; if Phase 4 also edits `ContextPanel`, the second to merge rebases |
| `src/ui/types.ts`, `copy.ts` (`copy.trust` only), `styles.css` (a new `/* Phase 5: notes */` section), `App.tsx` (MemoryTab props: `sessions`, `onOpenSession`) | B | — |
| `tests/note-card.test.mjs`, `tests/desktop-memory.spec.ts` (new); `tests/copy.test.mjs`, `tests/styles.test.mjs` (assertions for own selectors) | B | — |

---

## 1. Verified starting points (read on 4 October 2026)

- `store.mjs` migrations stop at **v7** (`migrate`, steps 1–7, each re-checked inside `BEGIN IMMEDIATE`; the app and the runtime open the same file). `tests/retrieval.test.mjs:99` asserts `user_version` **7** after migrating from v1, so it must become 8.
- `memories(id, project_id, current_revision, status, pinned)`. Approval writes audit `memory-active` with `{ id, revision, reason, supersedes }` (`setMemoryStatus`); there is no approval timestamp column.
- `revisions.body.createdAt` exists on every revision. Revision 1 has the note's original `source` and (if promoted) `promotedFrom`.
- Receipts: `prepareContext(…, { persist })` stores only launch receipts (Phase 0). `updateReceiptState(id, state, sessionId, launchPrompt)` moves `prepared → submitted | failed | uncertain` and `submitted → uncertain`; it is called by the runtime (`terminal.mjs:171, 182, 544, 600`) and by `recoverSessions`. It is not inside a transaction. `listReceipts` hides old previews (prepared, no session ID, no session naming them).
- Receipt `items[]` hold the delivered memory snapshots with `id` and `revision`.
- `proposals.body`: `kind` (`rule`, `test-command`, `branch-status`), `source` (`rule`: note `Stated as "rule:" in the task of a <provider> session on <YYYY-MM-DD>.`; `test-command`: note `… in session <id>.` and statement `… observed in a <provider> session on <date>`; `branch-status`: `null`), `evidence.sessionId`, `memoryId` once accepted, `createdAt`, `handledAt`.
- `acceptProposal` creates a **candidate** whose revision-1 source is the proposal's `source` (a `user` note), so without the proposal link a session note looks manual. `setMemoryStatus` links open `branch-status` proposals to an approved branch brief (`$.memoryId`).
- `purgeSession` (Phase 0): deletes the session's events, receipts and row; for every proposal of that session it nulls `evidence.sessionId` and `evidence.eventId`, sets `evidence.sessionPurged: true`, and replaces the session ID in `source.note` with "a purged session". It refuses when another session continues the same native conversation. `removeSession` only hides the session and keeps its receipts.
- `listMemoryPage(projectId, { offset, limit ≤ 200, filter: all|review|active|history, search })` returns `{ items (validated), total, offset, limit, counts (per status) }`. `validation()` returns `current | stale | wrong-branch | folder-removed` against the **primary checkout**.
- Session titles: `displayName || title`. A session's `nativeId` can arrive after delivery (Codex exit banner, user confirmation).
- `tests/copy.test.mjs` bans `stale`, `approved`, `receipts`, `knowledge`, `constraint`, `claims` and similar words from visible text in `.tsx` files. Category codes stay in `.ts` modules.
- `tokens.css`: "Amber means 'needs you' and nothing else." A changed file under a note does need the user (decision 4). Today `.memory-state.stale` is red; Phase 5 makes "Check needed" amber.

---

## 2. Group A: core (tasks 5.1, 5.2 and the core half of 5.3)

### A1. Migration v8 (`store.mjs`, step 8)

```js
[8, () => {
  this.db.exec(`CREATE INDEX IF NOT EXISTS proposals_memory ON proposals(json_extract(body,'$.memoryId'));
    CREATE INDEX IF NOT EXISTS proposals_session ON proposals(json_extract(body,'$.evidence.sessionId'));
    ALTER TABLE memories ADD COLUMN approved_at TEXT;
    ALTER TABLE memories ADD COLUMN approved_revision INTEGER;
    CREATE TABLE IF NOT EXISTS deliveries(receipt_id TEXT NOT NULL, memory_id TEXT NOT NULL, revision INTEGER, project_id TEXT NOT NULL,
      session_id TEXT, provider TEXT, native_id TEXT, at TEXT NOT NULL, PRIMARY KEY(receipt_id, memory_id));
    CREATE INDEX IF NOT EXISTS deliveries_memory ON deliveries(project_id, memory_id);
    CREATE INDEX IF NOT EXISTS deliveries_session ON deliveries(session_id);`);
  // Latest approval per note, in one pass over the audit log (no per-row subquery).
  const latest = new Map();
  for (const row of this.db.prepare(`SELECT at, body FROM audit WHERE action='memory-active' ORDER BY id`).all()) {
    try { const body = JSON.parse(row.body); if (typeof body.id === 'string') latest.set(body.id, { at: row.at, revision: Number.isInteger(body.revision) ? body.revision : null }); } catch { /* truncated body: skip */ }
  }
  const set = this.db.prepare('UPDATE memories SET approved_at=?, approved_revision=? WHERE id=?');
  for (const [id, a] of latest) set.run(a.at, a.revision, id);
  this.db.exec(BACKFILL_DELIVERIES);
}],
```

`BACKFILL_DELIVERIES` (module constant, reused by the test as the "on-demand" reference):

```sql
INSERT OR IGNORE INTO deliveries(receipt_id, memory_id, revision, project_id, session_id, provider, native_id, at)
SELECT r.id, json_extract(i.value,'$.id'), json_extract(i.value,'$.revision'), r.project_id,
       coalesce(json_extract(r.body,'$.sessionId'), s.id), json_extract(s.body,'$.provider'), json_extract(s.body,'$.nativeId'),
       coalesce(json_extract(r.body,'$.updatedAt'), json_extract(r.body,'$.createdAt'))
FROM receipts r JOIN json_each(r.body,'$.items') i
LEFT JOIN sessions s ON s.id = coalesce(json_extract(r.body,'$.sessionId'),
  (SELECT s2.id FROM sessions s2 WHERE json_extract(s2.body,'$.receiptId')=r.id LIMIT 1))
WHERE json_extract(r.body,'$.state') IN ('submitted','uncertain') AND json_extract(i.value,'$.id') IS NOT NULL;
```

- Previews were never stored after Phase 0; older preview rows are `prepared` and excluded by the state filter. `failed` receipts are excluded.
- Active notes without any `memory-active` audit (databases older than v4) keep `approved_at = NULL`; the card then says "You remembered this" without a time (section 3.2).

### A2. Keeping the new columns and rows current

- **`setMemoryStatus`:** inside the existing transaction, when `status === 'active'`: `UPDATE memories SET approved_at=?, approved_revision=? WHERE id=?` with one `now()` value and `memory.revision`. Archive and reject leave both columns alone (an archived note still says when it was remembered).
- **`updateReceiptState`:** wrap the read-modify-write in `this.transaction(…)`. When the receipt moves **from `prepared`** to `submitted` or `uncertain`, insert one row per item with `INSERT OR IGNORE` (so `submitted → uncertain` adds nothing). `session_id` is the updated `sessionId`; `provider` and `native_id` are read from that session row at that moment (both may be null); `at` is `updatedAt`. No caller runs inside a transaction today (verified: `terminal.mjs` and `recoverSessions` call it directly), so `BEGIN IMMEDIATE` doesn't nest.
- **`purgeSession`** (`maintenance.mjs`), inside its transaction, before deleting receipts: `DELETE FROM deliveries WHERE session_id=? OR receipt_id=?` (`sessionId`, `session.receiptId`). In the same `UPDATE proposals … json_set(…)` also set `'$.evidence.provider', session.provider` and `'$.evidence.sessionDate', substr(session.createdAt, 1, 10)`. **The title is not kept:** purging deletes what the user typed, and the title comes from the task.
- **`removeProject({ deleteData: true })`:** add `deliveries` to the per-project delete list. `removeSession` and the default `removeProject` keep everything.
- **`storageInfo`:** add `deliveries` to the table list (the Settings data section shows these counts).

### A3. `src/core/insights.mjs` (new): origins and counts

The store delegates: `memoryOrigins(projectId, ids)`, `deliveryCounts(projectId, ids)` and `memoryChecks(projectId, opts)` call the functions below with `this`. Add all three to `STORE_METHODS`.

```js
// ids: 1–200 distinct strings of ≤100 chars, else 'Invalid note list'. Unknown IDs and IDs of
// other projects are simply absent from the result. Uses storedProject (no Git), so it is cheap.
export function memoryOrigins(store, projectId, ids) → { [id]: Origin }
export function deliveryCounts(store, projectId, ids) → { [id]: number }   // every requested own ID present, 0 if none
export function memoryChecks(store, projectId, { offset = 0, limit = 50 }) → { offset, checked, total, stale: string[] }
```

**`Origin`** (also typed in `src/ui/types.ts` by B0):

```ts
interface Origin {
  kind: 'session' | 'manual' | 'git' | 'import' | 'promoted';
  createdAt: string;                         // revision 1
  approvedAt: string | null; approvedRevision: number | null;
  session?: { id: string | null; title: string | null; provider: string | null; date: string | null; state: 'present' | 'removed' | 'purged' };
  git?: { base: string | null; head: string };
  promotedFrom?: { branch: string };
}
```

**Resolution, per ID (in this order):**
1. One query for revision 1: `SELECT m.id, m.approved_at, m.approved_revision, r.body FROM memories m JOIN revisions r ON r.memory_id=m.id AND r.number=1 WHERE m.project_id=? AND m.id IN (SELECT value FROM json_each(?))`.
2. One query for linked proposals: `SELECT body FROM proposals WHERE project_id=? AND json_extract(body,'$.memoryId') IN (SELECT value FROM json_each(?))`. It must use `proposals_memory` (asserted with `EXPLAIN QUERY PLAN`). Ignore `branch-status` proposals here. For several, take the earliest `handledAt`.
3. **A linked `rule` / `test-command` proposal → `session`:**
   - `evidence.sessionId` set and the session row exists: `state` is `removed` when `session.removed`, else `present`. `title` (displayName or title) and `id` are returned **only for `present`**; `provider` and `date` (`createdAt.slice(0,10)`) for both.
   - `evidence.sessionId` null (purged) or the row is gone: `state: 'purged'`, `id: null`, `title: null`. `provider` / `date` from `evidence.provider` / `evidence.sessionDate` (A2). For rows purged before Phase 5: parse `/in the task of a (\w+) session on (\d{4}-\d{2}-\d{2})/` from `source.note` (rule) or `/observed in a (\w+) session on (\d{4}-\d{2}-\d{2})/` from the statement (test-command). Accept only a provider in `PROVIDERS` (`agents.mjs`), else `provider: null`. If no date can be parsed, use `proposal.createdAt.slice(0,10)`.
4. Otherwise, by revision 1: `promotedFrom` → `promoted`; `source.kind === 'git'` → `git` (`base`, `head`); `import` → `import`; `user` or `file` → `manual`.

**`deliveryCounts`** counts at query time, not from the snapshot columns, because a session's native ID is often learned after delivery:

```sql
SELECT d.memory_id AS id, count(DISTINCT CASE
  WHEN json_extract(s.body,'$.nativeId') IS NOT NULL THEN json_extract(s.body,'$.provider')||':'||json_extract(s.body,'$.nativeId')
  WHEN d.native_id IS NOT NULL THEN d.provider||':'||d.native_id
  WHEN d.session_id IS NOT NULL THEN 'session:'||d.session_id
  ELSE 'receipt:'||d.receipt_id END) AS n
FROM deliveries d LEFT JOIN sessions s ON s.id=d.session_id
WHERE d.project_id=? AND d.memory_id IN (SELECT value FROM json_each(?)) GROUP BY d.memory_id
```

**`memoryChecks`** checks the project's current notes (`active` and `candidate`) in the same order as the Memory list (`m.pinned DESC, r.rowid DESC`). It works in chunks of at most **50** (else 'Invalid page'). Each chunk runs `store.validation(project, note, cache)` with one cache per chunk. It returns the IDs whose result is `stale` and `total` = the number of current notes. This is the only Git- and hash-bound call here. Renderers call it chunk by chunk, so other store requests interleave in the worker.

### A4. `listMemoryPage` additions (`store.mjs`)

New options: `category = 'all'` (`choice` over `all` + the six categories), `otherBranch = false` (boolean), `ids = null` (null or 1–200 strings). The existing behaviour and arguments are unchanged.

- `where` gains: `AND (?='all' OR json_extract(r.body,'$.category')=?)`. With `otherBranch`: `AND json_extract(r.body,'$.scope')='branch' AND json_extract(r.body,'$.branch') IS NOT ?` (the primary checkout's branch; with a detached HEAD every branch note counts). With `ids`: `AND m.id IN (SELECT value FROM json_each(?))`.
- **Return** additionally:
  - `categoryCounts: { all, brief, decision, constraint, convention, lesson, issue }`: one `GROUP BY` over the same status, search and other-branch conditions **without** the category condition, so the chips show what each choice would list;
  - `otherBranch: number`: the same `where` without the category or other-branch conditions, plus the other-branch condition.
- Validation still runs only for the returned page.

### A5. IPC (`main.mjs`, `preload.cjs`)

```js
memoryPage: ({ projectId, offset, limit, filter, search, category, otherBranch, ids }) => store.listMemoryPage(projectId, { offset, limit, filter, search, category, otherBranch, ids }),
memoryOrigins: ({ projectId, ids }) => store.memoryOrigins(projectId, ids),
deliveryCounts: ({ projectId, ids }) => store.deliveryCounts(projectId, ids),
memoryChecks: ({ projectId, offset, limit }) => store.memoryChecks(projectId, { offset, limit }),
```

In `preload.cjs`, add after the `allowed` line: `for (const action of ['memoryOrigins', 'deliveryCounts', 'memoryChecks']) allowed.add(action);`. Group B folds it into the set literal once Phase 3 has merged.

### A6. Tests (Group A)

`tests/insights.test.mjs` (new) uses a fixture like `knowledge.test.mjs`: a Git repo, a store and `openProject`. Deliveries are created without the runtime: `prepareContext` (persist) → `saveSession({ id, projectId, provider, nativeId, receiptId, title, createdAt, status: 'exited' })` → `updateReceiptState(receipt.id, state, session.id)`.

1. **`migration v8 from a v7 database file backfills approvals and deliveries`**
   - Build it with the current code: two notes approved (one approved twice across a revision), a third still a candidate. Add receipts in each state: submitted, uncertain, `submitted → uncertain`, failed and prepared-with-session, plus one legacy preview row inserted raw (`prepared`, no session).
   - Close, then turn the file into a v7 one with raw `DatabaseSync`: drop `deliveries`, its two indexes and the two proposal indexes, `ALTER TABLE memories DROP COLUMN approved_at` / `approved_revision`, then `PRAGMA user_version=7`.
   - Reopen. Assert:
     - `user_version` is 8;
     - the `deliveries` row count equals `SELECT count(*) FROM receipts r, json_each(r.body,'$.items') WHERE state IN ('submitted','uncertain')`;
     - for each note, `deliveryCounts` equals an on-demand distinct-conversation count over `json_each` (written in the test, not with `deliveries`);
     - `approved_at` / `approved_revision` equal the last `memory-active` audit's `at` / `revision`; the candidate stays `NULL`;
     - `EXPLAIN QUERY PLAN` of the origins proposal lookup mentions `proposals_memory`.
   - Reopening again is a no-op (the row counts don't change).
2. **`deliveries: previews and failed launches are not counted`**: `prepareContext({ persist: false })` → 0 rows; failed → 0; prepared with a session → 0; submitted → 1; then `submitted → uncertain` → still 1 row and a count of 1.
3. **`deliveries: a resume chain counts once`**:
   - Two sessions with the same `codex` + `nativeId`, each with its own receipt, both submitted → 1.
   - A third with another native ID → 2.
   - Two sessions without native IDs → +2 (session fallback).
   - A Codex session delivered with `nativeId: null` whose ID is then saved (`saveSession`) to match its resume's → counted once (the count joins the live session row).
4. **`deliveries: one note counts across its revisions`**: deliver r1 in session A, revise, approve and deliver r2 in session B → 2. Rows record revisions 1 and 2.
5. **`purge removes a session's deliveries; remove keeps them; deleting project data clears them`** (`maintenance.test.mjs`):
   - `purgeSession` lowers the count by one, and no `deliveries` row names the session or its receipt.
   - `removeSession` leaves the count unchanged.
   - `removeProject({ deleteData: true })` leaves 0 rows for the project and keeps other projects' rows.
6. **`memoryOrigins: every kind`**:
   - `manual` (user source and file source), with `createdAt` = revision 1;
   - `git` (a status-helper draft saved with a `git` source), `{ base, head }`;
   - `import` (via `importBrain`);
   - `promoted` (`proposePromotion`), `promotedFrom.branch`;
   - `session`: a `rule:` task → `generateProposals` → `acceptProposal` → `setMemoryStatus('active')` gives `state: 'present'`, the title, `provider` and an `approvedAt`;
   - a branch brief approved with an open `branch-status` proposal is still `git` or `manual` per its revision 1, never `session`.
7. **`memoryOrigins: removed and purged sessions`**:
   - `removeSession` → `removed`, title and ID `null`, provider and date kept.
   - `purgeSession` → `purged` with `evidence.provider` / `evidence.sessionDate`.
   - Legacy purged proposals (strip the two fields with `json_remove`): `rule` → provider and date parsed from the note; `test-command` → parsed from the statement. A note naming an unknown provider gives `provider: null`.
8. **`memoryOrigins: a revised note keeps its revision-1 origin`**: revise a session note twice and approve. The kind stays `session`, and `approvedRevision` is 3.
9. **`memoryOrigins and deliveryCounts validate input and scope`**: 201 IDs or a non-string throws; another project's ID is absent; an unknown ID is absent from the origins and reports 0 in the counts.
10. **`listMemoryPage: category, counts and other branches`** (`knowledge.test.mjs`):
    - `category: 'lesson'` lists only lessons;
    - `categoryCounts` ignore the category but respect `filter` and `search`;
    - on `main`, a note for `feature/x` counts in `otherBranch`, and `otherBranch: true` lists only it;
    - `ids` limits the page;
    - `category: 'nope'` and 201 IDs throw;
    - existing callers without the new options get the same `items` as before.
11. **`memoryChecks: chunks and a changed file`**:
    - 60 current notes give two chunks (50 + 10) with `total: 60`.
    - After editing `tests.md`, the file note is in `stale`; before the edit it isn't.
    - `limit: 51` throws.
12. **`setMemoryStatus records the approval time`**: `approved_at` is set on approval and kept after archive.
13. `retrieval.test.mjs`: the v1 → latest assertion becomes 8. `storage-worker.test.mjs`: the worker exposes the three new methods.

### Group A acceptance

- A v7 database opens as v8 in both processes (app and runtime) with no data loss. The backfilled counts equal the on-demand `json_each` counts.
- Previews and failed launches never count. `uncertain` counts. A resumed conversation counts once. Purge lowers the count; removal doesn't.
- Origins: the proposal lookup runs on `proposals_memory`; one origins call for 200 IDs costs three SQLite queries and no Git.
- `memoryChecks` is the only call that hashes files, at most 50 notes per call.
- `npm test`, `npm run check` and `npm run build` pass. No renderer file has changed.

---

## 3. Group B: renderer (task 5.3 and the trust lines of 5.2)

### B0. Seam commit: "Phase 5 seams: NoteCard contract"

This commit lands on `claude/ux-redesign` before the rest of Group B. It creates `noteCardModel.ts` with its tests and a `NoteCard.tsx` that renders the statement, category and evidence lines. It also adds the types and copy. Phase 4's hover card and Phase 6's wrap-up import exactly this contract.

```ts
// types.ts
export interface MemoryOrigin { /* the Origin shape from A3 */ }
export interface NoteTrust { origin?: MemoryOrigin | null; sent?: number | null }   // undefined = still loading: render nothing for that line
export interface MemoryPage { /* … */ categoryCounts?: Record<string, number>; otherBranch?: number }

// NoteCard.tsx
export type NoteCardVariant = 'memory' | 'receipt' | 'hover' | 'preview';
export function NoteCard(props: {
  note: Memory;                       // current note (memory, hover, preview) or a delivered snapshot (receipt)
  project: Project;                   // root names for folder evidence, current branch
  variant: NoteCardVariant;
  trust?: NoteTrust;
  matched?: string[];                 // Phase 4: matched task words → "matches a b"
  checkNeeded?: boolean;              // overrides validation (the receipt variant shows freshness at launch only)
  onOpenSession?(sessionId: string): void;   // the "›" link; omitted → plain text
  onLeaveOut?(): void;                // preview and hover: "Leave out ⌫"
  actions?: ReactNode;                // Memory tab buttons (Remember, Pin, Revise…)
  children?: ReactNode;               // extra rows (conflicts, evidence details)
}): JSX.Element;

// noteCardModel.ts (pure; node --test imports it directly)
export function whenText(iso: string, now: number): string;         // "today", "yesterday", "3 days ago" (< 7), else "4 Oct 2026" (Intl, en-GB date)
export function originLine(note: Pick<Memory,'status'>, origin: MemoryOrigin | null | undefined, now: number): { text: string; sessionId: string | null } | null;
export function evidenceLine(note: Memory, rootName?: string): { text: string; tone: 'quiet' | 'amber' } | null;
export function sentLine(n: number | null | undefined): string | null;
export const CATEGORY_ORDER: readonly string[];                       // all, brief, decision, constraint, lesson, convention, issue
```

### B1. Line rules (`noteCardModel.ts`)

**`originLine`, for `status === 'active'`:**

| Origin | Text |
|---|---|
| `session`, `present` | `You remembered this <when(approvedAt)>, from the session '<title>' (<Provider>) ›` (`sessionId` set) |
| `session`, `removed` / `purged` | `You remembered this <when>. From a removed session (<Provider>, <date>)`. With an unknown provider: `From a removed session (<date>)` |
| `manual` | `You added this on <date(createdAt)>` |
| `git` | `Drafted from Git (<base7>..<head7>), remembered by you`. Without a base: `Drafted from Git (up to <head7>), remembered by you` |
| `import` | `Imported on <date(createdAt)>, remembered by you` |
| `promoted` | `Proposed for all branches from ⑂ <branch>, remembered by you` |

- With `approvedAt` null, "You remembered this <when>" becomes "You remembered this".
- **Candidate, rejected or archived:** the same origin clause without "You remembered this", for example `From the session '<title>' (<Provider>) ›` or `You added this on <date>`. The status chip already says what state the note is in.
- The provider name comes from the existing provider labels (`Claude Code`, `Codex`, `Cursor`).

**`evidenceLine`** (file sources only; others return `null`, because Git and statements are covered by the origin line):

| `validation` | Text | Tone |
|---|---|---|
| `current` | `Based on <folder/><path>:<a>–<b> · file unchanged since you saved it` (`:<a>` when a = b) | quiet |
| `stale` | `Check needed · file changed` (the path stays in the `title`) | amber |
| `wrong-branch` | `Based on <path>:<a–b> · only on ⑂ <branch>` | quiet |
| `folder-removed` | `Based on <path>:<a–b> · its folder was removed from the project` | quiet |

- In the **`receipt`** variant (a delivered snapshot), the suffix is `checked when the session started`, because freshness now says nothing about what was sent.

**`sentLine`:** `null` (loading) → nothing; 0 → `Not sent yet`; 1 → `Sent to 1 session`; n → `Sent to n sessions`. It has a `title` of `copy.trust.sentTip`: "Counted once per conversation, including resumes. Includes starts where Journal could not confirm delivery."

### B2. `NoteCard.tsx` layout and behaviour

- **Rows:** meta row (category · matched words · pinned; status chip on the right); statement (`dir="auto"`); scope row (branch, area, applies-when, `r<n>`); the origin line; the evidence line; the sent line; then `children` and `actions`.
- **Layout by variant:**
  - `hover` and `preview` keep one line each, with ellipsis and the full text in `title`;
  - `memory` wraps the text;
  - `receipt` shows origin and sent, plus evidence with the receipt suffix.
- **Semantics:** `<article aria-label="<category>: <first 80 chars>">`. The origin link is a real `<button className="link">` with the visible text. The sent count has no interaction.
- **Amber** uses `--amb` on `--ambsoft`, the existing tokens, so the contrast test already covers it. No new colour.
- **No animation.** Hover styles go in `@media (hover:hover) and (pointer:fine)`. There is no `transition: all`. The amber line never pulses.
- `.memory-state.stale` moves from red to amber (`--amb`/`--ambsoft`), so "Check needed" looks the same everywhere.

### B3. Trust data hooks

```ts
// useNoteTrust.ts
export function useNoteTrust(projectId: string | null, ids: string[], version: number): Record<string, NoteTrust>;
```

- Calls `memoryOrigins` and `deliveryCounts` in parallel for IDs missing from its cache, in batches of ≤200.
- Caches per project. It clears on a `version` change, which App bumps on knowledge changes **and** on session status events that reach `running` (a new delivery).
- Drops replies for a previous project (ticket counter). A failure leaves those lines blank and never shows a toast for every card.

```ts
// useMemoryChecks.ts
export function useMemoryChecks(projectId: string | null, seed: Memory[], active: boolean, version: number):
  { stale: Set<string>; checked: number; total: number | null; done: boolean };
```

- **Seeds** from the visible page's `validation === 'stale'` items, so the visible page counts first.
- **Then** runs `memoryChecks` chunks of 50 one at a time, while `active` (the Memory tab is visible and the document is visible). It stops at 1000 notes and shows `Checked 1000 of N`.
- **Restarts** on `version`, on a project switch, when the tab becomes visible again, and on window `focus` (files change outside Journal). At most one scan runs at a time; a restart cancels the running one at the next chunk boundary.

### B4. Memory tab filters (`KnowledgePanel.tsx`, rendered by `MemoryTab`)

The layout, top to bottom, under the existing `Project memory` heading and the suggestions block (Phase 3):

1. **Search** (existing `knowledge-search`, 150 ms debounce) and `＋ Add`.
2. **Category chips:** a `div role="group" aria-label="Category"` of `<button aria-pressed>`, single choice.
   - Labels: `All n`, `Project and branch n` (`brief`), `Decisions n`, `Rules n` (`constraint`), `Lessons n`, `Conventions n`, `Known issues n`.
   - A chip with 0 is hidden unless it is selected. Counts come from `categoryCounts`.
3. **Status and attention row:**
   - the existing status buttons (`Current`, `Needs review n`, `Remembered`, `History`);
   - then two toggles: `Check needed n` and `Other branches n`.
   - **Check needed:**
     - The count shows `…` with `aria-busy` while the scan runs. The final count is announced once through a polite live region ("3 notes need a check"), never per chunk.
     - It is amber only when n > 0.
     - Selecting it sends `ids = [...stale]` (≤200; beyond that, a note reads "Showing the first 200").
   - **Other branches** sends `otherBranch: true`. Its cards hide Revise and Remember, as in the master-plan note for task 6.2; the backend already refuses with a message naming the branch.
   - The two toggles exclude each other and combine with category, status and search.
4. **The list:** a `NoteCard variant="memory"` per item. Today's actions move into `actions` unchanged. The conflict block and the evidence disclosure move into `children`.
5. **Empty states:**
   - "No notes need a check" when Check needed is on and nothing is stale;
   - "No notes for other branches" when Other branches is on and nothing matches;
   - otherwise today's texts.

Filters are App-run state (not stored), so the tab keeps them while you switch tabs. A project switch resets them.

### B5. Session tab (`ContextPanel.tsx`)

The delivered-notes list renders `NoteCard variant="receipt"` with `trust` from `useNoteTrust` keyed by the snapshot's `id`. Excluded and left-out lists keep their current rows. This is the only change to `ContextPanel`.

### B6. App wiring (`App.tsx`)

- `MemoryTab` and `SessionTab` receive `sessions` (the loaded list, including archived ones when loaded) and `onOpenSession(id)`.
- `onOpenSession(id)` selects the session if it is in the list; otherwise the line renders without "›".
- A `trustVersion` bumps with `knowledgeVersion` and on a session status event to `running`.

### B7. Tests (Group B)

**`tests/note-card.test.mjs`** (pure, with a fixed `now`):
- `originLine` for each kind × `present` / `removed` / `purged` / unknown provider, active and candidate, `approvedAt` null.
- `whenText` boundaries: today, yesterday, 6 days, 7 days → a date.
- `evidenceLine`:
  - every validation;
  - a = b;
  - a folder name;
  - the receipt suffix.
- `sentLine` for 0, 1 and 2.
- No line contains "used", and none contains the words `copy.test.mjs` bans.

**`tests/desktop-memory.spec.ts`** (new, fixture provider, hidden windows):
1. **Category chips filter and count:**
   - add a decision, two lessons and a rule, and remember them;
   - `Lessons 2` lists two cards;
   - `All 4`;
   - searching "docker" updates the counts;
   - a zero chip is hidden.
2. **Check needed counts a changed file:**
   - remember a note on `tests.md`; its card reads `file unchanged since you saved it`;
   - edit the file on disk, then focus the window (or re-show the tab);
   - the toggle reads `Check needed 1`, and the card shows `Check needed · file changed` in amber (computed colour equals `--amb`);
   - selecting the toggle lists only that card.
3. **Other branches:** a note remembered on `feature/x` while checked out, then check out `main` and reopen the project. `Other branches 1`; its card has no Revise or Remember.
4. **Origin and Sent to:**
   - start a fixture session whose task has `rule: Integration tests always need Docker running` and let it exit;
   - Add for review → Remember. The card reads `You remembered this today, from the session '<title>' (<provider>) ›`, and activating "›" selects that session;
   - start a second session whose task matches the note; the card reads `Sent to 1 session` (the first session's task created the rule, but the note did not exist yet at its launch);
   - a manual note reads `You added this on <date>`.
5. **Session tab cards:** the second session's Session tab shows the note as a card with `Sent to 1 session` and the `checked when the session started` suffix.
6. **Keyboard:**
   - Tab reaches the chips, the toggles and the origin link in order;
   - Enter and Space toggle `aria-pressed`;
   - the focus ring is visible on each (`:focus-visible`).
- `tests/styles.test.mjs`: new hover rules sit inside the pointer media query; `.memory-state.stale` uses amber tokens.
- `tests/copy.test.mjs`: `NoteCard.tsx` and `KnowledgePanel.tsx` pass the visible-term scan with no new `ALLOWED` entries (category codes live in `noteCardModel.ts`).

### Group B acceptance

- **Every note card in Memory and Session shows:**
  - its origin with the agreed wording;
  - for file sources, a freshness line;
  - a "Sent to" count that matches `deliveryCounts`.
- Filters combine, and counts reflect the other active filters.
- "Check needed" counts the visible page at once and the rest asynchronously, without blocking typing or terminal output. The worker handles at most one 50-note chunk at a time.
- No decorative motion. Keyboard access to all controls. Hover is gated by pointer capability.
- All four checks pass. Results are recorded in `docs/IMPLEMENTATION-STATUS.md` under "UX redesign - Phase 5 (memory trust)", fixture-only.

---

## 4. Decisions

1. **Counts join the live session row** (Group A3). The snapshot `provider` / `native_id` in `deliveries` is only a fallback, because Codex and confirmation flows learn the native ID after delivery. Without the join, a resume chain would count twice.
2. **Removed and purged sessions share one wording,** `From a removed session (<provider>, <date>)`. A removed (hidden) session's title is withheld too, because the user hid it. The origin link appears only for a present session that App can select.
3. **Purge keeps provider and date on its proposals, never the title** (A2). The title comes from the task text that purge exists to delete. Older purged rows use the parse fallback.
4. **"Check needed" is amber.** The user agreed this wording, and a changed source asks the user to look, which is the meaning tokens reserve amber for. The red `stale` chip becomes amber to match.
5. **The check-needed total is project-wide over current notes,** independent of the active filters. The toggle then lists those notes through `ids`. Validation can't run in SQL, and per-filter scans would multiply the hashing.
6. **`branch-status` is not a separate origin kind.** A branch brief's origin is whatever its revision 1 was (`git` from the helper, or `manual`), which already reads "Drafted from Git".
7. **Session-tab cards show freshness at launch only** (`checked when the session started`). They describe what was sent, and receipts are immutable.
8. **`NoteCard` belongs to Phase 5, and B0 lands first.** Phase 4's hover card and Phase 6's wrap-up import it instead of forking a card.

---

## 5. Risks

| Risk | Mitigation |
|---|---|
| The app and runtime open the file at once during v8 | the existing per-step re-check inside `BEGIN IMMEDIATE`; `CREATE … IF NOT EXISTS`; `ADD COLUMN` runs only inside the version-guarded step |
| `ALTER TABLE … DROP COLUMN` (used only by the test to build a v7 file) is missing from the bundled SQLite | Node 24 bundles SQLite 3.53 (checked), and `DROP COLUMN` exists since 3.35. If it fails, rebuild `memories` without the columns in the test |
| Large audit logs slow the v8 backfill | a single ordered scan into a Map, then one `UPDATE` per approved note; no correlated subqueries |
| `updateReceiptState` in a transaction meets a caller that already holds one | verified none today; a test calls it through `recoverSessions`; a nested call would fail loudly in tests, not silently |
| Expression indexes aren't used because the query text differs | the queries use exactly `json_extract(body,'$.memoryId')`; the migration test asserts the plan |
| Check-needed scans compete with terminal and IPC load | 50 notes per call, one at a time, paused when hidden, capped at 1000; results are announced once |
| Phase 2 B/C, Phase 3 and Phase 4 edit `store.mjs`, `main.mjs`, `preload.cjs` or `ContextPanel.tsx` at the same time | Group A adds methods and touches only the named functions; preload uses a separate statement; Group B rebases after Phase 3 and coordinates `ContextPanel` merge order with Phase 4 |
| An inflated "Sent to" from `uncertain` deliveries | D6 counts them by the user's decision; the tooltip says so |
| Old purged proposals lack provider and date | parse fallback; unknown → `From a removed session (<date>)`; tested |

---

## 6. Corrections to the master plan

1. **Task 5.2 origin kinds:** `branch-status` is folded into `git` (decision 6). There are five kinds: `session`, `manual`, `git`, `import` and `promoted`.
2. **Task 5.2 purged fallback:** "read provider and date from `proposal.source.note`" works only for `rule` proposals. `test-command` notes carry the session ID, which Phase 0's purge now replaces. Phase 5 records `evidence.provider` / `evidence.sessionDate` at purge and parses the statement for older rows.
3. **Task 5.1 `deliveries` columns** are kept, but counting joins `sessions` for the current native ID (decision 1).
4. **Task 5.1 "removal doesn't decrement"** means `removeSession` (hide). `removeProject({ deleteData: true })` deletes the project's deliveries along with its receipts.
5. **Task 5.3 needs a fourth core call,** `memoryChecks(projectId, { offset, limit ≤ 50 })`, for the asynchronous total, and `listMemoryPage` gains `ids` and `otherBranch` as well as `category`. Add `memoryChecks` to section 4.3's IPC list.
6. **Task 5.1 also updates `updateReceiptState`** to run in a transaction, and **`setMemoryStatus`** to write `approved_at` / `approved_revision`.
7. **`tests/retrieval.test.mjs`** asserts `user_version` 7 and becomes 8. `docs/ARCHITECTURE.md` says "currently 7" and gains the `deliveries` table.
8. **The `NoteCard` lines** use the user-agreed wording in this plan's header. The master plan's "You remembered this <when>, from the session…" and "Sent to N sessions" are unchanged; "Drafted from Git" gains ", remembered by you", and removed sessions gain their own line.
9. **Stale styling:** `.memory-state.stale` changes from red to amber (decision 4).
