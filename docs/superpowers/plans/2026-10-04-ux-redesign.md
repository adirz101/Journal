# Journal UX redesign implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read `AGENTS.md` first and follow it. In particular, read `/Users/azechary/Downloads/skills-main/skills/emil-design-eng/SKILL.md` before any UI task.

**Goal:** Build the redesigned Journal cockpit shown in the design canvas. Keep every existing contract: native CLIs, review-gated memory, immutable receipts and exact resume.

**Architecture:** The redesign touches four layers:
- **Core** (`src/core`): new deterministic queries for previews, note origins, delivery counts, suggestions per session and the out-of-date catch.
- **Runtime** (`src/runtime`, `src/core/terminal.mjs`): honest per-provider activity, pending-permission detail and stable slots.
- **Desktop main** (`src/desktop`): a shortcut router that works while the terminal has focus, notifications, menus, and new IPC actions on the preload allow-list.
- **Renderer** (`src/ui`): semantic tokens, a plain-language copy module, and components split out of `App.tsx`.

Each phase ships working, tested software.

**Tech stack:** Electron 44, React 19, Vite 8, TypeScript 6, Node 24 `node:sqlite` (FTS5), node-pty, xterm.js 6, Playwright (headless desktop scenarios), `node --test`.

**Design source:** the Journal redesign mockup canvas (claude.ai artifact `BYL5oqosoDgM11cfxM5UAu`, private). Board numbers below (B1–B15) refer to its titles.

---

## 0. How this plan is organised

The redesign spans several independent subsystems, so this document has two levels:

1. **Master plan (sections 1–5):**
   - every feature from the mockups, with the data it needs, new or changed functions, UI, tests and acceptance criteria;
   - the open decisions;
   - phases, their dependencies, and the files each phase owns.
2. **Phase 0 in full bite-sized TDD detail (section 6).** Exact files, test code, implementation code and commands. These bug fixes are needed whatever the redesign decides.

Phases 1–9 (section 7) list concrete tasks, signatures, test cases and acceptance criteria. **Before a phase starts, expand it into its own bite-sized plan** in `docs/superpowers/plans/` (same format as section 6), written against the code as it is then. Most later phases depend on the decisions in section 2 and on code earlier phases change. Writing their full code now would mean guessing.

Work on a branch created from `main` (for example `claude/ux-redesign`). Don't commit to `main`. Run checks after every task:

```bash
npm test            # core unit tests (node --test)
npm run check       # tsc --noEmit
npm run build       # vite production build
npm run test:desktop  # Playwright + real Electron + node-pty, headless (needs Electron-native node-pty: npm run rebuild)
```

Check exit status before calling anything done. Fixture results are not authenticated provider behaviour. Report native checks separately (`docs/NATIVE-VALIDATION.md`).

---

## 1. Feature inventory (what the mockups require)

Each line gives the mockup board, then the feature and the layers it needs. C = core, R = runtime, D = desktop main, U = renderer.

| # | Feature | Boards | Layers | Phase |
|---|---|---|---|---|
| F1 | Plain-language vocabulary everywhere, with tooltips that keep the technical term | all | U (+ C strings shown in UI) | 1 |
| F2 | Provider logos (Claude, OpenAI for Codex, Cursor) | all | U | 1 |
| F3 | Design tokens and type scale: 11 px minimum, themed scrollbars, focus ring, light/dark parity | B8 | U | 1 |
| F4 | Shortcut router that works while the terminal has focus, and the final shortcut map | B8 | D, U | 1 |
| F5 | Honest per-provider states: Claude *Working / Needs approval / Your turn*; Codex/Cursor *Running · output just now / quiet Nm*; "Limited status" tag | B4, B4b, B8 | R, U | 2 |
| F6 | Attention banner that names the pending command (Claude) | B4 | R, U | 2 |
| F7 | Stable slots ⌘1–4, slot meter, "next needs you" ⌘J | B4 | R, U | 2 |
| F8 | Desktop notification and dock/taskbar badge when Claude needs approval and the window is unfocused | (research) | D | 2 |
| F9 | Sidebar: project switcher, New session, Active slots, Recent by day, two-line rows, Memory footer and badge, runtime line, Settings dialog | B4 | U | 3 |
| F10 | Session header, status bar ("Agent got N notes · See what was sent", diff +/−, "Output not saved") | B4 | U (+C counts) | 3 |
| F11 | Inspector with 3 tabs: Session (knows + did), Files (Changed/All), Memory | B4, B6 | U | 3 |
| F12 | Smaller screens: inspector rail and overlay below 1440 px, sidebar rail below 1180 px | B10, B11 | U | 3 |
| F13 | Composer: agent cards, mode switch Build/Plan/Read-only, one Start button, live "What the agent will know" | B5, B3 | C, D, U | 4 |
| F14 | Task box underlines matched words, hover card, "N notes match" | B13 | C, U | 4 |
| F15 | Note card trust lines: origin, approved when, "Based on file:lines", "File unchanged / Check needed", "Sent to N sessions" | B13, B6 | C, U | 5 |
| F16 | Memory tab: category filters with counts, search, other-branch and check-needed states | B6 | C, U | 5 |
| F17 | Wrap-up screen: summary cards, suggestions for this session, Remember / Remember all, first-time explainer, Continue proof, hand-off | B6 | C, R, U | 6 |
| F18 | Out-of-date catch: a session changed a note's file; note and changed lines side by side; Update / Still true / Archive | B14 | C, U | 6 |
| F19 | Exited-with-error view: last terminal output (while the runtime still holds it) | B9 | R, U | 6 |
| F20 | Welcome and first run: agents detected, Install/Sign in for every provider | B1 | D, C, U | 7 |
| F21 | "Getting to know your project": automatic Git drafts on first open, inline "Working on now / Next", Remember both | B2 | C, U | 7 |
| F22 | First session sparse states; personality (mascot placements, voice rules, first-note moment) | B3, B12 | U | 7 |
| F23 | Command palette (sessions, actions, notes), open any file, no-results actions | B7, B9 | C, D, U | 8 |
| F24 | States: runtime disconnected, crash recovery list, agent can't start, slots full, no results | B9 | R, D, U | 8 |
| F25 | Accessibility, reduced motion, Windows pass, docs, usability round with the built app | B15 | all | 9 |

---

## 2. Decisions needed before the phases they block

Each decision has a recommendation. The user must confirm the items marked **spec**, because they amend `docs/TERMINAL-FIRST-SPEC.md` or `docs/PROJECT-ORIENTATION.md`.

| # | Decision | Recommendation | Blocks |
|---|---|---|---|
| D1 **spec** | **One-action Remember.** Today a suggestion becomes a *candidate* (`acceptProposal`) and needs a separate *Approve*. The mockups use one "Remember" click: suggestions, "Remember all" (≤5), "Remember both" on first run, and "Still true". | Allow one action when the full statement (and, for Still true, the changed lines) is visible on screen. Audit it with a distinct `via` (`'wrap-up'`, `'first-run'`, `'reaffirm'`). Keep the two-step flow in the Memory tab for edits. | 6, 7 |
| D2 **spec** | **Range-level freshness.** Notes go stale when *any* byte of their file changes (whole-file SHA-256). The `rangeHash` already used for references would flag only changes to the cited lines. | Phase 6 ships file-level, worded "file changed". Range-level is a follow-up after D2 is approved. A backfill is deterministic: `sha256(excerpt)`. | 6 (follow-up) |
| D3 **spec** | **Hash caching across previews.** The spec says hashes are cached only within one operation. | Don't cache. Every keystroke runs a cheap SQL-only `previewSelection`; the full validating preview runs only on idle (≈1 s) or on request, and launch revalidates as today. | 4 |
| D4 **spec** | **Term limit mismatch.** The spec says 16 query terms; `queryTerms` defaults to 24 (`src/core/retrieval.mjs:27`). | Change the spec to 24, which matches tested behaviour. | 4 |
| D5 | **Preview receipts.** Every "Preview context" call writes a permanent receipt (`src/core/store.mjs:446`). | Stop storing previews (Phase 0, task 0.1). Launch receipts are unchanged. | 0 |
| D6 | **What "Sent to N sessions" counts.** | Distinct native conversations (`provider` + `nativeId`, falling back to the session ID), counting `submitted` and `uncertain` deliveries, per note across all revisions. Wording stays "sent", never "used". | 5 |
| D7 | **Monospace font.** The CSP is `font-src 'self'`, so Google Fonts can't load. | Use the system stack (`ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace`) in the UI and the terminal. No bundling, notices or audit cost. | 1 |
| D8 | **Shortcut map** (see 2.1). On Windows/Linux the terminal swallows Ctrl+letter and Alt+digit. | Route every app shortcut through Electron `before-input-event`. macOS uses ⌘; Windows/Linux use Ctrl+Shift (VS Code convention). Replace the mockup's ⌘R Continue (it collides with Reload) and Ctrl+1–3 (Mission Control and terminal collisions). | 1 |
| D9 | **Provider logos.** Brand usage rules for Anthropic, OpenAI and Cursor marks. | Check each brand page before release. Ship Simple Icons paths (CC0) in `ProviderMark.tsx`, keep text names next to them, and fall back to neutral monograms if a brand refuses. Record sources in `THIRD_PARTY_NOTICES.md`. | 1 |
| D10 | **Automatic first-run drafts.** | Draft automatically only when the project has no brief at all, once per project, after the project has rendered. Never redraft on later opens. | 7 |
| D11 | **Wrap-up change stats.** Live working-tree values drift when other sessions keep editing. | Snapshot `{additions, deletions, files}` at session end into the session row. The card shows the snapshot; "Open diff" shows live. | 6 |
| D12 | **Hand-off defaults.** | Prefill the new composer with the previous task text and references, editable, with no automatic start. Only approved notes travel. | 6 |
| D13 | **View menu in released builds.** Default `viewMenu` gives ⌘/Ctrl+R Reload and DevTools to users. | In packaged builds, a custom View menu without Reload, Force Reload and DevTools (Phase 0, task 0.5). Development keeps the default. | 0 |
| D14 | **Notifications.** | Add them (Phase 2), Claude only, one per waiting episode. Hide the command text by default (lock-screen privacy) behind a setting. | 2 |
| D15 | **Usability test timing.** | Run the mockup test (board B15) during Phases 0–2, which don't depend on it. Fold findings into Phases 3–8 before they're expanded. | 3–8 |

### 2.1 Recommended shortcut map (D8)

Every app shortcut is intercepted in the main process (`before-input-event`), so it works while the terminal has focus. Keys not listed stay with the terminal.

| Action | macOS | Windows / Linux | Notes |
|---|---|---|---|
| Command palette | ⌘K (also ⇧⌘P) | Ctrl+Shift+P | Ctrl+K is kill-line in shells |
| Open any file | ⌘P | Ctrl+Shift+O | Ctrl+P is shell history |
| New session | ⌘N | Ctrl+Shift+N | Ctrl+N is shell history |
| New session in a separate copy | ⌥⌘N | Ctrl+Shift+Alt+N | Avoid Ctrl+Alt (AltGr on European layouts) |
| Start (composer focused) | ⌘↵ | Ctrl+Enter | Scoped to the task box only |
| Slots 1–4 | ⌘1–4 | Alt+1–4 | Now intercepted; today the terminal swallows Alt+digit |
| Next session that needs you | ⌘J | Ctrl+Shift+J | |
| Inspector tabs Session/Files/Memory | ⌥⌘1–3 | Alt+Shift+1–3 | Replaces Ctrl+1–3 in the mockup |
| Toggle inspector | ⌘I | Ctrl+Shift+B | Ctrl+Shift+I is DevTools in dev builds |
| Toggle sidebar | ⌘\\ | Ctrl+Shift+\\ | |
| Focus terminal | ⌘E | Ctrl+Shift+E | Files moves to ⌥⌘2 / Alt+Shift+2 |
| Add a note | ⇧⌘K | Ctrl+Shift+K | Unchanged |
| Open project | ⌘O | Ctrl+O | |
| Settings | ⌘, | Ctrl+, | |
| Continue (wrap-up screen) | ⌘↵ | Ctrl+Enter | The screen's primary action; no global ⌘R |

Update the keyboard map on board B8 and every tooltip to match.

---

## 3. Bugs found during the audit (fix regardless)

| ID | Bug | Where | Phase |
|---|---|---|---|
| BUG-1 | Every context preview inserts a permanent receipt, which fills "Recent receipts" and inflates any delivery count | `src/core/store.mjs:446`, `src/desktop/main.mjs:211` | 0 |
| BUG-2 | The repo overview draft crashes on large repos: `ls-tree -r` overflows the 1 MiB Git buffer, `structure()` returns `null`, and `describeStructure(null)` throws | `src/core/status.mjs:118-157` | 0 |
| BUG-3 | A suggestion from a purged session can't be accepted (`getSession` throws) | `src/core/store.mjs:609`, `src/core/maintenance.mjs:117` | 0 |
| BUG-4 | Claude can stay "waiting" through a whole approved command: no `PreToolUse` follows the approval, and `PostToolUse` doesn't clear the state | `src/core/terminal.mjs:313-330` | 0 |
| BUG-5 | Released builds keep Reload (⌘/Ctrl+R), Force Reload and DevTools in the View menu | `src/desktop/menu.mjs` | 0 |
| BUG-6 | A branch-scoped suggestion is bound to *whatever branch is checked out at accept time*, not the branch it came from | `src/core/store.mjs:610` → `:223` | 0 |
| BUG-7 | On Windows/Linux, Alt+1–4 never reaches the app while the terminal has focus; the test only checks that a label is visible | `src/ui/App.tsx:160`, `tests/desktop-sessions.spec.ts:93` | 1 |
| BUG-8 | Exited sessions keep their 256 KiB buffer until archived or removed, so memory grows in a long-running runtime | `src/core/terminal.mjs:383-388` | 6 |
| BUG-9 | `identityAmbiguous` (Claude hook ID mismatch) lives only in memory and isn't persisted | `src/core/terminal.mjs:291-302` | 6 |

---

## 4. Architecture changes at a glance

### 4.1 Core (`src/core`)

| New or changed | Purpose | Phase |
|---|---|---|
| `prepareContext(…, { persist })` | Previews are not stored (BUG-1) | 0 |
| `previewSelection(projectId, { task, references, workspaceId })` | SQL/FTS-only candidates with reasons and matched terms. No Git, no writes. Used on keystrokes | 4 |
| `queryTermSpans(text)` in `retrieval.mjs` | Positions of each query term in the task, for underlines | 4 |
| `selection.terms` on receipt and preview items | Matched raw terms instead of the heuristic reason string | 4 |
| Migration **v8** | `proposals` expression indexes on `$.memoryId` and `$.evidence.sessionId`; `memories.approved_at`, `approved_revision` (backfilled from audit `memory-active`); `deliveries` table (backfilled from receipts) | 5 |
| `src/core/insights.mjs` (new): `memoryOrigins`, `deliveryCounts` | Note trust lines (F15) | 5 |
| `listMemoryPage({ category, … })` plus `categoryCounts` | Memory tab filters (F16) | 5 |
| `listProposals(projectId, state, { sessionId })` | Suggestions for one session (F17) | 6 |
| `rememberProposals(ids, { via })`, `rememberDraft(projectId, draft, { via })`, `reaffirmMemory(id, { startLine, endLine })` | One-action Remember (D1) | 6, 7 |
| `staleNotesForSession(sessionId)` in `insights.mjs` | Out-of-date catch, with hunks in the note's line coordinates | 6 |
| `sessionSummary(sessionId)` | Wrap-up cards: change snapshot, tests, identity state and source | 6 |
| `structure()` fallback (BUG-2); `searchFiles(workspace, query)` | Large repos; ⌘P | 0, 8 |

### 4.2 Runtime (`src/core/terminal.mjs`, `src/runtime`)

| New or changed | Purpose | Phase |
|---|---|---|
| `PostToolUse*` clears `waiting` (BUG-4) | Honest Claude state | 0 |
| `session.lastOutputAt`, plus a coalesced `{type:'activity', sessionId, lastOutputAt}` event sent only when output resumes after ≥10 s of quiet, at most once per 5 s per session | Codex/Cursor "output just now / quiet Nm" | 2 |
| `permission` event records `{tool, command (redacted, 300), path, toolUseId}`; `session.pending` is set and cleared | Attention banner | 2 |
| `session.slot` (lowest free 1–4, kept until the session stops being live) | Stable ⌘1–4 | 2 |
| `session.nativeIdSource` (`preassigned-observed`, `create-chat`, `exit-banner`, `user`) and a persisted `identityMismatch` | Continue proof (BUG-9) | 2, 6 |
| Error `code` field in runtime errors (`SLOTS_FULL`, `PROVIDER_MISSING`, …) | States sheet | 2 |
| `recovered` list in the hello reply | Crash recovery panel | 8 |
| Exited-buffer release policy (BUG-8): keep the last 8 exited buffers, release older ones | Memory bound; "last output" availability is honest | 6 |

### 4.3 Desktop main (`src/desktop`)

| New or changed | Purpose | Phase |
|---|---|---|
| `menuTemplate({ packaged })` (BUG-5); later a "Settings…" item | Safe menus | 0, 3 |
| `src/desktop/shortcuts.mjs` (new): `before-input-event` router → `{type:'command', id}` | Shortcuts work in the terminal (BUG-7) | 1 |
| `src/desktop/notify.mjs` (new): notifications and badge | F8 | 2 |
| New IPC actions on `src/desktop/preload.cjs:2`: `previewSelection`, `memoryOrigins`, `deliveryCounts`, `sessionSummary`, `staleNotesForSession`, `rememberProposals`, `rememberDraft`, `reaffirmMemory`, `providerLogin`, `searchFiles` | Renderer data | 4–8 |
| Generic `providerLogin({ provider })` replacing `cursorLogin`, with constant argv per provider | F20, F24 | 7 |

### 4.4 Renderer (`src/ui`): target file map

`App.tsx` (351 lines) is split by responsibility. New files:

| File | Responsibility |
|---|---|
| `tokens.css` | Semantic color tokens for both themes, type scale, scrollbars, focus ring |
| `copy.ts` | Every user-facing term from the vocabulary (F1), with tooltips |
| `ProviderMark.tsx` | Provider logos (inline SVG, `currentColor`, `aria-hidden`) |
| `shortcuts.ts` | Shortcut map per platform, labels for tooltips, command IDs |
| `sessionState.ts` | `stateFor(session, now, connected)` → `{word, tone, detail, limited}`; `needsYou`; slot ordering. Replaces the helpers in `SessionList.tsx` |
| `Sidebar.tsx` | Project switcher, New session, Active slots, Recent by day, footer |
| `SessionHeader.tsx`, `StatusBar.tsx` | Header with actions and attention banner; bottom bar |
| `Inspector.tsx`, `SessionTab.tsx`, `FilesTab.tsx`, `MemoryTab.tsx` | Three-tab inspector built from the existing panels |
| `NoteCard.tsx` | One note with its trust lines (used in Session, Memory, hover card and wrap-up) |
| `Composer.tsx`, `TaskField.tsx`, `ContextPreview.tsx` | New-session screen; mirror-overlay task field; live preview |
| `WrapUp.tsx`, `StaleCatchCard.tsx` | Session end loop |
| `Welcome.tsx`, `GettingToKnow.tsx`, `FirstNoteMoment.tsx` | First run |
| `CommandPalette.tsx` | ⌘K / Ctrl+Shift+P |
| `RecoveryPanel.tsx`, `StartError.tsx`, `SettingsDialog.tsx` | States and settings (Settings absorbs `DataDialog.tsx` and the theme switch) |

---

## 5. Phases and dependencies

```
Phase 0  Bug fixes ───────────────┐
Phase 1  Foundation (tokens, copy, logos, shortcut router)
            │
Phase 2  Honest session model (runtime)
            │
Phase 3  Shell: sidebar, header, status bar, inspector, rails
            ├──────────────┬──────────────┬──────────────┐
Phase 4  Composer +    Phase 5  Memory  Phase 7  First run  Phase 8  Palette +
         live preview           trust            (needs 4)          states
            └──────┬───────┘
Phase 6  Session end loop (needs 4, 5)
            │
Phase 9  Polish, accessibility, Windows, docs, usability round
```

Rough size, for one experienced developer: Phase 0 S · 1 M · 2 M · 3 L · 4 L · 5 M · 6 L · 7 M · 8 M · 9 M.

---

## 6. Phase 0: bug fixes (full detail)

**Goal:** fix BUG-1 to BUG-6 with regression tests. No UI redesign yet.
**Depends on:** nothing. **Decisions:** D5, D13 (both recommended as written).

### Task 0.1: Context previews are not stored (BUG-1)

**Files:**
- Modify: `src/core/store.mjs:334` (signature) and `src/core/store.mjs:445-447` (insert)
- Modify: `src/desktop/main.mjs:211` (IPC preview passes `persist: false`)
- Test: `tests/knowledge.test.mjs`

- [ ] **Step 1: Write the failing test.** Append to `tests/knowledge.test.mjs`:

```js
test('a context preview is not stored as a receipt; a launch receipt still is', t => {
  const f = fixture(t); const memory = f.propose(); f.store.setMemoryStatus(memory.id, 'active');
  const before = f.store.listReceipts(f.project.id).length;
  const preview = f.store.prepareContext(f.project.id, 'Docker', { persist: false });
  assert.equal(preview.items.length, 1);
  assert.equal(preview.preview, true);
  assert.equal(preview.state, 'prepared', 'The UI keeps treating it as a prepared packet');
  assert.equal(f.store.listReceipts(f.project.id).length, before, 'A preview writes nothing');
  assert.throws(() => f.store.getReceipt(preview.id), /Unknown receipt/);
  f.store.prepareContext(f.project.id, 'Docker');
  assert.equal(f.store.listReceipts(f.project.id).length, before + 1, 'The default still stores');
});
```

- [ ] **Step 2: Run it and confirm it fails.**
Run: `node --test --test-name-pattern="not stored as a receipt" tests/knowledge.test.mjs`
Expected: FAIL. `preview.preview` is `undefined`, and the receipt count grows.

- [ ] **Step 3: Implement.** In `src/core/store.mjs`, change the signature at line 334:

```js
  prepareContext(projectId, query, { workspaceId = null, disabled = [], references = [], persist = true } = {}) {
```

Replace the insert and return at lines 446–447:

```js
    // Previews show what would be sent; only a launch keeps an immutable receipt.
    if (!persist) return { ...receipt, preview: true };
    this.db.prepare('INSERT INTO receipts VALUES(?,?,?)').run(id, projectId, JSON.stringify(receipt));
    return receipt;
```

In `src/desktop/main.mjs:211`, pass `persist: false` in the `prepareContext` IPC handler's options object, keeping its other fields. The launch path (`src/core/terminal.mjs:103`) calls the store directly and keeps the default `persist: true`.

- [ ] **Step 4: Run the tests and confirm they pass.**
Run: `npm test`
Expected: all pass. `tests/explorer.test.mjs:193` counts receipts created by direct store calls (default `persist: true`), so it is unaffected.

- [ ] **Step 5: Desktop check.**
Run: `npm run check && npm run build && npm run test:desktop`
Expected: all pass. If a scenario expected a preview under "Recent receipts", update it to expect only launch receipts, with a comment naming BUG-1.

- [ ] **Step 6: Commit.**

```bash
git add src/core/store.mjs src/desktop/main.mjs tests/knowledge.test.mjs
git commit -m "Context previews no longer write receipts"
```

### Task 0.2: Repo overview drafts survive very large repositories (BUG-2)

**Files:**
- Modify: `src/core/status.mjs:118-133` (`structure`, `describeStructure`) and `src/core/status.mjs:144` (`overviewDraft`)
- Test: `tests/status.test.mjs`

- [ ] **Step 1: Write the failing test.** Add a new import line after the existing imports in `tests/status.test.mjs`:

```js
import { structure, describeStructure } from '../src/core/status.mjs';
```

Then append:

```js
test('a tree too large for one Git listing falls back to top-level structure without counts', () => {
  const run = (root, args) => {
    if (args.includes('-r')) throw new Error('stdout maxBuffer length exceeded');
    return '040000 tree 1111111111111111111111111111111111111111\tsrc\n100644 blob 2222222222222222222222222222222222222222\tpackage.json';
  };
  const result = structure('/unused', 'HEAD', run);
  assert.equal(result.counted, false);
  assert.deepEqual([...result.dirs], [['src', null]]);
  assert.deepEqual(result.files, ['package.json']);
  assert.equal(describeStructure(result), 'src; key files: package.json');
});
```

- [ ] **Step 2: Run it and confirm it fails.**
Run: `node --test --test-name-pattern="too large" tests/status.test.mjs`
Expected: FAIL with `structure is not a function` (it isn't exported yet).

- [ ] **Step 3: Implement.** Replace `structure` and `describeStructure` in `src/core/status.mjs`:

```js
export function structure(root, ref, run = git) {
  const paths = quiet(() => run(root, ['ls-tree', '-r', '--name-only', ref]).split('\n').filter(Boolean), null);
  if (paths) {
    const dirs = new Map(); const files = [];
    for (const path of paths) {
      const [first, ...rest] = path.split('/');
      if (rest.length) dirs.set(first, (dirs.get(first) ?? 0) + 1); else files.push(first);
    }
    return { dirs, files, counted: true };
  }
  // Very large trees overflow the bounded Git output: list the top level only, without counts.
  const top = quiet(() => run(root, ['ls-tree', ref]).split('\n').filter(Boolean), null);
  if (!top) return null;
  const dirs = new Map(); const files = [];
  for (const line of top) {
    const [meta, name] = line.split('\t');
    if (meta.split(' ')[1] === 'tree') dirs.set(name, null); else files.push(name);
  }
  return { dirs, files, counted: false };
}

export function describeStructure({ dirs, files }) {
  const listed = [...dirs].sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0) || a[0].localeCompare(b[0])).slice(0, 10)
    .map(([dir, count]) => count === null ? dir : `${dir} (${count})`);
  const top = files.filter(name => MANIFESTS.test(name)).slice(0, 5);
  return `${listed.join(', ') || 'no directories'}${top.length ? `; key files: ${top.join(', ')}` : ''}`;
}
```

In `overviewDraft`, right after `const now = structure(root, 'HEAD');`, add:

```js
  if (!now) throw new Error('Journal could not read this repository’s file list; try again or write the overview by hand');
```

- [ ] **Step 4: Run the tests and confirm they pass.**
Run: `node --test tests/status.test.mjs && npm test`
Expected: PASS. The existing test "an overview draft starts from README purpose and tracked structure" still sees counts, because the full listing succeeds.

- [ ] **Step 5: Commit.**

```bash
git add src/core/status.mjs tests/status.test.mjs
git commit -m "Repo overview drafts fall back to top-level structure on very large trees"
```

### Task 0.3: Suggestions from a purged session can still be remembered (BUG-3)

**Files:**
- Modify: `src/core/maintenance.mjs:125-130` (purge transaction)
- Test: `tests/proposals.test.mjs`

- [ ] **Step 1: Write the failing test.** Append to `tests/proposals.test.mjs`:

```js
test('a suggestion from a purged session can still be accepted; forged sessions are still refused', t => {
  const f = fixture(t);
  const s = f.session('Ship it.\nRule: Release tags must be signed before publishing.', { survivors: [] });
  const [created] = f.store.generateProposals(s.id);
  f.store.purgeSession(s.id);
  const kept = f.store.getProposal(created.id);
  assert.equal(kept.evidence.sessionId, null);
  assert.equal(kept.evidence.sessionPurged, true);
  assert.equal(f.store.acceptProposal(created.id).status, 'candidate');
});
```

The fixture session is `stopped`, with `survivors: []` and no `endedAt`, so `purgeSession`'s guards (`src/core/maintenance.mjs:118-125`) allow it.

- [ ] **Step 2: Run it and confirm it fails.**
Run: `node --test --test-name-pattern="purged session" tests/proposals.test.mjs`
Expected: FAIL with `Unknown session`.

- [ ] **Step 3: Implement.** In `src/core/maintenance.mjs`, inside the `store.transaction(() => { … })` of `purgeSession`, before the `DELETE FROM sessions` line, add:

```js
    // Open suggestions outlive their session: keep them acceptable, and record why no session is linked.
    store.db.prepare(`UPDATE proposals SET body=json_set(body,'$.evidence.sessionId',NULL,'$.evidence.sessionPurged',json('true'))
      WHERE json_extract(body,'$.evidence.sessionId')=? AND json_extract(body,'$.state')='open'`).run(sessionId);
```

`acceptProposal` already skips the session check when `evidence.sessionId` is falsy (`src/core/store.mjs:609`). The existing forged-session test (`tests/proposals.test.mjs:56-57`) keeps passing, because a forged ID is still non-null.

- [ ] **Step 4: Run the tests and confirm they pass.**
Run: `npm test`
Expected: PASS, including `maintenance.test.mjs` purge tests.

- [ ] **Step 5: Commit.**

```bash
git add src/core/maintenance.mjs tests/proposals.test.mjs
git commit -m "Suggestions stay acceptable after their session is purged"
```

### Task 0.4: An approved Claude tool clears "waiting" (BUG-4)

**Files:**
- Modify: `src/core/terminal.mjs:329` (`PostToolUse` / `PostToolUseFailure` case)
- Test: `tests/terminal.test.mjs`

- [ ] **Step 1: Write the failing test.** Append to `tests/terminal.test.mjs`, which uses the existing `runtime(t)` fixture:

```js
test('an approved tool ends the waiting state when it completes', async t => {
  const f = runtime(t);
  const { session } = await f.manager.start({ projectId: f.project.id, provider: 'claude', task: 'x' });
  f.manager.ingest(session.id, { event: 'PermissionRequest', nativeId: session.nativeId, tool: 'Bash' });
  assert.equal(f.store.getSession(session.id).status, 'waiting');
  f.manager.ingest(session.id, { event: 'PostToolUse', nativeId: session.nativeId, tool: 'Bash', toolUseId: 'approved-1' });
  const after = f.store.getSession(session.id);
  assert.equal(after.status, 'running');
  assert.equal(after.activity, 'working');
});
```

- [ ] **Step 2: Run it and confirm it fails.**
Run: `node --test --test-name-pattern="approved tool ends" tests/terminal.test.mjs`
Expected: FAIL. The status is still `waiting`.

- [ ] **Step 3: Implement.** In `src/core/terminal.mjs`, make the first statement of `case 'PostToolUse': case 'PostToolUseFailure': {`:

```js
        // The tool ran, so any permission prompt for it was answered, even if no further PreToolUse arrives.
        if (session.status === 'waiting') this.observe(id, event.nativeId, 'running', 'working');
```

- [ ] **Step 4: Run the tests and confirm they pass.**
Run: `npm test`
Expected: PASS, including `tests/runtime.test.mjs` "Claude hook observations…". That test emits `PermissionRequest` last, so it still ends in `waiting`.

- [ ] **Step 5: Record the native check.** Add a line to `docs/NATIVE-VALIDATION.md` under a "To verify" heading:
"After approving a Bash permission in authenticated Claude Code, Journal shows Working, not Needs approval, while the command runs."

- [ ] **Step 6: Commit.**

```bash
git add src/core/terminal.mjs tests/terminal.test.mjs docs/NATIVE-VALIDATION.md
git commit -m "Claude leaves the waiting state once an approved tool completes"
```

### Task 0.5: Released builds have no Reload or DevTools in the View menu (BUG-5)

**Files:**
- Modify: `src/desktop/menu.mjs` (`menuTemplate`)
- Modify: `src/desktop/main.mjs:469` (pass `packaged: app.isPackaged`)
- Test: `tests/menu.test.mjs`

- [ ] **Step 1: Write the failing test.** Append to `tests/menu.test.mjs`:

```js
test('released builds have no Reload or developer tools in the View menu', () => {
  const options = { name: 'Journal', checkForUpdates() {}, openUrl() {}, packaged: true };
  for (const platform of ['darwin', 'win32']) {
    const template = menuTemplate({ ...options, platform });
    assert.ok(!template.some(item => item.role === 'viewMenu'), platform);
    const view = template.find(item => item.label === 'View');
    assert.deepEqual(view.submenu.filter(item => item.role).map(item => item.role), ['resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen'], platform);
  }
});
```

- [ ] **Step 2: Run it and confirm it fails.**
Run: `node --test tests/menu.test.mjs`
Expected: the new test FAILs, because `viewMenu` is still present.

- [ ] **Step 3: Implement.** In `src/desktop/menu.mjs`, change the signature to `menuTemplate({ platform, name, checkForUpdates, openUrl, packaged = false })`. Add as its first line:

```js
  // Released builds: zoom and full screen only. Reload would drop the renderer mid-session for no user benefit.
  const view = packaged
    ? { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] }
    : { role: 'viewMenu' };
```

Replace both occurrences of `{ role: 'viewMenu' }` with `view`. In `src/desktop/main.mjs:469`, add `packaged: app.isPackaged` to the object passed to `menuTemplate`.

- [ ] **Step 4: Run the tests and confirm they pass.**
Run: `npm test && npm run test:desktop`
Expected: PASS. The existing test omits `packaged`, so it still sees `viewMenu`.

- [ ] **Step 5: Commit.**

```bash
git add src/desktop/menu.mjs src/desktop/main.mjs tests/menu.test.mjs
git commit -m "Released builds drop Reload and DevTools from the View menu"
```

### Task 0.6: A branch suggestion is remembered on its own branch only (BUG-6)

**Files:**
- Modify: `src/core/store.mjs:605-610` (`acceptProposal`)
- Test: `tests/proposals.test.mjs`

- [ ] **Step 1: Write the failing test.** Append to `tests/proposals.test.mjs`:

```js
test('a branch suggestion cannot be remembered while another branch is checked out', t => {
  const f = fixture(t);
  const s = f.session('Rule: Feature flags on this branch default to off.', { survivors: [] });
  const [created] = f.store.generateProposals(s.id);
  f.store.db.prepare(`UPDATE proposals SET body=json_set(body,'$.scope','branch','$.branch','feature/flags') WHERE id=?`).run(created.id);
  assert.throws(() => f.store.acceptProposal(created.id), /Switch to feature\/flags/);
  assert.equal(f.store.getProposal(created.id).state, 'open', 'Nothing changed');
});
```

- [ ] **Step 2: Run it and confirm it fails.**
Run: `node --test --test-name-pattern="branch suggestion" tests/proposals.test.mjs`
Expected: FAIL. It is accepted onto `main`.

- [ ] **Step 3: Implement.** In `acceptProposal` in `src/core/store.mjs`, after the `branch-status` check, add:

```js
    if (proposal.scope === 'branch' && proposal.branch && proposal.branch !== this.project(proposal.projectId).branch) {
      throw new Error(`Switch to ${proposal.branch} to remember this branch suggestion`);
    }
```

- [ ] **Step 4: Run the tests and confirm they pass.**
Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/core/store.mjs tests/proposals.test.mjs
git commit -m "Branch suggestions are only remembered on their own branch"
```

### Task 0.7: Phase 0 verification and status

- [ ] Run `npm test && npm run check && npm run build && npm run test:desktop`. All must pass; record the counts.
- [ ] Update `docs/IMPLEMENTATION-STATUS.md`: add a "UX redesign, Phase 0" entry listing BUG-1 to BUG-6 as fixed, plus the native check that remains from task 0.4.
- [ ] Commit: `git commit -am "Record Phase 0 of the UX redesign"`

---

## 7. Phases 1–9 (expand each into its own bite-sized plan before starting)

Each task lists **files**, **what to build** (signatures and behaviour), **tests** and **acceptance**. Use TDD for every task: failing test, run, implement, run, commit.

### Phase 1: Foundation (F1–F4, BUG-7)

**Task 1.1: Semantic tokens and type scale (F3, D7)**
- **Files:** create `src/ui/tokens.css`; modify `src/ui/styles.css` (import it at the top and replace hard-coded hex with `var(--…)`), `src/ui/theme.ts` (xterm themes read the same values), `src/ui/TerminalPane.tsx` (system monospace stack).
- **Build:**
  - Tokens for both themes, from board B8: `--bg --side --panel --raised --field --hover --sel --line --line2 --tx --tx2 --tx3 --acc --accbtn --accsoft --amb --ambsoft --ambline --grn --grnsoft --red --redsoft --term`.
  - Light theme on `:root[data-theme=light]`, which keeps the existing mechanism (`App.tsx:33`).
  - Raise every size below 11 px (about 60 rules, listed in the audit) to the scale 11 / 12 / 13 / 16 / 22.
  - Scrollbars: `color-scheme` per theme, a thin rounded thumb using `--line2`, darker on hover.
  - Focus: 2 px `--acc` outline with 2 px offset, `:focus-visible` only.
  - Hover effects inside `@media (hover:hover) and (pointer:fine)`. No `transition: all`. Theme switches cause no transitions.
- **Tests:**
  - Unit test (`tests/tokens.test.mjs`): parse `tokens.css` and check that every text/surface pair meets contrast ≥4.5:1 in both themes, with a small WCAG luminance helper inside the test.
  - Desktop: update `desktop.spec.ts:69` to the token's computed value.
  - Add a check that no computed `font-size` below 11 px exists on the main screen.
- **Acceptance:** light and dark screenshots match boards B4/B5. No hard-coded hex values remain outside `tokens.css` and `theme.ts`.

**Task 1.2: Plain-language copy module (F1)**
- **Files:** create `src/ui/copy.ts`; modify every call site the audit lists (`KnowledgePanel.tsx`, `KnowledgeForm.tsx`, `ContextPanel.tsx`, `ActivityPanel.tsx`, `DataDialog.tsx`, `ManageProjectDialog.tsx`, `ExplorerPanel.tsx`, `ProviderStatus.tsx`, `SessionList.tsx`, `App.tsx`) and the desktop specs that match on the old strings.
- **Build:**
  - `copy` with keys such as `memory: 'Project memory'`, `memoryTab: 'Memory'`, `note: 'note'`, `remember: 'Remember'`, `suggestions: 'Suggestions'`, `aboutProject: 'About this project'`, `branchStands: 'Where this branch stands'`, `outOfDate: 'Out of date'`, `checkNeeded: 'Check needed'`, `whatWasSent: 'What was sent'`, `continue: 'Continue'`, `readOnly: 'Read-only'`, `separateCopy: 'Separate copy (worktree)'`, `rule: 'Rule'`, each with a `tooltip` that keeps the technical term (for example "Approve: agents receive it from the next session").
  - Core strings shown in the UI (selection reasons such as `repo overview` and `branch update`, warnings such as "Review them in Knowledge") are mapped in the renderer through `copy.reason(code)`.
  - **Don't change packet or receipt text**, because receipts are immutable. A follow-up may add a `code` field to reasons and warnings in core so the renderer maps codes, not English.
- **Tests:**
  - Update the desktop spec strings listed in the audit: `tab /^Knowledge/` → `/^Memory/`, `'Approve'` → `'Remember'`, `'Resume'` → `'Continue'`, `'Preview context'` → (Phase 4 removes it; keep it until then), `/Research/` → `/Read-only/`, `.terminal-label 'research'` → `'read-only'`.
  - Keep provider aria prefixes (`Claude Code: …`, `Codex: …`, `Cursor: …`).
  - Add `tests/copy.test.mjs`, a unit test that fails if old terms (`claim`, `Knowledge`, `receipt`, `stale`, `Approve`) appear in `src/ui/**/*.tsx` text outside `copy.ts` and `title` attributes.
- **Acceptance:** board B8's vocabulary is used everywhere. Screen-reader names keep the precise meaning, for example "Remember (approve for agents)".

**Task 1.3: Provider logos (F2, D9)**
- **Files:** create `src/ui/ProviderMark.tsx`; modify `SessionList.tsx`, `App.tsx` (Start buttons, terminal heading), `ProviderStatus.tsx`, `ContextPanel.tsx`; update `THIRD_PARTY_NOTICES.md` through `npm run notices` if needed.
- **Build:** `<ProviderMark provider size? />` renders a tile containing an inline `<svg aria-hidden="true">` with Simple Icons paths (`claude`, `openai`, `cursor`).
  - Claude keeps `#D97757` on a tinted tile.
  - OpenAI and Cursor use `currentColor`.
  - Text names stay next to the logo, or in the row's aria-label.
- **Tests:**
  - Unit render test with `react-dom/server` `renderToString`: each provider gives an svg with `aria-hidden`.
  - Desktop: provider aria-label prefixes are unchanged.
- **Acceptance:** boards B1, B4 and B4b.

**Task 1.4: Shortcut router (F4, BUG-7, D8)**
- **Files:** create `src/desktop/shortcuts.mjs` and `src/ui/shortcuts.ts`; modify `src/desktop/main.mjs` (attach to `webContents.on('before-input-event')`), `src/desktop/preload.cjs` (no new action; commands arrive through the existing `onEvent`), `src/ui/App.tsx` (handle `{type:'command', id}` and delete the window keydown switch at `App.tsx:156-175`).
- **Build:** `matchShortcut(input, platform) → id | null`, a pure function covering the map in 2.1.
  - On a match, call `event.preventDefault()` and send `{type:'command', id}` to the renderer.
  - Never intercept Ctrl+C, Ctrl+D, Ctrl+Z, Ctrl+L, Ctrl+R or any Ctrl+letter without Shift on Windows/Linux.
  - `⌘↵` / `Ctrl+Enter` aren't routed globally; `TaskField` handles them.
- **Tests:**
  - `tests/shortcuts.test.mjs`: a table-driven test of `matchShortcut` for both platforms, including the do-not-intercept list.
  - Desktop: in `desktop-sessions.spec.ts`, focus the terminal, press `Alt+2` (Linux CI) or `Meta+2`, and assert that **the selected session's title changed**. That replaces the always-true label check at `:93`.
- **Acceptance:** every shortcut in 2.1 works with the terminal focused. Terminal control keys still reach the CLI.

### Phase 2: Honest session model (F5–F8)

**Task 2.1: Last-output activity for Codex/Cursor (F5)**
- **Files:** `src/core/terminal.mjs` (`output()`, `emitStatus`), `src/runtime/protocol.mjs` (event type), `src/ui/types.ts`.
- **Build:**
  - `entry.session.lastOutputAt` is set in `output()` only.
  - Echo of typed input is ignored: output within 300 ms of a `write()` doesn't move it.
  - Emit `{type:'activity', sessionId, lastOutputAt}` when output resumes after ≥10 s of quiet, throttled to 5 s per session. Continuous output emits nothing.
  - Persist `lastOutputAt` with the existing 5 s session save.
- **Tests (unit, fake PTY and fake timers):**
  - A flood of 1,000 chunks gives exactly one event.
  - Quiet for 11 s, then output, gives one more event.
  - Echo within 300 ms of input is ignored.
- **Acceptance:** the renderer can compute "output just now" (output in the last 10 s) and "quiet Nm" with its 15 s clock and no IPC flood.

**Task 2.2: Per-provider state words (F5)**
- **Files:** create `src/ui/sessionState.ts` (replacing `stateLabel`, `needsAttention` and `resumable` in `SessionList.tsx`); test `tests/session-state.test.mjs` (pure TS compiled by `tsc`, or written as `.mjs` mirroring the function; follow the repo's pattern of testing pure UI helpers).
- **Build:** `stateFor(session, now, connected)`:
  - **Claude:** `waiting` → "Needs approval" (amber, attention); `running`+`idle` → "Your turn"; `running`+`working` → "Working".
  - **Codex and Cursor:** `running` → "Running", with detail "output just now" or "quiet Nm", and `limited: true`. Never amber.
  - **Any provider:** `exited 0` → "Exited 0"; `exited N` → "Exited N" (error tone); `stopped`, `interrupted` and `orphaned` as on board B8; disconnected → "Disconnected · state unknown".
  - `needsYou(session)` is true only for Claude `waiting`, `failed`, `orphaned`, or survivors present.
- **Tests:** a table test over every status, activity and provider combination.
- **Acceptance:** board B8's state table.

**Task 2.3: Pending command for the attention banner (F6)**
- **Files:** `src/core/terminal.mjs:316` and the `PreToolUse`/`PostToolUse`/`Stop`/`UserPromptSubmit` cases; `src/desktop/hook.mjs` (pass `tool_input.command`, `file_path` and `tool_use_id` for `PermissionRequest` if present).
- **Build:**
  - The `permission` event records `{tool, command: redact(cmd, 300) | null, path: relative | null, toolUseId | null}`.
  - `session.pending = {tool, command, path, at}` is set on `PermissionRequest` and cleared on `PreToolUse`, `PostToolUse*`, `Stop` and `UserPromptSubmit`.
  - If the payload lacks the command, fall back to the most recent unmatched `command-start` for Bash, marked `inferred: true`.
- **Tests:**
  - Unit: a `PermissionRequest` with a command gives a redacted `pending`, which clears on `PostToolUse`.
  - Unit: the inferred fallback.
  - Runtime test: extend `tests/runtime.test.mjs:197` with a command payload.
- **Native check:** record in `docs/NATIVE-VALIDATION.md` whether Claude's `PermissionRequest` hook payload includes `tool_input`.
- **Acceptance:** board B4's banner shows the exact command for Claude. Codex/Cursor never show a banner.

**Task 2.4: Stable slots and "next needs you" (F7)**
- **Files:** `src/core/terminal.mjs` (slot assignment in `start`; release on exit, stop or orphan end), `src/ui/sessionState.ts` (`slotOrder`), `src/ui/App.tsx` (commands `slot-1..4` and `next-needs-you`).
- **Build:**
  - `session.slot` = the lowest free of 1–4 among live sessions, assigned at start, kept across reloads, freed when the session stops being live.
  - The sidebar sorts Active by `slot`.
  - `next-needs-you` cycles through `needsYou` sessions in slot order.
- **Tests:**
  - Unit: start A, B and C (slots 1–3); stop B; start D gets slot 2; A stays on 1.
  - Desktop: ⌘2 selects the same session before and after a renderer reload.
- **Acceptance:** shortcuts never move.

**Task 2.5: Identity source and error codes (supports F17, F24)**
- **Files:** `src/core/terminal.mjs` (where `nativeId` is set: preassigned, `create-chat`, exit banner, `confirmNativeId`; plus `identityMismatch` persistence, BUG-9), `src/runtime/runtime.mjs:131` (errors carry `code`).
- **Build:** `session.nativeIdSource ∈ {preassigned, preassigned-observed, create-chat, exit-banner, user}`, and `session.identityMismatch: boolean`. Errors throw `Object.assign(new Error(msg), { code: 'SLOTS_FULL' })`, and the protocol forwards `code`.
- **Tests:** unit tests for each source transition, mismatch persistence, and the `SLOTS_FULL` code reaching the client.

**Task 2.6: Notifications and badge (F8, D14)**
- **Files:** create `src/desktop/notify.mjs`; modify `src/desktop/main.mjs` (subscribe in `runtime.on('event')`; `app.setAppUserModelId` on Windows).
- **Build:**
  - When a Claude session enters `waiting` while `!window.isFocused()`, show one `Notification` per waiting episode: "Claude needs approval: <session title>", plus the command if the setting allows.
  - Clicking it focuses the window and sends `{type:'command', id:'select-session', sessionId}`.
  - Badge = the number of `needsYou` sessions (`app.setBadgeCount`, or `dock.setBadge` on macOS).
- **Tests:**
  - Unit: `notify.mjs` with an injected Notification constructor gives one notification per episode, none when focused, and none for Codex.
  - Desktop: a headless hook captures calls, following the `__journalMenuHook` pattern.

### Phase 3: Shell (F9–F12)

**Task 3.1: Sidebar (F9)**
- **Files:** create `src/ui/Sidebar.tsx`; retire `SessionList.tsx` after moving its helpers; create `src/ui/SettingsDialog.tsx` (absorbs `DataDialog.tsx`, the theme switch and update settings); modify `src/desktop/menu.mjs` ("Settings…" ⌘, / Ctrl+,).
- **Build:**
  - **Project switcher** button: mascot tile, name, path and branch. It opens a menu of projects with Open project…, Manage… and Remove items, reusing `showMenu`.
  - **New session** button.
  - **Active** · "N of 4" with a 4-segment meter; rows in slot order.
  - **Recent**, grouped Today / Yesterday / Earlier by `endedAt ?? lastActivityAt ?? createdAt`.
  - Rows have two lines: title on line 1; line 2 is the state word, then extras ("N suggestions" from `proposals` where `evidence.sessionId` matches, "Can continue" from `resumable`, or the project name for other projects).
  - Attention rows are tinted amber in place.
  - **Footer:** Project memory (with the suggestions badge), Settings, and "Runtime connected · local only".
  - App fetches `proposals` (not only the panel) and refetches on the `proposals` event.
- **Tests:** update `desktop-projects.spec.ts`, `desktop-context-menus.spec.ts` and `desktop-sessions.spec.ts` selectors (the audit lists every one). New scenarios:
  - Recent groups by day.
  - A suggestions count appears on the row after a session ends.
  - Settings opens with ⌘, and contains Dark mode and Data and backups.
- **Acceptance:** board B4's sidebar.

**Task 3.2: Session header and status bar (F10)**
- **Files:** create `src/ui/SessionHeader.tsx` and `src/ui/StatusBar.tsx`; modify `App.tsx:297-312`.
- **Build:**
  - **Header:** title (rename inline); provider logo with the CLI version *at launch* (store `session.cliVersion` at start in `terminal.mjs`); workspace label (`copy.separateCopy` for worktrees); mode; "Started Nm ago"; **Interrupt ⌃C**, **Stop**, ⋯ menu.
  - For Codex/Cursor, a "Limited status" chip with its tooltip.
  - **Banner:** amber, `role="status"`, shown when `session.pending` is set: "Claude is waiting for your approval · <tool>: <command>", with "Answer in the terminal. Journal never approves for you."
  - **Status bar:**
    - "Agent got N notes · X KB · See what was sent". The link opens the Session tab scrolled to the packet.
    - Diff "+a −d in f files" from `sessionChanges`: refreshed on `file` events for Claude, and polled every 10 s while visible for Codex/Cursor.
    - "Output not saved".
- **Tests:** update `.terminal-label` assertions (≈15). New scenarios: the banner shows a fixture command, the status bar counts match the receipt, and the "Limited status" chip appears for the Codex fixture.

**Task 3.3: Three-tab inspector (F11)**
- **Files:** create `src/ui/Inspector.tsx`, `SessionTab.tsx`, `FilesTab.tsx` and `MemoryTab.tsx`; modify `App.tsx:26` (`Panel` becomes `'session' | 'files' | 'memory'`) and `App.tsx:317-339`.
- **Build:**
  - **Session tab:** `ContextPanel`, then a compact "What it did" timeline from `ActivityPanel`, with one shared `sessionEvents` fetch. For Codex/Cursor, "Activity isn't visible for <provider>. Its terminal shows everything. Changes are still tracked in Files."
  - **Files tab:** toggle **Changed (n)** / **All files**.
    - *Changed* = `ChangesPanel` semantics (since the session's start commit, with the "before" marker kept).
    - *All files* = `ExplorerPanel` (its own git-status filter stays inside).
  - **Memory tab:** `KnowledgePanel` (suggestions on top).
  - Shortcuts ⌥⌘1–3 / Alt+Shift+1–3 through the router.
- **Tests:** update every `getByRole('tab', …)` in the audit list; new tab names and the merged content render.

**Task 3.4: Rails and overlay (F12)**
- **Files:** `src/ui/ResizableWorkspace.tsx`, `src/ui/styles.css`.
- **Build:**
  - **Below 1440 px:** the inspector becomes a 44 px rail of tab icons with badges. ⌘I or a click opens it as an absolutely positioned overlay (it doesn't change grid columns, so the terminal never refits). Esc closes it.
  - **Below 1180 px:** the sidebar becomes a 56 px rail (project, New, slot tiles with state dots, Recent, Memory, expand). ⌘\\ toggles it.
  - Exactly 1440 counts as wide.
  - Automatic collapse never overwrites stored preferences (`journal-panel-widths`, `journal-panel-collapsed`).
- **Tests:** update `desktop-layout.spec.ts` (the separator is gone in rail mode; assert rail and overlay behaviour). New: at 1280×800 the terminal has ≥100 columns with the overlay closed.

### Phase 4: Composer and live preview (F13, F14; D3, D4)

**Task 4.1: SQL-only `previewSelection` and term spans**
- **Files:**
  - `src/core/retrieval.mjs`: `queryTermSpans(text) → [{term, start, end}]` using `matchAll` indexes, splitting camelCase and separators into sub-ranges with the same rules as `queryTerms`.
  - `src/core/store.mjs`:
    - `previewSelection(projectId, { task, references, workspaceId })` runs the brief/pinned/area/FTS stages with no evidence validation, no Git spawns and no writes. It returns `{ items: [{id, category, statement, scope, branch, reason, terms, checkedAtStart: false}], briefs, counts }`.
    - In `prepareContext`, add `selection.terms` from per-term FTS checks: `SELECT 1 FROM memory_fts WHERE rowid=? AND memory_fts MATCH ?` over the ≤12 delivered items.
  - `src/core/store-methods.mjs`, `src/desktop/main.mjs` and `preload.cjs` gain the action.
- **Tests:**
  - Spans for `fooBar`, paths, Unicode and repeated words.
  - Porter-only matches ("retries" / "retry").
  - `previewSelection` writes nothing (receipt count unchanged, no `git` spawns: inject a counting `git` or assert timing).
  - Its candidate set equals `prepareContext`'s before validation.
- **Acceptance:** a keystroke preview costs one SQLite query.

**Task 4.2: Composer (F13)**
- **Files:** create `src/ui/Composer.tsx` and `ContextPreview.tsx`; modify `App.tsx:280-295`.
- **Build:**
  - **Agent cards** show logo, name, version and status ("Installed · 2.1.286", "Sign in needed", "Not installed · Install…"). Claude/Codex sign-in is unknown until Phase 7 adds `auth status`, so never claim "signed in" without data.
  - **Mode switch** Build / Plan / Read-only maps to `{ plan, research }` and keeps today's rules: Codex has no Plan; Cursor needs `supports.mode`. One line explains the selected mode.
  - **Workspace select** plus Manage.
  - **One primary button:** "Start <agent> ⌘↵".
  - **ContextPreview:**
    - debounce 250 ms → `previewSelection`, with a ticket counter that drops stale replies;
    - after 1 s idle → `prepareContext({ persist: false })` for exact bytes and validation;
    - meter (notes / KB); groups "Every session knows", "Relevant to your task" and "Not included" (reason chips); ⌫ leaves a note out.
- **Tests:**
  - Update the `'Start Claude'` / `'Start Codex'` / `'Start Cursor'` selectors (more than 30) to `getByRole('button', { name: /^Start/ })` after selecting the agent card.
  - Update `getByLabel('Initial task')` → `getByLabel('Task')`.
  - New: typing updates the preview without receipts; leave-out works; Codex disables Plan.

**Task 4.3: Underlines and hover card (F14)**
- **Files:** create `src/ui/TaskField.tsx`.
- **Build:**
  - Keep the `<textarea>`, and add an `aria-hidden` mirror div behind it with identical font, padding, wrapping and scroll. Wrap matched spans in `<mark>`, underline style only.
  - Hover and focus use pointer hit-testing against mirror rects; keyboard users get a focusable "N notes match" button that opens the same list.
  - The hover card is `NoteCard` (Phase 5 adds trust lines; Phase 4 shows statement, category, matched words and Leave out).
  - Closed by default. No animation (typing is high-frequency).
  - `aria-describedby` points to the polite live summary.
- **Tests:**
  - Unit: span-to-mirror mapping.
  - Desktop: typing "worktree" underlines it, hovering opens the card, Leave out removes the note from the preview.

### Phase 5: Memory trust (F15, F16; D6)

**Task 5.1: Migration v8**
- **Files:** `src/core/store.mjs` (`migrate` steps); test `tests/knowledge.test.mjs`.
- **Build:**
  - `CREATE INDEX proposals_memory ON proposals(json_extract(body,'$.memoryId'))` and `proposals_session ON proposals(json_extract(body,'$.evidence.sessionId'))`.
  - `ALTER TABLE memories ADD COLUMN approved_at TEXT`, plus `approved_revision INTEGER`; backfill from audit `memory-active`, and set them in `setMemoryStatus`.
  - `CREATE TABLE deliveries(receipt_id TEXT, memory_id TEXT, revision INTEGER, project_id TEXT, session_id TEXT, provider TEXT, native_id TEXT, at TEXT, PRIMARY KEY(receipt_id, memory_id))` with an index `(project_id, memory_id)`. Backfill from receipts in state `submitted`/`uncertain` with `json_each(body,'$.items')`.
  - Write rows in `updateReceiptState` on the first move to `submitted` or `uncertain`. Delete them in `purgeSession` and `removeProject`.
- **Tests:**
  - A v7 database file migrates to v8; the backfill equals an on-demand `json_each` count.
  - Previews and failed receipts aren't counted; purge decrements; removal doesn't.

**Task 5.2: Origins and counts (F15)**
- **Files:** create `src/core/insights.mjs` (`memoryOrigins(store, projectId, ids)` and `deliveryCounts(store, projectId, ids)`); IPC and preload.
- **Build:**
  - **Origin kinds:**
    - `session`: via `proposals.memoryId` → `evidence.sessionId` → title and provider; `sessionState` is `present`, `removed` or `purged` (the purged fallback reads provider and date from `proposal.source.note`).
    - `manual`.
    - `git`: `{base, head}`.
    - `import`.
    - `promoted`.
    - `branch-status`, worded "Drafted from Git".
  - Uses revision 1 `createdAt` and `memories.approved_at`.
  - Counts are distinct conversations (D6).
- **Tests:** each origin kind, removed vs purged sessions, a revised note keeps its revision-1 origin, and counts dedupe a resume chain.

**Task 5.3: NoteCard and Memory tab (F15, F16)**
- **Files:** create `src/ui/NoteCard.tsx`; modify `KnowledgePanel.tsx` (becomes the Memory tab body); `src/core/store.mjs` (`listMemoryPage` gains `category`, returns `categoryCounts` and an `otherBranch` count).
- **Build:**
  - `NoteCard` lines:
    - category · matched words;
    - statement;
    - "You remembered this <when>, from the session '<title>' (<provider>) ›", "You added this on <date>" or "Drafted from Git (<base>..<head>)";
    - "Based on <path>:<a–b> · file unchanged since you saved it", or amber "Check needed · file changed";
    - "Sent to N sessions";
    - Leave out ⌫ (in previews).
  - **Memory tab:** search, category chips with counts, and a "check needed" total computed asynchronously for the visible page first, then in chunks of 50.
- **Tests:** filtering and counts; stale counted after a file edit; the card text for each origin kind.

### Phase 6: Session end loop (F17–F19; D1, D11, D12; BUG-8, BUG-9)

**Task 6.1: `sessionSummary` and end snapshot**
- **Files:** `src/core/insights.mjs`, `src/core/terminal.mjs` (snapshot `changeStats` at exit through `sessionChanges`).
- **Build:** `sessionSummary(sessionId) → { changes: {additions, deletions, files}, tests: {passed, failed, commands: []}, identity: {nativeId, confirmed, source, mismatch} }`. Tests come from `command-end` events with `test: true` (Claude only; others are `null`).
- **Tests:** the snapshot is unchanged by a later edit; each identity state; Codex shows `tests: null`.

**Task 6.2: Suggestions for one session; one-action Remember (D1)**
- **Files:** `src/core/store.mjs` (`listProposals(projectId, state, { sessionId })` and `rememberProposals(ids, { via })`; refactor `proposeMemory` into an internal no-transaction variant so a batch is atomic).
- **Build:**
  - `rememberProposals` accepts ≤5 IDs.
  - Per ID: accept, then approve. Audit `memory-active` with `{via}`.
  - All-or-nothing; branch mismatch refused (task 0.6).
- **Tests:** a batch of 3 gives 3 active notes and 3 audits; one bad ID rolls back all; a duplicate fingerprint from a resumed session is reported as "already suggested".

**Task 6.3: Out-of-date catch (F18)**
- **Files:** `src/core/insights.mjs` (`staleNotesForSession(store, sessionId)`), `src/core/store.mjs` (`reaffirmMemory(id, { startLine, endLine })` = a new revision with fresh evidence, then approve with `via: 'reaffirm'`). Create `src/ui/StaleCatchCard.tsx`.
- **Build:**
  - Changed paths come from the session snapshot, including the `from` path of renames.
  - Match active notes where `source.kind='file'` and the path matches (respecting `rootId` and folder prefixes), and `validation === 'stale'`.
  - **Hunk:** if `sha256(git cat-file blob <source.commit>:<path>) === contentHash`, diff `<commit> -- path` against the working tree and keep the hunks that overlap `[startLine, endLine]`. Otherwise locate `excerpt` in the current file. Cap at 20 notes.
  - Refuse to reaffirm on another branch for branch-scoped notes.
  - If the excerpt moved, the UI asks for the new line range before reaffirming.
  - **Card:** the note on the left with the changed value highlighted, the diff on the right. **Update note…** opens `KnowledgeForm` prefilled; **Still true** calls `reaffirmMemory`; **Archive** calls `setMemoryStatus(id, 'archived')`. Undo is available for 10 s where reversible.
- **Tests:** note flagged on its changed file; a rename's `from` is flagged; folder-root mapping; hunk overlap; the uncommitted-capture fallback; reaffirm gives revision n+1, active, with history preserved.

**Task 6.4: Wrap-up screen (F17)**
- **Files:** create `src/ui/WrapUp.tsx`; modify `App.tsx` (show it when the selected session ends while selected, and on selecting an ended session).
- **Build:**
  - Header: title, provider, workspace, "Exited 0 after 18m"; buttons Show terminal and **Continue ⌘↵** (primary).
  - Cards: Changes (+ Open diff), Tests run (Claude) or "Not visible for Codex", and "Continue this conversation": the ID plus its source in words ("ID confirmed by Claude" / "from Codex's exit message, confirm before continuing").
  - The out-of-date card above the suggestions when present.
  - **Suggestions:** "Worth keeping from this session?" with Remember / Edit / Dismiss, plus Remember all (≤5).
    - Suggestions arrive asynchronously, about 1.5 s after the session ends, so show a quiet "Looking for suggestions…" placeholder for up to 3 s.
    - First-time explainer (stored flag `journal-seen-suggestions`).
  - **Hand-off:** "Continue with another agent" opens the Composer prefilled with the task and references (D12).
- **Tests:**
  - Ending a fixture session shows the wrap-up with counts.
  - Remember adds a note visible in Memory.
  - Remember all.
  - Hand-off prefills the composer.

**Task 6.5: Exited-with-error view and buffer policy (F19, BUG-8)**
- **Files:** `src/core/terminal.mjs` (keep the last 8 exited buffers and release older ones); `src/ui/WrapUp.tsx` (error variant).
- **Build:**
  - For exit ≠ 0, the wrap-up leads with a read-only `TerminalPane` replaying the retained buffer.
  - If `attach` returns `{chunks: [], gap: true}`, show: "Terminal output is kept in memory only while Journal's runtime runs. It was not saved and is no longer available."
- **Tests:** a 9th exited session releases the oldest; the error view shows the replay or the honest message.

### Phase 7: First run (F20–F22; D10)

**Task 7.1: Provider detection and sign-in for all providers (F20)**
- **Files:**
  - `src/core/agents.mjs`: async detection, so `execFileSync` no longer blocks main at startup. Optional auth probes `claude auth status --json` and `codex login status`; their output shapes are verified locally without logging account details, and the result is `unknown` on any doubt.
  - `src/desktop/processes.mjs`: one runner per provider and kind.
  - `src/desktop/main.mjs`: `providerLogin({provider})` with constant argv `claude auth login` / `codex login` / `agent login`, replacing `cursorLogin`.
  - `preload.cjs` and `ProcessDialog.tsx`.
- **Tests:** detection states from fixtures; constant argv (no user input reaches argv); the Cursor flows still pass (`desktop-cursor.spec.ts`).
- **Native check:** record the auth-status shapes in `docs/PROVIDERS.md`.

**Task 7.2: Welcome screen (F20)**
- **Files:** create `src/ui/Welcome.tsx`; modify `App.tsx:278`.
- **Build:**
  - Mascot (`journal-mark` / `journal-mark-white` per theme), "Your agents remember your project", one line of explanation, **Open a project… ⌘O**, and "Any Git folder. Or drop one on this window."
  - Folder drop calls `openProject` with the path (main validates it as a Git checkout).
  - The "Agents on this computer" list.
  - Lock line: "Everything stays on this computer."
- **Tests:** update `desktop-identity.spec.ts:20-21` (the heading changes); dropping a folder opens it.

**Task 7.3: "Getting to know your project" (F21, D1, D10)**
- **Files:** create `src/ui/GettingToKnow.tsx`; `src/core/store.mjs`:
  - `rememberDraft(projectId, { scope, statement, base }, { via: 'first-run' })` = `proposeMemory` + `setMemoryStatus('active')`, refusing placeholders as today.
  - `needsOrientation(projectId)` = no active or candidate brief.
- **Build:**
  - After a project with no brief opens, run `proposeStatusUpdate('checkout')` and `proposeStatusUpdate('branch')` in the background. The branch draft is skipped on detached or unborn HEAD with a plain message.
  - Show the draft cards:
    - **About this project:** Purpose and Structure, with an inline Constraints field. It's optional: when empty, remove that line instead of saving a placeholder.
    - **Where this branch stands:** Done, plus inline fields **Working on now** and **Next**, written into the statement in place of the placeholders.
  - **Remember both ⌘↵** and **Skip for now**.
  - Side panel: "How Journal remembers" (3 steps).
  - Facts line: "Drafted from Git: README, N top-level folders, M commits · no AI call · nothing left this computer."
- **Tests:**
  - A fresh repo shows the screen.
  - Remember both creates 2 active briefs with audits `via:'first-run'`.
  - Skip shows nothing again on the next open.
  - A large repo uses the BUG-2 fallback.
  - A detached HEAD gives the overview only.

**Task 7.4: First session states and personality (F22)**
- **Files:** `ContextPreview.tsx` (empty "Relevant to your task" box with mascot and copy), `SessionTab.tsx` (empty states), create `src/ui/FirstNoteMoment.tsx`, `styles.css`.
- **Build:**
  - Voice rules from board B12: first person only in onboarding, empty states and explanations; neutral elsewhere; no exclamation marks or emoji.
  - First-note moment: once per install (`localStorage journal-first-note-seen`). A 280 ms ease-out pop plus a small head tilt, skipped under `prefers-reduced-motion`, non-blocking, `role="status"`.
  - Before writing CSS, read `animate/SKILL.md` and `review-animations/SKILL.md` from the skill collection.
- **Tests:** the moment shows once; reduced-motion emulation shows the text without animation; tests don't wait on it.

### Phase 8: Command palette and states (F23, F24)

**Task 8.1: Command palette (F23)**
- **Files:**
  - Create `src/ui/CommandPalette.tsx` in-house, with native `<dialog>`, combobox/listbox ARIA and `aria-activedescendant`. No `cmdk` dependency, which would need renderer-bundle, audit and notices changes.
  - `src/core/files.mjs`: `searchFiles(view, query, limit=50)` via `git ls-files`, respecting sensitive-file rules.
  - IPC and preload.
- **Build:**
  - Groups: Sessions (state and slot), Actions (every command in 2.1, with keys shown), Project memory (`memoryPage` search, 150 ms debounce).
  - `>` restricts results to actions; a separate shortcut opens it in file mode.
  - Opens and closes with no animation.
  - **No results:** "No sessions, commands or notes match '…'" with **New session with this task ↵** and **Add as a note**.
  - "Quiet sessions to check" lists Codex/Cursor sessions that have been quiet for 2 minutes or more.
- **Tests:** keyboard-only navigation; each group; file search excludes sensitive files; the no-results actions.

**Task 8.2: State screens (F24)**
- **Files:** create `src/ui/RecoveryPanel.tsx` and `StartError.tsx`; `src/runtime/runtime.mjs` (hello includes `recovered: [{id, status, identityVerified}]`); `App.tsx`.
- **Build:**
  - **Disconnected:** a banner with Reconnect now. Rows say "Disconnected · state unknown".
  - **Crash recovery:** "The session runtime stopped unexpectedly. N sessions were interrupted. Nothing was resent." Each row has **Continue** when `resumable`; otherwise "Needs the conversation ID before continuing" (Codex without a confirmed ID). Plus the leftover-process link from `survivors`.
  - **Can't start:** `StartError` in the composer, keyed by error `code`, with the provider-specific command, Open terminal (`providerLogin`), Copy command and Check again. The task text is kept.
  - **Slots full:** Start disabled, with the reason "4 of 4 running. Stop one to start another. You can still write the task now."
- **Tests:** runtime crash fixture → recovery panel; a fixture provider that fails at sign-in → `StartError`; four sessions → disabled reason.

### Phase 9: Polish and verification (F25)

- [ ] **Accessibility pass on every new screen:**
  - keyboard-only walkthrough of the three test tasks;
  - VoiceOver (macOS) and NVDA (Windows) names for rows, tabs, banner and palette;
  - the contrast test from task 1.1 run on both themes;
  - focus return after every dialog;
  - `aria-live` used sparingly (never per terminal chunk).
- [ ] **Motion:** run `review-animations` against the diff. Nothing animates on keyboard-triggered actions, and `prefers-reduced-motion` is respected everywhere.
- [ ] **Performance:**
  - flood the terminal (existing scenario) while typing in the composer, and check that the preview stays responsive;
  - measure the renderer with React Profiler on session switch (target <16 ms commit);
  - check that `activity` events stay throttled.
- [ ] **Windows:** run `docs/WINDOWS.md` and the shortcut table in 2.1 on Windows 11 (Ctrl+Shift combinations, Alt+1–4, toasts with `AppUserModelId`).
- [ ] **Docs:**
  - Update `README.md` (screens and shortcuts).
  - Update `docs/IMPLEMENTATION-STATUS.md`.
  - Apply the approved spec amendments (D1–D4) to `docs/TERMINAL-FIRST-SPEC.md` and `docs/PROJECT-ORIENTATION.md`.
  - Update `docs/PROVIDERS.md` (auth status, pending command).
  - Add a product screenshot where the README has a TODO.
- [ ] **Usability round 2** with the built app: the same script as board B15, plus terminal feel and real approvals. Compare with the mockup round.
- [ ] **Final:** `npm test && npm run check && npm run build && npm run test:desktop`, then `npm run dist:dir` and `npm run smoke:packaged`.

---

## 8. Self-review checklist (run before expanding each phase)

- Every feature F1–F25 maps to a task: F1 1.2 · F2 1.3 · F3 1.1 · F4 1.4 · F5 2.1/2.2 · F6 2.3 · F7 2.4 · F8 2.6 · F9 3.1 · F10 3.2 · F11 3.3 · F12 3.4 · F13 4.2 · F14 4.3 · F15 5.2/5.3 · F16 5.3 · F17 6.2/6.4 · F18 6.3 · F19 6.5 · F20 7.1/7.2 · F21 7.3 · F22 7.4 · F23 8.1 · F24 8.2 · F25 9.
- Every bug BUG-1 to BUG-9 maps to a task: 1 → 0.1 · 2 → 0.2 · 3 → 0.3 · 4 → 0.4 · 5 → 0.5 · 6 → 0.6 · 7 → 1.4 · 8 → 6.5 · 9 → 2.5.
- Names used across tasks are consistent: `persist`, `previewSelection`, `queryTermSpans`, `selection.terms`, `memoryOrigins`, `deliveryCounts`, `rememberProposals`, `rememberDraft`, `reaffirmMemory`, `staleNotesForSession`, `sessionSummary`, `session.slot`, `session.pending`, `session.lastOutputAt`, `session.nativeIdSource`, `session.identityMismatch`, `stateFor`, `needsYou`, `matchShortcut`.
- Contracts preserved:
  - native CLIs keep login, settings and permissions;
  - nothing is admitted without a visible user action;
  - receipts stay immutable (previews are not receipts);
  - exact-ID resume only;
  - no terminal output persisted;
  - no model calls.
