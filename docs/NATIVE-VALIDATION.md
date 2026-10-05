# Local native provider validation

1 October 2026, manual run on the user's Mac, after merging [PR #1](https://github.com/adirz101/Journal/pull/1). This is a bounded authenticated trial of the terminal-only slice, not full-roadmap acceptance or a release. No CI, hosted runners or scheduled tests were used.

## Environment and boundaries

- Host Node 25.6.1; Electron 44.5.1 / Node 24.21.0; Electron-native node-pty 1.1.0.
- Installed Claude Code 2.1.284, authenticated with Claude.ai; Codex CLI 0.154.0, authenticated with ChatGPT. Authentication checks reported status only, without account identity or credentials.
- Actual Electron app, real native CLIs and model turns, isolated Journal data and a disposable Git project under ignored `.cache/native-validation/run-2/`. The fixture has no dependencies or private data. Native terminal output was observed locally; no native transcript storage or hidden reasoning was read for validation.
- Inherited Codex model `gpt-6.1-sol` was rejected by the CLI with HTTP 400 for this ChatGPT account. The user selected `gpt-5.6-luna` for the short trial. A temporary PATH wrapper in this app's process supplied `--model gpt-5.6-luna` on fresh launch and exact resume. Production launcher arguments and permanent model settings were not changed.
- Native workspace trust was accepted for the disposable fixture. Codex's newly detected hooks were left untrusted through its native prompt (on 1 October 2026, before Journal registered Codex hooks); existing hook configuration was not edited. Its configured local MCP server failed to connect. Claude's inherited integrations included an ancestor AGENTS.md loader. Tasks prohibited agent spawning and network tools, but provider startup integrations were still inherited.
- Codex retained its native custom `workspace` permissions profile. Claude's review started in inherited auto mode; its native Shift+Tab control switched this trial to stricter manual mode for permission tests. Each allowed write used **Yes once**, without switching to automatic edit approval. No permission bypass flags or manual global configuration edits were used. Native trust decisions may persist in provider-managed settings.

## Observed outcomes

| Trial | Observed evidence | Result and limit |
| --- | --- | --- |
| Codex task with reviewed knowledge | Approved branch rule required prefix `JOURNAL_NATIVE_41C7:`. Codex edited `fixture.mjs`, created `result.txt`, corrected an initially malformed Node check and produced `CODEX_INITIAL_DONE` with `JOURNAL_NATIVE_41C7:hello`. Host file inspection corroborated the result. | Authenticated task completed. Receipts alone were not used as success evidence. |
| Codex exact resume | Graceful native exit printed UUID `01a0f661-908b-7193-8520-6ac6f3b44aeb`. After manually confirming it in Journal, Resume targeted that UUID. With no tools or file reads, Codex recalled `CODEX_INITIAL_DONE` and the result, then produced `CODEX_RESUME_DONE`. Journal supplied a refreshed packet and the new task. | Same native conversation retained; no latest-session selection or replay of the original task. |
| Codex interrupt | Journal's Interrupt button reached a turn at native “Working”; the CLI displayed “Conversation interrupted.” Journal Stop then ended the terminal. | Active inference interruption observed. The proposed timer command had not started, so running-tool cancellation and child-process cleanup are not proven. A separate earlier timer finished normally and is not counted as interruption. |
| Codex manual permissions | Explicit approval requests were refused by the existing native profile; `deny-me.txt` and `allow-me.txt` were absent. `/permissions` showed custom `workspace` as current. | No interactive allow/deny prompt appeared. Automatic refusal is not counted as operator denial or approval. Native manual approval remains a gap under this profile. |
| Codex → Claude knowledge handoff | Codex result committed in the fixture; a source-backed result lesson was explicitly approved in Journal. Claude received both reviewed claims, read fixture/source files, ran a Node check and returned `CLAUDE_HANDOFF_DONE` with `JOURNAL_NATIVE_41C7:hello`. | Authenticated cross-provider knowledge use observed. The lesson was manually reviewed; no automatic extraction. |
| Claude manual refusal | Visible native Write prompt for `claude-deny.txt`; selected **No**. Native tool reported rejection. Host inspection confirmed the file was absent. | Denial respected, no retry or alternative write observed. Native denial ended that turn; the allowed write used a separate follow-up. |
| Claude one-time approval | Visible native Write prompt for `claude-allow.txt`; selected **Yes**. Native tool reported creation, then returned `CLAUDE_PERMISSION_DONE`. Host inspection found exactly `CLAUDE_ALLOWED` (14 bytes, no newline). | Approval respected without broadening the session's edit permissions. |
| Claude exact resume | Journal Stop ended the original terminal. Resume used native UUID `813286ae-f24d-4f60-8ec8-03849197a664`. With no tools or reads, Claude recalled the review marker, checked result and both permission outcomes, then produced `CLAUDE_RESUME_DONE`. | Same conversation retained with two revalidated claims and a new task, without repeating the original review. |

Both native providers and the isolated application were stopped after the trial. Journal metadata records all five launch rows as exited. Claude Stop produced native exit code 129; this was an intentional terminal stop after completed responses, not a failed model turn.

## Reconciliation with Journal records

Fixture project ID: `8bc43826-2404-4c9f-adbf-52f025dd086a`, branch `main`.

- Initial fixture commit: `b05987a44a99a3694e6a3115181657743ce092c1`.
- Recorded Codex result commit: `ff9833d8947f61dd15f57ddc9d2e2fb6ff6bd42c`.
- Approved prefix rule: `12e0defc-06e0-4bb4-8b6b-8c281bb8e687`, revision 1, `POLICY.md:1` at the initial commit.
- Approved result lesson: `e9cebf34-4c33-4764-a7ca-4e5b21ce0edc`, revision 1, `result.txt:1` at the result commit.

| Launch | Journal session | Receipt | Claims |
| --- | --- | --- | --- |
| Unsupported initial Codex model | `abf7a002-2656-4585-b570-33e7f2da12ac` | `2dd311ba-a0f5-467f-bb7c-5e2d50a2b391` | 1 |
| Successful Codex task | `c01a0551-3b50-4446-a845-4a41a94487e8` | `b2189f6d-6c82-433a-9674-f1dd2f872b03` | 1 |
| Exact Codex resume | `96175814-23d4-4578-8c95-8379ceccd037` | `0b8245d4-20c0-4975-bdf6-5ab67728a11c` | 1 |
| Claude review and permission tests | `5bec64d9-aa97-4131-bd6d-7d5937fe06c5` | `d7694f1e-1ef1-47e0-8c9d-76bcc496eafa` | 2 |
| Exact Claude resume | `c1d6e76c-dbfe-4947-85cc-c3b36d42423d` | `ca55ba6a-9a09-415a-afb8-a9f8a38c9467` | 2 |

All five receipts are `submitted`: they record process launch with the captured prompt, not model acceptance. The unsupported-model launch demonstrates that distinction. Both resume receipts contain the current-knowledge replacement notice and no repetition of the previous task. They link to the original Journal rows and keep the same confirmed native UUIDs.

Final fixture SHA-256 fingerprints:

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `POLICY.md` | 93 | `ec08af3bee6cde84c51cd8a4b92c5a7230e31ee67cd0bd8c0ad128d5f4b670d0` |
| `fixture.mjs` | 87 | `183e19f95d48c8bb901bebf4e8429d59c18ecc50da0c354af61bdb92e227eaa4` |
| `result.txt` | 26 | `0d1e3dcd1b14549d69fa5566b1ee59c2bdaa7fa20d006821c13bcf3a93b135c2` |
| `claude-allow.txt` | 14 | `85f6784a44b0318d0b0bae4402aaeda366c94bf257940417dd04f0cfd4461fce` |

`fixture.mjs` contains ``export function label(value) { return `JOURNAL_NATIVE_41C7:${String(value).trim()}`; }`` followed by a newline. `result.txt` contains the checked result followed by one newline. Permission files were outside the source-backed claims; the allowed file remained untracked. The disposable checkout and raw native output are excluded from the product's Git history.

## Discovered defect and local regression

Codex 0.154.0 prints its resume instruction as:

```text
To continue this session, run:
  codex resume <UUID>
```

Journal previously recognized only the older inline banner. The live trial therefore required manually entering the visible UUID. `captureCodexId` now recognizes either explicit native banner, including CRLF and ANSI styling; the latest malformed banner is refused. This stays an **unconfirmed hint** and cannot authorize Resume.

Two parser regressions failed before the fix and passed afterward. A runtime regression feeds the multiline banner over three PTY chunks, checks stored unconfirmed identity, rejects premature resume and verifies exact argv after confirmation. This runtime test uses a controlled PTY callback, not a second paid native turn. The fixed automatic hint was not rerun in a fresh real-provider app; native resume itself was verified through manual confirmation.

A fresh read-only reviewer found no actionable issues in the source, regressions and evidence claims, and independently passed all 24 agent/runtime tests. The reviewer did not observe the native trials or rerun desktop acceptance. Parent verification passed all 40 core tests, typecheck, production build and the local Electron/native-PTY fixture scenario. The production build retains its existing roughly 545 KiB chunk warning.

Final required local checks are reported in [implementation status](IMPLEMENTATION-STATUS.md). Outstanding native coverage: Codex interactive approval under an approval-capable profile, interruption of an already running tool and child cleanup, Windows, and broader combinations of inherited plugins/settings. No installer, signing, public release or full-roadmap implementation is established by this trial.

## Sign-in status check (5 October 2026)

The user signed in to Claude Code and Codex and tested both through Journal. Journal's own
detection and status probe (`detectProvider` then `probeAuth` from `src/core/agents.mjs`) was then run
against the real CLIs on the user's Mac. Only the conclusion and the shape of the output were
printed; no account detail was read into a log.

| Provider | Version | Help documents a status check | Journal's conclusion | Output shape |
| --- | --- | --- | --- | --- |
| Claude Code | 2.1.286 | `auth` listed | signed in (270 ms) | `auth status --json` exits 0, JSON on stdout |
| Codex | codex-cli 0.159.3 | `login` and `login status` listed | signed in (118 ms) | `login status` exits 0, its line on **stderr**, nothing on stdout |
| Cursor | 2026.10.01-e373342 | detected and ready | (own sign-in check, not probed here) | — |

Codex reporting on stderr confirms the probe's `output: 'both'`. The signed-out outputs of
both CLIs are still unverified.

## To verify

A checklist for the user's own computers, after the UX redesign (Phases 0-9). Everything here was
built and tested with fixture CLIs only: the desktop tests prove what Journal sends, shows and
records, not how a real Claude Code, Codex or Cursor reacts, nor what the operating system or a
screen reader does. Tick an item when it was seen with a real, signed-in CLI (or real hardware).
Note the CLI version for anything provider-specific. Real launches keep their argv, native
settings, permissions and exact-ID resume; nothing here asks you to change them.

### Agents and sign-in

- [ ] **Status checks, signed out.** With each CLI signed out, `claude auth status --json`, `codex login status` and `cursor-agent status` are read as signed out (note which stream and exit code each uses). Signed in was verified on 5 October 2026 (above).
- [ ] **What the rows and cards say.** The Welcome rows and the composer's agent cards read "Signed in · <bare version>" (2.1.286, not "2.1.286 (Claude Code)") only after a clean check, "Sign in needed" or "Sign-in unknown" otherwise; an unknown state offers a quiet **Sign in…** with no warning; no window size cuts "Signed in" or "Sign in needed" short.
- [ ] **Sign in from Journal.** **Sign in…** on a row or card, and **Open terminal** on the "can't start" card, run `claude auth login`, `codex login` and Cursor's login in Journal's visible terminal, including any browser hand-off; the row or card updates once the terminal exits, and **Check again** clears the card. Journal never sees the credentials.
- [ ] **Install from Journal.** **Install…** runs the official command and the CLI is found afterwards (macOS, and Windows in PowerShell without a profile); a failed download is shown as failed. A removed Cursor CLI shows "Cursor isn’t installed" with Cursor's official install command.
- [ ] **The "can't start" card.** A signed-out Claude Code or Codex shows the card with its login command while Start stays enabled and the CLI shows its own login; **Copy command** puts the exact command on the clipboard.
- [ ] **The default agent with a slow check.** With real CLIs and a slow Claude Code sign-in check (for example on a slow network), the composer's default settles on Claude Code and its Start label never changes to another agent after typing begins; a card you chose, a hand-off and a remembered agent are never changed by a later check.
- [ ] **Detection stays out of the way.** The first window appears before a slow CLI (for example one waiting on the network) finishes its version or help read, and a probe that times out leaves no `claude`, `codex` or `agent` child running.
- [ ] **Opening a project by drag.** A folder dragged in from Finder opens as a project (on the Welcome screen, and on the sidebar with a project open); the dashed outline does not flicker while the pointer crosses the screen; two folders say "Drop one folder at a time."; a file says "Drop a folder from Finder or File Explorer."; a non-Git folder is refused plainly; a drop on a running terminal does nothing.
- [ ] **Getting to know your project** on a detached HEAD (only the project card) and on a large monorepo (the top-level fallback; note how long drafting takes).

### Sessions and approvals

- [ ] **Modes.** Build, Plan and Read-only start the same native modes as before the composer (Claude plan mode for Plan and Read-only, the Codex read-only sandbox, Cursor Plan and Ask).
- [ ] **Working after an approval.** After approving a Bash permission in Claude Code, Journal shows Working, not Needs approval, while the command runs.
- [ ] **The approval banner** shows the command or path from a real `PermissionRequest`. Check whether that payload carries `tool_use_id` and `tool_input`: without them Journal matches the in-flight tool by name, command and path, and marks the detail inferred.
- [ ] **Hook order.** Claude fires PreToolUse before PermissionRequest for the same tool; whether subagent hooks share the parent `session_id` (if they do, a sibling tool must not hide an open approval); whether a second permission prompt (for example from a parallel subagent) can appear before the first is answered.
- [ ] **Answering a prompt.** A digit, Enter or Esc answers a Claude permission prompt; note which hook events follow a denial with feedback, and whether Esc or Ctrl+C on a prompt fires any hook (PostToolUseFailure or Stop).
- [ ] **Esc and Ctrl+C** at a single prompt, and while Claude works, return Claude to its input box: Journal shows Your turn, and a following tool event shows Working. Esc that closes an open autocomplete menu (after `/` or `@`) or leaves vim insert mode (`/vim`) must not show Your turn; Esc with nothing typed must.
- [ ] **Known limitation, two open prompts:** Esc or Ctrl+C rejects the whole turn natively, but Journal keeps Needs approval until a rejected tool reports. Note what Claude shows and which hooks fire.
- [ ] **Codex and Cursor idle screens.** Whether they repaint on their own (a clock, spinner or cursor) with no input; such output keeps "output just now" lit. Note versions and how often.
- [ ] **Sent to N sessions** (Memory): a Claude conversation continued twice counts once; a Codex session whose ID arrives only from its exit banner, then is continued, counts once; a Cursor session counts by its chat ID; a session interrupted by a runtime crash right after launch counts (uncertain) and never reads "What was sent".

### Wrap-up and memory

- [ ] **Conversation ID.** A real Claude Code exit shows "Same conversation · ID confirmed by Claude" and Continue resumes that exact conversation; a real Codex exit shows "From Codex’s exit message · confirm before continuing" and Continue stays disabled until the ID is confirmed.
- [ ] **Tests run.** A real Claude test command (for example `npm test`) fills Tests run with its count and command; Codex and Cursor show "Not visible for Codex" or "Not visible for Cursor".
- [ ] **Error exit.** An authenticated session that exits with an error (for example a bad Codex `config.toml`) leads with its real last output, and Copy output copies it on macOS and on Windows.
- [ ] **The first-note moment,** played at 0.2× in DevTools (from scale 0.96, the mascot tilting from -8°, nothing from scale 0) and looked at again the next day; with "Reduce motion" on it appears without motion. It never takes focus from the composer.

### Codex and Cursor hooks
Fixture-tested only (5 October 2026). The provider behaviour underneath was observed natively on
5 October 2026 with Codex 0.159.3 and Cursor 2026.10.01 in a throwaway repository (plan section 3);
these check Journal's integrated feature.
- [ ] **Codex review, once.** The first Codex session shows "Hooks need review" listing Journal's 9 hooks (Session flags); after trusting them, a new session and `codex resume` start without the review, and the session shows Working, then Your turn.
- [ ] **Codex approval.** A command that needs approval shows Needs approval with the command; answering in the terminal returns to Working; a Codex notification appears while Journal is in the background.
- [ ] **Codex interrupt and exit.** Esc during a turn leaves the turn interrupted (not Your turn); `/quit` ends the session with its ID recorded; Continue resumes the same conversation.
- [ ] **Codex untrusted.** Choosing "Continue without trusting" leaves the session on Limited status, and Journal never claims a state.
- [ ] **Codex questions and other approvals.** Whether `request_user_input` or plan-mode questions, network approvals and MCP approvals fire any hook (Journal maps none of them).
- [ ] **Codex after an app update.** Whether Codex asks to review the hooks again after Journal is updated (the launcher path stays the same).
- [ ] **Codex sub-agents.** A sub-agent's events never change the parent's state or ID.
- [ ] **Cursor level 1.** A Cursor session shows its activity (last seen: command finished) and never Your turn; nothing is written to `~/.cursor`.
- [ ] **Cursor turn status.** Settings shows the exact change; after confirming, a new Cursor session shows Your turn when a turn ends and one interruption for Esc; Remove leaves the other entries unchanged.
- [ ] **Cursor in-session changes.** `/new` or `/resume` inside the Cursor TUI marks the identity as changed instead of rebinding silently.
- [ ] **Cursor with a user stop hook that returns a follow-up.** The follow-up turn is shown as a new turn.
- [ ] **Shell start-up.** A slow shell profile (Cursor runs hooks through `$SHELL -ilc`) never delays or blocks the agent beyond Cursor's 5 s timeout.
- [ ] **Windows, both providers.** Hooks run (launcher `.cmd`), with a data folder path without spaces; a path with spaces leaves sessions on Limited status.

### Palette and states

- [ ] **Crash recovery with real agents.** With an authenticated Claude session live, kill the runtime (SIGKILL the PID in `runtime.json`): the panel lists it as interrupted, nothing is resent, Continue resumes the same conversation by its exact ID and the row goes; Done hides the panel, also after a reload and an app restart. An unconfirmed Codex session needs its conversation ID first. An agent that outlives the runtime is listed as still running outside Journal.
- [ ] **Reconnect now.** With the runtime made unstartable (for example `runtime.mjs` unreadable in a packaged build's unpacked folder, then restored), the three-launch stop is reported and Reconnect now launches it again at once.
- [ ] **Window crash** (new in part 2). In a packaged build with two live sessions, crash the window's renderer (for example `kill -SEGV` on the Journal Helper (Renderer) process): the window shows "Something went wrong" with Reload focused, in the chosen appearance; Reload reopens the project, both terminals reattach with their output, and typing reaches the same agents. Nothing is resent.
- [ ] **Open-file on a large checkout:** `git ls-files` and ranking time on a repository with well over 100,000 files, and the 200,000-file cap reports truncation instead of failing (fixture: 3-13 ms for typical queries on 200,000 synthetic paths).
- [ ] **First keystroke.** Typing immediately after ⌘K on a busy machine: no character reaches the terminal before the palette's input has focus.

### Terminal colours

- [ ] **Claude Code with its theme set to Auto (match terminal):** in the light appearance a fresh and a continued session draw Claude's light theme (the prompt echo block and "Jump to bottom" light, not dark grey); in dark both draw dark. Switch the appearance while each runs, including one not on screen: Claude follows within a moment. With the theme unset (Claude's default) Claude stays dark in light mode, as Settings says.
- [ ] **Codex and Cursor in the light appearance** are readable and use light-background colours, fresh and continued.
- [ ] **A session started while no window shows it** (started, then the window reloaded before its first output): Claude's startup probes are reported unsupported; check it still draws correctly and does not flicker more than one started on screen.
- [ ] **Theme reports.** Claude Code 2.1.286 turns mode 2031 on without asking (no DECRQM first). With a newer version, check whether it starts asking: Journal answers no DECRQM in the runtime and xterm.js reports 2031 as unknown, which could stop Claude listening for theme reports.

### Windows 11

- [ ] **The [Windows checklist](WINDOWS.md)** on real hardware: ConPTY keys, Alt menu-bar focus, Job Objects and the rest.
- [ ] **App keys.** Ctrl+Shift+N, Alt+1-4, Ctrl+Shift+J, Ctrl+Shift+E, Alt+Shift+1-3, Ctrl+Shift+B, Ctrl+Shift+K, Ctrl+, and Ctrl+Shift+\ reach Journal while the terminal has focus; Ctrl+\, Ctrl+K, Ctrl+P, Ctrl+C and Ctrl+R still reach the CLI; Ctrl+O opens a project outside the terminal.
- [ ] **Palette keys** (Windows and Linux). Ctrl+Shift+P opens the palette and Ctrl+Shift+O open-file from the terminal; inside the open palette Ctrl+Shift+P closes it and Ctrl+Shift+O switches to files with the text kept; Escape returns focus to the terminal. The View menu shows them without registering them.
- [ ] **Composer and first run.** Ctrl+Enter starts from the task box and remembers on Getting to know your project; Enter in a field moves to the next field; Delete on a focused note leaves it out; Open a project… shows Ctrl+O; the wrap-up's Ctrl+Enter and Ctrl+Shift+Enter work.
- [ ] **Settings and layout.** The File menu's Settings… opens Settings; at the default window size the layout is medium (sidebar docked, inspector rail).
- [ ] **Text and scaling.** The task box's underlines line up with the text under ClearType at 100 %, 125 % and 150 %, also after it scrolls.
- [ ] **Agents.** Codex offers "Open Codex install page" (no confirmed command) and it opens in the default browser; install and sign-in finish in PowerShell; a probe timeout ends the whole process tree; a folder dragged from File Explorer opens and a network share is refused.
- [ ] **High Contrast (forced colours):** focus rings, the selected agent card and mode, the active palette option and matched characters, the runtime banner, the recovery panel, the "can't start" card and the window-crash page stay distinguishable.
- [ ] **"Show animations" off:** the first-note moment appears without motion.

### VoiceOver and NVDA

The desktop tests check names, roles and live regions in the DOM, never what is spoken.

- [ ] **Rows and tabs.** Session rows are read with their state ("Needs approval, … needs attention"); the inspector tabs and agent rows (name, state, the one action, Check again with the provider's name) and the Working on now, Next and Rules to keep labels are read.
- [ ] **Status regions are spoken once, without moving focus:** the first-note message, an agent row's note after an install or sign-in ("Signed in to Codex."), the note under the composer's cards, Claude's approval banner when it appears, the runtime banner ("Lost connection to the session runtime…"), the recovery announcement ("The session runtime stopped unexpectedly. N sessions were interrupted…") and the wrap-up's "Session ended. n suggestions."
- [ ] **Focus moves are read.** Getting to know your project reads its heading on entry; after Remember or Skip focus is in the task box; Reconnecting… and Checking… keep focus and are read as unavailable; when the banner, a recovery row or the "can't start" card goes, the newly focused control (the terminal, the next row's button, or Start) is read.
- [ ] **The command palette** (VoiceOver and NVDA): the combobox reads the active option's name and group as the arrows move, a blocked action is read as unavailable with its reason, the no-results message is read before New session with this task, and the result count is read once the query settles. The same for open-file, including "No file name matches…".
- [ ] **The wrap-up's shortcuts** are announced on Continue and Remember all (VoiceOver and Narrator).
- [ ] **The window-crash page** reads its heading, sentence and the focused Reload button.

### Packaging

- [ ] **Approval notifications** in packaged macOS and Windows builds (Windows needs the AppUserModelId); clicking one focuses Journal on the session. The Dock badge and the taskbar flash follow sessions waiting for approval and orphaned sessions, and clear when none remain. The tests replace the OS notification, badge and focus.
- [ ] **The Windows portable EXE** has no Start-menu shortcut with Journal's AppUserModelId: check whether its approval toasts appear at all, under which name, and whether clicking one focuses Journal; otherwise it relies on the taskbar flash.
- [ ] **The macOS sandbox warning** (`sandbox_extension_issue_file failed …`) in a packaged build: whether it appears there at all (only development builds were checked; it is harmless).
- [ ] **An update end to end** needs two published releases: download in the background, Restart to update on request, and the running-session choice before install.
- [ ] **`npm run dist:dir`, `npm run release:audit` and `npm run smoke:packaged`** on macOS with Xcode 26 selected (`DEVELOPER_DIR`), and the release workflow's Windows package and smoke test.
