# Journal UX redesign, Phase 3: Shell

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Read `AGENTS.md` first. Before any UI edit, read `/Users/azechary/Downloads/skills-main/skills/emil-design-eng/SKILL.md`. Group C also reads `apple-design/SKILL.md` sections 1–3 and 7 for the resize handles, the overlay and its focus return. If the collection is missing, say so; don't claim you applied it.

**Goal:** Phase 3 of [the UX redesign](2026-10-04-ux-redesign.md) (tasks 3.1–3.4, F9–F12): the board B4 shell. It has a sidebar with a project switcher, slots, Recent by day and a footer; a session header with the attention banner; a status bar; a three-tab inspector; and rails plus an overlay for smaller windows (boards B10 and B11). A Settings dialog absorbs Data and backups, the theme switch, updates and the Phase 2 notification preferences.

**Design source:** the approved mockup boards (local HTML) in `…/scratchpad/journal-mock/src/`: `Main.body.html` (B4), `CodexSession.body.html` (B4b), `Laptop1280.body.html` (B10), `Laptop1024.body.html` (B11) and `System.body.html` (B8). Use `base.css` for structure only; the tokens already exist in `src/ui/tokens.css`.

**Prerequisite:** all of Phase 2 (groups A, B and C) is merged on `claude/ux-redesign`. Phase 3 reads these Phase 2 contracts:
- `session.slot`, `pending`, `lastOutputAt` and the `activity` event;
- `sessionState.ts` (`stateFor`, `needsYou`, `slotOrder`, `slotTarget`, `nextNeedsYou`, `outputDetail`, `resumable`);
- the `focus-session` event and error `code`s;
- `tip.limitedStatus` (a separate export of `copy.ts`, not `copy.tip`);
- `userData/preferences.json` with `PREFERENCE_DEFAULTS` and the two menu checkboxes.

Step A0 checks every name against the merged code and fixes this plan if anything drifted.

**Checks after every commit:** `npm test`, `npm run check`, `npm run build`. Renderer and desktop changes also need `npm run test:desktop` (hidden windows, Electron-native node-pty; check the exit status). Every result here is fixture-only. Phase 3 adds no provider behaviour.

**Out of scope:**
- The mockup's custom title bar, breadcrumbs and search field (the palette is Phase 8); the native window frame stays.
- The composer, agent cards and live preview (Phase 4); trust lines and Memory filters (Phase 5); one-click Remember (Phase 6, so "Add for review" stays).
- Motion. The overlay, the rails and the tab switches are keyboard-frequent, so none of them animates (emil-design-eng: never animate keyboard-initiated actions). Hover states go inside `@media (hover:hover) and (pointer:fine)`. There is no `transition: all`.

---

## 0. Groups, order and file ownership

```
A0 seam commit (Group A implementer, on claude/ux-redesign)
 ├── Group A  sidebar + Settings            (worktree p3a)  ─┐
 ├── Group B  header, status bar, inspector (worktree p3b)  ─┼─ merge A → B → C
 └── Group C  rails, overlay, layout modes  (worktree p3c)  ─┘
```

- **A0 goes first** (section 1): contracts, all new copy keys, sentence-case eyebrows, test helpers and the CSS section markers. B and C branch from A0.
- **A, B and C run in parallel**, each in its own worktree. Each one renders its own rail variant: A builds `Sidebar pane="rail"` and B builds `Inspector pane="rail"`. C only composes them. Until C merges, A and B wire their components into today's `ResizableWorkspace` unchanged.
- **Merge order: A, then B, then C.** C's desktop scenarios need both rails, so C rebases on A+B before running `test:desktop`. Before merging, rebase on the previous group and rerun every check.

| File | Owner | Others may touch |
|---|---|---|
| `src/ui/Sidebar.tsx`, `sidebarModel.ts`, `SettingsDialog.tsx` (new); `SessionList.tsx`, `DataDialog.tsx` (deleted) | A | — |
| `src/desktop/menu.mjs`, `tests/menu.test.mjs`, the `preferences`/`setPreference` actions in `main.mjs` and `preload.cjs` | A | — |
| `src/ui/SessionHeader.tsx`, `StatusBar.tsx`, `Inspector.tsx`, `SessionTab.tsx`, `FilesTab.tsx`, `MemoryTab.tsx`, `NewSessionView.tsx`, `sessionView.ts`, `useSessionData.ts` (new) | B | — |
| `ContextPanel.tsx`, `ActivityPanel.tsx`, `ChangesPanel.tsx`, `KnowledgePanel.tsx`, `ExplorerPanel.tsx` | B | A0 (eyebrow strings only) |
| `src/core/terminal.mjs` (`cliVersion`), the `start` handler in `main.mjs` | B | — |
| `src/ui/ResizableWorkspace.tsx`, `useShellLayout.ts` (new), `tests/layout.test.mjs`, `tests/desktop-layout.spec.ts` | C | — |
| `src/desktop/shortcuts.mjs`, `tests/shortcuts.test.mjs`, `src/ui/types.ts` `CommandId` | A (`settings`), C (`toggle-sidebar`) | one row each, added with its handler |
| `src/ui/App.tsx` | all | A: the sidebar region and project menus. B: the main and inspector regions and session state. C: the `ResizableWorkspace` wrapper and the layout commands. Regions are marked in A0. |
| `src/ui/styles.css` | all | each group edits only its own marked section (A0) plus selectors it owns |
| `src/ui/copy.ts` | A0 | groups may fix wording; new keys only in their own `copy.<group>` object |
| `tests/support/ui.ts` (new) | A0 | each group rewrites the bodies of the helpers it owns (section 1.5) |
| `tests/tokens.test.mjs`, `tests/styles.test.mjs` | A | B and C add assertions for their own selectors |

---

## 1. A0: the seam commit (Group A implementer, before forking)

One commit: "Phase 3 seams: copy, contracts, test helpers". **It changes no behaviour**, and all four checks must pass.

### 1.1 Types (`src/ui/types.ts`)

```ts
export interface Proposal { /* … */ evidence?: { sessionId?: string | null } | null; }  // core already returns it (proposals.mjs; store.mjs generateProposals)
export interface Session  { /* … */ cliVersion?: string | null; }   // B fills it in at launch
export type InspectorTab = 'session' | 'files' | 'memory';
export type Pane = 'full' | 'rail';
export interface Preferences { notifications: boolean; notificationCommand: boolean; }
```

### 1.2 App-level proposals (`src/ui/useProposals.ts`, new)

`useProposals(projectId: string | null, version: number, onError): Proposal[]` fetches `proposals` for the current project. Two things trigger a refetch: a change of `version` (App passes `knowledgeVersion`, which it already bumps on the `proposals` event and after accept/dismiss through `onChanged`), and a project switch. A stale reply (from the previous project) is dropped, and another project's list is never returned while its own is loading.

App passes the result to both the Sidebar and the Memory tab. `KnowledgePanel` gains an optional `proposals` prop; when it is set, the panel stops fetching on its own. One fetch serves the whole window.

### 1.3 Copy (`src/ui/copy.ts`)

Every key below goes in now, so the groups never edit the same lines. Use sentence case and the plain vocabulary (`tests/copy.test.mjs`).

```ts
export const shell = {
  // A: sidebar and settings
  newSession: 'New session', active: 'Active', slotsUsed: (n: number) => `${n} of 4`,
  recent: 'Recent', today: 'Today', yesterday: 'Yesterday', earlier: 'Earlier', archived: 'Archived',
  suggestionCount: (n: number) => count(n, 'suggestion'), canContinue: 'Can continue', settings: 'Settings',
  runtimeConnected: 'Runtime connected · local only', runtimeStarting: 'Starting runtime…', runtimeDisconnected: 'Runtime disconnected',
  switchProject: (name: string) => `Switch project. Current: ${name}`, noProject: 'No project open',
  appearance: 'Appearance', dark: 'Dark', light: 'Light', notifications: 'Notifications',
  notifyApproval: 'Notify me when Claude needs approval', notifyCommand: 'Show the command in notifications',
  notifyCommandHint: 'Notifications can appear on the lock screen.', dataAndBackups: 'Data and backups', updates: 'Updates',
  // B: header, banner, status bar, inspector
  buildMode: 'Build mode', planMode: 'Plan mode', started: (ago: string) => `Started ${ago} ago`, limitedStatus: 'Limited status',
  interrupt: 'Interrupt', approvalTitle: 'Claude is waiting for your approval', answerInTerminal: 'Answer in the terminal.',
  neverApproves: 'Journal never approves for you.',
  agentGot: (n: number, size: string) => `Agent got ${count(n, 'note')} · ${size}`, agentGotNone: 'Agent got no notes',
  deliveryUncertain: (n: number, size: string) => `Delivery uncertain · ${count(n, 'note')} · ${size}`, notSent: 'Nothing was sent',
  seeWhatWasSent: 'See what was sent', seeWhatWasPrepared: 'See what was prepared',
  diffFiles: (files: number) => `in ${count(files, 'file')}`, noChanges: 'No changes yet',
  nativePermissions: 'Native permissions', outputNotSaved: 'Output not saved',
  sentUncertain: 'What was prepared (delivery uncertain)',  // heading for an uncertain delivery (Phase 1 review note)
  inspector: 'Inspector', tabSession: 'Session', tabFiles: 'Files', tabMemory: 'Memory',
  whatThisAgentKnows: 'What this agent knows', atLaunch: (ago: string) => `at launch, ${ago} ago`,
  whatItDid: 'What it did', fromHooks: 'from Claude hooks', showTimeline: 'Show full timeline',
  activityHidden: (provider: string) => `Activity isn't visible for ${provider}`,
  activityHiddenBody: (provider: string) => `${provider} doesn't report its commands or approval prompts to Journal. Its terminal shows everything. Changes are still tracked in Files.`,
  lastOutput: (detail: string) => `Last output: ${detail}`,
  changedCount: (n: number) => `Changed (${n})`, allFiles: 'All files', changesSinceStart: 'Changes since start', uncommitted: 'Uncommitted',
  // C: layout
  showInspector: 'Show inspector', hideInspector: 'Hide inspector', expandSidebar: 'Expand sidebar', collapseSidebar: 'Collapse sidebar',
  recentSessions: 'Recent sessions',
} as const;
// Added to the existing `tip` object (tooltips may keep technical terms; the copy test exempts `tip`):
export const tip = { /* … existing keys … */
  outputNotSaved: 'Journal never stores terminal output. The runtime keeps a bounded buffer while the session lives.',
  seeWhatWasSent: 'The record of the exact text handed to the CLI at launch (receipt)',
  uncommitted: 'Files with Git status changes in the working tree',
} as const;
```

Extend `the vocabulary itself avoids the old terms` in `tests/copy.test.mjs` to the `shell` object, calling each function with sample arguments.

### 1.4 Sentence-case eyebrows (Phase 1 review note)

- Convert every uppercase eyebrow string to sentence case, for example `WHAT THE AGENT RECEIVES` → `What the agent receives`, `REFERENCED FOR THIS TASK` → `Referenced for this task`, and `TIMELINE · n` → `Timeline · n`. The files are `ActivityPanel`, `ContextPanel` (including the reference-list titles, which are also region names), `ChangesPanel`, `DataDialog`, `App` (`WORKSPACE`, `A CONTINUOUS THREAD`), `KnowledgeForm`, `KnowledgePanel`, `ProcessDialog`, `ManageProjectDialog`, `RenameDialog` and `WorkspaceDialog`.
- Sidebar captions (`PROJECTS`, `SESSIONS`, `RECENT`, `ARCHIVED`) are replaced in Group A.
- In `styles.css`, remove `letter-spacing:1.5px` from `.eyebrow`. It suits uppercase only.
- **Test:** in `tests/copy.test.mjs`, add `eyebrows are sentence case`. It scans `src/ui/**/*.tsx` text inside `className="eyebrow"` and every `aria-label`, and fails on two or more consecutive all-caps words (`/\b[A-Z]{2,}\s+[A-Z]{2,}\b/`). `⌘`, `KB` and `ID` are allowed alone.
- Update `tests/desktop-explorer.spec.ts:139,148` to the sentence-case region names.

### 1.5 Desktop test helpers (`tests/support/ui.ts`, new)

Move the selectors that Phase 3 changes behind helpers, with **today's** implementation, and switch the specs to call them. The behaviour is unchanged, so the suite stays green. Afterwards each group rewrites only its own helper bodies, which keeps the spec diffs small and the merges clean.

| Helper | Today | Owner | After Phase 3 |
|---|---|---|---|
| `currentProject(page)` | `.workspace-heading h1` | A | `.project-switcher .project-name` |
| `projectNames(app, page)` | `navigation Projects .project-name` | A | labels captured from `__lastMenu` after opening the switcher |
| `switchProject(app, page, name)` | click `.project-link` by text | A | the switcher menu hook picks the item whose label starts with `name` |
| `openAnotherProject(app, page)` | `.open-project` click | A | switcher menu → `open-project` |
| `projectContextMenu(page)` | `.project-link` (first) right-click target | A | `.project-switcher` |
| `manageProject(app, page, name)` | `Manage <name>` button | A | switcher menu → `manage` |
| `setTheme(page, theme)` | `Switch to <theme> mode` button | A | Settings → radio `Dark`/`Light` → Done |
| `openSettings(page, section?)` | `Data and backups` button | A | footer `Settings` button (or the `settings` command) |
| `slotsUsed(page, n)` | text `n/4 active` | A | text `n of 4` |
| `newSession(page)` | no-op if no session is selected, else `New session` click | B | always `New session`, unless the New session view is already shown |
| `sessionStatus(page)` | `.terminal-label` | B | `.session-header .session-meta` |
| `sessionActions(page)` | `.terminal-actions` | B | `.session-actions` |
| `inspectorTab(page, name)` (async: selects the tab and returns it) | tab by today's name (`Context`, `Changes`, `Activity`, `Files`, `Memory`) | B, then C | new tab names (`Context`/`Activity` → `Session`; `Changes` → `Files` plus the `Changed (n)` radio). C adds "open the overlay first in rail mode". |
| `filesView(page, view)` | no-op | B | radio `Changed (n)` / `All files` |
| `statusBar(page)` | `.terminal-footer` | B | `.status-bar` |
| `inspectorToggle(page, 'hide' \| 'show')` | `Hide side panel` / `Show side panel` | C | `Hide inspector` / `Show inspector` |
| `ensureWide(app)` | no-op | C | `setContentSize(1600, 900)`; specs that need the docked inspector call it first. On Windows, a 1440-px window has less than 1440 px of content. |

### 1.6 CSS sections and App regions

- At the end of `styles.css`, add three marked, empty sections: `/* === Phase 3 A: sidebar and settings === */`, `/* === Phase 3 B: session view and inspector === */` and `/* === Phase 3 C: layout, rails and overlay === */`. Leave at least four lines between them so git merges the three groups' appends cleanly.
- In `App.tsx`, add region comments around the sidebar block, the main block, the inspector block and the command handler, so each diff stays inside its own region. Don't move code in A0.

---

## 2. Group A: Sidebar and Settings (task 3.1, Settings, row states)

**Files:** new `src/ui/Sidebar.tsx`, `src/ui/sidebarModel.ts`, `src/ui/SettingsDialog.tsx`, `tests/sidebar-model.test.mjs` and `tests/desktop-sidebar.spec.ts`. Modify `App.tsx` (sidebar region, project menus, `settings` command), `src/desktop/menu.mjs`, `main.mjs` (preferences actions and the menu click), `preload.cjs` (allow-list), `shortcuts.mjs` (one row), `types.ts` (`CommandId`), `styles.css` (section A), `tests/menu.test.mjs`, `tests/shortcuts.test.mjs`, `tests/styles.test.mjs`, `tests/tokens.test.mjs`, and the bodies of the A helpers in `tests/support/ui.ts`. Delete `SessionList.tsx` (`relativeTime`, `sessionName` and `byPin` move to `sidebarModel.ts`) and `DataDialog.tsx` (its content moves into Settings).

### A1. `sidebarModel.ts` (pure, unit-tested; `node --test` imports `.ts` directly)

```ts
export const sessionName: (s: Session) => string;
export const relativeTime: (iso: string | null | undefined, now: number) => string;    // unchanged
export const byPin: (a: Session, b: Session) => number;                                 // Recent and Archived only
export type DayGroup = { key: 'today' | 'yesterday' | 'earlier'; label: string; sessions: Session[] };
export function recentGroups(sessions: Session[], projectId: string | null, now: number): DayGroup[];
export function suggestionCounts(proposals: Proposal[]): Map<string, number>;             // by evidence.sessionId
export function rowDetail(s: Session, state: SessionState, ctx: { suggestions: number; currentProjectId: string | null; projectName: (id: string) => string }): string[];
```

- **`recentGroups`:** today's Recent filter (not live, orphaned, archived or removed; current project). Each session's time is `endedAt ?? lastActivityAt ?? createdAt` against **local** midnight of `now`; groups are sorted by `byPin`; empty groups are omitted.
- **`rowDetail`** returns line 2's parts, joined with ` · `, in this order: the state word; its detail (Needs approval detail, "output just now" / "quiet Nm"); the mode (`Read-only` / `Plan mode`, ended sessions only); `n suggestions` when n > 0; `Can continue` when `resumable(s)`; the project name for other projects; `⑂ branch` for worktrees. Board B4 examples: `Exited 0 · 2 suggestions`, `Interrupted · Can continue`, `Running · quiet 2m · EngineForge`, `Stopped · Read-only`.

**Tests (`tests/sidebar-model.test.mjs`):**
- `recent groups by local day`: with a fixed `now` of 2026-10-04 10:00 local, sessions that ended at 09:00 today, 23:30 yesterday and 3 days ago land in Today, Yesterday and Earlier. A session with only `createdAt` uses it. Live and archived sessions and other projects are excluded.
- `pins order within a day group, not across groups`.
- `suggestion counts by session`: proposals without `evidence.sessionId` are ignored.
- `row detail order`: each of the four B4 examples above, plus a Claude waiting row (`Needs approval · npm run test:desktop`).

### A2. `Sidebar.tsx`

```ts
export function Sidebar(props: {
  pane: Pane;                                   // 'full' | 'rail' (C decides; until C merges App passes 'full')
  projects: Project[]; project: Project | null;
  sessions: Session[]; proposals: Proposal[];
  selectedId: string | null; connected: boolean; runtimeState: 'connected' | 'connecting' | 'disconnected';
  now: number; canStart: boolean;
  shortcuts: Bootstrap['shortcuts'] | undefined; appearance: Appearance; update: UpdateState | null;
  onSelect(s: Session): void; onSessionMenu(s: Session, at?: Point): void; onNew(): void;
  onSwitchProject(at?: Point): void;            // App opens the native switcher menu
  onProjectMenu(at?: Point): void;              // right-click: the current project's context menu
  onOpenMemory(): void; onOpenSettings(): void;
  onExpand?(): void; onShowRecent?(): void;     // rail only (C wires them to toggle-sidebar)
}): JSX.Element;
```

**Full pane (board B4), top to bottom:**
- **Project switcher** `button.project-switcher`:
  - Contents: the Journal mark tile (`img.brand-icon`, theme-dependent as today), the project name (`.project-name`), and a sub-line with the path and `⑂ branch` (`.branch-badge` moves here). Tests that look for `feat/elsewhere` read this sub-line.
  - Name: `aria-label={shell.switchProject(name)}`, `aria-haspopup="menu"`. With no project, the label is `shell.noProject` and it runs `openProject`. Right-click opens `projectMenu(currentProject)`.
- **New session** (`button.new-session`): full width, with the `new-session` shortcut `<kbd>` and `aria-keyshortcuts`. Disabled when `!canStart`.
- **Active:** the heading `Active`, `.slots-used` text `n of 4` and a 4-segment meter (`span.slot-meter`, `aria-hidden`; screen readers hear the text). Rows come from `slotOrder` (all projects).
- **Recent:** the `recentGroups` day labels as `div.day` with `role="group"` and `aria-label` set to the label.
- **Archived** (toggle, current project).
- An empty state when nothing exists.
- **Footer** (`.sidebar-footer`): `Project memory` with an accent badge for open suggestions (`onOpenMemory`); `Settings` (`onOpenSettings`, shortcut in `title`); the runtime line (`status-dot` + `shell.runtime*`); with no project, the `UpdateNotice` above them, as today.

**Row (`button.session-select`, one pattern for every row in the sidebar):**
- **Grid:** `[mark] [title] [trail]`, then line 2 spanning the title and trail columns, as in B4's `.row` (`grid-template-columns: 20px minmax(0,1fr) auto`).
- **Leading glyph:** `ProviderMark` at size 20. The status dot is dropped (Phase 1 review note).
- **Trail:** for a slotted session, the slot shortcut label (`<kbd>`, `aria-hidden`; `aria-keyshortcuts` on the row). Otherwise the relative time (`time.r`).
- **Line 2** (`.session-line`): `rowDetail(...)`, with the state word coloured by tone: `attention` → `--amb`, `error` → `--red`, everything else → `--tx3`.
- **Attention rows** (`needsYou || tone === 'attention'`): class `attention`, with `--ambsoft` fill and a `--ambline` border.
- **aria-label:** keeps Phase 2's format `"<Provider>: <title>. <word>[, <detail>][, limited status][, pinned][, needs attention]"`, so the `/^Claude Code: …/` selectors stay valid.
- Codex/Cursor rows have `title={tip.limitedStatus}`. The context menu is unchanged (`onSessionMenu`).

**Rail pane (board B11, 56 px):**
- Project tile (`aria-label` = `switchProject`, opens the switcher).
- New session (icon, `aria-label` "New session (⌘N)" from shortcuts).
- A `rsep`, then one 40×40 tile per slotted session: `ProviderMark` at 26 plus a state dot `.sd` coloured by tone (`attention` amber, `active` `--grn`, `error` `--red`, others `--tx3`). The tile carries `aria-current` when selected and class `attention` when it needs you. Its `aria-label` is `"Slot n, <Provider>: <title>. <word>[, <detail>]"` and its `title` is `"<⌘n> · <title> · <word>"`.
- A `rsep`, then Recent (`onShowRecent`), a spacer, Project memory with its badge, and Expand (`onExpand`, `title` with the `toggle-sidebar` label once C adds it).
- Every rail button is a real `<button>` with an accessible name. Badges are 11 px (the type floor; the mockup's 10.5 px is corrected).

**Project switcher menu (App, region A):** `switcherMenu(at)` uses `showMenu`:
- one item per project, `{ id: 'project:<id>', label: name + (pinned ? ' · Pinned' : '') + (current ? ' · Current' : '') }`, in today's project order;
- a separator, then `Open project…` (`open-project`), `Manage project…` (`manage`), `Rename…`, `Pin`/`Unpin`, `Add folder…`, `Reveal in …`, `Copy path` and `Remove from Journal…`.

The actions after the separator reuse the existing `projectMenu` handlers for the current project. The per-project `⋯` buttons and the Projects `<nav>` are removed. **Consequence:** right-click acts on the current project only. To manage another project, switch to it first; the switcher menu lists all projects.

**Pins:** with stable slots (Phase 2), pins no longer reorder Active; they order Recent day groups and Archived.

### A3. Row states (one pattern, master-plan Phase 3 note)

| State | Fill | Border | Extra cue |
|---|---|---|---|
| rest | transparent | transparent | — |
| hover (fine pointer only) | `--hover` | — | — |
| selected | `--sel` | — | 2 px `::before` accent bar (`inset-block:6px; left:0; width:2px; border-radius:1px; background:var(--acc)`), `aria-current="true"`; forced colors: `Highlight` |
| selected + hover | `--sel-hover` | — | bar stays |
| attention | `--ambsoft` | `--ambline` | the state word in `--amb`; hover keeps `--ambsoft` |
| attention + selected | `--ambsoft` | `--ambline` | the accent bar |

- Apply this pattern to `.session-select` and the rail tiles (`.rail-tile`). Group B applies the same rows to `.tree-row`, `.changed-row` and inspector lists. Selected tree rows currently ignore hover; they get `--sel-hover`.
- **`tests/styles.test.mjs`:**
  - Replace `.project-link` with `.project-switcher` where it applies. The switcher is a button, not a selectable row, so drop it from the selected-bar loop.
  - Add `.session-select.attention`, which uses `--ambsoft`, `--ambline` and no `--sel`.
  - Add `.rail-tile[aria-current=true]`, which uses `--sel`.
  - Add `.tree-row.selected:hover`, which uses `--sel-hover`, inside the fine-pointer block (B adds the CSS; A writes the assertion list as `TODO(B)`, and B removes the TODO).
- **`tests/tokens.test.mjs`:**
  - Extend the provider-mark test's surfaces to `[...SURFACES, 'sel-hover', 'ambsoft-over-side']`. An attention row composites `--ambsoft` over `--side`. Claude on `--claude-soft` and `--tx` on the neutral tile must stay at least 3:1.
  - New test `state dots are at least 3:1 on the rail`: `--amb`, `--grn`, `--red` and `--tx3` against `--side`, `--sel` and composited `--ambsoft`, in both themes.
  - D9a: the neutral tile is nearly invisible on light `--sel`. Give the tile `box-shadow: inset 0 0 0 1px var(--line2)` inside selected rows. This is cosmetic, so it has no assertion.

### A4. Settings dialog and menu item

**`SettingsDialog.tsx`:**

```ts
export function SettingsDialog(props: { appearance: Appearance; onAppearance(a: Appearance): void;
  update: UpdateState | null; project: Project | null; onClose(): void; onDataChanged(): void }): JSX.Element;
```

- A modal `<dialog>` with `useModalDialog` (Esc closes; the router steps aside) and `aria-labelledby` pointing at its `h2 Settings`. It has four sections, each an `h3`:
  1. **Appearance:** `role="radiogroup"` with the radios `Dark` and `Light`. Choosing one applies immediately.
  2. **Notifications:** checkboxes `shell.notifyApproval` and `shell.notifyCommand` (disabled while the first is off; hint `notifyCommandHint`), read through `api('preferences')` and written through `api('setPreference', { key, value })`.
  3. **Updates:** `UpdateSettings` (unchanged).
  4. **Data and backups:** `DataDialog`'s body, moved here: storage facts, Back up, Export, Import and the restore note. `DataDialog.tsx` is deleted.
- The footer has `Done`.

**Main (`main.mjs`, `preload.cjs`):**
- `preferences: () => preferences` (main's in-memory copy, which the notifier also reads), and `setPreference: ({ key, value })`, which accepts only `PREFERENCE_DEFAULTS` keys with boolean values and writes through Phase 2's `writePreferences` (it already throws `Invalid preference` for anything else) and updates that copy. main.mjs already has a positional `setPreference(key, value)` helper for the menu; replace it. Both actions go on the preload allow-list.

**Menu (`menu.mjs`):**
- Remove the Phase 2 checkboxes (`notify-approval` and `notify-command`) and their `preferences`/`setPreference` parameters. Settings replaces them.
- Add `{ id: 'settings', label: 'Settings…', accelerator: 'CmdOrCtrl+,', registerAccelerator: false, click: () => openSettings() }`:
  - **macOS:** in the app menu after Check for Updates…, followed by a separator.
  - **Windows/Linux:** replace `{ role: 'fileMenu' }` with `{ label: 'File', submenu: [settings, { type: 'separator' }, { role: 'quit' }] }`. Electron's `fileMenu` role holds only Quit on these platforms, so nothing is lost.
- `main.mjs` passes `openSettings: () => send({ type: 'command', id: 'settings' })`. The router owns the key: `preventDefault` in `before-input-event` also suppresses menu accelerators, so the command fires once.

**Router row (`shortcuts.mjs`, same commit as the App handler):**
- MAC `{ id: 'settings', meta: true, code: 'Comma', label: '⌘,', aria: 'Meta+,' }`
- OTHER `{ id: 'settings', control: true, code: 'Comma', label: 'Ctrl+,', aria: 'Control+,' }`

Use the physical code, because `letter()` never matches punctuation. `CommandId` gains `'settings'`. The App handler: `if (id === 'settings') setSettingsOpen(true)`, which works with or without a project.

**Shortcut table (master section 2.1):** add the row `Settings | ⌘, | Ctrl+, | Router + menu "Settings…"` to the B8 keyboard map in tooltips. The master plan already lists it; mark it implemented in `IMPLEMENTATION-STATUS.md`.

### A5. Tests

**Unit tests:**
- `tests/menu.test.mjs`: `Settings… sits in the app menu on macOS and in File on Windows and Linux` (accelerator `CmdOrCtrl+,`, `registerAccelerator: false`, click calls `openSettings`); `no notification checkboxes remain in the menu`; the existing tests still pass.
- `tests/shortcuts.test.mjs`: `⌘,` (darwin) and `Ctrl+,` (win32/linux) give `settings`; `⌘⇧,` and `Ctrl+Shift+,` give `null`; the parity tests pass with the new `CommandId`.
- `tests/sidebar-model.test.mjs` (A1), plus the styles and tokens additions in A3.

**Desktop: update these selectors through the A helpers:**
- `desktop-projects.spec.ts:18,20,22,33,35,36,38`: project order, Manage and the current project.
- `desktop-context-menus.spec.ts:35–98`: the project right-click target is `.project-switcher`. The `.pin-mark` check becomes the menu label `· Pinned`. After a removal, the switcher shows `No project open`.
- `desktop-explorer.spec.ts:153,174`: `switchProject`, `projectContextMenu`.
- `desktop-sessions.spec.ts:81,123` (`n of 4`) and `:279` (the branch is in the switcher sub-line).
- `desktop.spec.ts:75,173` and `desktop-layout.spec.ts:87`: `setTheme` (Settings → radio).
- `desktop-updates.spec.ts:17`: `openSettings`, heading `Updates`.

**New `tests/desktop-sidebar.spec.ts`** (hidden windows, fixture CLIs):
- `Active shows slots in order with the meter`: with two fixture sessions, the text reads `2 of 4`, two meter segments are on, and each row has its `⌘n`/`Alt+n` `<kbd>` and no `.status-dot`.
- `an ended session lands in Recent under Today, with its suggestion count`: start Claude with the task `rule: Release tags must be signed` (`ruleProposals` reads rule lines from the task; the runtime generates suggestions about 1.5 s after the session ends, see A0 findings), then Stop. The `Today` group holds the row, line 2 matches `/Stopped · 1 suggestion/`, and the `Project memory` badge shows 1.
- `a waiting Claude row is tinted and names the command`: drive a `PermissionRequest` hook line with a command, as in Phase 2's B4 spec. The row has class `attention`, and its line 2 contains the command.
- `Settings opens with the shortcut while the terminal has focus`:
  - Focus `.xterm-helper-textarea` and `pressKey(app, ',', ['meta'])` (`control` on win32/linux).
  - The dialog `Settings` is visible and contains `Dark`, `Light`, `Notifications`, `Updates` and `Data and backups`.
  - Toggling `Notify me when Claude needs approval` off disables the command checkbox and persists: reopen Settings after `page.reload()` and it is still off.
  - Esc closes the dialog, and the next key reaches the terminal.
- `the switcher lists projects and switches`: with two projects open, `projectNames` returns both in pin order, and `switchProject` changes `currentProject`.

### Group A acceptance

- The sidebar matches board B4 (full) and B11 (rail, rendered by `pane="rail"` even before C wires it; check this with a temporary story or a unit render with `renderToString`).
- Project switching, managing and context menus work through the switcher. No project row list remains.
- Settings is reachable from the footer, the menu (`Settings…`) and ⌘, / Ctrl+, while the terminal has focus. It contains appearance, notifications, updates and data. `DataDialog.tsx` and the menu checkboxes are gone.
- One row pattern; provider marks and state dots meet 3:1 (tested); nothing renders below 11 px; no new transitions.
- All four checks pass.

---

## 3. Group B: session header, banner, status bar and inspector (tasks 3.2, 3.3)

**Files:** new `src/ui/SessionHeader.tsx`, `StatusBar.tsx`, `NewSessionView.tsx`, `Inspector.tsx`, `SessionTab.tsx`, `FilesTab.tsx`, `MemoryTab.tsx`, `sessionView.ts` (pure), `useSessionData.ts`, `tests/session-view.test.mjs` and `tests/desktop-inspector.spec.ts`. Modify `App.tsx` (main and inspector regions, `Panel` → `InspectorTab`, the tab commands), `ContextPanel.tsx`, `ActivityPanel.tsx`, `ChangesPanel.tsx`, `KnowledgePanel.tsx`, `ExplorerPanel.tsx` (filter label), `src/core/terminal.mjs` and the `main.mjs` `start` handler (`cliVersion`), `tests/terminal.test.mjs`, `styles.css` (section B), the bodies of the B helpers, and the desktop specs listed in B6.

### B1. Main area: two views

**This change is what brings back at least 10 terminal rows at 900×640** (master Task 3.4).
- **No session selected** (project open): `NewSessionView` takes the whole main column. It holds today's `launch-bar` content, moved verbatim: `Initial task`, the references, the Start buttons, `Preview context`, workspace, the mode checkboxes, the provider line and `CursorStatus`. Under it sits the `terminal-empty` art.
- **Session selected:** `SessionHeader`, the banner, hints, `TerminalPane`, the resume-ID row, then `StatusBar`. There is **no launch bar above the terminal**.
- **No project:** the welcome screen stays (Phase 7 replaces it).

Phase 4 replaces `NewSessionView`'s body with the Composer and keeps the split. `New session` (button, ⌘N, rail) selects the New session view: today's `newSession()`.

**Spec impact:** every start while a session is selected now goes through `newSession(page)` first (B7). The `.workspace-heading` header with the project name is removed; the project is shown in the sidebar switcher (A).

### B2. `SessionHeader.tsx` and the attention banner

```ts
export function SessionHeader(props: {
  session: Session; state: SessionState; connected: boolean; busy: boolean; canStart: boolean; now: number;
  projectBranch: string | null; agentVersion: string | null;    // fallback when cliVersion is missing (older sessions)
  onInterrupt(): void; onStop(): void; onContinue(): void; onArchiveToggle(): void;
  onEndOrphan(): void; onEndSurvivors(): void; onMenu(at: Point): void;
}): JSX.Element;
```

**Row 1:**
- `h1.session-title`: `displayName || title`, ellipsis, with the full text in `title`. Rename stays in the `⋯` and right-click menus (`RenameDialog`), so there is **no inline editor** (decision 6).
- `.session-actions`:
  - **Live and connected:** `Interrupt <kbd>⌃C</kbd>` (shows `Ctrl+C` on Windows/Linux) and `Stop` (danger ghost; disabled while `stopping`).
  - **Ended:** `Continue` when `resumable`, and `Archive`/`Unarchive`. **Orphaned:** `End orphaned process`. **Survivors:** `End n leftover process(es)`.
  - Always: `⋯` (`aria-label="More session actions"`, `aria-haspopup="menu"`).

**Row 2** (`.session-meta`, small, `--tx3`; the parts are separate spans):
- the provider mark at 16 plus `PROVIDER_NAMES[p] + (cliVersion ?? agentVersion ? ' ' + version : '')`;
- the workspace: `copy.separateCopy` with `tip.separateCopy`, plus `⑂ branch` for worktrees; `Folder · name` for `root:` workspaces; otherwise `⑂ branch`, or `started on ⑂ x` when the project branch moved (today's `projectBranchChanged`);
- the mode: `Read-only` / `Plan mode` / `Build mode`;
- `Started Nm ago` (`relativeTime(createdAt)`);
- the state word and detail from `stateFor`. This span is what the old `.terminal-label` held, so specs match `Stopped`, `Exited 0` and so on here;
- for Codex/Cursor, a `Limited status` chip (`.chip`, `title={tip.limitedStatus}`).

**Banner** (`div.attention-banner`, `role="status"`):
- Shown when `session.provider === 'claude' && session.status === 'waiting'`.
- Text: `<b>Claude is waiting for your approval</b>`, then `· <tool>: ` and `<code>{pending.command ?? pending.path}</code>` when `pending` has them (with `inferred` add `title="Inferred from the last command Claude started"`), then `Answer in the terminal.` and `Journal never approves for you.`
- The second sentence hides when the main column is narrower than 720 px (container query on `.workspace`), as in B11. Codex and Cursor never show the banner.
- Style: `--ambsoft` fill, `--ambline` border, `--tx` text, the icon in `--amb`. No animation; it appears and disappears with state.

**Hints below the banner:** keep today's `.session-hint` paragraphs unchanged (branch moved, orphaned, interrupted, survivors). The runtime-disconnected, warning and error banners move to the top of the main column.

### B3. `StatusBar.tsx`

```ts
export function StatusBar(props: { session: Session; receipt: Receipt | null; changes: ChangesState;
  update: UpdateState; onShowSent(): void; onError(e: unknown): void }): JSX.Element;
```

`footer.status-bar`, 34 px high, 12 px text, `--tx3`. Left to right:
- **Delivery** (`statusLine(receipt)` from `sessionView.ts`). The size is the UTF-8 byte length of `receipt.packet`, formatted `x.y KB`.
  - `submitted`: `Agent got n notes · x KB · ` plus the link `See what was sent`. Zero items: `Agent got no notes · See what was sent`.
  - `uncertain`: `Delivery uncertain · n notes · x KB · ` plus the link `See what was prepared`. `failed`: `Nothing was sent`, no link.
  - The link is a `button.link` with `title={tip.seeWhatWasSent}`. It calls `onShowSent`: App selects the Session tab, shows the inspector (C: docks it, or opens the overlay), and bumps `packetSignal`. `SessionTab` then scrolls `data-testid="context-packet"` into view and focuses its heading.
- **Diff:** `<span class="t-g">+a</span> <span class="t-r">−d</span> in f files`, or `No changes yet`. It is hidden while `changes.available === false`.
- **Right side:** `Native permissions · Output not saved` (`title={tip.outputNotSaved}`). `Native permissions` hides below 720 px, as in B11. Then the compact `UpdateNotice`, which moves here from `.terminal-footer`.

**The receipt for this session** is `receipt?.id === session.receiptId ? receipt : null`, and App loads it on select as today. A preview receipt never feeds the status bar.

### B4. Shared session data (`useSessionData.ts`, `sessionView.ts`)

There is one `sessionEvents` fetch and one `sessionChanges` source for the header, the status bar and both tabs:

```ts
// sessionView.ts (pure)
export function mergeEvents(stored: TimelineEvent[], live: TimelineEvent[], sessionId: string): TimelineEvent[]; // dedupe by id, else at+kind+json, sorted
export function statusLine(receipt: Receipt | null): { text: string; link: 'sent' | 'prepared' | null };
export function diffSummary(changes: Changes | null): { additions: number; deletions: number; files: number } | null;
export function activityVisible(session: Session): boolean;    // claude only
export const packetBytes: (packet: string) => number;
// useSessionData.ts
export function useSessionEvents(sessionId: string | null, live: TimelineEvent[]): { events: TimelineEvent[]; error: string };
export function useSessionChanges(session: Session | null, fileEvents: number): { changes: Changes | null; loading: boolean; error: string; refresh(): void };
```

- **`useSessionEvents`** fetches once per session ID and merges live events. `ContextPanel`'s reference list and the "What it did" list both read it; their own `sessionEvents` fetches (`ContextPanel.tsx:29`, `ActivityPanel.tsx:53`) are removed and the data comes in as props.
- **`useSessionChanges`** refetches when `fileEvents` changes (Claude), every 10 s while the session is live, `provider !== 'claude'` and the document is visible, and on `refresh()`. A stale reply after a session switch is dropped (ticket counter). `ChangesPanel` takes `changes`, `loading`, `error` and `refresh` as props instead of fetching.

### B5. Inspector (`Inspector.tsx` + three tabs)

```ts
export function Inspector(props: {
  pane: Pane; tab: InspectorTab; onTab(t: InspectorTab): void;
  badges: { files: number; memory: number };          // changed-file count; open suggestions
  shortcuts: Bootstrap['shortcuts'] | undefined;
  onHide?(): void;                                     // full pane: collapse to rail (C wires it)
  onShow?(t?: InspectorTab): void;                     // rail: open/expand (C wires it)
  children: ReactNode;                                 // the active tab's panel; not rendered in rail pane
}): JSX.Element;
```

**Full pane:**
- An `aside#knowledge-sidebar.knowledge-panel` (the ID stays for the separator's `aria-controls`) with `aria-label="Inspector"`.
- A `role="tablist"` of three `role="tab"` buttons: `Session`, `Files` with a count badge, and `Memory` with a badge. Each tab has `aria-controls`, `aria-keyshortcuts` (`tab-*`), and a `title` holding its label plus keys.
- Arrow keys move between the tabs and Home/End jump to the ends (roving `tabIndex`, per WAI-ARIA). The panel has `role="tabpanel"`.
- The hide button (`aria-label={shell.hideInspector}`) is rendered only when `onHide` is set.
- Accent badges are 11 px. **The memory badge is accent, not amber** (decision 3).

**Rail pane (44 px, B10/B11):** three icon buttons with `aria-label`s `"Session (⌥⌘1)"`, `"Files, n changed (⌥⌘2)"` and `"Memory, n suggestions (⌥⌘3)"` (from the shortcut labels), badges where applicable, and `aria-pressed` on the active tab while an overlay is open; then a spacer and `Show inspector` (`onShow()`). Icons are inline SVG, `aria-hidden`, `currentColor`.

**Tabs:**
- **`SessionTab`:**
  - `ContextPanel` first. Its heading is `What this agent knows`, followed by `at launch, Nm ago` when a session receipt exists, or `copy.willKnow` for a preview.
  - **Uncertain delivery** uses `shell.sentUncertain` instead of `copy.whatWasSent` (Phase 1 note). `failed` keeps `copy.wasGoingToSend`.
  - Then `What it did`:
    - **Claude:** a compact list of the `command-*`, `file` and `permission` events (time, kind chip, path or command, `exit 0 · 4.2 s` chip), newest last and capped at 30. A `Show full timeline` disclosure reveals the existing virtualized `Timeline` and the test summary. These come from `ActivityPanel`, split into `ActivitySummary` and `Timeline` exports.
    - **Codex/Cursor:** `Activity isn't visible for <provider>`, then `activityHiddenBody`, then `Last output: <outputDetail(...)>`.
  - Then the `See what was sent` button and the note "Changes apply from the next start. What was already sent stays on record."
  - With no session (preview or a selected receipt), the tab shows `ContextPanel` alone: today's Context panel, sentence-cased.
- **`FilesTab`:**
  - With a session, a `role="radiogroup"` `aria-label="Files view"` with the radios `Changed (n)` and `All files`.
  - **Default:** `Changed` while the session has at least one change, otherwise `All files`. The user's last choice wins for the rest of the app run (state in App, not stored).
  - *Changed* renders `ChangesPanel` (heading `Changes since start`, `base <sha7>`, the `before` marker unchanged); *All files* renders `ExplorerPanel`, which is all that shows without a session.
  - Explorer's own `Changed` filter button is **renamed `Uncommitted`** (`title={tip.uncommitted}`), so two different "Changed" controls never appear together. `tab-files` still bumps `explorerFocus`.
- **`MemoryTab`:** `KnowledgePanel` with `proposals` from App. The suggestions stay on top (`Suggestions · n`, sentence case). The heading is `Project memory`. Its eyebrow `A shared foundation` is dropped as decorative.

**App:**
- `Panel` becomes `InspectorTab` (default `'memory'` with no session, `'session'` after a start; today's `setPanel('context')` becomes `'session'`).
- `tab-session`, `tab-files` and `tab-memory` set the tab and show the inspector (until C: `setCollapsed(false)`).
- Badges: `files = diffSummary(changes)?.files ?? 0` and `memory = proposals.length`.
- The current five-tab rail (`.panel-rail`) is replaced by `Inspector pane="rail"`, rendered while `collapsed`.

### B6. `cliVersion` at launch

- In `main.mjs`, the `start` handler adds `cliVersion` from the main process's own provider detection (the module-level `agents`: `detectAgents()` at startup, Cursor refreshed by `refreshCursor`) to `runtime.call('start', …)`. The runtime is a separate process; a runtime from an older build ignores the field, so the session simply lacks `cliVersion`. The renderer never sends it; the handler ignores any renderer value.
- In `terminal.mjs`, add `cliVersion` to the parameters `launch` destructures (`start` only adds the slot) and store `session.cliVersion = typeof v === 'string' ? v.slice(0, 64) : null`. Resume stores the version detected at that launch. It persists in the `sessions.body` JSON (no migration).
- **`tests/terminal.test.mjs`:** `start stores cliVersion and persists it`; `non-string cliVersion becomes null`; `resume records the version at resume time`.

### B7. Tests

**Unit (`tests/session-view.test.mjs`):**
- `statusLine` for `submitted` with 6 items and 1,946 bytes gives `Agent got 6 notes · 1.9 KB`. Also check `uncertain`, `failed`, zero items and `null`.
- `packetBytes` counts UTF-8 (an emoji is 4 bytes).
- `mergeEvents` dedupes a live event that is also stored, and drops other sessions' events.
- `diffSummary`: `null` gives `null`; the files count includes untracked files and excludes preexisting ones, matching `ChangesPanel`.
- `activityVisible`: true for Claude only.

**Desktop selectors to update (through the B helpers):**
- `.terminal-label` in `desktop.spec.ts` (3), `-sessions` (6), `-cursor` (2), `-context-menus` (2) and `-explorer` (1). The expected words follow Phase 2's state words (`Stopped`, `Exited 0`, `Read-only`).
- `.terminal-heading .provider-mark…`: `desktop.spec.ts:55` and the Codex variant, now `.session-header .provider-mark…`.
- `.terminal-actions` → `.session-actions`.
- Tabs:
  - `Context` → `Session`: `desktop.spec.ts:147,161,172`; `-explorer`; `-status`.
  - `Activity` → `Session`, asserting in the "What it did" list: `-sessions:198`.
  - `Changes` → `Files` plus the radio `Changed (1)`, then the `agent-output.txt` row and `Diff for agent-output.txt`: `-sessions:217–219`.
  - `Files` → `Files` plus `All files` where a session is selected: `-explorer`, `-cursor`.
- Explorer `/^Changed/` → `Uncommitted`: `-explorer:113`.
- Starts while a session is selected go through `newSession(page)` first: `desktop.spec.ts:147–149`; `-sessions` (four-session loop `:76`, `:189`, `:208`, `:251`, `:274`); `-context-menus`, `-cursor` and `-brief` (each start after the first).
- `.terminal-footer` → `.status-bar`, and `.terminal-footer .update-notice` → `.status-bar .update-notice`: `-updates:61–64`.
- `getByTestId('context-packet')` and `Preview context` are unchanged. `Preview context` lives in `NewSessionView`.

**New `tests/desktop-inspector.spec.ts`:**
- `the banner names the pending command and clears after approval`: the fixture hook writes a `PermissionRequest` with `tool_input.command: 'npm run test:desktop'`; `role=status` contains `Claude is waiting for your approval`, `Bash:` and the command; after `PostToolUse` it is gone.
- `the status bar counts match the receipt`: remember two notes, start a session whose task matches them; the bar matches `Agent got 2 notes · ` with KB equal to `packetBytes` of `getReceipt(...).packet`; `See what was sent` selects the Session tab and puts `context-packet` in the viewport.
- `Codex shows Limited status and no activity list`: the header chip `Limited status`; the Session tab contains `Activity isn't visible for Codex` and `Last output:`; no command rows and no banner.
- `the diff updates from file events (Claude) and polling (Codex)`:
  - The fixture writes `agent-output.txt`; the status bar shows `+1` and `in 1 file`, and the Files badge shows 1.
  - For Codex, the update arrives within 12 s with no file event.
- `inspector tabs: arrows move focus; ⌥⌘1–3 select while the terminal has focus`: `pressKey` with `alt`+`meta` (Alt+Shift on Linux).
- `the header shows the CLI version recorded at launch`: `fixture 1.0` (the fixture's `--version`).

### Group B acceptance

- Boards B4 and B4b match in the main column and the docked inspector: header, banner (Claude only), status bar and three tabs. Codex/Cursor are honest: a `Limited status` chip, no banner, and "Activity isn't visible".
- One `sessionEvents` fetch per session, and one `sessionChanges` source shared by the status bar, the Files tab and the badge.
- No uppercase eyebrows remain. An uncertain delivery never reads "What was sent".
- All four checks pass.

---

## 4. Group C: layout modes, rails and overlay (task 3.4)

**Files:** rewrite `src/ui/ResizableWorkspace.tsx`; new `src/ui/useShellLayout.ts`, `tests/layout.test.mjs` and `tests/desktop-small-window.spec.ts`. Modify `App.tsx` (the wrapper and the layout commands), `shortcuts.mjs` and `types.ts` (`toggle-sidebar`), `tests/shortcuts.test.mjs`, `styles.css` (section C), `tokens.css` (one shadow color), `tests/desktop-layout.spec.ts`, `tests/desktop.spec.ts` (the 900×640 floor), and the bodies of the C helpers.

### C1. Modes (pure, `useShellLayout.ts`)

```ts
export type LayoutMode = 'wide' | 'medium' | 'narrow';
export const WIDE_MIN = 1440, MEDIUM_MIN = 1180;
export function layoutMode(width: number): LayoutMode;      // ≥1440 wide (1440 counts as wide), ≥1180 medium, else narrow
export type PaneState = 'full' | 'rail' | 'overlay' | 'none';
export function paneStates(mode: LayoutMode, prefs: { sidebarCollapsed: boolean; inspectorCollapsed: boolean },
  open: { sidebar: boolean; inspector: boolean }, hasInspector: boolean): { sidebar: PaneState; inspector: PaneState };
export function useShellLayout(hasInspector: boolean): {
  mode: LayoutMode; sidebar: PaneState; inspector: PaneState;
  toggleSidebar(): void; toggleInspector(): void; showInspector(): void; closeOverlays(restoreFocus?: boolean): void;
};
```

| Mode | Sidebar | Inspector | ⌘\\ / Ctrl+Shift+\\ | ⌘I / Ctrl+Shift+B, tab commands |
|---|---|---|---|---|
| wide (≥1440) | full, resizable; rail if the user collapsed it | full, resizable; rail if the user collapsed it | toggles the stored `journal-sidebar-collapsed` (new key) | ⌘I toggles the stored `journal-panel-collapsed`; a tab command expands it |
| medium (1180–1439) | full or the user's rail | **rail + overlay** | toggles the stored sidebar preference | opens/closes the overlay; a tab command opens it on that tab |
| narrow (<1180) | **rail + overlay** | **rail + overlay** | opens/closes the sidebar overlay | same as medium |

- **The mode comes from `matchMedia('(min-width:1440px)')` and `('(min-width:1180px)')` listeners.** That avoids per-pixel React work during a window drag, and the CSS can use the same breakpoints.
- **Automatic rails never write `journal-panel-widths`, `journal-panel-collapsed` or `journal-sidebar-collapsed`.** Only explicit toggles in wide/medium mode do.
- **A mode change closes any open overlay.**
- **At most one overlay is open at a time:** opening the sidebar overlay closes the inspector overlay, and the reverse.

### C2. `ResizableWorkspace` composition

```tsx
<ResizableWorkspace layout={shell} wide={previewing && tab === 'files'}
  sidebar={pane => <Sidebar pane={pane} … />}
  inspector={state ? pane => <Inspector pane={pane} …>{panel}</Inspector> : null}>
  {main}
</ResizableWorkspace>
```

**Grid columns:**
- wide: `sidebar | main | inspector`, with today's width logic and resizers unchanged;
- medium: `sidebar | main | 44px`;
- narrow: `56px | main | 44px`;
- a sidebar rail in wide or medium mode: `56px | main | …`.

**Resizers:** the sidebar separator exists only while the sidebar is `full`, and the inspector separator only while the inspector is `full` (wide). They are unchanged otherwise: pointer capture, `requestAnimationFrame` coalescing, keyboard steps and double-click reset.

**Overlay** (`div.shell-overlay.inspector-overlay` or `.sidebar-overlay`):
- **Position:**
  - `position:absolute; top:0; bottom:0;` inside `.app-shell`;
  - `right:44px` (inspector) or `left:56px` (sidebar);
  - `z-index:20`, background `--panel` / `--side`, border `--line2`;
  - `box-shadow:-16px 0 40px var(--shadow-overlay)` (mirrored for the sidebar).
- **Width:**
  - inspector: `clamp(320px, stored knowledge width, 420px)`, and up to `min(720px, 50vw)` while a file is previewed;
  - sidebar: `clamp(220px, stored sidebar width, 300px)`.
- **The grid columns never change when it opens or closes, so `TerminalPane`'s `ResizeObserver` never fires and the PTY is never resized.**
- **Not a modal:** `role="complementary"` with `aria-label="Inspector"` or `"Sidebar"`. There is no focus trap and no scrim.
- **Opening:**
  - remembers `document.activeElement`;
  - moves focus to the active tab, or to the sidebar's selected row or New session;
  - no animation, on keyboard or pointer opens alike.
- **Closing** returns focus to the remembered element if it is still connected, otherwise to the terminal (`journal:focus-terminal`).
- **Esc closes it only when focus is inside the overlay or its rail.** Esc in the terminal always reaches the CLI (Claude uses Esc). The handler sits on the overlay container and does not `stopPropagation` anywhere else.
- **Light dismiss:** a `pointerdown` outside the overlay and both rails closes it without restoring focus (the click decides focus). It ignores events inside `dialog[open]`, such as a note form opened from Memory.
- **Choosing** a session in the sidebar overlay, or `New session`, closes it.

`tokens.css` gains `--shadow-overlay` in both themes: dark `rgba(0,0,0,.35)`, light `rgba(23,36,59,.18)`. It is a shadow color, not a tint, so it is not listed in the tint test's `bases`.

### C3. Shortcut row and App wiring

- **The `toggle-sidebar` row** comes with its handler:
  - MAC `{ id: 'toggle-sidebar', meta: true, code: 'Backslash', label: '⌘\\', aria: 'Meta+\\' }`.
  - OTHER `{ id: 'toggle-sidebar', control: true, shift: true, code: 'Backslash', label: 'Ctrl+Shift+\\', aria: 'Control+Shift+\\' }`.
  - Plain `Ctrl+\` (SIGQUIT) is never routed.
  - **Tests:** `⌘\` and `Ctrl+Shift+\` give `toggle-sidebar`; `Ctrl+\` on win32/linux gives `null`; and the parity tests pass.
- **App command handler:**
  - `toggle-inspector` → `shell.toggleInspector()`;
  - `toggle-sidebar` → `shell.toggleSidebar()`;
  - `tab-*` → `setTab(...)` and `shell.showInspector()`;
  - B's `onShowSent` and A's `onOpenMemory` → `setTab` and `shell.showInspector()`;
  - A's rail `onExpand` → `toggleSidebar`, and `onShowRecent` → open the sidebar overlay scrolled to Recent.
- **Shortcut table:** both rows are already in master section 2.1. Add their labels to the rail tooltips and to `aria-keyshortcuts` on the Expand and Show inspector buttons.

### C4. Tests

**Unit (`tests/layout.test.mjs`):**
- `layoutMode boundaries`: 1439 → medium, 1440 → wide, 1179 → narrow, 1180 → medium, 900 → narrow.
- `paneStates table`: every mode × the two preferences × the two open flags.
  - In narrow mode the stored preferences don't matter.
  - The inspector is `none` without a project.
  - At most one overlay at a time.
- `automatic rails never write preferences`: stub `localStorage`, flip the modes, and check that nothing was written.

**Desktop `desktop-layout.spec.ts` (rewritten):**
- At 1600×900 both separators exist. Drag, keyboard steps, persistence across a reload, and double-click reset all keep today's assertions. Focus rings stay clear, and the type floor holds.
- At 1280×800:
  - no inspector separator;
  - the inspector rail has three tab buttons;
  - the sidebar separator still exists.
- At 1024×720: neither separator exists, and both rails are visible.
- Returning to 1600×900 restores the stored widths and the collapsed preferences, so automatic modes did not overwrite them.
- In wide mode, ⌘\ and ⌘I collapse to rails and **persist across a reload**.
- The `Hide inspector` / `Show inspector` buttons have clear focus rings.

**New `tests/desktop-small-window.spec.ts`** (fixture CLI with a `size` command that prints `SIZE <cols>x<rows>` and prints `RESIZED` on `process.stdout` `resize`):
- `1280×800: the terminal has at least 100 columns with the overlay closed`: type `size` and parse at least 100 columns.
- `opening and closing the overlay never refits the terminal`:
  - Note the `SIZE`, then open with ⌘I/Ctrl+Shift+B through `pressKey` and close with Esc (focus is in the overlay).
  - No new `RESIZED` appears.
  - The `.terminal-surface` width is unchanged.
  - `size` reports the same value.
- `Esc in the terminal reaches the CLI while the overlay is open`:
  - Open the overlay, then click into the terminal; light dismiss closes it.
  - Reopen it with ⌘I, which focuses the tab, then focus the terminal with ⌘E.
  - Press Esc: the fixture echoes `ESC` and the overlay stays open.
- `rail tab buttons open the overlay on that tab`: the badges match B's counts.
- `900×640: at least 10 terminal rows; the sidebar overlay toggles with ⌘\`:
  - Count `.xterm-rows > div` (at least 10) and check `size` (rows at least 10).
  - ⌘\ opens the sidebar overlay and focuses the selected row. Choosing a row closes it.

**`desktop.spec.ts:106–108`:** raise the floor from 3 to **10** and replace the comment. Phase 3's split view restores the rows (master Task 3.4 attributed this to the composer).

### Group C acceptance

- Boards B10 (1280: sidebar plus inspector rail; ⌘I overlay) and B11 (1024: two rails) match. Exactly 1440 is wide.
- The terminal never refits on overlay open or close, and Esc in the terminal is never captured. At 900×640 at least 10 rows show, and at 1280×800 at least 100 columns.
- Stored widths and collapse preferences survive automatic mode changes.
- No animation on rails or overlays; hover only for fine pointers; focus returns where it came from.
- All four checks pass.

---

## 5. Phase verification and status

After C merges, run the whole suite on `claude/ux-redesign`: `npm test`, `npm run check`, `npm run build` and `npm run test:desktop` (hidden windows). Record the results in `docs/IMPLEMENTATION-STATUS.md` under "UX redesign - Phase 3 (shell)", in the Phase 1 section's style. Report fixture results separately from native checks.

**Native checks to list** ("To verify" in `docs/NATIVE-VALIDATION.md`):
- The banner shows the real Claude `PermissionRequest` command, depending on the Phase 2 native check.
- Codex and Cursor idle redraws don't keep "output just now" lit.
- Windows: `Ctrl+,` and `Ctrl+Shift+\` reach the router; the File-menu Settings item works; at a default window size the layout is medium, as expected.

---

## 6. Decisions

1. **The main column has two views, New session and Session; no launch bar sits above a running terminal.** This is what restores at least 10 rows at 900×640, and Phase 4's composer fills the New session view.
2. **Project switching uses a native menu** (`showMenu`) instead of a project list. Right-click acts on the current project. Pin order shows as menu order plus a `· Pinned` label.
3. **Suggestion badges use the accent colour, not amber.** The mockup's badges are amber, but `tokens.css` reserves amber for "needs you", and a suggestion never blocks an agent. Revisit if the usability round disagrees.
4. **The footer button reads `Settings`** (mockup: "Settings and data"). The dialog's sections name the data.
5. **No custom title bar, breadcrumbs or search field** until Phase 8. The rails carry the sidebar and inspector toggles.
6. **Session rename keeps `RenameDialog`, with no inline header editing.** Keys typed next to a focused terminal must never land in a title field by accident, and the dialog already supports reset-to-default.
7. **Settings and toggle-sidebar match the physical `Comma` and `Backslash` keys.** The menu shows `CmdOrCtrl+,` with `registerAccelerator: false`; the router dispatches it once.
8. **The Phase 2 notification checkboxes leave the menu.** Settings reads and writes `preferences.json` through two allow-listed actions with validated boolean keys.
9. **Esc closes an overlay only from inside it.** Light dismiss is by pointer. The overlay is non-modal.
10. **The explorer's own "Changed" filter becomes `Uncommitted`.** Only the Files-tab radio says "Changed".

## 7. Risks

| Risk | Mitigation |
|---|---|
| Phase 2 names drift from its plan | A0 checks every contract against the merged code first and edits this plan |
| Spec churn across three groups | A0's helpers; each group edits only its own helper bodies; merge A → B → C with a rebase and a full desktop run per merge |
| `App.tsx` conflicts | marked regions; components take props, not App internals; C, the last to merge, owns the wrapper |
| A Windows 1440-px window lands in medium mode, so specs miss the docked inspector or the separators | `ensureWide(app)` in every spec that needs them |
| `matchMedia` flips mid-drag close an overlay the user just opened | acceptable (rare); documented |
| xterm refits from a font load or a scrollbar change when the overlay appears | the overlay is out of flow and `.workspace` keeps `overflow:hidden`; the spec checks for `RESIZED` |
| Light dismiss swallows the first click into the terminal | the `pointerdown` still reaches the terminal (no `preventDefault`); covered by the Esc scenario |
| The four-session loop and other specs start slower through `newSession` | one extra click; the four-session spec stays under its timeout |
| The native switcher menu is invisible to Playwright | `__journalMenuHook` captures the items (`__lastMenu`); the menu order is asserted there |

## 8. Corrections to the master plan

1. **Task 3.4 says "the composer redesign must restore ≥10 rows".** Phase 3 restores them by splitting the main column (decision 1). Phase 4 keeps that.
2. **Task 3.1:** project switching is a native menu, and right-click acts on the current project only. The Projects navigation and the per-project `⋯` buttons are removed.
3. **Task 3.1 badges:** the mockup's amber suggestion badges conflict with the tokens rule "Amber means needs you". They are accent-coloured (decision 3).
4. **Task 3.2 "CLI version at launch":** the main process records `cliVersion` from its own provider detection. The renderer never supplies it.
5. **Task 3.2 "rename inline":** kept as a dialog (decision 6).
6. **Task 3.3:** the explorer's "Changed" filter is renamed `Uncommitted` so it never sits beside the Files tab's "Changed (n)".
7. **Task 3.4 "Esc closes it":** only while focus is inside the overlay. Esc in the terminal belongs to the CLI.
8. **Mockup details corrected for the type floor and the shortcut map:** rail badges are 11 px (not 10.5), and the rail tooltips' `⌃1–3` become `⌥⌘1–3` / `Alt+Shift+1–3`, as in master section 2.1.
9. **Settings shortcut placement:** the macOS app menu and the Windows/Linux File menu, routed by `shortcuts.mjs` (`code: 'Comma'`). Section 4.3 only says "a Settings… item".
10. **Phase 2 menu checkboxes** (Phase 2, C2) are removed in Phase 3 once Settings owns the notification preferences.
11. **Pins (Phase 2 correction 9) restated:** Active is ordered by slot; pins order Recent day groups and Archived.

## A0 findings (checked against the merged Phase 2 code, 4 October 2026)

The plan text above was corrected where it named a wrong API. What A0 found:

1. **Phase 2 contracts match.** `Session.slot`, `pending` (`PendingApproval`), `lastOutputAt`, the `activity` and `focus-session` events, `settle()` in the preload and `ERROR_CODES`/`errorCode()` (`types.ts`, mirrored from `terminal.mjs`) exist as named. `sessionState.ts` exports `stateFor(session, now, connected)`, `needsYou`, `resumable`, `slotOrder`, `slotTarget`, `nextNeedsYou(sessions, currentId)`, `outputDetail(lastOutputAt, now)`, `OUTPUT_FRESH_MS`, `Tone` and `SessionState { word, tone, detail, limited }`. State words live in `copy.state`.
2. **`tip.limitedStatus`**, not `copy.tip.limitedStatus`: `tip` is its own export.
3. **Preferences.** main.mjs keeps an in-memory `preferences` (read at startup, passed to the notifier as `preferences: () => preferences`) and a positional `setPreference(key, value)` that shows an error box and rebuilds the menu. `writePreferences` throws `Invalid preference`. The checkboxes (`notify-approval`, `notify-command`; labels "Notify When Claude Needs Approval", "Show Commands in Notifications") sit in the macOS app menu and in the **Window** menu on Windows/Linux (`menuTemplate` builds a custom `windowMenu` for them); Group A removes both. `preferences`/`setPreference` are not on the preload allow-list yet.
4. **CLI version source.** main.mjs's module-level `agents` (`detectAgents()`; Cursor updated by `refreshCursor`). The `start` handler forwards to the runtime process; `TerminalManager.start` adds the slot and calls `launch`, which destructures its parameters, so `cliVersion` must be added there.
5. **When rule-line suggestions appear.** `src/runtime/runtime.mjs` calls `store.generateProposals(sessionId)` 1.5 s after a session first reaches a non-live status, and sends `{ type: 'proposals', projectId, count }` only when something was created. Rule lines come from `receipt.query` (the task), need at least four words and must not be generic advice. Each proposal's `evidence.sessionId` names its session.
6. **App-level proposals.** `useProposals` takes `onError` and reuses `knowledgeVersion`; `KnowledgePanel` takes an optional `proposals` prop and then stops fetching. A desktop check in `desktop-brief.spec.ts` covers the event path and the refetch after Dismiss.
7. **Copy.** `shell.neverApproves` uses "approves", an old-term match in `tests/copy.test.mjs`; it is allow-listed there (tool approval in the CLI, not note review). `diffFiles` and `atLaunch` are fragments that start lowercase by design.
8. **Eyebrow test** is stricter than 1.4: an eyebrow may not contain any all-caps word (so single words such as `COMMANDS`, `PROJECT`, `FOLDERS` also failed); `aria-label`s and components' `title` props (the reference lists' region names) fail on a run of two all-caps words. Abbreviations such as `KB`, `ID`, `PID`, `CLI` and `HEAD` may stand alone. The sidebar's `.nav-caption` text and the brand's `PROJECT MEMORY`/`LOCAL` are not eyebrows and remain for Group A.
9. **Helpers (1.5).** `slotsUsed(page, n)` takes the count; `inspectorTab` selects and returns the tab; `setTheme` is a no-op when the theme is already set. `newSession`, `filesView` and `ensureWide` are no-ops and not yet called: Group B inserts `newSession` before starts (B7), Group C calls `ensureWide`. Selectors left in place for their owners: `desktop-context-menus.spec.ts` `.project-link` count after removal and `.pin-mark`; `desktop-projects.spec.ts` `.project-link[aria-current]`; `desktop-explorer.spec.ts` the Files tab `aria-selected` after the keyboard path; `desktop-layout.spec.ts` the Memory tab hover; `desktop-sessions.spec.ts` `.panel-tabs` selected tab; `desktop.spec.ts` `.terminal-heading .provider-mark`. `switchProject` also replaced the `/^<project>/` button clicks in `desktop.spec.ts`, `-brief`, `-status` and `-lifecycle`.
10. **Known test hazard (not A0's to fix).** `desktop-sessions.spec.ts` "next needs-you jumps to a Claude session waiting for approval…" can post a real OS notification, because only `desktop-notify.spec.ts` installs the notification hooks. A fix is in progress elsewhere; until it merges, run the desktop suite with `--grep-invert "next needs-you"`.

