# Journal UX redesign, Phase 7: First run

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Read `AGENTS.md` first. Group B reads `/Users/azechary/Downloads/skills-main/skills/emil-design-eng/SKILL.md` before any UI edit, and `animate/SKILL.md` plus `review-animations/SKILL.md` before writing or merging the first-note moment. All three were read for this plan. If the collection is missing, say so; don't claim you applied it.

**Goal:** Phase 7 of [the UX redesign](2026-10-04-ux-redesign.md) (tasks 7.1–7.4; F20–F22; D1, D10). A new user opens Journal, sees which agents are on the computer and can install or sign in to each one, opens a project, and leaves the first screen with two reviewed notes ("About this project", "Where this branch stands") that every session receives. The first session is sparse but explains itself, and the first remembered note gets one small moment.

**Design source:** `…/scratchpad/journal-mock/src/Welcome.body.html` (board 1), `GetToKnow.body.html` (2), `FirstSession.body.html` (3), `Personality.body.html` (12) and `States.body.html` panel 3 (the sign-in commands only; the `StartError` card is Phase 8). Mock details that change:
- Board 1 shows "Signed in" for Claude and Codex. Journal shows it only when the auth probe returned `signed-in`; otherwise the row says "Installed · <version>" and offers **Sign in…** (decision 4).
- Board 2 has no Constraints field. Phase 7 adds an optional one, labelled **Rules to keep** because `tests/copy.test.mjs` bans "constraints" in visible text. The saved line keeps the `Constraints:` label that `overviewDraft` writes.
- Board 2's "Done" row is the draft's `Completed (…)` block, shown verbatim (D1 needs the whole statement on screen).

**Checks after every commit:** `npm test`, `npm run check`, `npm run build`. Group A's desktop commits and every Group B commit also run `npm run test:desktop` (hidden windows, Electron-native node-pty; check the exit status). Everything here is fixture acceptance. Phase 7 changes no launch argv, native settings, permissions or exact-ID resume. Real auth-status shapes, real `claude auth login` / `codex login` and real installers are manual items (section 6).

**Out of scope:**
- known-location lookup for Claude and Codex installed off `PATH` (Cursor already has it); Phase 7 says so in the row instead;
- a mascot outside the six placements on board 12;
- model calls of any kind (drafts are Git-only, as today);
- `StartError`, the recovery panel and slots-full (Phase 8);
- the wrap-up explainer (Phase 6; it reuses `firstNote.ts` from B4 once both have merged).

---

## 0. Groups, order and file ownership

```
A0 contract commit (Group A implementer, on claude/ux-redesign)
 ├── Group A  core/desktop: detection, auth probes, providerLogin/providerInstall, ProcessRunner,
 │            rememberDraft, needsOrientation, first-open drafts, IPC                    (worktree p7a)
 └── Group B  renderer: Welcome, GettingToKnow, FirstNoteMoment, empty states, folder drop (worktree p7b)
merge A → B (B rebases on A and reruns all four checks)
```

**Dependencies:**
- **Group A starts after Phase 6 Group A task A4 has merged** (`prepareMemory` / `writeMemory` / `approveMemory`). `rememberDraft` is built on them. If Phase 6 A4 hasn't merged when Phase 7 must start, A implements that split exactly as Phase 6 A4 specifies (same names, same tests) in its own first commit, and Phase 6 rebases onto it.
- **Group B starts after** all of Phase 3 (being finished on `claude/ux-redesign-p3cloud`: `NewSessionView`, `Sidebar`, `SessionTab`, `SettingsDialog`, `copy.ts` `shell`), Phase 4 Group B (`Composer`, `ContextPreview`, `composerModel.agentCard`) and Phase 5 Group B (`MemoryTab`, which hosts `KnowledgePanel`).
- **Phase 8 Group B depends on Group A here** (`providerLogin`, `AgentInfo.auth`, `AgentInfo.commands`). Section 7 lists what Phase 8 must adjust.

| File | Owner | Others may touch |
|---|---|---|
| `src/core/process.mjs` (`runFile`, moved from `cursor.mjs`'s private `run`), `src/core/cursor.mjs` (imports it) | A | — |
| `src/core/agents.mjs` (`initialAgents`, `detectProvider`, `probeAuth`, `parseClaudeAuth`, `parseCodexAuth`, `PROVIDER_COMMANDS`) | A | — |
| `src/core/status.mjs` (`fillDraft`, `basis.facts`) | A | — |
| `src/core/store.mjs` (`needsOrientation`, `firstRunDrafts`, `rememberDraft`, `skipOrientation`, `hasActiveNotes`), `src/core/store-methods.mjs` | A | Phase 6 owns the A4 split |
| `src/desktop/processes.mjs` (key `provider:kind`) | A | — |
| `src/desktop/main.mjs` (detection, `providerStatus`, `providerLogin`, `providerInstall`, `openProjectPath`, `firstRunDrafts`, `rememberDraft`, `skipOrientation`, bootstrap `hasNotes`, quit dialog), `src/desktop/preload.cjs` (allow-list, `pathForFile`) | A0 stubs, then A | — |
| `src/ui/types.ts` (`AgentInfo`, `FirstRunDrafts`, `ProcessKind`), `src/ui/copy.ts` (`firstRun`, `providers`, `voice` objects) | A0 | B may fix wording |
| `tests/agents.test.mjs`, `tests/cursor.test.mjs`, `tests/status.test.mjs`, `tests/first-run.test.mjs` (new), `tests/process-runner.test.mjs` (new) | A | — |
| `src/ui/Welcome.tsx`, `GettingToKnow.tsx`, `FirstNoteMoment.tsx`, `AgentRow.tsx`, `firstRunModel.ts`, `firstNote.ts` (new) | B | — |
| `src/ui/ProviderStatus.tsx` (becomes a thin wrapper over `AgentRow`), `ProcessDialog.tsx` (title per provider) | B | — |
| `src/ui/App.tsx` (welcome region, orientation trigger, process view, drop target, first-note signal), `Composer.tsx` / `composerModel.ts` (install and sign-in for every provider), `ContextPreview.tsx` (mascot in the empty Relevant box), `SessionTab.tsx` and `Sidebar.tsx` (sparse copy), `KnowledgePanel.tsx` (two deferred strings) | B | owners from Phases 3–5; B adds one region or prop each |
| `src/ui/tokens.css` (`--ease-out` only), `src/ui/styles.css` (new section `/* === Phase 7: first run === */`) | B | — |
| `tests/desktop-first-run.spec.ts` (new), `tests/desktop-identity.spec.ts`, `tests/desktop-cursor.spec.ts`, `tests/copy.test.mjs`, `tests/first-run-model.test.mjs` (new), `tests/support/ui.ts` (`skipFirstRun` helper) | B | — |

---

## 1. A0: the contract commit (before forking)

### 1.1 Types (`src/ui/types.ts`)

```ts
export type AuthState = 'unchecked' | 'signed-in' | 'signed-out' | 'unknown';
export type ProcessKind = 'install' | 'login';
export interface AgentInfo { /* existing fields */ auth?: AuthState;
  supports?: { resume?: boolean; createChat?: boolean; mode?: boolean; login?: boolean; authStatus?: boolean };
  // Display strings from main's constant table; the renderer never builds argv.
  commands?: { login: string | null; install: string | null; installPage: string | null } }
export interface DraftFacts { readme: string | null; folders: number; commits: number; counted: boolean }
export interface FirstRunDrafts { projectId: string; head: string; overview: StatusDraft | null; branch: StatusDraft | null;
  branchSkipped: 'detached' | 'unborn' | 'no-commits' | null }
```
`StatusDraft.basis` gains `facts?: DraftFacts`. `Bootstrap` gains `hasNotes: boolean`. The `process-exit` event gains `provider: Provider`.

### 1.2 IPC (`main.mjs`, `preload.cjs`)

Replace `installCursor` and `cursorLogin` in the allow-list with `providerInstall` and `providerLogin`, and add one line: `for (const action of ['openProjectPath', 'firstRunDrafts', 'rememberDraft', 'skipOrientation']) allowed.add(action);`. Preload also exposes `pathForFile: file => webUtils.getPathForFile(file)` on `window.journal` (Electron removed `File.path`; `webUtils` is the supported way, and it returns `''` for files that didn't come from the OS).

A0 stubs, each replaced in Group A: `providerLogin`/`providerInstall` delegate to today's Cursor code for `cursor` and throw `Not available yet` otherwise; `openProjectPath` throws `Not available yet`; `firstRunDrafts` returns `null`; `rememberDraft` and `skipOrientation` throw `Not available yet`; bootstrap `hasNotes: false`.

### 1.3 Copy (`src/ui/copy.ts`)

Three objects; B fills the remaining wording. Voice rules (board 12) in a comment above them.
- `firstRun`: `welcomeTitle` "Your agents remember your project", `welcomeBody` "Journal runs Claude Code, Codex and Cursor in their own terminals, and gives every new session what you taught the last one.", `openProject` "Open a project…", `openHint` "Any Git folder. Or drop one on this window.", `agentsHeading` "Agents on this computer", `agentsHint` "You need at least one", `localOnly` "Everything stays on this computer. Your agents keep their own logins, settings and approvals.", `knowTitle` "I read your project. Here’s what I’d tell an agent.", `facts(f)` → "Drafted from Git: README, 8 top-level folders, 93 commits · no AI call · nothing left this computer" (README omitted when null; "top-level entries" when not counted), `aboutProject` "About this project", `branchStands` "Where this branch stands", `workingOn` "Working on now", `next` "Next", `rulesToKeep` "Rules to keep", `optional` "optional", `onlyYou` "Only you know these two lines. Git can’t tell an agent what you meant to do next.", `rememberBoth` "Remember both", `rememberOne` "Remember", `skip` "Skip for now", `editLater` "You can edit these any time in Project memory.", `howTitle` "How Journal remembers" plus its three steps, `noBranch.detached` "This checkout isn’t on a branch, so I drafted only the project overview.", `noBranch.unborn`, `firstNote` "First note remembered. Every new session in Journal will know it.", `draftBranch` "Draft “Where this branch stands”", `draftProject` "Draft “About this project”", `dropNotFolder` "Drop a folder from Finder or File Explorer.".
- `providers`: `checking`, `installedAs(version)`, `signedIn`, `signInNeeded`, `notInstalled`, `install` "Install…", `signIn` "Sign in…", `checkAgain`, `offPath(name)` "Installed, but Journal can’t find {name} on PATH. Restart Journal, or add its folder to PATH.", `loginTitle(name)` "Sign in to {name}", `installTitle(name)` "Install {name}", `installedHere(name)`.
- `voice`: none; the rules live in `tests/copy.test.mjs` (B5).

---

## 2. Group A: core and desktop

### A1. Async detection (`agents.mjs`, `process.mjs`, `cursor.mjs`)

- Move `cursor.mjs`'s private `run` to `process.mjs` as exported `runFile(path, args, env, { platform, cwd, timeout, stdin = 'ignore' })`: `execFile` through `launchTarget`, `windowsHide`, `maxBuffer` 256 KiB, `childEnv` (drops `ELECTRON_RUN_AS_NODE`, sets `NO_OPEN_BROWSER=1`). On timeout it kills the process tree (POSIX group via `detached: true` and `process.kill(-pid)`; Windows `taskkill /T /F`), as `createChat` does. `cursor.mjs` imports it; its behaviour is unchanged.
- `initialAgents()` returns all three rows with `state: 'checking'`, `available: false`, `auth: 'unchecked'`, `commands` filled. Main starts with it; nothing runs synchronously.
- `detectProvider(provider, env, { runner = runFile, probes = true })` for `claude` and `codex`: `resolveExecutable`, then `--version` (4 s). With `probes`, one `--help` read (4 s) sets `supports.login` and `supports.authStatus`:
  - Claude: both true only when the help lists an `auth` command (`/^\s+auth\b/m`).
  - Codex: `supports.login` when the top-level help lists `login`; `supports.authStatus` only when `codex login --help` (a second read) lists `status`.
  Returns `{ provider, state: 'ready' | 'missing', available, version, path, supports, auth: 'unchecked', commands, capabilities }`. `detectAgents` (sync) is deleted; `detectCursor` stays and gains `commands`.
- **`PROVIDER_COMMANDS`** (constant, frozen) holds per provider `{ login: argv | null, install: { display, file, args } per platform | null, installPage: url }`:
  - login argv: Claude `['auth', 'login']`, Codex `['login']`, Cursor `['login']`;
  - install: Cursor's existing `installCommand`. Claude's native installer and Codex's install command are entered **only after A1's first step checks them against the official installation pages on the day** (`code.claude.com/docs`, `developers.openai.com/codex`) and records the URL and date in `docs/PROVIDERS.md`. A command that can't be confirmed, or that needs a tool Journal can't find (`npm` for an npm-based install, via `resolveExecutable`), is `null` and the row offers **Open install page** (`shell.openExternal` of the constant URL) instead.
  - The display strings are what `AgentInfo.commands` carries to the renderer.

### A2. Auth probes (`agents.mjs`)

- `probeAuth(row, env, { runner })` → `'signed-in' | 'signed-out' | 'unknown'`. It runs **only** when `row.available && row.supports.authStatus`. An unrecognized subcommand could otherwise reach the CLI as a prompt (a model request) or start a login flow, so there is no "try and see" fallback.
  - Claude: `claude auth status --json`, 8 s, stdin ignored.
  - Codex: `codex login status`, 8 s, stdin ignored.
- **Parsing keeps only the conclusion.** stdout and stderr are parsed in memory and dropped. They never reach a log, an event, an error message, diagnostics or the renderer.
  - `parseClaudeAuth({ stdout, code })`: JSON with a boolean `loggedIn` → `signed-in` / `signed-out`; anything else → `unknown`.
  - `parseCodexAuth({ stdout, stderr, code })`: a line starting `Not logged in` → `signed-out`; a line starting `Logged in` with exit 0 → `signed-in`; anything else → `unknown`. **An exit code alone never decides.**
  - Timeouts, spawn errors and parse errors → `unknown`. Any thrown error is replaced by `unknown` before it leaves the function.
- Cursor keeps `cursorAuth` / `parseAuth` unchanged.

### A3. Main: detection, refresh and processes (`main.mjs`, `processes.mjs`)

- `let agents = initialAgents()`. After `app.whenReady` and window creation, `void refreshProviders()`: the three providers run in parallel, each with its own in-flight promise (today's `refreshCursor` pattern generalized to `refreshProvider(provider, { fresh })`). Every finished row sends `{ type: 'providers', agents }`.
- **Test gate:** auth probes run when `!headless || globalThis.__journalAuthProbes === true`. Existing desktop fixtures run any argument other than `--version` as an interactive session and append it to their launch ledgers, so ungated probes would add spurious launches to nine specs and hang until timeout. `--help` reads follow the same gate (without them `supports.login`/`authStatus` stay false in headless runs, and only Cursor shows sign-in, as today). This follows the `__journalCursorInstall` precedent; `desktop-first-run.spec.ts` sets the hook and clicks **Check again** to exercise the real path.
- `providerStatus({ provider, fresh })`: any provider (validated with `choice`), returns the refreshed row. Today's "Only Cursor needs a status check" error goes.
- `providerLogin({ provider })`: `choice(provider, PROVIDERS)`. The executable is the **current detected row's `path`** (Cursor: `findCursor`), never from input. Throws `Install <name> first` when missing and `<name> <version> can’t sign in from Journal. Run <name> in a terminal and sign in there.` when `supports.login` is false. Argv is `PROVIDER_COMMANDS[provider].login`, through `launchTarget`, `cwd: homedir()`, env without `ELECTRON_RUN_AS_NODE`. Returns `{ id, command }` (display string). No confirmation dialog, as with `cursorLogin` today: signing in is the CLI's own flow, in a visible terminal.
- `providerInstall({ provider })`: Cursor keeps its confirmation text. Claude and Codex get the same native `showMessageBox` (exact command, where it downloads from, "runs as you, without administrator rights, in a window where you can watch its output", "Journal will not receive or store your credentials"). It runs only on **Install**, with `installEnv`. `null` install → throws `Open the install page instead`. The test override `__journalCursorInstall` becomes `__journalInstall?.[provider]`.
- After a `login` or `install` process exits, main refreshes that provider (`fresh: true`) itself. The renderer's Check again stays as the manual path.
- **`ProcessRunner`** keys its single-run slot by `${provider}:${kind}`: Codex sign-in can run while Cursor installs, and a second click on the same row still throws `This is already running`. `start({ provider, kind }, spec)`; `process-exit` carries `provider`; `running()` returns `{ provider, kind }[]`. The quit dialog names the first one ("The Claude Code installation is still running." / "Codex sign-in is still running.").
- `openProjectPath({ path })`: a string of at most 4096 characters that is absolute (`isAbsolute`), exists and is a directory (`statSync`). Then `store.openProject(path)`, which already refuses non-Git folders. Errors are plain: `Drop a Git folder` / the store's message.
- `firstRunDrafts({ projectId })` → `store.firstRunDrafts(projectId)`, gated by `!headless || globalThis.__journalFirstRun === true` (the same fixture reason: many specs open a fresh repo and go straight to Start). `rememberDraft({ projectId, overview, branch })` → `store.rememberDraft(projectId, { overview, branch }, { via: 'first-run' })`; **`via` is fixed in main**. `skipOrientation({ projectId })` → `store.skipOrientation(projectId)`.
- Bootstrap gains `hasNotes: await store.hasActiveNotes()`.

### A4. Drafts with facts and filled fields (`status.mjs`)

- `readmePurpose` returns `{ name, line }`. `overviewDraft` adds `basis.facts = { readme: name | null, folders: now.dirs.size, commits: Number(rev-list --count HEAD) | 0, counted: now.counted }`. The BUG-2 fallback (`counted: false`) still gives a folder count, worded "top-level entries".
- `fillDraft(statement, { currentWork, next, constraints })` (pure). For each of `Current work:`, `Next:` and `Constraints:` whose value is a placeholder: a non-empty field (trimmed, at most 500 characters, single line, `refuseCredentials`) replaces the placeholder; an empty field **removes the whole line**. Lines the user didn't own (a value that isn't a placeholder) are never changed. Afterwards `PLACEHOLDER.test(result)` must be false, or it throws `Replace the bracketed placeholders before saving the update` (today's message).

### A5. Store: orientation and one-action Remember (`store.mjs`)

- **Orientation flag** in the project body: `orientation: { state: 'shown' | 'remembered' | 'skipped', at }`. `openProject` already spreads `prior`, so the flag survives reopening and remove-then-restore.
- `needsOrientation(projectId)` = no `orientation` flag **and** no `active` or `candidate` brief of either scope (the `proposeStatusUpdate` query without the scope filter). Projects from before Phase 7 with no brief are offered it once; any brief means never (decision 2).
- `firstRunDrafts(projectId)`:
  - returns `null` unless `needsOrientation`;
  - unborn HEAD (`!project.head`) → `null` **without** setting the flag, since there is nothing to draft yet;
  - otherwise `overview = proposeStatusUpdate(projectId, 'checkout')`;
  - `branch = proposeStatusUpdate(projectId, 'branch')` unless `!project.branch` (`branchSkipped: 'detached'`); a throw from either draft gives `null` for that card with `branchSkipped`/`notes` explaining it;
  - then sets `orientation.state = 'shown'` (D10: once per project, even if the user walks away) and returns `{ projectId, head: project.head, overview, branch, branchSkipped }`.
- `rememberDraft(projectId, { overview, branch }, { via })`:
  - `via` must be `'first-run'`;
  - each part is `null` or `{ statement, base, head }`, at least one non-null;
  - each `head` must equal the current `project.head`, else `The project changed since these drafts were made. Open Project memory to draft them again.`;
  - **prepare outside the transaction:** for each part, refuse if a brief of that scope (and, for `branch`, that branch) is now `active` or `candidate` (`A project summary was added meanwhile; review it in Project memory`); then `prepareMemory(projectId, { statement, category: 'brief', scope, source: { kind: 'git', base } })`. That keeps today's placeholder refusal, `refuseCredentials` and `captureEvidence`;
  - **then one transaction:** `writeMemory` for each, re-read, `approveMemory(memory, { via })` (audit `memory-active` with `via: 'first-run'`), set `orientation.state = 'remembered'`, audit `orientation-remembered` `{ projectId, notes: n }`. Any throw rolls everything back;
  - returns the active notes.
- `skipOrientation(projectId)`: sets `orientation.state = 'skipped'` and audits `orientation-skipped`. No notes are touched.
- `hasActiveNotes()`: `SELECT 1 FROM memories WHERE status='active' LIMIT 1` across projects.
- `STORE_METHODS` gains `needsOrientation`, `firstRunDrafts`, `rememberDraft`, `skipOrientation` and `hasActiveNotes`.

### A6. Tests (Group A)

`tests/agents.test.mjs` (fake `runner`, no real CLIs):
- `initialAgents marks every provider checking and runs nothing`;
- `detectProvider reads version and help asynchronously` (the runner receives `--version`, `--help`; nothing uses `execFileSync`; grep-assert `agents.mjs` has no `execFileSync`);
- `a Claude without an auth command gets no probe and no sign-in`;
- `a Codex whose login help lacks status gets no probe`;
- `parseClaudeAuth keeps only loggedIn`: `{"loggedIn":true,"email":"a@b.c","orgName":"X"}` → `signed-in`, and `JSON.stringify(row)` contains no `@` and no `X`; `{"loggedIn":"yes"}`, plain text, empty → `unknown`;
- `parseCodexAuth`: "Logged in using ChatGPT" exit 0 → `signed-in`; "Not logged in" exit 1 → `signed-out`; exit 1 with empty output → `unknown`; "Logged in…" with exit 1 → `unknown`;
- `probeAuth turns a timeout and a spawn error into unknown`; its error never carries stdout or stderr text;
- `PROVIDER_COMMANDS login argv is constant`: a deep-frozen table; `providerLogin` input with extra fields (`argv`, `command`, `path`) is ignored (asserted in the main-level test below).

`tests/process-runner.test.mjs` (fake spawn):
- `one run per provider and kind`: `claude:login` and `cursor:install` together succeed; a second `claude:login` throws;
- `process-exit carries provider and kind`;
- `running lists provider and kind`.

`tests/cursor.test.mjs`: the existing suite passes after the `runFile` move (no assertion changes).

`tests/status.test.mjs`:
- `fillDraft replaces placeholders and drops empty optional lines`;
- `fillDraft never edits a carried line`;
- `fillDraft refuses a remaining placeholder and a credential`;
- `overview facts count README, folders and commits, including the large-repo fallback` (inject the `structure` runner like the BUG-2 test).

`tests/first-run.test.mjs` (temporary repos, real store):
- `a fresh repo needs orientation once`: `firstRunDrafts` returns both drafts and sets `shown`; a second call returns `null`;
- `a project with any brief never needs orientation` (candidate counts too);
- `an unborn repo returns null and stays eligible`; after a commit it returns drafts;
- `a detached HEAD drafts the overview only` (`branchSkipped: 'detached'`);
- `rememberDraft remembers both in one step`: 2 `active` briefs (checkout and branch), `approved_at` set, audits `memory-active` × 2 with `via: 'first-run'` and one `orientation-remembered`;
- `rememberDraft is all-or-nothing`: a credential in the branch statement → no notes, no audits, flag still `shown`;
- `rememberDraft refuses a moved HEAD and a brief added meanwhile`;
- `rememberDraft refuses any via but first-run`;
- `skipOrientation stores nothing but the flag`.

`tests/desktop-first-run.spec.ts` gets two Group A scenarios (Group B adds the UI ones):
- `providers are detected after the window shows`: a fixture `claude` whose `--version` sleeps 1.5 s. The window and the Welcome heading appear first; the Claude row reads `Checking…`, then `Installed · …`;
- `providerLogin runs the constant command for each provider`: with `__journalAuthProbes` set and Check again, fixture CLIs (whose help lists `auth` / `login status`) log their argv. Calling `providerLogin({ provider: 'codex', argv: ['--evil'] })` through `window.journal.request` runs exactly `login`, and the Codex row then reads `Signed in`.

### Group A acceptance

- No synchronous child process runs in main at startup; detection and probes are asynchronous and bounded.
- Auth state is `signed-in` or `signed-out` only from a probe that parsed cleanly; everything else is `unknown`, and no account detail leaves the parser.
- `providerLogin` argv is constant per provider; the executable comes from detection.
- `rememberDraft` is atomic and audited `via: 'first-run'`; orientation is offered once per project.
- All four checks pass; `desktop-cursor.spec.ts` passes unchanged except button names B renames.

---

## 3. Group B: renderer

### B1. `firstRunModel.ts` (pure; `node --test` imports `.ts` directly)

- `agentRow(agent, platform)` → `{ name, sub, tone: 'ok' | 'warn' | 'muted', action: 'install' | 'install-page' | 'login' | null, quietLogin: boolean }`:
  - `checking` → `providers.checking`, muted;
  - missing → `notInstalled`, plus `install` when `commands.install`, else `install-page` when `commands.installPage`;
  - Cursor's `not-cursor`, `unsupported` and `unlaunchable` keep today's sentences from `CursorStatus`;
  - available: `installedAs(version)`; `auth === 'signed-in'` adds `· Signed in` (ok); `signed-out` or Cursor `login-required` → `signInNeeded`, warn, `login`; `unknown`/`unchecked` with `supports.login` → `login` with `quietLogin: true` (a text button, no warning).
  - **Phase 4's `composerModel.agentCard` is rewritten to call `agentRow`**, so the composer cards and the Welcome rows can't disagree.
- `draftLines(statement)` → `{ kind: 'text' | 'field', label, value, key? }[]`. It splits on newlines; `Current work:` / `Next:` / `Constraints:` lines holding a placeholder become fields (`workingOn`, `next`, `rulesToKeep`); every other line is text, shown verbatim.
- `previewStatement(statement, fields)` mirrors core `fillDraft`, so the card shows exactly what will be saved. A unit test compares the two on shared fixtures.
- `cardMeta(draft)`: badge "Draft", source "README.md · 577fb89" or "1 commit since main" from `basis`.

### B2. `Welcome.tsx` and `AgentRow.tsx` (board 1)

- `Welcome` replaces the `!state` branch in `App.tsx`. Layout:
  - mascot (`journal-mark` / `journal-mark-white` per theme, 64 px, `alt=""`);
  - `h1` `welcomeTitle` and the one-line body;
  - a primary **Open a project…** with the platform label from `bootstrap.shortcuts['open-project']` in a `<kbd>`, and `aria-keyshortcuts`;
  - `openHint`;
  - the "Agents on this computer" list of three `AgentRow`s (`<ul aria-label="Agents on this computer">`);
  - a lock icon and the `localOnly` line.
  - When projects exist but none is selected (after removing the current one), the same screen shows.
- `AgentRow`: `ProviderMark`, name, `sub`, and one action button named for the provider ("Install Claude Code…", "Sign in to Codex…", "Open Cursor install page") so the accessible names stay unique. Then a **Check again** text button. The off-PATH hint shows when `onPath === false` (Cursor) or after an install exit 0 that left the provider `missing` (`offPath`).
- `ProviderStatus.tsx`'s `CursorStatus` becomes a wrapper that renders `AgentRow` plus Cursor's two extra hints (off PATH, no modes). Its region label stays "Cursor provider status".
- App: `processView` gains `provider`; `install(provider)` / `login(provider)` call `providerInstall` / `providerLogin`; `ProcessDialog`'s title is `providers.installTitle(name)` / `loginTitle(name)`. On exit, App applies the `providers` event main sends; it doesn't refresh the provider itself.
- **Folder drop:** the window-level `dragover` (`preventDefault` only when `dataTransfer.types` includes `Files`) and `drop` handlers live in App, active only while `Welcome` or the sidebar project switcher is visible. On drop: `window.journal.pathForFile(files[0])`; an empty string → inline `dropNotFolder`; otherwise `openProjectPath({ path })`, then the same steps as `openProject()`. A dashed outline on the Welcome card while dragging is a class toggle with no motion. Main's `will-navigate` guard already stops file navigation.

### B3. `GettingToKnow.tsx` (board 2)

- **Trigger (D10):** after `refresh(projectId)` resolves for a project, App waits one `requestAnimationFrame`, then calls `firstRunDrafts` once per project per app run (a `Set` ref, so it doesn't loop). A non-null result puts the main column in `firstRun` mode in place of `NewSessionView`. The sidebar stays as Phase 3 built it; **New session ⌘N** leaves the screen, and the drafts are lost (decision 3).
- **Header:** `knowTitle` (h2) with a 40 px mascot, and `facts(basis.facts)`.
- **Two cards** (`<section aria-labelledby>`):
  - **About this project** — "All branches", Draft badge, `cardMeta`; the statement as `draftLines`; the optional **Rules to keep** field when the draft has a `Constraints:` placeholder;
  - **Where this branch stands** — "Only on <branch>"; the `Completed…` text block; **Working on now** and **Next** inputs in place of their lines, followed by `onlyYou`.
  - Each card has **Edit**, which opens `KnowledgeForm` with that draft (today's two-step review flow) and, on save, removes the card from this screen.
  - `branchSkipped` shows the plain one-line message instead of the second card. A draft's `basis.notes` show under its card, muted.
- **Fields:** single-line `<input>` with `<label>`, `maxLength` 500, and Enter moves to the next field. With the screen open, `⌘↵` / `Ctrl+Enter` (scoped to the screen's `<form>`, as Phase 4 scopes Start) submits.
- **Remember both ⌘↵** (or **Remember** with one card): one `rememberDraft` with `previewStatement` results and each draft's `base` and `head`.
  - Success → `knowledgeVersion` bump, the first-note signal (B4), and the main column returns to `NewSessionView`, where the composer's "Every session knows" lists both notes.
  - A refusal shows inline under the buttons (`role="alert"`) and changes nothing.
- **Skip for now:** `skipOrientation`, then `NewSessionView`. `editLater` below the buttons.
- **Side panel** "How Journal remembers": three numbered steps (static), hidden below 1180 px.
- **No animation** on the screen or its cards. It's a one-time screen, but its content is text the user reads and edits.
- **Deferred strings:** `KnowledgePanel`'s "Propose branch update" and "Propose overview" become `firstRun.draftBranch` / `draftProject`, and "Propose update" on a brief becomes "Draft an update". Remove the two `DEFERRED` entries for Phase 7 from `tests/copy.test.mjs`.

### B4. `firstNote.ts` and `FirstNoteMoment.tsx` (board 12)

- `firstNote.ts`:
  - `claimFirstNote(hasNotesAtStart: boolean): boolean` returns true once per install: it is true only if `localStorage['journal-first-note-seen'] !== '1'` and `!hasNotesAtStart`, and sets the key either way;
  - `settleFirstNote(hasNotes)` is called once at bootstrap; it sets the key silently when the install already has notes, so upgrading users never see it.
  - Every storage access is in try/catch. Without storage it never fires, because a repeated "first" moment would be false.
- Call sites: `GettingToKnow` success, the Memory tab's approve (`setMemoryStatus` → `active`), and Phase 6's `rememberProposals` success once that has merged (one line in `WrapUp.tsx`, or a follow-up noted in status if Phase 6 isn't merged).
- `FirstNoteMoment`: an inline strip at the top of the main column, not a toast. It shows the mascot (32 px), `firstNote` and a **Close** button. `role="status"`. It stays until closed or a session starts. It never takes focus and never blocks input.
- **Motion (animate skill, run in order):**
  - **gate:** rare, first-time; purpose **delight** (the one budgeted place on board 12);
  - **tool:** CSS keyframes, which are acceptable for a one-off, non-interruptible entrance;
  - **properties:** `transform` and `opacity` only;
  - **values:** the strip enters `opacity 0 → 1` with `transform: scale(0.96) → scale(1)`; the mascot adds `rotate(-8deg) → rotate(0)`, `transform-origin: 50% 80%`, delayed 40 ms;
  - **easing and duration:** 280 ms with `var(--ease-out)`;
  - **reduced motion:** `tokens.css`'s global `prefers-reduced-motion` rule removes animations, so the strip just appears.
  - `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)` is added to `tokens.css`, which has no easing token yet.
  - Later notes get the plain "Remembered" check, with no motion.

### B5. Sparse first-session states and voice (boards 3 and 12)

- **Sidebar**, with no sessions in the project:
  - Active shows "No sessions yet.";
  - Recent shows "Your first session will appear here." (replacing "Your sessions will appear here.").
- **ContextPreview:** the empty Relevant box (Phase 4's `relevantEmpty`) gains the 32 px mascot on the left, `alt=""`. The copy is unchanged.
- **Brief rows in "Every session knows":** remembered in this app run → a "Just remembered" chip, from a `Set` of IDs returned by `rememberDraft`.
- **SessionTab:** its empty "What it did" and "What it knows" states get first-person explanations ("I’ll list what this agent does here while it runs.") only when they explain. Status and errors stay neutral.
- **Empty terminal art** (`NewSessionView`): `A familiar place to work` / "Start an agent with ⌘N. Your logins, settings and approvals stay with the CLI." The shortcut label comes from `bootstrap.shortcuts`.
- **Voice test** (`tests/copy.test.mjs`, new cases):
  - `no exclamation marks or emoji in visible copy`: every `copy.ts` string and visible TSX string, checking `!` outside code and `\p{Extended_Pictographic}`;
  - `first person only where board 12 allows it`: strings matching `\b(?:I|I’ll|I’d|I’m|me|my)\b` must come from `copy.firstRun`, `composer.relevantEmpty`, the SessionTab explanations or Phase 6's explainer key. The allow-list names each key.

### B6. Styles (`styles.css`, emil-design-eng applied)

- A section `/* === Phase 7: first run === */`. Welcome is centred, with a maximum width of 560 px; the agent list uses the 11 px minimum for secondary text, and rows are at least 44 px high.
- Buttons have a focus ring from `tokens.css`. Hover backgrounds sit behind `@media (hover: hover) and (pointer: fine)`. There is no `transition: all`; the only keyframes are B4's.
- Light and dark mascots follow `appearance`. The drop outline uses `--focus`.
- Check Windows: `<kbd>` shows "Ctrl+O", the off-PATH hint names `%LOCALAPPDATA%` paths, and the PowerShell command wraps.

### B7. Tests (Group B)

`tests/first-run-model.test.mjs`:
- `agentRow never says signed in without a probe`;
- `agentRow offers install, install page or sign-in per state`;
- `agentRow and agentCard agree for every fixture row`;
- `draftLines finds the three fields and keeps other lines verbatim`;
- `previewStatement equals core fillDraft` (shared fixtures);
- `claimFirstNote fires once and never for an install with notes`.

`tests/desktop-first-run.spec.ts` (each sets `__journalFirstRun` and, where noted, `__journalAuthProbes` before opening):
- `welcome lists agents and opens a project`: heading `Your agents remember your project`, three rows; a missing Cursor offers `Install Cursor…`; **Open a project…** opens the stubbed dialog's repo;
- `dropping a folder opens it`: `page.evaluate` calls `openProjectPath` for the repo and a non-Git folder (plain error). A synthetic `DataTransfer` drop shows `dropNotFolder`, because a synthetic `File` has no OS path. The real drag is a manual check;
- `a fresh repo shows Getting to know your project`: both cards; facts line counts; typing Working on now and Next updates the text; **Remember both** → the composer's "Every session knows" lists both with "Just remembered"; the first-note strip appears once; Memory lists two notes;
- `remember both is audited first-run`: reads `listAudit` through `app.evaluate` → 2 × `memory-active` `via: 'first-run'`;
- `skip shows nothing again`: Skip, quit, relaunch with the same data, reopen → composer, no first-run screen;
- `a project with a brief never shows it`;
- `a detached HEAD shows the overview card only`;
- `the large-repo fallback still drafts` (a repo whose `ls-tree -r` exceeds the bounded output: reuse the BUG-2 fixture generator);
- `a signed-out Codex fixture says Sign in needed and signs in` (`__journalAuthProbes`): `login status` prints "Not logged in" exit 1 until `login` writes a marker; Sign in to Codex… → ProcessDialog shows `codex login`; on exit the row reads `Signed in`;
- `reduced motion shows the first-note text without animation`: `page.emulateMedia({ reducedMotion: 'reduce' })`; `getAnimations()` on the strip is empty. Tests never wait on the animation.

Updated specs:
- `desktop-identity.spec.ts:20`: heading `Your agents remember your project`;
- `desktop-cursor.spec.ts`: button names `Install Cursor…` / `Sign in to Cursor…` (from `PROVIDER_NAMES`) (region name unchanged);
- `tests/support/ui.ts`: a `skipFirstRun(page)` helper, a no-op unless the screen is present, for specs that later enable the hook.

### Group B acceptance

- A first launch with no projects shows board 1; every provider row is honest about install and sign-in and has exactly one next action.
- Opening a fresh repo shows board 2 once; Remember both creates two active briefs in one action; Skip is permanent for that project.
- First person appears only in onboarding, empty states and explanations; no exclamation marks or emoji anywhere.
- The first-note moment plays once per install, never for upgrading users, and not at all under reduced motion; keyboard actions never animate.
- All four checks pass.

---

## 4. Phase verification and status

- [ ] A and B merged into `claude/ux-redesign`; then `npm test && npm run check && npm run build && npm run test:desktop` (check the exit status).
- [ ] Run `review-animations` against the B diff; record the findings table in the PR description.
- [ ] Update `docs/IMPLEMENTATION-STATUS.md` ("UX redesign, Phase 7": F20–F22, D10 implemented, D1 extended to `via: 'first-run'`, the fixture-versus-native split), `docs/PROVIDERS.md` (auth probes, install commands with source URL and date, sign-in per provider) and `README.md` (first run).
- [ ] Section 6 native items are listed in `docs/NATIVE-VALIDATION.md` as **not yet run** until the user runs them.

## 5. Decisions

1. **Auth probes are opt-in by capability, never by trial.** A probe runs only when `--help` lists the subcommand, because an unknown subcommand may be read as a prompt (a hidden model request) or start a login flow.
2. **Orientation eligibility** = no brief of any state that counts (`active`, `candidate`) and no flag. Pre-Phase-7 projects without a brief see it once. An unborn repo isn't marked, so it's offered after the first commit.
3. **The flag is set when drafts are produced**, not when the user acts (D10 "once"). Leaving with ⌘N loses the drafts; Project memory's Draft buttons recreate them.
4. **Claude and Codex never show "Signed in" without a parsed probe**; `unknown` offers a quiet Sign in… instead of a warning.
5. **Empty fields remove their line** rather than block Remember: "Working on now" and "Next" are encouraged (`onlyYou`), not required. A placeholder never reaches storage.
6. **Visible "Rules to keep", stored `Constraints:`**: the label is UI vocabulary, and the stored label stays what `overviewDraft` and `carriedLine` read.
7. **Install for every provider**, but only with a command confirmed against official docs on the day; otherwise **Open install page**.
8. **Test gates `__journalAuthProbes` and `__journalFirstRun`** (headless only) keep nine existing fixture specs unchanged. `desktop-first-run.spec.ts` covers the real path.
9. **One `rememberDraft` for both cards** (the master plan's name kept): one action, one transaction, `via` fixed in main.
10. **Inline first-note strip, not a toast**: no timer, no focus steal, and it doesn't compete with Phase 8's banners.

## 6. Risks and native verification

| Risk | Mitigation |
|---|---|
| Auth output contains account details (email, org, masked key) | Parsed in memory to one of three words; never logged, sent, stored or put in errors; a unit test asserts no `@` survives |
| Probe output shapes differ from assumptions | Anything unrecognized is `unknown`; the native list records the real shapes in `PROVIDERS.md` |
| A probe on an old CLI runs a prompt or a login | Help-gated (decision 1); stdin ignored; 8 s timeout kills the tree; `NO_OPEN_BROWSER=1` |
| Probes slow startup or pile up | Async, parallel, one in flight per provider, after the window shows |
| Install commands drift or run remote scripts | Confirmed per release against the official page; shown verbatim; native confirmation; visible terminal; `installEnv`; no elevation |
| Claude/Codex installed off `PATH` aren't found | Plain `offPath` hint after install; known-location lookup is out of scope |
| Test gates hide the default path | `desktop-first-run.spec.ts` runs it with the hooks on; the gates are headless-only |
| Drafts go stale before Remember | `head` check in `rememberDraft`; prepare-then-write with Phase 6's expected-revision check |
| A dropped path opens something unintended | Absolute existing directory only, then the store's Git check; same trust as the open dialog |
| The global reduced-motion rule also removes the opacity fade | Accepted: board 12 says the message "just appears" |

**Native verification (manual, on the user's computer; never in CI):**
1. `claude --help` lists `auth`; `claude auth status --json` signed in and signed out. Record the key names (not values) in `PROVIDERS.md`.
2. `codex login --help` lists `status`; `codex login status` signed in (ChatGPT and API key) and signed out. Record the exit codes.
3. Sign in to Claude Code… and Sign in to Codex… from Welcome complete in the visible terminal; the row turns `Signed in` without Check again.
4. Install Claude Code… and Install Codex… (where confirmed) on macOS and Windows 11; the off-PATH hint is accurate.
5. Dragging a folder from Finder and File Explorer opens it; dragging a file shows the plain error.
6. Getting to know your project on a real repository (this one), with a detached HEAD and with a large monorepo.
7. The first-note moment, played at 0.2× in DevTools and with macOS/Windows reduced motion on; looked at again the next day.
8. VoiceOver and NVDA read the agent rows, the field labels and the status strip.

## 7. Corrections to the master plan and other phase plans

1. **Master 7.1 file list:** add `src/core/process.mjs` (`runFile`) and `store-methods.mjs`. `ProcessRunner` today allows one `install` and one `login` across all providers; the key becomes `provider:kind`.
2. **Master 7.1 probes:** they must be capability-gated (decision 1), and Codex's exit code alone must not decide.
3. **Master 7.2 "modify `App.tsx:278`":** the welcome is the `!state` branch of Phase 3's `App.tsx`. The heading assertion is at `desktop-identity.spec.ts:20`. Folder drop needs `webUtils.getPathForFile` in preload and a new `openProjectPath` action; `openProject` takes no path.
4. **Master 7.3 `rememberDraft = proposeMemory + setMemoryStatus`:** that isn't atomic for two notes; it uses Phase 6 A4's split and handles both cards in one call.
5. **Master 7.3 "inline Constraints field":** the visible label can't say "Constraints" (`copy.test.mjs`); see decision 6.
6. **Master 7.4:** the mock's "pop" maps to `scale(0.96)` (never from 0), and reduced motion is already global in `tokens.css`.
7. **Phase 4:** `composerModel.agentCard` is replaced by `firstRunModel.agentRow`, and `ComposerProps.cursor` becomes `providers: { onInstall(p), onLogin(p), onCheck(p) }`.
8. **Phase 8:** login and install display strings come from `AgentInfo.commands`, not a renderer table. Its signed-out fixture must **print "Not logged in"** (exit code alone is `unknown`), list `status` in `codex login --help`, and set `__journalAuthProbes`. Install commands for Claude/Codex exist only where Phase 7 confirmed them.
9. **Phase 6:** `WrapUp.tsx` calls `claimFirstNote` after a successful Remember (one line), whichever phase merges second.
