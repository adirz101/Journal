# Journal UX redesign, Phase 8: Command palette and states

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Read `AGENTS.md` first. Group B reads `/Users/azechary/Downloads/skills-main/skills/emil-design-eng/SKILL.md` before any UI edit, and `review-animations/SKILL.md` before merging. `pick-ui-library/SKILL.md` was read for this plan: its list names `cmdk` for command menus; Phase 8 deliberately leaves that list and builds the palette in-house (decision 1). If the collection is missing, say so; don't claim you applied it.

**Goal:** Phase 8 of [the UX redesign](2026-10-04-ux-redesign.md) (tasks 8.1 and 8.2; F23, F24). Add a keyboard-first command palette and "open any file", and give every failure state one honest sentence and one next step:
- palette groups: Sessions, Quiet sessions to check, Actions, Project memory;
- the no-results actions;
- runtime disconnected, crash recovery, an agent that can't start, and all slots full.

**Design source:** `…/scratchpad/journal-mock/src/Palette.body.html` (board 7) and `States.body.html` (board 9, six panels). Panel 5 ("Session exited with an error") belongs to Phase 6. Three mock details change:
- the palette footer's `⌘↵ open beside` is dropped, because Journal has no split view;
- the mock's "work tree" becomes "separate copy" (Phase 1 vocabulary);
- Windows/Linux keys follow section 2.1 of the master plan.

**Checks after every commit:** `npm test`, `npm run check`, `npm run build`. Group B, and Group A's runtime and desktop commits, also run `npm run test:desktop` (hidden windows, Electron-native node-pty; check the exit status). Everything here is fixture acceptance. Phase 8 changes no provider argv, native settings, permissions or exact-ID resume. "Open terminal" runs Phase 7's constant-argv `providerLogin`. Whether a real `codex login` or `claude auth login` flow completes is a manual item for `docs/NATIVE-VALIDATION.md`.

**Out of scope:**
- terminal-output search (output is never stored; the palette says so);
- a fuzzy search over note bodies beyond `memoryPage`'s existing `search`;
- custom title bar or search field (the palette replaces it);
- install commands for Claude and Codex that Phase 7 doesn't define;
- range-level freshness;
- motion of any kind on the palette.

---

## 0. Groups, order and file ownership

```
A0 contract commit (Group A implementer, on claude/ux-redesign)
 ├── Group A  core/runtime/desktop: searchFiles, recovery in hello, retryNow, rows, IPC   (worktree p8a)
 └── Group B  renderer: CommandPalette, RecoveryPanel, StartError, banner, slots-full     (worktree p8b)
merge A → B (B rebases on A and reruns all four checks)
```

- **Group A can start once Phase 3 Group A has merged.** It owns `menu.mjs` and adds the `settings` shortcut row that A's parity tests must keep. A needs nothing else that is unmerged.
- **Group B starts after:**
  - all of Phase 3 (`NewSessionView`, `FilesTab`, `Sidebar`, the main-column banners and the App regions);
  - Phase 4 Group B (`Composer`, `startBlock`, `composer` copy);
  - Phase 5 Group B (`MemoryTab`);
  - Phase 7 Group A (`providerLogin`, auth probes on `AgentInfo`).

  The Phase 7 plan is not written yet. A0 records the names it finds in master section 4.3 (`providerLogin({ provider })`, `agent.auth: 'signed-in' | 'signed-out' | 'unknown'`). B rechecks them after rebasing and edits this plan if they drifted.
- **A0 goes first** (section 1): types, copy keys, IPC names with working stubs, both shortcut rows **with** a minimal handler and a stub palette (a row without a handler would swallow its key), and the CSS section marker.

| File | Owner | Others may touch |
|---|---|---|
| `src/core/files.mjs` (`listFiles`, `rankFiles`, `searchFiles`) | A | — |
| `src/runtime/runtime.mjs` (recovery state, `acknowledgeRecovery`), `src/desktop/runtime-client.mjs` (`retryNow`) | A | — |
| `src/desktop/shortcuts.mjs` (two ids, three MAC rows, two OTHER rows, `alias`), `src/desktop/menu.mjs` (two items) | A0 rows, A menu | — |
| `src/desktop/main.mjs` (`searchFiles`, `acknowledgeRecovery`, `reconnectRuntime`, bootstrap `recovery`, the file-list cache), `src/desktop/preload.cjs` (one `for … allowed.add` line) | A0 stubs, then A | — |
| `tests/files-search.test.mjs` (new), `tests/runtime.test.mjs`, `tests/runtime-client.test.mjs` (new if absent), `tests/shortcuts.test.mjs`, `tests/menu.test.mjs` | A | — |
| `src/ui/types.ts` (`CommandId`, `FileHit`, `Recovery`, `Bootstrap.recovery`, runtime event), `src/ui/copy.ts` (`palette`, `states` objects) | A0 | B may fix wording |
| `src/ui/CommandPalette.tsx`, `paletteModel.ts`, `RecoveryPanel.tsx`, `StartError.tsx`, `statesModel.ts`, `RuntimeBanner.tsx` (new) | A0 stub palette, then B | — |
| `src/ui/App.tsx` (command handler ids, palette state, recovery state, banner), `Composer.tsx` (StartError slot, reference picker button), `Sidebar.tsx` (New session enabled while full), `FilesTab.tsx`/`ExplorerPanel.tsx` (`reveal` prop), `MemoryTab.tsx` (`focus` prop), `KnowledgeForm.tsx` (`initialStatement`) | B | owners from Phases 3–5 and 7; B adds props and one region each |
| `src/ui/styles.css` (new section `/* === Phase 8: palette and states === */`) | B | — |
| `tests/palette.test.mjs`, `tests/states.test.mjs`, `tests/desktop-palette.spec.ts`, `tests/desktop-states.spec.ts` (new), `tests/support/ui.ts` (`openPalette` helper) | B | — |

---

## 1. A0: the contract commit (before forking)

One commit: "Phase 8 seams: palette ids, recovery, copy". It must pass all four checks.

### 1.1 Shortcut rows (`src/desktop/shortcuts.mjs`)

```js
// MAC (the ⇧⌘P alias comes first and is marked, so labels and aria show ⌘K)
{ id: 'command-palette', meta: true, shift: true, key: 'p', label: '⇧⌘P', aria: 'Meta+Shift+P', alias: true },
{ id: 'command-palette', meta: true, key: 'k', label: '⌘K', aria: 'Meta+K' },
{ id: 'open-file', meta: true, key: 'p', label: '⌘P', aria: 'Meta+P' },
// OTHER (Ctrl+K is kill-line and Ctrl+P is shell history; both stay with the terminal)
{ id: 'command-palette', control: true, shift: true, key: 'p', label: 'Ctrl+Shift+P', aria: 'Control+Shift+P' },
{ id: 'open-file', control: true, shift: true, key: 'o', label: 'Ctrl+Shift+O', aria: 'Control+Shift+O' },
```

`shortcutKeys` skips rows with `alias: true`. `⌘K` and the existing `⇧⌘K` add-note row differ by Shift, which `matchShortcut` already compares. `COMMAND_IDS` dedups as today. `CommandId` gains `'command-palette' | 'open-file'`.

### 1.2 Types (`src/ui/types.ts`)

```ts
export interface FileHit { path: string; score: number; spans: [number, number][] }   // spans: matched character ranges in path
export interface FileSearch { available: boolean; reason?: 'not-git' | 'failed'; hits: FileHit[]; total: number; truncated: boolean }
export interface RecoveredSession { id: string; status: 'interrupted' | 'orphaned'; identityVerified: boolean | null }
export interface Recovery { at: string; runtimeId: string; sessions: RecoveredSession[] }
export interface Bootstrap { /* … */ recovery: Recovery | null }
// runtime event gains recovery; the existing boolean `recovered` (reconnected) is kept unchanged
| { type: 'runtime'; state: 'connected' | 'disconnected' | 'connecting'; warning?: string; recovered?: boolean; recovery?: Recovery | null }
```

### 1.3 IPC (`main.mjs`, `preload.cjs`)

| Action | Main handler | Stub (A0) |
|---|---|---|
| `searchFiles` | `({ projectId, rootKey, query, limit }) => searchFiles(await fileRoot(projectId, rootKey), text(query, 'query', 200, true), clamp(limit, 1, 100, 50))`, with the listing cached (A3) | `{ available: true, hits: [], total: 0, truncated: false }` |
| `acknowledgeRecovery` | `({ at }) => runtime.call('acknowledgeRecovery', { at })`; it also clears main's copy | clears main's copy only |
| `reconnectRuntime` | `() => runtime.retryNow()` | `void runtime.reconnect()` |

`bootstrap` gains `recovery: runtime.info?.recovery ?? null` (the auth reply `RuntimeClient` already keeps in `info`). The `reconnected` handler sends `{ type: 'runtime', state: 'connected', recovered: true, recovery: hello.recovery ?? null }`. `preload.cjs` gains `for (const action of ['searchFiles', 'acknowledgeRecovery', 'reconnectRuntime']) allowed.add(action);`.

### 1.4 Copy (`src/ui/copy.ts`)

`palette`:
- `placeholder` "Search sessions, commands and notes…"; `filePlaceholder(root)` "Open a file in {root}…";
- groups `sessions`, `quiet` "Quiet sessions to check", `actions`, `memory` "Project memory", `files` "Files";
- `noResults(q)` "No sessions, commands or notes match “{q}”."; `newWithTask` "New session with this task"; `addAsNote` "Add as a note";
- `searches` "Searches titles, tasks and notes. Terminal output isn’t saved, so it isn’t searched.";
- footer `move` "move", `open` "open", `commandsOnly` "Type > for commands only";
- `fileHint` "Type part of a file name"; `notGit` "File search needs a Git folder. Use the Files tab."; `filesTruncated(n)`;
- one label per command id under `actions`, for example `'new-session': 'New session'` and `'next-needs-you': 'Jump to the next session that needs you'`.

`states`:
- `lostTitle` "Lost connection to the session runtime"; `lostBody` "Your agents may still be running. Journal is trying again every few seconds."; `reconnectNow` "Reconnect now"; `reconnecting` "Reconnecting…";
- `crashTitle` "The session runtime stopped unexpectedly"; `crashBody(n)` "{n} sessions were interrupted. Nothing was resent to the agents."; `crashContinue` "Continue each one when you’re ready; it reopens the same conversation.";
- `needsId` "Needs the conversation ID before continuing"; `confirmId` "Confirm ID…"; `stillRunning` "Still running outside Journal"; `leftover(n)` "{n} leftover process(es) still running"; `review` "Review"; `done` "Done";
- `cantStartTitle(name, problem)`, for example "Codex isn’t signed in"; `signInBody` "Sign in once in a terminal, then start again. Journal never handles your login.";
- `openTerminal` "Open terminal"; `copyCommand` "Copy command"; `checkAgain` "Check again"; `kept` "Your task text is kept. Nothing was sent.";
- `slotsFull` "4 of 4 running. Stop or finish one to start another. You can still write the task now." (replaces Phase 4's `composer.slotsFull`).

The copy scanner's banned words stay out of `.tsx` strings.

### 1.5 Stub handler, palette and CSS

- In App's command region: `command-palette` and `open-file` set `palette` to `{ mode: 'all' | 'files' }` unless a dialog is open.
- `CommandPalette.tsx` (stub) is a `<dialog>` opened with `useModalDialog`. It holds one input and closes on Escape, so `tests/modal.test.mjs` passes.
- Append `/* === Phase 8: palette and states === */` to `styles.css`, with four blank lines around it.

---

## 2. Group A: core, runtime and desktop

### A1. `searchFiles` (`src/core/files.mjs`)

```js
export const MAX_LISTED_FILES = 200_000;
export async function listFiles(root)            // root: fileRoot() result { path, gitRoot, prefix, git }
export function rankFiles(paths, query, limit = 50)   // pure
export async function searchFiles(root, query, { limit = 50, list = listFiles } = {})
```

**`listFiles`:**
- A non-Git root returns `{ available: false, reason: 'not-git' }`. There is no directory walk (decision 4).
- Otherwise it runs `git -C gitRoot ls-files -z --cached --others --exclude-standard [-- prefix]` through the existing `git()` helper: `GIT_LITERAL_PATHSPECS=1`, `GIT_OPTIONAL_LOCKS=0`, a timeout of 8 s, `windowsHide`, and `maxBuffer` 64 MiB.
- Each entry is processed in order:
  1. strip `prefix`;
  2. dedupe (a path can be both cached and modified);
  3. drop every path where `isSensitivePath(repoRelative) || isSensitivePath(rootRelative)`;
  4. drop paths with control characters (`treePath` rules).
- It stops at `MAX_LISTED_FILES` and reports `truncated`.
- A Git failure returns `{ available: false, reason: 'failed' }`. The Git message is never shown, because it may contain paths outside the root.

**`rankFiles`** (case-insensitive, deterministic):
- The query is split on whitespace, and every token must match as a subsequence of the path.
- Score bonuses:
  - a contiguous match in the basename;
  - a match at a segment start (after `/`, `-`, `_`, `.`, or a camelCase boundary);
  - a shorter path.
- Penalty: gaps between matched characters.
- Ties break by path (`localeCompare`, numeric).
- `spans` are the matched ranges, merged.
- An empty query returns no hits; the renderer shows `fileHint`.
- Cost bound: tokens are capped at 8 and the query at 200 characters; paths longer than 1024 are skipped.

**Opening a hit:** opening always goes through the existing `previewFile`. It re-checks containment, symlinks, sensitivity and the canonical name. A symlink or submodule in the list therefore opens with today's honest error instead of reading through the link.

### A2. Tests (`tests/files-search.test.mjs`, new)

- `lists tracked and untracked files, never ignored ones`: a fixture repo with `.gitignore` and an untracked file.
- `sensitive files never appear`: `.env`, `.env.local`, `id_rsa`, `config/secrets.json`, `certs/a.pem`, `.aws/credentials`, `terraform.tfstate`, `Service_Account-x.json`; upper-case variants (`.ENV`); and a nested `sub/.ssh/known_hosts`.
- `a folder root lists only below its prefix, relative to it`: an additional Git folder with a prefix.
- `a non-Git folder reports not-git`.
- `ranking prefers basename and segment-start matches`: `term` ranks `src/core/terminal.mjs` above `docs/TERMINAL-FIRST-SPEC.md`, and `tm` matches `terminal.mjs`. Spans are asserted.
- `ties are stable and limited`: 60 equal hits give 50, in path order, with `total: 60`.
- `a path is never interpreted as a pathspec`: a file named `:(glob)*` lists literally.
- `Git failures are reported without the message`: a fake `git` on `PATH` exits 128 and prints a path.
- `the listing is capped`: inject `list` returning 200,001 entries; `truncated: true`.

### A3. Main: the listing cache and IPC

- Cache key: `projectId\0rootKey`. The value is `{ at, listing }`, kept for 30 s and at most 4 roots, oldest dropped. One listing call runs per key at a time (shared promise, like `statusCalls`).
- The cache is dropped on any `ROOT_CHANGES` action. A watcher `files` event for the key also drops it, so a newly created file appears.
- `searchFiles` ranks the cached listing in main. On 200k paths this is a synchronous scan of roughly 20 ms, measured in A's test with `performance.now()` and logged, not asserted. The renderer debounces at 120 ms, so ranking never runs per keystroke burst.

### A4. Recovery in the hello (`runtime.mjs`)

- After `manager.recover()`, the runtime keeps `let recovery = recovered.length ? { at, runtimeId, sessions: recovered.map(s => ({ id: s.id, status: s.status, identityVerified: s.identityVerified ?? null })) } : null;`. The list is capped at 100, matching `liveSessions`' limit.
- The auth reply adds `recovery`.
- New method `acknowledgeRecovery({ at })` sets `recovery = null` only when `at` matches, so a stale acknowledgement never hides a newer crash. Add it to `METHODS`.
- **No protocol bump:** the field is optional, and an older runtime rejects the method with "Unknown runtime operation". Main catches that and clears its own copy. Changing `runtime.mjs` changes `buildId()` anyway, so the build-mismatch warning covers mixed versions.
- The recovery list lives only in memory. If the app never connects before the runtime idles out (60 s with no client and nothing live), the list is lost. The sessions still show "Interrupted" in Recent, and the panel is a convenience, not the record (decision 6).

### A5. Reconnect now (`runtime-client.mjs`)

`reconnect()` sleeps between attempts. Phase 8 makes that sleep wakeable:
- `this.wake` resolves the current wait.
- `retryNow()`:
  - does nothing if a socket exists or the client is closing;
  - otherwise sets `this.launches = 0`. A user retry may launch again after the three-launch `failed` stop;
  - wakes the loop, or starts `reconnect()` if no loop is running (after `failed`).
- `reconnect()` is guarded by `this.reconnecting`, so two loops never both emit `reconnected`.
- The protocol-mismatch wait (30 s) is also woken. The attempt re-checks and warns again if the mismatch remains.

### A6. Menu (`menu.mjs`)

- The View menu gains `Command Palette…` and `Open File…`.
- Each item shows its accelerator label with `registerAccelerator: false`, as Phase 3's Settings item does. Its click sends the command, so the router stays the only key path.
- Test in `tests/menu.test.mjs`: both items exist on all three platforms, and their labels match `shortcutKeys`.

### A7. Tests (Group A)

- `tests/shortcuts.test.mjs`:
  - `⌘K and ⇧⌘P open the palette; ⌘P opens a file on macOS`;
  - `Ctrl+Shift+P and Ctrl+Shift+O on Windows and Linux; Ctrl+K and Ctrl+P stay with the terminal`;
  - `an alias row never replaces the label` (`shortcutKeys('darwin')['command-palette'].label === '⌘K'`);
  - `⇧⌘K stays add-note`;
  - the existing parity and no-duplicate tests pass unedited.
- `tests/runtime.test.mjs`:
  - `the hello reports sessions recovered from a crashed runtime`: seed a foreign-runtime live session and start the runtime. The auth reply has `recovery.sessions[0].status === 'interrupted'`;
  - `acknowledging recovery clears it for the next client, and a stale at is ignored`;
  - `a clean start has no recovery`.
- `tests/runtime-client.test.mjs`:
  - `retryNow wakes a waiting reconnect and emits reconnected once`, with a fake `attempt` and injected waits;
  - `retryNow after failed launches again`.
- `tests/storage-worker.test.mjs`: unchanged. `searchFiles` runs in main, not the worker.

### Group A acceptance

- The four checks pass. The new tests pass, and the existing `runtime`, `terminal`, `shortcuts` and `menu` suites pass unedited apart from the added cases.
- In a fixture repo, `searchFiles` never returns a path for which `isSensitivePath` is true, and never reads a file.
- After a forced runtime kill, the next hello carries the interrupted session. It is cleared after `acknowledgeRecovery`.

---

## 3. Group B: renderer

### B1. `paletteModel.ts` (pure; `node --test` imports it directly)

```ts
export type PaletteItem =
  | { kind: 'session'; id: string; session: Session; label: string; detail: string; keys: string | null; action: 'open' | 'continue' }
  | { kind: 'action'; id: CommandId | ExtraAction; label: string; keys: string | null; enabled: boolean; reason: string | null }
  | { kind: 'note'; id: string; label: string; category: string }
  | { kind: 'file'; id: string; path: string; spans: [number, number][] }
  | { kind: 'fallback'; id: 'new-with-task' | 'add-as-note'; label: string };
export interface PaletteGroup { id: 'sessions' | 'quiet' | 'actions' | 'memory' | 'files' | 'none'; label: string; items: PaletteItem[] }
export function parseQuery(raw: string): { text: string; actionsOnly: boolean }       // leading '>' (spaces trimmed)
export function sessionMatches(sessions: Session[], projectId: string | null, text: string, now: number, connected: boolean): PaletteItem[]
export function quietSessions(sessions: Session[], now: number): Session[]      // Codex/Cursor, live, quiet >= 120 s
export function actionItems(ids: readonly (CommandId | ExtraAction)[], keys: Record<string, { label: string }>, can: (id: string) => string | null, text: string): PaletteItem[]
export function buildGroups(input: { text; actionsOnly; sessions; quiet; actions; notes; notesLoading }): PaletteGroup[]
export function moveActive(groups: PaletteGroup[], activeId: string | null, delta: 1 | -1 | 'first' | 'last' | 'next-group' | 'prev-group'): string | null
```

**Sessions:**
- Matched case-insensitively on `displayName || title`, the provider name and the branch. Up to 6 results: live sessions in slot order, then the rest by `lastActivityAt`. Sessions of the current project come before others.
- `detail` is the `stateFor` word and detail (for example "Running · output just now"), or "Exited 0 · 2d".
- `keys` is the slot label (`⌘2`) while the session holds a slot.
- An ended session that is `resumable` gets `action: 'continue'`, shown as a trailing "Continue" hint. Enter opens the session. The hint tells the user that Continue is available in its header; the palette never starts a session by itself.

**Quiet sessions to check:**
- `quietSessions` lists live Codex and Cursor sessions whose `lastOutputAt` is at least 2 minutes old, or that have had no output since a `createdAt` at least 2 minutes old. They are sorted quietest first.
- Shown only for an empty query, and only when connected (while disconnected the state is unknown).
- The detail reuses `outputDetail` ("Cursor · quiet 2m").

**Actions:**
- Every id in `COMMAND_IDS` except `slot-1…4` (which the Sessions group covers) and `command-palette`/`open-file` themselves.
- Plus `ExtraAction`: `'manage-workspaces'`, `'new-session-separate-copy'` (only if Phase 3–7 added its row; otherwise omitted) and `'check-agents'` (Check again on providers).
- `can(id)` returns the same disabled reason the matching button shows. A disabled action stays listed with `aria-disabled` and its reason, and Enter does nothing.

**Project memory:**
- `memoryPage({ projectId, search: text, filter: 'active', limit: 5 })`, debounced 150 ms, with replies applied only for the latest ticket.
- Not searched for queries shorter than 2 characters, or with `>`.

**No results** (non-empty text; every group empty; no memory request in flight): one `none` group.
- The message `noResults(q)` is a non-option paragraph.
- Then two options: `new-with-task` (active by default, label `New session with this task`, keys `↵`) and `add-as-note`.
- Then `searches`.

**Ordering:** for an empty query, Sessions (live only), Quiet, Actions. With text, Sessions, Actions, Project memory. With `>`, Actions only.

### B2. `CommandPalette.tsx`

```ts
export function CommandPalette(props: {
  mode: 'all' | 'files'; projectId: string | null; rootKey: string | null; rootLabel: string | null;
  sessions: Session[]; now: number; connected: boolean; keys: Record<string, { label: string; aria: string }>;
  can(id: string): string | null; purpose?: 'open' | 'reference';
  onRun(id: CommandId | ExtraAction): void; onOpenSession(s: Session): void; onOpenNote(id: string): void;
  onOpenFile(path: string): void; onNewWithTask(text: string): void; onAddNote(text: string): void; onClose(): void;
}): JSX.Element;
```

**Structure** (board 7):
- `<dialog className="palette" aria-label="Command palette">` (file mode: "Open a file"), opened with `useModalDialog`.
- Inside: `<input role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list" aria-activedescendant={activeId}>`, followed by a `<kbd>esc</kbd>`.
- Then `<div id="palette-list" role="listbox" aria-label=…>`, with one `role="group" aria-labelledby` per group, its caption carrying `role="presentation"` and an id.
- Options are `<div role="option" id="palette-opt-…" aria-selected={active} aria-disabled?>`. They are never focusable: focus stays in the input.
- Matched characters are `<mark>` from the spans (files) or from case-insensitive substring ranges (labels).
- The footer `↑↓ move · ↵ open · Type > for commands only` is `aria-hidden`; the same information is in the input's `aria-describedby` text.

**Keyboard** (input `onKeyDown`, ignored while `event.nativeEvent.isComposing`):
- ↑/↓ move and wrap; PageUp/PageDown jump a group; Enter runs the active option.
- Escape is native `cancel`: it closes and restores focus.
- ⌘K / Ctrl+Shift+P inside the palette closes it. Main stops claiming keys while a modal is open, so the dialog handles these keys itself, matched with `keys.ts` `keyLetter`.
- ⌘P / Ctrl+Shift+O switches to file mode with the text kept.
- Tab is prevented, because the input is the only stop.
- The active option is kept by id, so results arriving later (memory) never move the selection. If the active id disappears, the first option becomes active. Scrolling uses `scrollIntoView({ block: 'nearest' })`.

**Pointer:**
- `pointermove` (not `mouseenter`, so scrolling under a still pointer changes nothing) sets the active option; `click` runs it.
- A click on the backdrop (the `dialog` element itself) closes.
- Hover colour lives inside `@media (hover:hover) and (pointer:fine)`.

**Focus:**
- Opening stores `document.activeElement`.
- Dismissing (Escape, backdrop, the toggle key) restores it, so a terminal user is back in the terminal.
- Running an option that moves focus (open session, focus terminal, New session) skips the restore.

**File mode:**
- Placeholder `filePlaceholder(rootLabel)`. `searchFiles` is debounced 120 ms; only the latest ticket applies.
- Each row shows the basename in `--tx` and the folder in `--tx3`, ellipsised from the left (`direction: rtl` on a wrapper with an inner `ltr` span), with the full path in `title`.
- `available: false` shows `notGit`, or a generic failure line. `truncated` shows `filesTruncated(n)`.
- `purpose: 'reference'` (from the composer) changes the title to "Reference a file". Enter calls `onOpenFile`, and App adds the reference instead of previewing.

**No animation:** the dialog has no transition and no `::backdrop` fade. This is a 100+ times-a-day, keyboard-initiated surface (emil-design-eng). The listbox is capped at `min(60vh, 520px)` and scrolls; the width is `min(640px, 100vw - 32px)`.

### B3. App wiring (command region, main region)

- `palette: { mode, purpose } | null`.
- The `command-palette` and `open-file` handlers open it. If it is already open, they do nothing; inside the dialog the palette handles its own toggle.
- `open-file` needs a project; without one, it opens `mode: 'all'` with Open project first.
- `onRun(id)` closes the palette, then calls `command.current(id)` on the next frame, so the `dialog[open]` guard in the handler doesn't swallow it.
- `onOpenSession` → `selectSession`.
- `onOpenNote(id)` → Memory tab, `showInspector()`, `memoryFocus = { id, seq }`. MemoryTab loads it with `memoryPage({ ids: [id] })` when it isn't on the current page, scrolls it into view and focuses its heading.
- `onOpenFile(path)`:
  - open mode: Files tab with `filesReveal = { rootKey, path, seq }`; `ExplorerPanel` expands the folders and opens the preview;
  - reference mode: `setReferences` with a whole-file `FileReference` (the same shape Files → "Reference in next task" builds).
- **The search root** is the Files tab's current root key (default `checkout`; inside a session, that session's workspace root). `rootLabel` comes from `fileRoots`.
- `onNewWithTask(text)` → `newSession()`, then set the task. If the draft already has text, the query is appended on a new line, so a draft is never discarded. Nothing starts.
- `onAddNote(text)` → `setForm({ initialStatement: text })`. `KnowledgeForm` prefills the statement. Saving goes through the existing review flow (adds a note for review); no one-click path.
- `can(id)` reuses the guards already in the command handler (`canStart`, `busy`, project open), lifted into one function so the palette and the keys agree.
- **Composer (master Phase 4 deferral):** add an "Add reference…" button beside the reference chips, with `<kbd>` showing the open-file keys. It opens the palette with `{ mode: 'files', purpose: 'reference' }`.

### B4. `statesModel.ts` (pure)

```ts
export type StartProblem =
  | { kind: 'signed-out'; provider: Provider; command: string }          // from Phase 7 auth probe or Cursor login-required
  | { kind: 'missing'; provider: Provider; command: string | null }       // PROVIDER_MISSING or not detected
  | { kind: 'unsupported'; provider: Provider; detail: string }           // PROVIDER_UNSUPPORTED or agent.state 'unsupported'
  | { kind: 'failed'; provider: Provider; detail: string };               // START_FAILED: the runtime's message
export function startProblem(input: { provider: Provider; agent: AgentInfo | undefined; error: unknown | null }): StartProblem | null
export function recoveryView(recovery: Recovery | null, sessions: Record<string, Session>, canStart: boolean): {
  rows: { session: Session; action: 'continue' | 'needs-id' | 'running' | 'gone'; reason: string | null }[];
  interrupted: number; leftovers: Session[]; allResumable: boolean } | null
```

**`startProblem` precedence:** a thrown `error` code wins over agent state. `SLOTS_FULL`, `SHUTTING_DOWN`, `CONVERSATION_OPEN`, `ORPHAN_RUNNING`, `ID_UNCONFIRMED` and `NOT_LIVE` return `null` and keep their existing paths (disabled reason or banner).

**`signed-out`** is reported **only** when `agent.auth === 'signed-out'` (Phase 7) or `agent.state === 'login-required'` (Cursor). `unknown` never produces it: Journal doesn't claim a login state it hasn't observed.

**`command`** comes from Phase 7's constant table:
- login: `claude auth login`, `codex login`, `agent login`;
- install: Cursor's official command only.

Claude and Codex get no install command unless Phase 7 adds one (out of scope).

**`recoveryView`:**
- Uses current session rows (status may have moved from orphaned to interrupted since the hello).
- `continue` when `resumable(session)`. Its reason is `states.slotsFull` when `!canStart` because slots are full, or `runtimeDown` while disconnected.
- `needs-id` for an interrupted session without a confirmed ID.
- `running` for `orphaned`.
- `gone` when the row was removed or archived.
- `leftovers`: recovered sessions that are orphaned or have `survivors?.length`.
- It returns `null` once no row is `continue`, `needs-id` or `running`. The panel then closes itself and acknowledges.

### B5. `RecoveryPanel.tsx` (board 9, panel 2)

**Layout:**
- A `section.recovery-panel` with `role="region"` and `aria-labelledby` its heading, at the top of the main column, above either view. It isn't modal, and the terminal stays usable.
- Heading `crashTitle`. Body: `crashBody(interrupted)`, plus `crashContinue` when `allResumable`.

**Rows:** provider mark (16), title (ellipsis, full in `title`), then one action:
- **Continue** (`button`, disabled with its reason as `title` and visible text when blocked) → `start(provider, session)`;
- `needsId` text plus **Confirm ID…**, which selects the session so the existing resume-ID row is shown;
- `stillRunning` plus **Review**, which selects it (the header offers End orphaned process).

**Footer:** when leftovers exist, `leftover(n) · Review`, which selects the first leftover. **Done** acknowledges.

**Lifecycle:**
- Shown from `bootstrap.recovery` or a runtime event's `recovery`.
- Session rows not in App's map are fetched with `getSession`, because interrupted sessions of another project aren't in `active`.
- `acknowledgeRecovery({ at })` is sent on Done, or when `recoveryView` returns `null`.
- A runtime event with a different `at` replaces the panel.

### B6. `RuntimeBanner.tsx` (board 9, panel 1)

- It replaces App's disconnected `error-banner` line (Phase 3 moved it to the top of the main column).
- `role="status"`, with `lostTitle`, `lostBody` and **Reconnect now** (`reconnectRuntime`). After a click the button reads `reconnecting` and stays disabled until the next `runtime` event or 5 s, whichever is first.
- The `failed` warning (the runtime couldn't be started) keeps its text below the title.
- Sidebar rows already say "Disconnected · state unknown" through `stateFor`, so nothing changes there.
- The mismatch warning keeps its separate banner.

### B7. `StartError.tsx` and slots full (board 9, panels 3 and 4)

**`StartError`** sits in `Composer` directly above the Start button, shown when `startProblem` returns non-null:
- `role="alert"` when it comes from a failed start, and `role="status"` when it comes from the agent state;
- title `cantStartTitle`, body (`signInBody` or the detail), the command in `<code>` (JetBrains Mono, selectable), and actions:
  - **Open terminal**: `providerLogin({ provider })` opens `ProcessDialog`; its exit runs Check again;
  - **Copy command**: clipboard via `navigator.clipboard.writeText`. The renderer may write the clipboard; a failure says "Copy failed";
  - **Check again**: `providerStatus` with fresh detection, which clears the card when fixed;
- the `kept` line.

**Start:**
- For `signed-out` and `missing`, Start stays enabled, because the native CLI handles its own login and the probe may lag.
- For `unsupported`, it is disabled with that reason.
- The task text is kept: Phase 4's restore-on-failure, unchanged.
- The Phase 4 inline handling for `PROVIDER_MISSING` moves here. The global banner no longer shows `START_FAILED` from the composer.

**Slots full:**
- Phase 4's `startBlock` returns `states.slotsFull` for `liveCount >= MAX_SESSIONS`.
- **New session (button, rail and ⌘N) stays enabled while slots are full.** The command handler's `canStart` guard becomes `state && connected-or-not`. The composer shows the disabled Start with the reason (`aria-describedby`), so the user can write the task now.

### B8. Styles and motion (emil-design-eng applied)

- No transitions on the palette, the banner, the recovery panel or StartError: all are state- or keyboard-driven.
- Hover colour only under `(hover:hover) and (pointer:fine)`.
- The active option uses `--accsoft` fill plus a 2 px inset `--acc` bar, so it is not shown by colour alone.
- Text is at least 11 px; contrast follows the `tokens.test.mjs` pairs.
- `::backdrop` uses the existing scrim token, with no blur (performance under terminal load).
- No `transition: all`. `prefers-reduced-motion` needs nothing, because nothing moves.

### B9. Tests (Group B)

**`tests/palette.test.mjs` (pure):**
- `> restricts results to actions`;
- `sessions match title, provider and branch; live first by slot`;
- `quiet sessions are Codex and Cursor live sessions quiet for at least 2 minutes, never Claude, never while disconnected`;
- `every routed command except slots and the palette itself is an action with its key label`, checked against `COMMAND_IDS`;
- `a disabled action keeps its reason`;
- `no results offers New session with this task first`;
- `moveActive wraps and jumps groups`;
- `the active option survives late memory results`.

**`tests/states.test.mjs` (pure):**
- `startProblem never says signed out for unknown auth`;
- `PROVIDER_MISSING maps to missing with Cursor's install command only`;
- `SLOTS_FULL is not a StartError`;
- `recoveryView: resumable → continue; unconfirmed Codex → needs-id; orphaned → running and a leftover; resolved rows close the panel`;
- `Continue is blocked with the slots-full reason`.

**`tests/desktop-palette.spec.ts`:**
- `⌘K / Ctrl+Shift+P opens the palette while the terminal has focus, and Escape returns focus to the terminal`: assert `document.activeElement` is inside `.xterm`;
- `keyboard-only: type, ↓, ↵ opens the session; aria-activedescendant follows the active option`;
- `> lists only actions; ↵ on New session shows the composer`;
- `memory search finds a remembered note and opens it in the Memory tab`;
- `open-file finds README.md and previews it; .env and id_rsa in the fixture never appear`;
- `no results: New session with this task fills the task box without starting` (assert the launch ledger is unchanged);
- `Add as a note opens the note form with the statement`;
- `Add reference… in the composer adds a file chip`;
- `opening and closing has no transition`: computed `transition-duration` is `0s` on the dialog and its options.

**`tests/desktop-states.spec.ts`:**
- `runtime crash → recovery panel lists the interrupted session with Continue; Done hides it and it stays hidden after a reload`. This extends today's `desktop-sessions.spec.ts:219` scenario: SIGKILL the runtime, then assert `f.launches()` stays at 1 until Continue.
- `an interrupted Codex session without a confirmed ID shows Needs the conversation ID; Confirm ID… selects it`.
- `disconnected banner: Reconnect now triggers an immediate attempt`. Kill the runtime and make the next launch fail fast with `JOURNAL_RUNTIME_LAUNCH_DELAY` if Group A adds that test-only hook; otherwise assert the button state and the eventual connection.
- `a provider removed after detection → StartError "isn’t installed" with Check again; the task text is kept`: delete `bin/codex` after launch, then Start.
- `a signed-out fixture provider → StartError with its login command, Copy and Open terminal`. This depends on Phase 7's auth-probe fixture: a fake `codex login status` exiting non-zero. Until Phase 7 merges, the scenario is `test.fixme` with that reason.
- `four sessions → New session still opens the composer; Start is disabled with "4 of 4 running…"; the typed task stays`.

### Group B acceptance

- The four checks pass. The keyboard-only walkthrough reaches every palette group and both fallback actions without a pointer.
- With VoiceOver, the combobox announces the active option name and its group. NVDA is checked in Phase 9.
- No palette path starts a session, approves a note or sends text to a terminal by itself.
- A file the explorer marks sensitive is never offered by open-file.

---

## 4. Phase verification and status

- Run `npm test && npm run check && npm run build && npm run test:desktop` after each merge (A, then B) and record the counts.
- Update `docs/IMPLEMENTATION-STATUS.md` ("UX redesign, Phase 8": F23, F24) and `docs/ARCHITECTURE.md` (`searchFiles`, recovery in the hello, `acknowledgeRecovery`, `retryNow`).
- Add to `docs/NATIVE-VALIDATION.md`:
  - Open terminal runs real `claude auth login` / `codex login` and Check again clears the card;
  - a real runtime crash with a live Claude session shows Continue and resumes the same conversation.
- Add the palette and open-file keys to the README shortcut table (Phase 9 finishes the docs).

---

## 5. Decisions

1. **The palette is in-house, not `cmdk`.** The list `pick-ui-library` curates names `cmdk`, but it would add a renderer dependency, audit allow-list and notices entries for one dialog. Journal already has `useModalDialog`, the shortcut router and its own key-matching rules. The in-house version is about 250 lines and fully under the modal counter.
2. **Focus stays in the input; options are reached with `aria-activedescendant`.** This is the WAI-ARIA combobox pattern, and it keeps IME and caret behaviour native.
3. **The palette never acts by itself.** Continue, Start, Remember and Stop stay on their own buttons. Session results open the session and say "Continue" as a hint. The fallback actions prefill and open; they never start or approve.
4. **Open-file uses `git ls-files` only**, with no directory walk for non-Git folders. It is fast, respects `.gitignore`, and filters sensitive paths twice (listing, then `previewFile`). Non-Git folders say so.
5. **File search runs in main with a 30 s listing cache**, not in the store worker. It is Git, not SQLite, and `fileRoot` and the watcher already live in main.
6. **Recovery is in-memory runtime state plus an acknowledgement keyed by `at`.** The master plan's "hello includes `recovered`" is kept in substance. The field is named `recovery`, because the runtime event already uses a boolean `recovered`.
7. **No protocol bump** for an optional hello field and a new method (A4).
8. **"Reconnect now" also resets the launch counter**, so it recovers from the three-failed-launches stop. Without that, the button would do nothing after `failed`.
9. **Signed out is never inferred.** `StartError` claims it only from Phase 7's probe or Cursor's status. Start stays enabled for signed-out and missing.
10. **New session stays reachable when slots are full** (board 9, panel 4). Only Start is blocked.
11. **Add as a note goes through review** (the existing two-step flow). D1's one-click Remember needs the full statement verified on screen, and a palette query isn't that.
12. **The palette root for files is the Files tab's current root.** A session's separate copy searches its own tree.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| `ls-files` on a very large repo is slow or huge | 8 s timeout, 64 MiB buffer, 200k cap with `truncated`, 30 s cache, one call per root at a time |
| Ranking 200k paths blocks main | 120 ms debounce, 8 tokens and 200 characters max, measured in A's test; move it to a worker only if the measurement exceeds 30 ms |
| A sensitive file reaches the list by case or a nested folder | `isSensitivePath` on both relative forms; `previewFile` re-checks the canonical name; tests cover upper case and nesting |
| ⌘K collides with xterm or shell habits | macOS ⌘ never reaches the terminal; Windows/Linux use Ctrl+Shift+P, and Ctrl+K stays with the shell (test) |
| Keys inside the open palette | main stops routing while a modal is open; the palette handles its toggle and Escape itself; `modal.test.mjs` keeps the counter honest |
| Commands run from the palette are swallowed by the `dialog[open]` guard | close first, run on the next frame (B3); the desktop test runs New session from the palette |
| The recovery list is lost when the runtime idles out before an app connects | the sessions still say Interrupted; documented (A4) |
| Phase 7 names drift (`providerLogin`, `auth`) | A0 records them; B rechecks after rebasing; the signed-out desktop scenario is `fixme` until Phase 7 merges |
| Several phases' components gain props (`FilesTab`, `MemoryTab`, `KnowledgeForm`, `Composer`, `Sidebar`) | B adds one optional prop or region each; it rebases on the latest of Phases 4–7 before its desktop run |
| Two reconnect loops emit `reconnected` twice | the `this.reconnecting` guard plus the wakeable sleep; unit-tested |

---

## 7. Corrections to the master plan

1. **Task 8.1 signature:** `searchFiles(view, query, limit=50)` becomes `searchFiles(root, query, { limit })`, where `root` is the existing `fileRoot()` record (path, gitRoot, prefix). It is split into `listFiles` and a pure `rankFiles`, and main caches the listing.
2. **Task 8.1 "a separate shortcut opens it in file mode":** `open-file` is ⌘P / Ctrl+Shift+O (section 2.1). ⇧⌘P is an alias of ⌘K, marked `alias` so labels show ⌘K.
3. **Task 8.1 actions:** slot commands are covered by the Sessions group, and the palette's own ids are excluded. Disabled actions stay listed with their reason.
4. **Task 8.2 `recovered: [{id, status, identityVerified}]`** becomes `recovery: { at, runtimeId, sessions }` with `acknowledgeRecovery({ at })` (decision 6). The boolean `recovered` on the runtime event is unchanged.
5. **Task 8.2 slots-full copy:** board 9 reads "Stop or finish one…". Phase 4's `composer.slotsFull` is replaced, and New session stays enabled (decision 10; Phase 3 A disabled it on `!canStart`).
6. **Task 8.2 "a fixture provider that fails at sign-in":** a provider doesn't fail at start when signed out; it shows its own login. The StartError comes from Phase 7's auth probe instead. The missing-provider case is tested by deleting the fixture binary after detection.
7. **Task 8.2 "Reconnect now":** it needs `retryNow()` in `runtime-client.mjs` (A5), including a launch-counter reset. The master plan listed no desktop change for it.
8. **Phase 4 deferral:** the composer's "+ Reference @" picker is built here as "Add reference…" on the file mode of the palette.
9. **Mock details:** `⌘↵ open beside` is dropped; "work tree" becomes "separate copy".
