# Journal UX redesign, Phase 4: Composer and live preview

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Read `AGENTS.md` first. Before any UI edit, read `/Users/azechary/Downloads/skills-main/skills/emil-design-eng/SKILL.md`. Group B also reads `apple-design/SKILL.md` (hover-card intent, interruptible pointer handling) from the same collection. If the collection is missing, say so; don't claim you applied it.

**Goal:** Phase 4 of [the UX redesign](2026-10-04-ux-redesign.md) (tasks 4.1–4.3, F13, F14, decisions D3 and D4). The New session view becomes the board B5 composer:
- agent cards that are honest about installation and sign-in;
- a Build / Plan / Read-only switch;
- one Start button (⌘↵ / Ctrl+Enter);
- a live "What the agent will know" preview with Leave out (⌫);
- matched-word underlines in the task box (board B13), a hover card and a keyboard-reachable "N notes match" button.

**Design source:** the approved boards (local HTML) in `…/scratchpad/journal-mock/src/`:
- `NewSession.body.html` (B5);
- `TaskMatch.body.html` (B13): underlines; the hover card is closed by default and opens on hover or from the button;
- `FirstSession.body.html` (B3): only its sparse "Relevant to your task" state belongs to Phase 4. Phase 7 owns the rest of first run.

The logic for the agent defaults and the mode help text is in `…/journal-mock/out/project/NewSession.dc.html`. Use `base.css` for structure only; the tokens already exist in `src/ui/tokens.css`.

**Prerequisite:** all of Phase 3 (groups A, B and C) is merged on `claude/ux-redesign`. Phase 4 reads these contracts:
- Phase 3 B's `NewSessionView.tsx`, the main-column split and `InspectorTab`;
- Phase 3 A0's `tests/support/ui.ts` helpers (`newSession`, `inspectorTab`) and its CSS section markers;
- Phase 2's `ERROR_CODES` (`SLOTS_FULL`, `PROVIDER_MISSING`) and the `code` that `api()` rethrows.

Step **A0** checks each of these names against the merged code and fixes this plan if anything drifted.

> **A0 check (4 October 2026):** A0 was cut from `15f8e86`, before Phase 3 merged. Phase 2's `ERROR_CODES` (`src/core/terminal.mjs`) and the preload's `code` on rejected requests exist. `NewSessionView.tsx`, `InspectorTab` and `tests/support/ui.ts` do not exist yet, so Group B rebases on the merged Phase 3 before B0 and rechecks section 1.6 there. `api()` passes the preload's error through unchanged, so `code` reaches callers.

**Checks after every commit:** `npm test`, `npm run check`, `npm run build`. Renderer and desktop changes also need `npm run test:desktop` (hidden windows, Electron-native node-pty; check the exit status). Every result here is fixture-only. Phase 4 adds no provider behaviour, and launch argv, native settings, permissions and exact-ID resume don't change.

**Out of scope:**
- Note trust lines ("sent to 4 sessions", "File unchanged" from delivery data): Phase 5.
- Claude/Codex `auth status`: Phase 7. Cards never claim "signed in" without data.
- The "+ Reference @" file picker: Phase 8, because it needs `searchFiles`. References are still added from Files → "Reference in next task".
- First-run mascot screens: Phase 7.
- Hand-off prefill: Phase 6.
- Motion. Typing, previews and the hover card are high-frequency, so none of them animates (see B7).

---

## 0. Groups, order and file ownership

```
A0 contract commit (Group A implementer, on claude/ux-redesign)
 ├── Group A  core: previewSelection, term spans, selection.terms, IPC, spec   (worktree p4a)
 └── Group B  renderer: Composer, ContextPreview, TaskField, selectors          (worktree p4b)
merge A → B (B rebases on A and reruns all four checks)
```

- **A0 goes first** (section 1). It freezes every cross-group contract and ships a working **stub** of `previewSelection`, so B can build and run desktop tests before A's SQL-only implementation exists.
- **A and B then run in parallel**, each in its own git worktree branched from A0.
- **Merge order: A, then B.** Before merging, B rebases on A and runs the whole suite. A's tests pin the result shapes, so B's code stays valid after the swap.

| File | Owner | Others may touch |
|---|---|---|
| `src/core/retrieval.mjs`, `src/core/retrieval.d.mts` (new) | A0 (`queryTermSpans`, real), then A | — |
| `src/core/store.mjs`, `src/core/store-methods.mjs` | A0 (stub), then A | — |
| `src/desktop/main.mjs` (`previewSelection` action only), `src/desktop/preload.cjs` (one allow-list entry) | A0 | — |
| `docs/TERMINAL-FIRST-SPEC.md` (lines 17 and 29) | A | — |
| `tests/retrieval.test.mjs`, `tests/preview-selection.test.mjs` (new), `tests/storage-worker.test.mjs`, `tests/benchmark.test.mjs` | A | — |
| `src/ui/types.ts` (`SelectionPreview`, `Mode`, `selection.terms`), `src/ui/copy.ts` (`composer` object) | A0 | B may fix wording |
| `src/ui/Composer.tsx`, `ContextPreview.tsx`, `TaskField.tsx`, `NoteCard.tsx`, `composerModel.ts`, `taskMirror.ts`, `useContextPreview.ts` (new) | B | — |
| `src/ui/App.tsx`, `NewSessionView.tsx`, `ContextPanel.tsx`, `styles.css` (new section `/* === Phase 4: composer === */`) | B | — |
| `tests/composer.test.mjs`, `tests/task-mirror.test.mjs`, `tests/preview-scheduler.test.mjs`, `tests/desktop-composer.spec.ts` (new), `tests/support/ui.ts` (`startSession`, `chooseMode`), every desktop spec in B8, `tests/copy.test.mjs` | B | — |

---

## 1. A0: the contract commit (before forking)

One commit: "Phase 4 seams: preview contract, term spans, copy". Existing behaviour doesn't change, and all four checks pass.

### 1.1 `queryTermSpans` (real, in `retrieval.mjs`)

```js
// Ranges of identifierParts(value) with UTF-16 offsets into value.
export function identifierPartRanges(value, offset = 0) → [{ part, start, end }]
export function identifierParts(value) { return identifierPartRanges(value).map(r => r.part); }  // same output as today
// Every occurrence of every term queryTerms(text, limit) would produce, in text order.
export function queryTermSpans(text, limit = 24) → [{ term, start, end, whole: boolean }]
```

- Words come from `text.matchAll(/[\p{L}\p{N}_./-]+/gu)`. The `whole` span is the word with leading and trailing `./-` trimmed. Part spans come from `identifierPartRanges(word, index)`.
- A span is kept only when its term is in `queryTerms(text, limit)`. Terms past the limit are never searched, so they are never underlined.
- Camel-case boundaries are computed without changing the string's length. Lowercasing is applied only to the `term` value, never to the offsets, so `text.slice(start, end)` is always the original text.
- `src/core/retrieval.d.mts` declares `queryTerms`, `queryTermSpans` and `identifierParts`, so the renderer can import the module under `tsc` strict. `retrieval.mjs` has no `node:` imports; a test enforces this (A7).

### 1.2 Result shapes (`src/ui/types.ts`; core returns exactly these)

```ts
export type Mode = 'build' | 'plan' | 'read-only';
export interface SelectionInfo { reason: string; bytes: number; terms?: string[] }   // terms: raw task terms FTS matched (new receipts only)
// Receipt.items[].selection becomes SelectionInfo; Receipt gains terms?: string[] (searched terms).
export interface SelectionPreview {
  kind: 'selection'; checked: false; query: string; branch: string | null;
  items: (Memory & { selection: SelectionInfo })[];   // same order and rules as a receipt
  excluded: { id: string; reason: string }[];          // never 'stale': evidence is not read
  warnings: string[]; bytes: number;                   // packet bytes before references and drift text
  terms: string[];                                     // queryTerms(task + reference paths)
  taskNotes: number;                                   // remembered non-brief notes on this branch or all branches (one COUNT)
}
```

### 1.3 IPC (`main.mjs`, `preload.cjs`, `store-methods.mjs`)

- `previewSelection: ({ projectId, task, workspaceId, branch, disabled, references }) => store.previewSelection(projectId, task, { workspaceId: workspaceId ?? null, branch: branch ?? null, disabled: disabled ?? [], references: references ?? [] })`.
- Add `'previewSelection'` to the preload `allowed` set and to `STORE_METHODS`.
- In `types.ts`, add `previewSelection` to `READS_KNOWLEDGE`. A preview right after a Remember then includes the new note; the wait is bounded at 10 s, as today.

### 1.4 The stub (replaced in A3)

`previewSelection` calls `prepareContext(…, { persist: false })` and maps the result to `SelectionPreview` (`checked: false`, `bytes = Buffer.byteLength(packet)`). Each item gets `selection.terms` from today's substring `hit` heuristic, and `taskNotes` uses the real COUNT query.
- Mark it `// A0 stub: replaced by the SQL-only selection (Phase 4 A3)`.
- The stub runs Git and reads evidence. That is acceptable for B's development, never for release; A3's tests fail against it.

### 1.5 Copy (`src/ui/copy.ts`, new `composer` object)

Use sentence case and the plain vocabulary. Every key goes in now:

```ts
export const composer = {
  newSession: 'New session', checkoutLine: (name: string, branch: string, sha: string) => `${name} · ${branch} at ${sha}`,
  task: 'Task', taskHint: 'optional, picks relevant notes', taskPlaceholder: 'What are you working on? Mention a module or path to include notes about it.',
  agent: 'Agent', mode: 'Mode', build: 'Build', plan: copy.plan, readOnly: copy.readOnly, workspace: 'Workspace', manage: 'Manage',
  modeHelp: { build: 'Normal native permissions. The CLI asks before it runs tools.',
    plan: 'Starts in Claude plan mode or Cursor Plan mode. You can switch inside the session.',
    'read-only': 'The agent can read but is asked not to change files (Claude plan mode, Codex read-only sandbox, Cursor Ask). You can switch inside the session.' },
  separateCopyHelp: 'Isolated from your other sessions. Journal never stashes, copies or force-removes your work.',
  start: (name: string) => `Start ${name}`, nativeStays: 'Your native login, settings and approvals stay with the CLI.',
  installed: (version: string | null) => version ? `Installed · ${version}` : 'Installed', signedIn: 'Signed in', signInNeeded: 'Sign in needed',
  notInstalled: 'Not installed', install: 'Install…', signIn: 'Sign in…', checking: 'Checking…', unsupported: 'Unsupported version',
  notCursor: 'Not the Cursor CLI', cantLaunch: 'Can’t launch',
  noPlan: (name: string) => `${name} has no plan mode. Choose Build or Read-only.`, noModes: 'This Cursor version has no modes. Choose Build.',
  slotsFull: '4 sessions are running. Stop one to start another.', runtimeDown: 'The runtime is reconnecting. Start is available again once it connects.',
  agentMissing: (name: string) => `${name} isn’t installed on this computer.`,
  updatesAsYouType: 'updates as you type', notes: 'Notes', size: 'Size', notChecked: 'Sources are checked when you start', checked: 'Sources checked',
  notesMatch: (n: number) => n === 1 ? '1 note matches' : `${n} notes match`, hoverHint: 'hover an underline',
  notesMatching: (word: string) => `Notes matching “${word}”`, matches: 'matches', leaveOutShort: 'Leave out',
  leaveOutTip: (mac: boolean) => `Tip: press ${mac ? '⌫' : 'Delete'} on a note to leave it out of this session only.`,
  inspectAll: 'Inspect all', restore: 'Restore', relevantNone: 'No remembered note matches this task yet.',
  relevantEmpty: 'Nothing here yet. After this session, I’ll suggest rules and lessons worth keeping. The ones you remember show up here when they match your task.',
  previewFailed: (message: string) => `Preview unavailable: ${message}`,
} as const;
```

Extend `the vocabulary itself avoids the old terms` in `tests/copy.test.mjs` to `composer`, calling each function with sample arguments.

### 1.6 The NewSessionView seam (contract only; B implements it)

`NewSessionView` (Phase 3 B) keeps its file and its place in the main column. Phase 4 replaces its body with a header and `<Composer {...props} />`:
- the header shows `composer.newSession` and `checkoutLine`;
- the `terminal-empty` art goes.

App owns the state; the Composer is presentational plus its preview hook:

```ts
export interface ComposerProps {
  project: Project; bootstrap: Bootstrap | null; workspaces: WorkspaceList | null;
  workspaceId: string; onWorkspace(id: string): void; onManageWorkspaces(): void;
  task: string; onTask(value: string): void; taskRef: RefObject<HTMLTextAreaElement>;
  references: FileReference[]; onRemoveReference(index: number): void;
  disabled: string[]; onDisabled(next: string[]): void;
  provider: Provider; onProvider(p: Provider): void; mode: Mode; onMode(m: Mode): void;
  connected: boolean; liveCount: number; busy: boolean;
  onStart(): void;                       // App's start(provider) with modeFlags(mode)
  onInspect(receipt: Receipt): void;     // set the receipt, show the inspector's Session tab
  cursor: { checking: boolean; note: string; onInstall(): void; onLogin(): void; onCheck(): void };
  startError: { code?: string; message: string } | null;
}
```

---

## 2. Group A: core (task 4.1, D3, D4)

**Files:** `src/core/retrieval.mjs`, `src/core/store.mjs`, the spec, and the A-owned tests. Use TDD: failing test, run, implement, run, commit.

### A1. Pin today's packets first

Before refactoring, add `prepareContext packets are unchanged by the selection refactor` to `tests/preview-selection.test.mjs` and commit it green against the current code.
- **Fixture:** two checkout briefs, one branch brief, two pinned rules, one area-scoped claim reached through a referenced folder, an FTS match set with a duplicate, five claims of one category (to hit category-limit), and enough text to hit the 12-item or 6000-byte budget.
- **Assert:** `packet` (with the receipt UUID replaced), item IDs, `selection.reason`, `excluded` and `warnings` all equal a literal snapshot.

### A2. Split `prepareContext` into shared stages (no behaviour change)

Private methods inside `JournalStore`:
- `selectCandidates(projectId, view, { areaQuery, terms, referencedPaths, check })` returns today's `matches` array. It covers the brief, pinned, area and paged-FTS stages, with SQL and ordering unchanged. `check(item)` returns the validation word. FTS paging counts an item as eligible when `check` returns `'current'` or `'unchecked'` and `areaMatches` holds.
- `assemblePacket(matches, view, { id, disabled, areaQuery, drift })` contains today's loop: exclusions, duplicates, the brief limit, the category limit and the 12-item/6000-byte budget, plus the packet text and the warnings. It returns `{ items, excluded, warnings, packet }`. `drift(memory)` is `this.drift(project, memory, cache)` for `prepareContext` and `() => null` for previews.
- After the split, `prepareContext` is `view` → `resolveReferences` → `selectCandidates(check = full validation)` → `assemblePacket` → `selection.terms` (A4) → the receipt. A1 stays green.

### A3. `previewSelection(projectId, task, { workspaceId, branch, disabled, references })`

SQLite only. It never runs Git, reads evidence files or hashes, and never writes.
- **Input:** the same `text(task, 'task', 4000, true)`, `refuseCredentials` and `disabled` checks as `prepareContext`. `branch` is `null` or `text(branch, 'branch', 255)`.
- **View, from stored records only:** `describe(storedProject(projectId))`.
  - A removed project throws as `project()` does.
  - `workspaceId`: a worktree must come from `getWorkspace` (SQL), belong to the project and be `ready`. A `root:<id>` must be in the stored `roots`. Otherwise the same messages as `view()`.
  - `branch` comes from the caller's hint: the branch the renderer shows for the selected checkout or worktree. It is never trusted for launch, because the idle full preview and the launch both recompute it with Git.
- **References:** never `resolveReferences`, because it hashes files. Their paths extend `areaQuery`. As in `resolveReferences`, a reference is primary when its `rootKey` is `'checkout'` or a worktree ID (not `root:`), whatever copy the session runs in, and primary paths feed the area stage. When both the session and a reference are primary but in different copies, it throws `resolveReferences`' message ("<path> is in <copy>, but this session runs in <copy>. Reference it from the session's own copy."); an unknown root throws `fileRoot`'s message. Root keys resolve from stored records (`storedRoot`), without checking the disk. Each `path` goes through `treePath`.
- **Cheap check:** `folder-removed` (stored roots), `wrong-branch` (hint; a guard only, because `selectCandidates` filters branch scope in SQL first), otherwise `'unchecked'`. `assemblePacket` treats `'unchecked'` like `'current'`.
- **Result:** `{ kind: 'selection', checked: false, query, branch, items, excluded, warnings, bytes: Buffer.byteLength(packet), terms, taskNotes }`. `taskNotes` is one `COUNT(*)` of active non-brief notes in scope for the branch, with `selection.terms` from A4.
  - Warnings that need validation (budget, briefs) are kept as computed.
  - The "no brief" warning is dropped, because the preview can't know it yet.

**Cost:** at most five selection queries (with the `taskNotes` count), ten FTS pages and 24 term checks (A4). Zero child processes, zero file reads, zero writes.

### A4. `selection.terms` through per-term FTS checks

After assembly, for `prepareContext` and `previewSelection` alike:

```js
const ids = JSON.stringify(items.filter(i => i.category !== 'brief').map(i => i.revisionId));   // ≤ 12
const check = this.db.prepare(`SELECT revision_id FROM memory_fts WHERE memory_fts MATCH ? AND revision_id IN (SELECT value FROM json_each(?))`);
for (const term of terms) for (const { revision_id } of check.all(`"${term.replaceAll('"', '""')}"`, ids)) termsByRevision.get(revision_id).push(term);
```

- At most 24 statements, one per term. FTS's porter stemming decides the match, so "retries" matches a note that says "retry", and nothing matches by prefix.
- Briefs get `terms: []`. They are independent of task words, so they never cause an underline.
- `selection.reason` doesn't change: old receipts and `selectionReason` keep working, and `terms` is additive. Old receipts without `terms` load unchanged.
- The receipt also stores `terms` (the searched list). Receipts stay immutable after insert.

### A5. Spec amendment (D3, D4; delegated by the user, applied here)

In `docs/TERMINAL-FIRST-SPEC.md`:
- **Line 17 (D3):** replace "hashes are cached only within one operation." with: "hashes are cached only within one operation, never across previews. While the user types, the composer preview (`previewSelection`) reads SQLite only: no Git, no evidence reads and no writes, so its notes are shown as not yet checked. After about one second of idle, the composer runs a full validating preview that stores nothing, and a launch validates again."
- **Line 29 (D4):** "before the 16-term limit" → "before the 24-term limit (`queryTerms`)".

Then:
- In `docs/IMPLEMENTATION-STATUS.md`, record D3 and D4 as applied in Phase 4. Master Phase 9 no longer applies them (correction 11).

### A6. Benchmark

In `tests/benchmark.test.mjs`, follow its existing style. On its largest fixture, time `previewSelection` beside `prepareContext` for the same task and assert `previewSelection` is no slower than `prepareContext`. Log both; there is no absolute millisecond bound, which would be flaky on CI.

### A7. Tests (named, with their key assertions)

**`tests/retrieval.test.mjs`:**
- `identifierParts output is unchanged by the range refactor`: the existing alias fixtures (`readTable`, `jsonStore.mjs`, `src/payments/retry.mjs`, `HTTPServer`) give the same arrays.
- `queryTermSpans marks camelCase parts, paths and repeated words`. For `Fix createRefund in src/payments/retry.mjs, then refund again`:
  - spans include `createrefund` 4–16 (whole), `create` 4–10, `refund` 10–16, `payments`, `retry`, and `refund` at both occurrences;
  - `new Set(spans.map(s => s.term))` equals `new Set(queryTerms(text))`.
- `queryTermSpans keeps UTF-16 offsets for Unicode`: a fixture with combining marks, an astral emoji before a word, and CJK (write it with `\u` escapes, per AGENTS.md). For every whole span, `text.slice(start, end).toLowerCase() === term`.
- `queryTermSpans never marks terms past the limit`: 30 distinct words with `limit = 24` give exactly 24 distinct terms.
- `retrieval.mjs is renderer-safe`: the source has no `from 'node:` import.

**`tests/preview-selection.test.mjs`:**
- `taskNotes counts in-scope non-brief notes`: two active rules, one brief and one other-branch note give `taskNotes === 2` with the hint `main`.
- `previewSelection writes nothing`: `SELECT total_changes()` is equal before and after (on the same connection), and the receipt and audit row counts are unchanged.
- `previewSelection never runs Git or reads evidence`:
  - Set `process.env.PATH` to an empty temp directory (restore it in `t.after`). `previewSelection` succeeds, and the same call to `prepareContext` throws (the guard is real).
  - Delete a cited evidence file. The preview still includes that note; the full preview excludes it as `stale`.
- `previewSelection selects what prepareContext selects when every source is current`: on the A1 fixture, the item IDs, their order, `selection.reason`, `selection.terms` and the `excluded` reasons are equal for a checkout session, an additional-folder (`root:`) session referencing the checkout and a worktree session; an area note sharing no word with the task is selected in both. A primary reference from another copy and unknown roots throw the same messages.
- `prepareContext packets for an additional-folder session are unchanged`: a second literal snapshot (a `root:` session, a drifted branch update with Git-range evidence, an environment qualifier, folder evidence, `area-not-requested`, and the brief-limit and missing-brief warnings).
- `wrong-branch and removed-folder notes are excluded from the stored records alone`: with the branch hint `feature/x`, a `main`-scoped branch note is never a candidate (SQL filters branch scope before ranking, as in `prepareContext`), so it is neither selected nor listed as excluded; `storedValidation` called directly returns `wrong-branch` for it. A note whose folder was removed is excluded as `folder-removed`.
- `previewSelection validates input like prepareContext`: a 4001-character task, a credential-shaped task, more than 100 disabled IDs, and a worktree from another project each throw the same message.
- `selection.terms records the task words FTS matched`: the note "Retry payment refunds with exponential backoff" and the task "payment retries please" give `['payment', 'retries']`; `retr` alone gives `[]`; brief items always give `[]`.
- `receipts without selection.terms still load`: insert a v-today receipt body; `getReceipt` returns it unchanged.

**`tests/storage-worker.test.mjs`:** `previewSelection is callable through the worker` (same shape).

### Group A acceptance

- A keystroke preview runs only SQLite statements (bounds in A3). With Git off the PATH it still works, and the store's change counter doesn't move.
- `prepareContext` output is byte-identical to before, apart from the added `selection.terms` and `terms` (A1 snapshot).
- The spec reads 24 terms and states the preview rule; the status doc records D3 and D4.
- All four checks pass, including the desktop run, since main and preload changed.

---

## 3. Group B: renderer (tasks 4.2, 4.3)

### B0. Start

Branch from A0. Read the merged `NewSessionView.tsx`, the `App.tsx` regions (Phase 3 A0 markers) and `tests/support/ui.ts`. Where Phase 3 names drifted from section 1.6, fix this plan first.

### B1. `composerModel.ts` (pure; `node --test` imports `.ts` directly)

- `modeFlags(mode)`: `build` → `{ plan: false, research: false }`, `plan` → `{ plan: true, research: false }`, `read-only` → `{ plan: false, research: true }`. The launch inputs stay exactly as today.
- `modeSupport(provider, agent)` gives `{ build: true, plan, 'read-only' }`:
  - **Codex:** `plan: false` (`noPlan`).
  - **Cursor:** `plan` and `read-only` require `agent.supports?.mode` (`noModes`).
  - **Claude:** all three.
- `agentCard(agent)` → `{ sub, tone: 'ok' | 'warn' | 'muted', action?: 'install' | 'login' }`:
  - `checking` or no agent: `checking`, muted;
  - `login-required` or `auth === 'signed-out'`: `signInNeeded`, warn, `login` when `supports?.login`;
  - available: `installed(version)`, plus ` · ${signedIn}` **only** when `auth === 'signed-in'` (Cursor's real check). Claude and Codex never show it before Phase 7;
  - `unsupported`, `not-cursor` and `unlaunchable`: the matching copy, warn;
  - missing: `notInstalled`; Cursor gets `install`. The Claude/Codex tooltip reads "Not found on PATH".
- `startBlock({ connected, liveCount, busy, agent, provider, mode })` gives the first reason as a string, or `null`, in this order: busy (no text), `runtimeDown`, `slotsFull`, `agentMissing`, `noPlan`/`noModes`.
- **Switching agents never changes the mode.** Choosing Codex while Plan is selected keeps Plan, marks it unsupported and blocks Start with `noPlan`. A silent switch to Build would raise permissions without the user choosing it.
- `previewView(result, disabled)` normalizes a `SelectionPreview` or a preview `Receipt` into:

  ```ts
  { checked, always: Item[], relevant: Item[], notIncluded: { reason, count }[], notes: number, bytes: number, matchedTerms: Set<string>, matchCount }
  ```

  - `always` holds briefs, `relevant` everything else (pinned rules carry a "Pinned" chip).
  - `matchCount` counts relevant items with at least one term.
  - The meter shows `notes / 12` and `KB / 6`, prefixed with `≈` while `!checked`.

### B2. `useContextPreview.ts` and its scheduler

The hook wraps `createPreviewScheduler({ debounceMs: 250, idleMs: 1000, request })`, a pure class with injected timers that `tests/preview-scheduler.test.mjs` exercises with `mock.timers`.
- **Each input change** (task, workspace, branch, disabled, references) increments `ticket` and restarts both timers.
- **After 250 ms**, `previewSelection`. At most one is in flight; a change during flight sets `dirty`, and one request follows the reply.
- **After 1000 ms idle**, `prepareContext` (main already forces `persist: false`). At most one is in flight. Its reply wins over any selection reply with the same or an older ticket.
- **A reply is applied only if its ticket is the latest.** A late full check never overwrites newer typing.
- **Leave out and Restore** request immediately (no debounce), then idle as usual.
- **`flush()`** runs the full check now and returns the `Receipt`. "Inspect all" uses it.
- **Errors** (for example the credential refusal) return `{ error }`. The preview shows `previewFailed(message)` in its own `role="status"`. It never calls App's `setError`, so typing never raises the global alert banner.
- A project or workspace switch resets everything and drops all in-flight tickets.

### B3. `Composer.tsx` (board B5)

The main column scrolls in this view. The layout is `grid-template-columns: minmax(0,1fr) 360px` with a 32 px gap and `max-width: 1080px`. A container query below 760 px stacks the preview under the form; the inspector stays as Phase 3 left it (decision 2).

**Form** (`<form aria-label="Start a session">`, `onSubmit` = Start):
1. `TaskField` (B4), then the reference chips (today's markup, moved) with "Paths and lines only; the agent reads the files itself."
2. **Agent:** a `role="radiogroup"` `aria-label="Agent"` with three `role="radio"` cards, using roving `tabIndex`, arrow keys and Home/End.
   - Each card shows `ProviderMark` (24 px), `PROVIDER_NAMES[p]` and the `agentCard` sub-line.
   - Unavailable agents stay selectable, so their action is reachable. The action is a separate button inside the card's region, not nested inside the radio. For Cursor, `CursorStatus` sits below the cards while Cursor is selected.
   - App remembers the choice in `localStorage['journal-agent']` (try/catch). The default is the first available agent in the order Claude, Codex, Cursor.
3. **Mode:** a segmented `role="radiogroup"` `aria-label="Mode"`: Build / Plan / Read-only.
   - An unsupported segment has `aria-disabled="true"` and a `title` with the reason, and stays focusable. A checked one stays checked.
   - `<p id="mode-help">` holds `modeHelp[mode]`.
4. **Workspace:** today's `<select aria-label="Workspace">` options, plus a `Manage` button (`aria-label="Manage workspaces"`) that opens `WorkspaceDialog`. `separateCopyHelp` shows while a worktree is selected.
5. **Start:** one `button.primary type="submit"` named `composer.start(PROVIDER_NAMES[provider])`, for example "Start Claude Code".
   - It holds `<kbd aria-hidden>⌘↵</kbd>` (`Ctrl+Enter` off macOS) and `aria-keyshortcuts="Meta+Enter"` / `"Control+Enter"`.
   - Disabled while `startBlock` returns a reason, which shows beside it (`role="status"`).
   - `nativeStays` sits under it.
   - **⌘↵ / Ctrl+Enter** is handled by the form's `onKeyDown`, scoped to the composer. It isn't routed through `shortcuts.mjs`: the terminal can't hold focus in this view, and IME composition (`event.isComposing`) is ignored.
   - A rejected start with `code === 'SLOTS_FULL'` shows `slotsFull` inline; `PROVIDER_MISSING` asks for `providerStatus` and shows the card state. Other codes use the existing banner; the Phase 8 states sheet replaces it.
   - After a start, App selects the new session (unchanged); the text in the task box is taken at submit time, as today.

### B4. `TaskField.tsx` and `taskMirror.ts` (board B13)

**`taskMirror.ts` (pure):** `segments(text, spans, matched: Set<string>)` → `{ text, term?: string }[]`.
- The concatenation equals `text`.
- A whole span is marked when its term matched; otherwise its matched parts are marked. Overlaps are resolved left-to-right, and the longest span wins.
- A trailing `\n` gets a zero-width space, so the mirror's height matches.

**`TaskField`** (`forwardRef` to the textarea):
- `<label for="task">Task</label>` with `<span id="task-hint">optional, picks relevant notes</span>`, so `getByLabel('Task', { exact: true })` finds the field.
- **Structure:** `div.task-field` (position relative) holds an `aria-hidden` `div.task-mirror` underneath and the `<textarea id="task" maxLength=4000 dir="auto">` on top with a transparent background.
  - Both share the class `.task-input`: font, size, line height, padding, border width, `box-sizing`, `white-space: pre-wrap`, `overflow-wrap: anywhere`, `tab-size` and `scrollbar-gutter: stable`. The shared class is the alignment contract, so styles are never copied by script.
  - Mirror text is `color: transparent`. `mark` has no background: `text-decoration: underline 2px var(--accent); text-underline-offset: 3px` (board B13).
  - The textarea auto-grows from 3 to 8 rows, then scrolls; the mirror's `scrollTop` follows `onScroll`.
- **Spans** = `queryTermSpans(task)`, imported from `../core/retrieval.mjs` and computed on the **current** text every render. Matched terms come from the latest applied preview, so stale results never misplace underlines. While `compositionstart…end` is active, the last segments are kept (no IME flicker).
- **Hover:** `pointermove` on the textarea hit-tests `mark.getClientRects()`, cached per render and invalidated on scroll or resize.
  - Over a mark for 300 ms, the hover card opens for that term. Moving between marks once a card is open switches instantly (tooltip warm-up pattern).
  - It closes 150 ms after the pointer leaves both the mark and the card. That grace lets the pointer travel into the card.
  - Wrapped in `matchMedia('(hover: hover) and (pointer: fine)')`: touch and pen users use the button.
- **The "N notes match" button** sits under the field when `matchCount > 0`: `notesMatch(n)`, then ` · hoverHint` on fine pointers. Its count text has an `id`; the textarea's `aria-describedby="task-hint task-matches"`.
  - The button opens the same card listing every matched note (`aria-expanded`, `aria-controls`).
  - The count updates only when it changes, so screen readers aren't flooded per keystroke (`aria-live="polite"` on the count span).
- **The hover card** is a non-modal `role="dialog"` with `aria-label={notesMatching(word)}` (or "Notes matching your task" from the button). It holds interactive content, so it isn't a `tooltip`.
  - It renders a `NoteCard` per note: category chip, `matches` with each term in `<mark>`, the statement, the evidence path, a "Checked when you start" or "Current" chip (from `checked`), and a `Leave out` button (`aria-label={copy.leaveOut}`).
  - **Closed by default.** Esc closes it only while focus is inside it, returning focus to the button (or the textarea). Clicking outside closes it.
  - There is no open or close animation.

**`NoteCard.tsx` (minimal):** `{ memory, terms?, checked, onLeaveOut? }`. Phase 5 adds trust lines to the same component.

### B5. `ContextPreview.tsx` (`<aside aria-label="Context preview">`)

- **Heading:** `copy.willKnow`, with `updatesAsYouType` as a muted end label. It isn't live, since the counts carry the news.
- **Meter:** two bars, `Notes n / 12` and `Size x.x / 6 KB`, as `role="meter"` with `aria-valuenow/min/max`. Widths change without a transition. While unchecked, the label reads `≈` and `notChecked`; once checked, `checked`.
- **"Every session knows":** brief `NoteCard`s.
- **"Relevant to your task":** non-brief `NoteCard`s with their `matches` chips. With no task, `relevantNone` is muted. With `taskNotes === 0` (the latest selection preview's value), `relevantEmpty` is the board B3 sparse state.
- **Rows** are `li` with `tabIndex` roving (one tab stop for the list; arrows move). Backspace or Delete on a focused row leaves it out and moves focus to the next row. Each row also has a visible `Leave out` button, which hover reveals on fine pointers and focus always reveals.
- **"Not included":** chips `n out of date`, `n other branch`, `n left out by you · Restore`, from `excluded` reasons via `excludedReason`. Then `Inspect all`, which calls `flush()` and then `onInspect(receipt)`: App sets the receipt and shows the inspector's Session tab, where `ContextPanel` shows the full packet and `context-packet`.
- **Footer:** `leaveOutTip(mac)`.

### B6. App, NewSessionView and ContextPanel

- **App:**
  - `research` and `plan` become `mode: Mode` (default `build`) and `provider: Provider`.
  - `start()` takes the provider from state and sends `modeFlags(mode)` (resume is unchanged).
  - `newSession()` focuses `taskRef`.
  - Remove the three Start buttons, `Preview context ↗`, the mode checkboxes, the provider line and the duplicated `CursorStatus` from the New session view.
- **The `onToggle` path in `ContextPanel`** for a preview receipt now also feeds the composer's `disabled`. A leave-out in the inspector and one in the composer stay one state.
- **ContextPanel:**
  - The empty state becomes "Type a task in New session to see what the agent will know."
  - Item reasons prefer `selection.terms` ("Matches retries, payment") and fall back to `selectionReason(reason)`.
  - Remove the "Preview context" wording.

### B7. Styles and motion (emil-design-eng applied)

| Element | Rule | Why |
|---|---|---|
| Underlines, hover card, preview list, meter | no transition, no keyframes | high-frequency and keyboard-driven; animation would lag typing |
| Start button | `transform: scale(0.97)` on `:active`, `transition: transform 120ms ease-out`; `none` under `prefers-reduced-motion` | presses should feel responsive; this is the only motion here |
| Agent cards and segments | `background-color`/`border-color` hover only inside `@media (hover:hover) and (pointer:fine)`; selected = 1.5 px accent border + `aria-checked` | gate hover by pointer; selection state never depends on hover |
| Hover card | `position: absolute` anchored under the mark's first rect, clamped to the field; `--raised` surface, `--line2` border, 10 px radius | it never covers the line being hovered |
| Focus | the shared `:focus-visible` ring on cards, segments, rows, the button and the card's controls | clear focus for a keyboard-first cockpit |

No `transition: all`. Type sizes keep the Phase 1 floor (11 px minimum).

### B8. Tests

**Unit:**
- `tests/composer.test.mjs`:
  - `modeFlags maps Build, Plan and Read-only to today's launch flags`;
  - `modeSupport blocks Codex Plan and Cursor modes without supports.mode`;
  - `switching agents never changes the mode`;
  - `agentCard never says signed in without auth data`: Claude/Codex fixtures with `auth` undefined contain no "Signed in"; Cursor `auth:'signed-in'` does;
  - `startBlock reports runtime, slots, missing agent and mode in order`;
  - `previewView groups briefs, counts matches and marks unchecked sizes with ≈`.
- `tests/task-mirror.test.mjs`:
  - `segments cover the text exactly once`;
  - `a matched whole word is underlined as one mark; only matched camelCase parts otherwise`;
  - `a trailing newline keeps the mirror height`;
  - `Unicode offsets match the textarea` (escapes).
- `tests/preview-scheduler.test.mjs`:
  - `three keystrokes inside 250 ms send one selection request`;
  - `a stale reply is dropped`;
  - `the full check runs after 1 s idle and a late one never overwrites newer typing`;
  - `leave-out requests immediately`;
  - `errors stay in the preview`.

**New `tests/desktop-composer.spec.ts`** (fixture agents; remember notes through the existing helpers):
- `typing updates the preview without storing receipts`:
  - Remember "Worktree removal refuses locked worktrees and keeps the branch". Type `worktree removal`.
  - Within 2 s the `Context preview` region's "Relevant to your task" lists it, and the meter reads `Notes`.
  - `api('project').receipts.length` is unchanged.
  - After about 1.2 s idle, the meter shows `Sources checked`.
- `matched words are underlined and the hover card leaves a note out`:
  - `.task-mirror mark` has the text `worktree`.
  - Hovering its box opens `getByRole('dialog', { name: /Notes matching/ })` with the statement.
  - `Leave out for this task` removes the note from the preview; Not included shows `1 left out by you`; `Restore` brings it back.
- `N notes match is keyboard reachable`: Tab from the task reaches `1 note matches`; Enter opens the card; Esc closes it and focus returns to the button.
- `Codex keeps Plan selected but blocks Start`:
  - Choose Plan, then the Codex card. The Plan radio is still checked with `aria-disabled="true"`, Start is disabled, and `Codex has no plan mode` shows.
  - Choose Read-only, and Start is enabled.
- `Cmd/Ctrl+Enter starts from the task box`: press `Meta+Enter` (darwin) or `Control+Enter` in the textarea. A session starts, and its receipt `query` equals the typed task.
- `Backspace on a focused preview note leaves it out`.
- `agent cards are honest`: the fixture Claude card reads `Installed · <fixture version>`; no card contains `Signed in`; with Cursor missing, its card reads `Not installed` with `Install…`.
- `the empty Relevant state shows the first-session copy`: a project with only a brief shows `Nothing here yet.`
- `Inspect all shows the checked packet in the Session tab`: `context-packet` contains the note's ID.
- `preview errors stay in the preview`: a credential-shaped task shows `Preview unavailable:` inside `Context preview`, and there is no `role=alert` banner.

**Selector migration** (through new helpers in `tests/support/ui.ts`: `startSession(page, provider, { task?, mode? })` picks the card, sets the mode, fills `Task` and clicks `/^Start /`; `chooseMode(page, mode)`):
- `'Start Claude'` (16), `'Start Codex'` (8) and `'Start Cursor'` (4) in `desktop.spec.ts`, `-brief`, `-explorer`, `-context-menus`, `-cursor`, `-sessions` and `-lifecycle` → `startSession`. Starts while a session is selected still go through `newSession(page)` first, inside the helper.
- `getByLabel('Initial task')` (21 in specs) → `getByLabel('Task', { exact: true })`.
- `Preview context` / `Preview context ↗` (8: `desktop.spec.ts:48`, `-brief:30,74,85`, `-explorer:129`, `-status:37,47,51`) → type the task, wait for `Sources checked`, then `Inspect all`. Assertions on `context-packet` are unchanged.
- `getByLabel('Read-only', { exact: true }).check()/uncheck()` (`-cursor:93,101`, `-sessions:278`) → `chooseMode(page, 'read-only' | 'build')`.
- `Workspaces…` (`-sessions:270,285,291`) → `Manage workspaces`.
- `Leave out for this task` (`-brief:78`): unchanged name, now inside the preview or the hover card.
- `tests/copy.test.mjs`: remove the two `DEFERRED` entries tagged `Phase 4` (`Preview context ↗`, `Initial task`).

### Group B acceptance

- Board B5 matches in the main column: task, agent cards, mode switch with help, workspace with Manage, one Start ⌘↵, and the live preview with meter, groups, Not included and the tip.
- Board B13 matches: accent underlines and the hover card closed by default. The "N notes match" button gives keyboard users the same card.
- No card claims "signed in" without data. Mode is never silently changed, and launch flags equal today's for each mode.
- Typing never stores a receipt or raises the global banner. Underlines always align with the current text, including after scrolling, wrapping, RTL text and IME input.
- At 900×640 the composer fits with the main column scrolling, and every control is reachable by keyboard.
- All four checks pass after rebasing on A.

---

## 4. Phase verification and status

After B merges, run the whole suite on `claude/ux-redesign`: `npm test`, `npm run check`, `npm run build` and `npm run test:desktop` (hidden windows). Record the results in `docs/IMPLEMENTATION-STATUS.md` under "UX redesign - Phase 4 (composer)", in the earlier phases' style. Report fixture results separately from native checks.

**Native checks to list** (under "To verify" in `docs/NATIVE-VALIDATION.md`):
- With real Claude, Codex and Cursor, each mode starts the same native mode as before. Launch argv is unchanged; the fixture argv tests already pin it.
- The Cursor card's `Signed in` / `Sign in needed` matches `cursor-agent status`.
- On Windows, Ctrl+Enter starts from the task box, and Delete leaves out a focused note.
- On Windows, the mirror aligns with the textarea under ClearType and 125 %/150 % scaling.

---

## 5. Decisions

1. **D3 applied: no cross-operation hash cache.** The typing preview never validates; the full preview validates on 1 s idle and on Inspect all; the launch validates again. The spec is amended in A5.
2. **D4 applied: the spec says 24 terms,** matching `queryTerms`.
3. **The preview lives in the main column (board B5), and the inspector stays as Phase 3 left it.** Hiding the inspector automatically would override the user's stored layout.
4. **The typing preview takes its branch from the renderer's display state,** never from Git. It is display-only: the idle check and the launch recompute it.
5. **`selection.terms` comes from per-term FTS checks,** so stemmed matches ("retries" / "retry") underline the user's own word. `selection.reason` stays for receipt compatibility.
6. **Briefs never produce underlines,** because they are independent of task words.
7. **Switching agents never changes the selected mode.** An unsupported mode blocks Start with a reason, instead of escalating to Build.
8. **⌘↵ / Ctrl+Enter is composer-local,** not routed through `shortcuts.mjs`. The task box has focus, not the terminal.
9. **The hover card is a non-modal dialog with a 300 ms warm-up.** It opens from pointer hover or the button, never from the caret, so it doesn't interrupt typing. There is no animation.
10. **Preview errors stay inside the preview.** The global banner is for actions the user took.
11. **Agent cards are radios, and modes are a radiogroup** (the mockup has `aria-pressed` buttons). The choice is exclusive, and arrow keys move it.

## 6. Risks

| Risk | Mitigation |
|---|---|
| The refactor changes `prepareContext` packets | A1 snapshot committed before A2; A3 parity test |
| The preview shows a stale note for up to 1 s, then it disappears | "Sources are checked when you start" label; the idle check replaces the list in place without animation; the meter shows `≈` until checked |
| The branch hint is stale after an external `git checkout` | App's existing 3-second checkout poll refreshes `state.project`; the idle full check corrects within 1 s; the launch is authoritative |
| The mirror misaligns (scrollbar, fonts loading, zoom, Windows scaling) | one shared `.task-input` class, `scrollbar-gutter: stable`, re-measure on `document.fonts.ready` and resize; unit-tested segments; a Windows native check |
| Store-worker queue contention (a backup or a long FTS) delays previews | one in-flight request per kind, tickets drop stale replies, coalesced `dirty` flag |
| More than 30 desktop selectors churn | `startSession` / `chooseMode` helpers; the migration list in B8; merge A first, then B, with one full desktop run |
| The A0 stub leaks into a release | A3's PATH-without-Git test fails against it; the stub comment names the replacement |
| The renderer bundle imports core code | only `retrieval.mjs`, which has a test that it stays free of `node:` imports, plus a `.d.mts` |
| The "N notes match" count spams screen readers | `aria-live` only on the count, updated when the number changes |

## 7. Corrections to the master plan

1. **Task 4.1 per-term SQL:** `memory_fts` has no `rowid` tied to a memory. Its `revision_id` is an UNINDEXED column. The check is one statement per term over `revision_id IN (json_each(?))`: at most 24 statements, not 12 × 24.
2. **"A keystroke preview costs one SQLite query"** → a bounded set of SQLite statements (A3), with zero Git, file reads or writes.
3. **`previewSelection` can't call `view()`/`project()`.** Both run `inspectProject`, which spawns Git four times. It uses stored records plus a branch hint (decision 4).
4. **References:** `resolveReferences` hashes files, so the preview uses reference paths only.
5. **The test "inject a counting git or assert timing"** becomes Git removed from `PATH` (A7). It is deterministic and proves the absence of Git.
6. **⌘↵** is handled in the composer, not by the main-process router (decision 8).
7. **"+ Reference @"** on board B5 is deferred to Phase 8 (`searchFiles`).
8. **Board sub-lines "2.1.286 · signed in"** for Claude/Codex aren't shown until Phase 7 provides `auth status`.
9. **The hover card's "sent to 4 sessions" and "File unchanged"** are Phase 5 trust lines. Phase 4 shows "Checked when you start" or "Current".
10. **"Preview context ↗"** is replaced by the live preview and "Inspect all", not merely removed.
11. **D3 and D4 are applied in Phase 4** (the user delegated these decisions). Phase 9's "apply D1–D4" now covers only D1 and D2.
12. **The board places the preview in the main column with no inspector.** Phase 4 keeps Phase 3's inspector (decision 3).
