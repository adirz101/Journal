# Codex and Cursor lifecycle hooks

Status: **revised plan, approved for phased implementation** (5 October 2026). Decisions:

- **Codex:** Journal adds its hooks per launch on every supported launch (no setting). The first
  launch shows Codex's own hook review; Codex then runs embedded.
- **Cursor:** a per-launch plugin by default, plus an opt-in, reviewed change to the user's
  `~/.cursor/hooks.json` (level 2, section 4.6).
- Native trials were run on 5 October 2026 (section 3). Automated tests stay fixture-only.

Evidence labels: **[Doc]** official documentation, **[Src]** inspected provider source or
installed bundle, **[Native]** observed in the 5 October trials on macOS with the named version.
A result is claimed only for the version where it was observed or read.

## 1. Sources

Codex (OpenAI). The docs moved from developers.openai.com/codex to learn.chatgpt.com/docs:
- Hooks: https://learn.chatgpt.com/docs/hooks
- Configuration reference: https://learn.chatgpt.com/docs/config-file/config-reference
- Advanced configuration (notify, precedence): https://learn.chatgpt.com/docs/config-file/config-advanced
- Configuration basics (layers): https://learn.chatgpt.com/docs/config-file/config-basic
- Source at tag `rust-v0.159.3` (commit `01fc69f4`), https://github.com/openai/codex/tree/rust-v0.159.3:
  `codex-rs/hooks/src/events/*.rs` (exit-code handling), `codex-rs/hooks/src/engine/discovery.rs`
  (layers, trust keys, timeout clamping), `codex-rs/hooks/src/engine/command_runner.rs`
  (timeouts), `codex-rs/core/src/session/turn.rs` (SessionStart timing),
  `codex-rs/tui/src/startup_hooks_review.rs` (review screen).

Cursor (Anysphere):
- Hooks: https://cursor.com/docs/hooks
- CLI parameters: https://cursor.com/docs/cli/reference/parameters
- CLI configuration: https://cursor.com/docs/cli/reference/configuration
- Plugins: https://cursor.com/docs/plugins and https://cursor.com/docs/reference/plugins
- CLI changelog: https://cursor.com/docs/cli/changelog
- Staff posts: https://forum.cursor.com/t/cursor-cli-askquestion-tool-skips-pretooluse-and-posttooluse-hooks/161836
  (AskQuestion fires no tool hooks), https://forum.cursor.com/t/cursor-cli-doesnt-send-all-events-defined-in-hooks/148316
- Installed bundle `~/.local/share/cursor-agent/versions/2026.10.01-e373342/` (event gating,
  payload fields).

## 2. Today in Journal (main)

- `src/runtime/observers.mjs` writes `<data>/observers/<id>.settings.json` (0600) for Claude,
  passed with `--settings`. The hook command runs `src/desktop/hook.mjs` with the target file
  and a 48-hex token in its arguments; the script appends filtered JSON lines and the runtime
  polls every 300 ms.
- Acceptance: Journal session ID (`JOURNAL_SESSION_ID`), token and a cwd inside the session
  root. A different native UUID sets `IDENTITY_CHANGED`.
- `TerminalManager.ingest` maps events to `status`/`activity`; `stateFor` shows Working, Your
  turn or Needs approval for Claude only; Codex and Cursor show "Running · output…" and
  "Limited status". About a dozen places branch on `provider === 'claude'`.
- Gaps: no turn identity (an old Stop can finish a newer turn), no observation-loss state (a
  session whose hooks never fire shows Working forever), sub-agent events not distinguished,
  final events can be lost when the observer is released 500 ms after exit.

## 3. Verified provider behaviour

### 3.1 Codex

| Topic | Finding |
|---|---|
| Hooks | SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, SubagentStart, SubagentStop, Stop, Interrupt [Doc][Src 0.159.3]. Minimum versions [Src, by tag]: trust and review 0.131; Subagent* 0.133; SessionEnd 0.145; Interrupt 0.150. |
| Per-launch config | `-c hooks.<Event>=[…]` adds hooks in the session-flags layer; hooks from every layer run [Doc][Src]. `notify` is a single value and is never overridden by Journal. |
| Embedded mode | Any `-c` override runs the TUI without the shared background server; the notice is one of the startup warnings (F2) [Src][Native 0.159.3]. |
| Trust | Every non-managed hook needs trust for its exact definition, stored as `hooks.state."<source>:<event>:<group>:<handler>".trusted_hash` in the user's config [Src]. Per-launch hooks appear as "Session flags" in Codex's review; once trusted, relaunch and `codex resume` need no review [Native 0.159.3]. Journal never passes `--dangerously-bypass-hook-trust`, never sets `hooks.state` and never writes trust. |
| Hook output | Exit 0 with empty stdout: no effect, for every event. Exit 2: blocked. Any other exit code or a timeout: the hook run is marked Failed, which blocks nothing [Src 0.159.3, `events/user_prompt_submit.rs`, `permission_request.rs`, `stop.rs`]. SessionEnd and Interrupt timeouts default to 1 s and are clamped to 3 s; others default to 600 s [Src `engine/discovery.rs`]. |
| Environment | Hooks receive the launch environment in embedded mode [Native 0.159.3]. |
| IDs | `session_id` equals the ID for `codex resume <id>` and the exit banner [Native]; turn events carry `turn_id` [Doc][Native]; sub-agent events carry the parent's `session_id` plus `agent_id`/`agent_type` [Doc][Src] (not observed natively). |
| Order | First prompt: SessionStart (`source=startup`, about 1.8 s after Enter, not at launch), UserPromptSubmit, Stop, one `turn_id` [Native]. Approval: PreToolUse, PermissionRequest (no `tool_use_id`), silent wait, PostToolUse, Stop [Native]. Esc: Interrupt, **no Stop** [Native]. `/quit`: SessionEnd about 35 ms after Enter; a session quit before any prompt sends SessionEnd **without** SessionStart [Native]. Resume: nothing at launch, then SessionStart (`source=resume`, same ID) on the first prompt [Native]. A message typed during a turn fires UserPromptSubmit only when it is submitted [Native]. |
| Not observable | Ready before the first prompt; the approval decision; a turn that errors (Stop is skipped on error [Src]); crashes. |

### 3.2 Cursor

| Topic | Finding |
|---|---|
| Hooks in the CLI | sessionStart, sessionEnd, beforeSubmitPrompt, afterAgentResponse, afterAgentThought, stop, preToolUse, postToolUse, postToolUseFailure, before/afterShellExecution, before/afterMCPExecution, beforeReadFile, afterFileEdit, preCompact, subagentStart, subagentStop, workspaceOpen [Src 2026.10.01]. Tab hooks are editor-only [Doc]. |
| Gating | The turn events (stop, beforeSubmitPrompt, afterAgentResponse, afterAgentThought) fire only when the user's or the project's own `hooks.json` defines that event [Src 2026.10.01][Native 2026.10.01]. |
| Per-launch config | `--plugin-dir <dir>` [Doc]; the plugin's `hooks/hooks.json` must contain `"version": 1`, otherwise its hooks silently never run [Native 2026.10.01] (the documented plugin example omits it). Local plugins can be disabled by enterprise policy [Doc]. |
| Trust | Workspace trust before the session; no per-hook approval [Doc]. Journal never passes `--trust`, `--force` or `--yolo`. |
| Hook output | before*, preToolUse and subagentStart are permission steps: they can deny, ask or rewrite, and invalid output blocks [Doc][Src]. stop with `followup_message` submits a new prompt [Doc]. sessionStart with `env` or `additional_context` changes the session [Doc]. Empty `{}` sets no field. |
| Execution | macOS: the user's `$SHELL -ilc` [Src]; Windows: PowerShell [Src, unverified]. The launch environment reaches every hook [Native]. |
| IDs | `conversation_id` equals `session_id` and the `create-chat` / `--resume` ID, stable across turns and in sessionEnd; `generation_id` changes per prompt [Native]. Payloads also carry `user_email` [Doc], which Journal never stores. |
| Order | Plugin only: sessionStart (new chats only), afterShellExecution, postToolUse, sessionEnd fire; stop and beforeSubmitPrompt do not; Esc produces no event [Native]. With user hooks for stop: stop `completed` per turn; one Esc gave stop `aborted` and stop `error` for the same generation [Native]. Approval wait: no event while the prompt waits [Native]. |
| Not observable | Approval wait (no event); AskQuestion (staff-confirmed); ready on `--resume` (sessionStart only for new chats) [Src][Native]. |

## 4. Design

### 4.1 Principles

1. **Observation only.** Journal's hooks never decide, never block, never add context and never
   submit a prompt (4.2).
2. **Per launch first.** No provider or project configuration is written without showing the
   exact change and receiving explicit approval (4.6).
3. **Never bypass trust** (Codex hook review, Cursor workspace trust) or permissions.
4. **Unknown stays unknown.** A state is current only with fresh evidence from a verified event;
   silence never means "finished" or "ready" (4.4).
5. **Lifecycle is not input readiness** (4.5). Automatic input and agent-to-agent messaging are
   out of scope.

### 4.2 Registered events and neutral responses

What is verified, not more: the hook launcher (4.3) always exits 0 and discards the script's
output and errors, printing only the neutral response; and each provider enforces the per-hook
timeout Journal registers and treats a timeout as non-blocking: Claude Code (code.claude.com/docs/en/hooks:
a hook at its `timeout` is cancelled and its output discarded; exit codes other than 2 do not
block), Codex (source `codex-rs/hooks/src/engine/command_runner.rs` at rust-v0.159.3: outcome
`timeout`, nothing decided; SessionEnd and Interrupt clamped to 3 s in `engine/discovery.rs`),
Cursor (cursor.com/docs/hooks: per-hook `timeout`; crashes, timeouts and exit codes other than 2
fail open unless `failClosed`, which Journal never sets). Registered timeouts: Claude 3 s, Codex
up to 5 s, Cursor 5 s. The provider's timeout bounds every stage, including the provider's shell
(Cursor runs `$SHELL -ilc`, so profiles), the launcher's start and the interpreter's start. On
macOS and Linux the launcher's watchdog also kills a stalled script or interpreter after 2 s;
native Windows has no launcher watchdog (unverified there).

| Provider | Events Journal registers | Response | Why the event is safe |
|---|---|---|---|
| Codex | SessionStart, UserPromptSubmit, PermissionRequest, PostToolUse, Stop, Interrupt, SessionEnd, SubagentStart, SubagentStop | empty stdout, exit 0 | Exit 0 with empty stdout has no effect on any event; other failures are non-blocking [Src 0.159.3]. Timeout 3 s (5 s for UserPromptSubmit, PermissionRequest, Stop). Not registered: PreToolUse (PermissionRequest and PostToolUse cover the states), PreCompact/PostCompact. |
| Cursor | sessionStart, sessionEnd, postToolUse, postToolUseFailure, afterShellExecution, afterMCPExecution, afterFileEdit, subagentStop, stop, afterAgentResponse | `{}`, exit 0 | No permission step is registered. `{}` sets no field, so it overrides nothing another hook returns under Cursor's merge rules [Doc]. |

- **No `before*` hooks for Cursor, without exception.** `beforeSubmitPrompt` is removed: turn
  start is taken from the first event of a new `generation_id` (4.3). A prompt submitted at Your turn
  makes the state unknown until the next event (never a stale Your turn); a turn with no tool and no
  response event before its stop shows no Working.
- **No `preToolUse` or `subagentStart` for Cursor** (permission steps). **No PreToolUse for Codex.**
- Fixture tests assert the exact registered event list per provider, the empty or `{}` output,
  exit 0 when the hook script throws, times out or is missing, and that no registration contains
  a permission step.

### 4.3 Shared observer, turns and deduplication

**Adapters.** `src/runtime/adapters/{claude,codex,cursor}.mjs`. Each provides the launch
arguments (Claude `--settings`, Codex `-c hooks.*`, Cursor `--plugin-dir`) and `normalize(raw)`
that maps a payload to Journal's vocabulary: `session-start`, `turn-start`, `tool-end`,
`permission-wait`, `turn-end` (`completed` | `interrupted` | `error`), `session-end`,
`child-start`, `child-end`.

**One hook entry point.** A launcher at a fixed path in Journal's data folder (rewritten by each
app version, so Codex's trust hash, which covers the command string, survives updates) runs
`hook.mjs` with the provider name. Per-launch values travel in the environment:
`JOURNAL_SESSION_ID`, `JOURNAL_HOOK_TARGET`, `JOURNAL_HOOK_TOKEN`. One hook group per event in a
fixed order, because Codex's trust key includes the group and handler index. The Cursor plugin
folder lives in the data folder too, with `"version": 1`.

**Payload hygiene.** The script keeps only IDs, the event name, statuses, tool names, the
redacted command and relative file paths. It drops `user_email`, prompts, assistant text, tool
output, transcript paths and model parameters.

**Turn identity.** Each event carries a turn key when the provider has one: Codex `turn_id`,
Cursor `generation_id`. Claude has none (today's behaviour is kept). Per session the runtime
keeps `currentTurn` and a bounded set of settled turn keys.

- A `turn-start` with a new key, or the first event of an unseen key, makes it the current turn
  (Working) and settles the previous one as superseded.
- A `turn-end` for a key that is not the current turn is **stale**: it is recorded for audit but
  never changes the state. An old Stop can never finish a newer turn.
- **Duplicates:** an event identical in (event, turn key, tool id, status) to one already
  applied is ignored.
- **One outcome per turn.** Terminal outcomes for the same key merge by precedence
  `interrupted` > `error` > `completed`, independent of timing. Cursor's `aborted` + `error` pair
  for one generation becomes one interruption, whichever arrives first. The timeline shows one
  entry per turn (collapsed by turn key); no time window is assumed.
- **Out of order:** events are applied in arrival order with the rules above. A tool or
  permission event for a settled turn is ignored for state. A delayed `turn-start` for an already
  settled key does not reopen it.
- **Codex Interrupt** is the terminal event for its turn (no Stop follows).

**Children.** Codex events with `agent_id` (and SubagentStart/Stop), Cursor events with a
`parent_conversation_id`, a child `conversation_id` or `subagent_*` fields, are child events.
They update a bounded child counter shown as detail. They **never** bind or replace the parent's
native identity, never start or finish the parent's turn and never clear its permission wait.
An event whose identity cannot be classified as parent or child is dropped.

### 4.4 Observation state and loss

Two separate things per session:

- `lastObserved`: the last applied lifecycle fact and its time (for example "approval asked
  14:02"). Always shown as past evidence.
- `observation`: `pending` | `live` | `unobserved` | `lost`. Only `live` lets `stateFor` present
  a current state (Working, Your turn, Needs approval). Everything else shows the limited model
  ("Running · output…") plus the last observed fact.

Definitions (implemented in Phase 1, `src/core/terminal.mjs` OBSERVATIONS):
- **live:** an applied parent event of this launch arrived: the first one (pending → live), or any
  one after a loss (lost → live). A child's event alone never makes it live.
- **unavailable, by positive evidence only:**
  - **pending → unobserved:** the launch registered nothing (provider not supported, a version or
    feature gate failed), a provider gate reports hooks untrusted or a plugin refused, or the first
    prompt was clearly submitted (Enter written to the PTY after text, or a launch prompt) and the
    terminal produced output but no event arrived within the grace period (20 s).
  - **live → lost:** the observer reports a failure (events file over its cap, unreadable) or a
    provider gate reports it unavailable. The display falls back to the limited model with the last
    observed fact ("state unknown for 12m · last seen: tool finished, 12m ago").
- **Silence never changes the observation.** A long tool run or an unanswered approval can be
  silent for a long time. Silence only ages confidence: `observation` stays live, `lastObserved`
  is kept, a pending approval is cleared only by an event or the user's answer, and Working that
  no hook confirmed for 5 minutes says so ("Working · no hook activity for 20m"). It never asserts
  completion or readiness: Your turn needs a turn-end event.
- **Turn errors without a completion event** (Codex skips Stop on error) therefore stay Working
  with that note until the next event or the exit.
- **Claude** gets the same model.

Limits stated in the UI and docs: Codex readiness before the first prompt, Codex turn errors,
Cursor approval waits and Cursor AskQuestion are not observable; Cursor turn end needs level 2.

### 4.5 Lifecycle vs input readiness

`activity` (lifecycle) is separate from `inputReady`, which stays `false` for Codex and Cursor.
Nothing sends text or Enter to them on the strength of a lifecycle event. Paste stays Claude-only.

### 4.6 Provider setup

- **Codex (every supported launch):** version 0.131 or later and `codex features list` showing
  hooks enabled; otherwise the launch is unchanged and the session is `unobserved`. Interrupt
  needs 0.150; below it, Esc leaves the turn unknown. Codex shows its review on the first launch;
  until the user trusts the hooks, Codex skips them and the session stays `unobserved`. Journal
  explains this once, near the composer card.
- **Cursor level 1 (default):** `--plugin-dir` with Journal's plugin (only when `--plugin-dir` is
  in `agent --help`). Observes tool activity and clean exit; turn end and interruption are not
  observable at this level.
- **Cursor level 2 (opt-in):** Settings shows the exact change to `~/.cursor/hooks.json`: Journal
  entries for `stop` and `afterAgentResponse` only, pointing at the fixed launcher, identified by
  that path; existing entries kept; `version` kept; an atomic write after explicit confirmation;
  a Remove action that deletes only Journal's entries. If the file is invalid JSON or symlinked,
  Journal refuses and explains. Unlocks turn finished, interrupted and error.

### 4.7 Process exit and final events

The native Codex ID can first arrive in SessionEnd, written about 35 ms before the process exits.

- On process exit the runtime **drains** the observer file (until it is empty and the hook
  launcher's own short timeout has passed) before marking the observer closed.
- Events drained after exit are accepted only for this launch's token and session and only for
  identity and the final turn outcome: they can record the native ID (`nativeIdSource: 'hook'`)
  and the clean-exit fact, never reopen the session or change its status from exited.
- After the drain the observer is closed; any later line or another launch's event is rejected.
- An integration fixture exits before the next polling interval and proves the final native ID
  is kept and offered for exact-ID resume, the session stays ended, and an event from another
  launch is rejected.

### 4.8 Identity binding

- A known native ID (Cursor `create-chat`, any resume, Claude's preassigned ID) must match the
  event's ID; a mismatch uses the existing `IDENTITY_CHANGED` path.
- A new Codex launch binds the first parent event's `session_id` as the observed native ID
  (confirmed), so exact-ID resume no longer depends on the exit banner. Children never bind it.
- Resume is a new launch with a new token: late events from the previous launch cannot land on it.

### 4.9 Bounded unverified capabilities

| Not verified natively | Conservative behaviour |
|---|---|
| Codex and Cursor sub-agents | Child rules in 4.3; unclassifiable events dropped |
| Codex questions (`request_user_input`) | Not mapped; never "Needs you" from them |
| Codex network and MCP approvals | A PermissionRequest is shown only as received; nothing inferred for other approval kinds |
| Cursor `/new` and `/resume` inside the TUI | A different `conversation_id` from the parent is a mismatch (`IDENTITY_CHANGED`), never a silent rebind |
| Codex trust after an app update | Fixed launcher path; if Codex asks again, the session is `unobserved` until trusted |
| A user stop hook returning `followup_message` (Cursor) | Journal's `{}` sets nothing; a follow-up turn is a new generation handled by 4.3 |
| Windows, both providers | Same design; documented as unverified; the Windows launcher follows the same always-exit-0 rule |

Fixture tests never claim native validation; native results live in
`docs/NATIVE-VALIDATION.md`.

### 4.10 Handling provider configuration safely

Any tool output that inspects a provider's configuration reads only the needed keys and redacts
values that look like tokens, keys, passwords or authorization headers. Whole configuration
files are never printed. Backups are compared by checksum.

## 5. Phases (independent review after each)

1. **Core observer:** adapter interface, fixed launcher and env routing, payload hygiene, turn
   identity and deduplication, observation state, exit drain, Claude moved onto it with no
   behaviour change except the loss model. Fixtures for duplicates, delays, out-of-order and the
   exit drain.
2. **Codex adapter:** version and feature gates, `-c` registration, identity binding, children,
   Interrupt.
3. **Cursor adapter:** level 1 plugin; level 2 reviewed change in Settings.
4. **Interface:** capability- and observation-aware `stateFor`, needs-you, notifications, card
   and chip copy, Activity and Tests panels for what each provider reports.
5. **Docs:** PROVIDERS.md, IMPLEMENTATION-STATUS.md, ARCHITECTURE.md, NATIVE-VALIDATION.md (manual
   steps for the unverified rows).

## 6. Phase 1 notes for the Phase 5 docs

- **Shutdown.** Quit with "stop": the runtime drains the final events of the sessions it stopped
  (bounded by one drain grace, 5.5 s, after at most 5 s waiting for exits; the app does not wait).
  Other runtime shutdowns (idle exit, replacement by another build) close observers at once; they
  have no running sessions to stop. Quit with "keep running" only disconnects the app: observation
  continues in the runtime.
  While a runtime drains it answers a new app's hello with `closing`; the app waits for it to exit
  (within its 15 s connect window) instead of launching over it, so reopening Journal right after a
  quit can take up to about 5.5 s longer.
- **After exit** the drain records only identity (a native ID first reported at the end, bound and
  confirmed) and the agent's clean end; it never records the final turn outcome or changes the
  ended status.
- **Windows (unverified natively):** the `.cmd` launcher has no watchdog (only the provider's
  timeout bounds a stalled interpreter); a data folder whose path contains `& ( ) @ ^ | % ! " < >`
  gets no launcher and sessions start unobserved; when the launcher cannot be replaced (in use),
  a versioned copy is written and its different command string means Codex asks to trust the hooks
  again for those launches.
- **Environment:** Claude Code may strip variables from hooks when `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`
  (its docs); whether that removes `JOURNAL_*` is unverified. Without them the hook writes nothing
  and the session becomes unobserved.
- **Older runtimes** that keep running across an app update use the older hook form; the hook keeps
  writing absolute file paths for them, as before.

Not committed, pushed or merged until the user asks.

## 7. Final review fixes (5 October 2026)

- Cursor binds its ID from the first parent event when `create-chat` failed (no false identity change).
- Without tool starts (Codex), only the asking tool's own end, or an answer key, settles an approval;
  Codex's letter keys count as answers (unverified natively).
- Cursor: a prompt submitted at Your turn makes the state unknown until the next event.
- Windows: hook commands use an unquoted launcher path of letters, digits and `_ . : \ -` only; any
  other path is not registered (sessions stay unobserved).
- Level 2 matches Journal's entries by exact command; if Journal's data folder moves, older entries no
  longer match and stay until removed by hand. With the Windows versioned-launcher fallback, level 2 is
  reported as not set up for those launches.
- Cursor level 1 may become `unobserved` after a reply with no tool event within 20 s; level 1 is always
  shown limited, so only the "last seen" detail is affected.
