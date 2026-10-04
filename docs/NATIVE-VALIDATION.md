# Local native provider validation

1 October 2026, manual run on the user's Mac, after merging [PR #1](https://github.com/adirz101/Journal/pull/1). This is a bounded authenticated trial of the terminal-only slice, not full-roadmap acceptance or a release. No CI, hosted runners or scheduled tests were used.

## Environment and boundaries

- Host Node 25.6.1; Electron 44.5.1 / Node 24.21.0; Electron-native node-pty 1.1.0.
- Installed Claude Code 2.1.284, authenticated with Claude.ai; Codex CLI 0.154.0, authenticated with ChatGPT. Authentication checks reported status only, without account identity or credentials.
- Actual Electron app, real native CLIs and model turns, isolated Journal data and a disposable Git project under ignored `.cache/native-validation/run-2/`. The fixture has no dependencies or private data. Native terminal output was observed locally; no native transcript storage or hidden reasoning was read for validation.
- Inherited Codex model `gpt-6.1-sol` was rejected by the CLI with HTTP 400 for this ChatGPT account. The user selected `gpt-5.6-luna` for the short trial. A temporary PATH wrapper in this app's process supplied `--model gpt-5.6-luna` on fresh launch and exact resume. Production launcher arguments and permanent model settings were not changed.
- Native workspace trust was accepted for the disposable fixture. Codex's newly detected hooks were left untrusted through its native prompt; existing hook configuration was not edited. Its configured local MCP server failed to connect. Claude's inherited integrations included an ancestor AGENTS.md loader. Tasks prohibited agent spawning and network tools, but provider startup integrations were still inherited.
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

- After approving a Bash permission in authenticated Claude Code, Journal shows Working, not Needs approval, while the command runs.
- Whether the `PermissionRequest` payload includes `tool_use_id` and `tool_input`. Journal matches an id-less request to the in-flight tool by name, command and file path, and otherwise falls back to the last tool of that kind completing. The pending-approval detail (redacted command or workspace-relative path) uses the request's own `tool_input` when present and the matched in-flight tool otherwise (marked inferred). The fixture tests (`tests/hook.test.mjs`, `tests/terminal.test.mjs`) cover only Journal's handling of these fields, not what native Claude Code sends.
- Which hook events follow a denial with feedback. Journal shows Working as soon as a single open prompt is answered in Journal's terminal with a digit or Enter, or when the asking tool completes.
- Esc and Ctrl+C at a single Claude permission prompt, and while Claude is working, return Claude to its input box with no hook. Journal shows Your turn; a following tool event shows Working. Journal also assumes an interrupted or rejected tool's PostToolUseFailure is not new work and keeps Your turn. While working, Journal counts Esc or Ctrl+C as an interrupt only when nothing was typed since the turn began; after typing it keeps Working. Check in particular: Esc that closes an open autocomplete menu (for example after typing `/` or `@` while Claude works) must not show Your turn, and with vim mode on (`/vim`), Esc that leaves insert mode must not either; Esc with nothing typed must still show Your turn in both modes.
- Known limitation: with two open Claude permission prompts, Esc or Ctrl+C natively rejects and ends the whole turn, but Journal settles prompts only as their tools report and never switches to Your turn here. It keeps showing Needs approval until a rejected tool reports, then Working, until a later hook (Stop, a new prompt or tool) corrects it. Check what native Claude Code shows and which hooks fire in this case.
- Claude fires PreToolUse before PermissionRequest for the same tool.
- Whether subagent hooks share the parent `session_id`. If they do, a sibling tool must not hide an open approval.
- Claude permission prompts are answered with a digit, Enter or Esc, which Journal uses to know the prompt was answered.
- Whether Claude can show a second permission prompt (for example from a parallel subagent) before the first is answered.
- Whether denying a Claude permission with Esc or Ctrl+C fires any hook (PostToolUseFailure or Stop).
- Packaged macOS and Windows builds show the approval notification (Windows needs the AppUserModelId), and clicking it focuses Journal on the session. The macOS Dock badge and the Windows taskbar flash follow Claude sessions waiting for approval and orphaned sessions, and clear when none remain. The fixture tests (`tests/notify.test.mjs`, `tests/desktop-notify.spec.ts`) replace the OS notification, badge and focus, so they do not prove the OS behaviour.
- The Windows portable EXE has no Start-menu shortcut carrying Journal's AppUserModelId (only the installer creates one). Check whether its approval toasts appear at all, under which name, and whether clicking one focuses Journal; if they do not, the portable build has no approval notifications and relies on the taskbar flash.
- Idle Codex and Cursor sessions: check whether their idle screens repaint on their own (a clock, spinner or cursor redraw) without any input or resize. Such output counts as agent output and keeps "output just now" lit while the agent is actually idle; note which versions do it and how often.
- The Claude attention banner shows the command or path from a real `PermissionRequest` (depends on the `tool_input` check above).
- Windows: Ctrl+, and Ctrl+Shift+\ reach Journal's shortcut router (Ctrl+\ still reaches the CLI), the File menu's Settings… item opens Settings, and at the default window size the layout is medium (sidebar docked, inspector rail).
- Composer modes with real CLIs: Build, Plan and Read-only start the same native modes as before the composer (Claude plan mode for Plan and Read-only, the Codex read-only sandbox, Cursor Plan and Ask). The launch argv is unchanged; the fixture argv tests pin it, not the CLIs' behaviour.
- The composer's agent cards: "Signed in" / "Sign in needed" / "Sign-in unknown" match `claude auth status --json`, `codex login status` and `cursor-agent status` for signed-in and signed-out accounts, and Install… / Install page… / Sign in… on each card run the same flows as Phase 7's provider rows.
- Windows: Ctrl+Enter starts from the task box, and Delete on a focused note in "What the agent will know" leaves it out.
- Windows: the task box's underlines line up with the typed text under ClearType at 100 %, 125 % and 150 % scaling, including after the box scrolls.
- "Sent to N sessions" (Phase 5, D6) with authenticated providers: a Claude conversation continued twice counts once; a Codex session whose native ID arrives only from its exit banner, then is continued, counts once after the ID is known; a Cursor session counts by its chat ID. A session interrupted by a runtime crash right after launch counts (uncertain) and its Session tab never reads "What was sent". The fixture tests (`tests/insights.test.mjs`, `tests/desktop-memory.spec.ts`) use fixture CLIs and stored IDs.
- Phase 7 first run: `claude auth status --json` and `codex login status` output when **signed out** (which stream, which exit code), and that Journal reads it as signed out. Signed in was verified on 5 October 2026 (see above).
- Phase 7 first run: Sign in from Journal finishes in the visible terminal for Claude Code, Codex and Cursor (including a browser hand-off), and the row updates once the terminal exits.
- Phase 7 first run: Install runs the official command and the installed CLI is found afterwards, on macOS and on Windows (PowerShell without a profile); a failed download is shown as failed.
- Phase 7 first run: dragging a folder in from Finder (macOS) and File Explorer (Windows) opens it as a project; a non-Git folder and a network share are refused plainly.
- Phase 7 first run: "Getting to know your project" on a detached HEAD (only the project card) and on a large monorepo (the top-level fallback, and how long drafting takes).
- Phase 7 first run: the first window appears before a slow CLI (for example one waiting on the network) finishes its version or help read.
- Phase 7 first run: a probe that times out ends the whole process tree (no `claude`, `codex` or `agent` child left running), on macOS and on Windows.
- Phase 6 wrap-up: a real Claude Code exit shows "Same conversation · ID confirmed by Claude" when Claude reported its session ID, and Continue resumes that exact conversation.
- Phase 6 wrap-up: a real Codex exit shows "From Codex’s exit message · confirm before continuing" when the ID came from the exit banner, and Continue stays disabled until the ID is confirmed.
- Phase 6 wrap-up: a real Claude test command (for example `npm test`) fills Tests run with its pass or fail count and command; Codex and Cursor show "Not visible for Codex" or "Not visible for Cursor".
- Phase 6 wrap-up: an authenticated session that exits with an error (for example a bad Codex `config.toml`) leads with the real last output, and Copy output copies it on macOS and Windows.
- Phase 6 wrap-up: ⌘↵ (macOS) and Ctrl+Enter (Windows) continue from the wrap-up, and ⇧⌘↵ / Ctrl+Shift+Enter remember all, with VoiceOver and Narrator announcing the shortcut on the buttons.
- Phase 8 crash recovery with a real provider: start an authenticated Claude Code session, kill the runtime (SIGKILL its PID from `runtime.json`), and check that the reconnected app's recovery (bootstrap and the runtime event) lists that session as interrupted, that nothing is resent, and that Continue resumes the same native conversation by its exact ID. Repeat with a Codex session whose ID is not yet confirmed: it is listed as interrupted with `identityVerified: null` and needs the conversation ID before continuing. A real agent that outlives the runtime (a provider that detaches) is listed as orphaned. The fixture tests (`tests/runtime.test.mjs`, `tests/desktop-search-recovery.spec.ts`) use fixture CLIs that die with their PTY.
- Phase 8 Reconnect now: with the runtime made unstartable (for example `runtime.mjs` unreadable in a packaged build's unpacked folder, then restored), the three-launch stop is reported, and Reconnect now launches it again at once after the fix, on macOS and on Windows (named pipe). `tests/runtime-client.test.mjs` covers the client with a fake connection only.
- Phase 8 Open terminal: from the "can't start" card, `claude auth login` and `codex login` run in Journal's visible terminal (Phase 7's constant `providerLogin`) and complete, including any browser hand-off, and Check again then clears the card. Journal never sees the credentials.
- Phase 8 open-file on large native checkouts: `git ls-files` time and the ranking time on a repository with well over 100,000 files, on macOS and on Windows (Git for Windows), and that the 200,000-file cap reports truncation instead of failing. The fixture measurement (`tests/files-search.test.mjs`, synthetic paths) was 3-13 ms for typical queries and about 37 ms for a query matching over half of 200,000 paths, ranked in 20,000-path slices.
- Phase 8 keys on Windows and Linux: Ctrl+Shift+P opens the command palette and Ctrl+Shift+O opens a file while the terminal has focus, and Ctrl+K and Ctrl+P still reach the CLI (kill-line and history). On macOS, ⌘K, ⇧⌘P and ⌘P reach Journal and never the terminal. The View menu shows ⌘K and ⌘P (Ctrl+Shift+P and Ctrl+Shift+O elsewhere) without registering them.
- Phase 8 Group B palette with VoiceOver (macOS): the combobox announces the active option's name and its group as the arrow keys move, a blocked action is announced as dimmed with its reason, and the no-results message is read before New session with this task. NVDA on Windows is checked in Phase 9. The desktop tests assert the ARIA attributes, not what a screen reader says.
- Phase 8 Group B palette keys inside the open palette on Windows and Linux: Ctrl+Shift+P closes it and Ctrl+Shift+O switches to files with the text kept (main stops routing keys while a dialog is open, so the palette matches them itself); Escape returns focus to the terminal. On macOS the same is covered by `tests/desktop-palette.spec.ts`.
- Phase 8 Group B first keystroke: typing immediately after ⌘K / Ctrl+Shift+P on a busy machine. The palette opens after one IPC round trip; check that no typed character reaches the terminal before the input has focus.
- Phase 8 Group B "can't start" card with real CLIs: a signed-out Claude Code or Codex (from Phase 7's status check) shows the card with `claude auth login` / `codex login`, Start stays enabled and the native CLI shows its own login; Copy command puts the exact command on the macOS and Windows clipboard. A removed Cursor CLI shows "Cursor isn’t installed" with Cursor's official install command. The fixture tests use fixture CLIs with an empty HOME and a fixture-only PATH.
- Phase 8 Group B crash recovery panel with a real provider: after a runtime crash with an authenticated Claude session live, the panel lists it with Continue; Continue resumes the same conversation by its exact ID and the row disappears; Done hides the panel and it stays hidden after a reload and an app restart.
- Phase 8 Group B Windows High Contrast (forced colors): the active palette option, matched characters, the runtime banner, the recovery panel and the "can't start" card stay distinguishable.
