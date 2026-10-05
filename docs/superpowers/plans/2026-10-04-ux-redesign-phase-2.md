# Journal UX redesign, Phase 2: Honest session model

Expands Phase 2 (tasks 2.1–2.6, F5–F8, D14) of
`docs/superpowers/plans/2026-10-04-ux-redesign.md` into three groups. Each group
is one implementer's work. Use TDD in every group: failing test, run, implement,
run, commit. Keep the AGENTS.md rules: Node ≥ 24; `npm test`, `npm run check`,
`npm run build`; `npm run test:desktop` (hidden windows, Electron-native
node-pty) for desktop changes; fixture results are never reported as native
provider behaviour.

**Scope guard.** The full sidebar, header banner and Settings dialog are Phase 3.
Phase 2 delivers the data model, the runtime protocol, the pure renderer helpers,
the shortcut, notifications, and the smallest visible use in the existing
`SessionList`.

---

## 0. Order and worktrees

```
Group A  runtime/core  ──►  merged on claude/ux-redesign
                               ├──► Group B  renderer   (worktree b)
                               └──► Group C  desktop    (worktree c)
```

- **A goes first.** B and C read fields that A creates (`slot`, `lastOutputAt`,
  `pending`, `nativeIdSource`, `identityMismatch`, error `code`, the `activity`
  event).
- **B and C can run in parallel** in separate git worktrees branched from A's
  merge commit. Their only shared contracts are in section 1. They touch
  different files except `src/ui/types.ts`, where C adds nothing; B owns all
  renderer files, including handling C's `focus-session` event.
- If B or C has to start before A merges, they can write their pure modules
  (`sessionState.ts`, `notify.mjs`) and unit tests against the section 1
  contracts. Desktop specs wait for A.
- Merge order: A, then B, then C. C's desktop spec needs B's `focus-session`
  handler.

---

## 1. Contracts shared by the groups

### 1.1 Session fields (runtime `session` object, persisted in `sessions.body`)

```ts
// Added to src/ui/types.ts Session by Group B (A produces them).
slot?: 1 | 2 | 3 | 4 | null;          // live sessions in this runtime only
lastOutputAt?: string | null;          // ISO; PTY output, excluding echo and resize repaint
pending?: { tool: string | null; command: string | null; path: string | null;
            at: string; inferred?: boolean } | null;   // Claude only, while waiting
nativeIdSource?: 'preassigned' | 'preassigned-observed' | 'create-chat' | 'exit-banner' | 'user' | null;
identityMismatch?: boolean;
```

`sessions.body` is a JSON column (`src/core/store.mjs:551`), so the new fields
persist without a migration. None of them is a `SESSION_USER_FIELDS` entry.

### 1.2 Runtime events (runtime → main → renderer, unchanged path)

```ts
{ type: 'activity'; sessionId: string; lastOutputAt: string }   // Codex and Cursor only
{ type: 'focus-session'; sessionId: string }                    // main → renderer (Group C sends, B handles)
```

`focus-session` is **not** a `{type:'command'}`. `tests/shortcuts.test.mjs:63`
requires the `CommandId` union to equal `COMMAND_IDS` exactly, and this ID has no
key.

### 1.3 Error codes

Runtime errors carry `code` from `TerminalManager` to the renderer `Error`. The
codes are exported from `src/core/terminal.mjs`:

```js
export const ERROR_CODES = Object.freeze({
  SLOTS_FULL: 'SLOTS_FULL',                 // start: 4 live (or pending) sessions
  SHUTTING_DOWN: 'SHUTTING_DOWN',
  PROVIDER_MISSING: 'PROVIDER_MISSING',     // Cursor CLI not found; spawn ENOENT
  PROVIDER_UNSUPPORTED: 'PROVIDER_UNSUPPORTED', // Cursor lacks resume/createChat/mode
  ID_UNCONFIRMED: 'ID_UNCONFIRMED',         // resume without a confirmed native ID
  CONVERSATION_OPEN: 'CONVERSATION_OPEN',   // same native conversation already live
  ORPHAN_RUNNING: 'ORPHAN_RUNNING',         // resume blocked by an orphan
  START_FAILED: 'START_FAILED',             // other launch failure (wrapped)
  NOT_LIVE: 'NOT_LIVE',                     // owned(): terminal not active
});
const fail = (code, message) => Object.assign(new Error(message), { code });
```

The renderer reads `error.code`. Messages stay as they are, and the desktop
specs match on them.

### 1.4 Protocol version

Bump `PROTOCOL` in `src/runtime/protocol.mjs` to **4** (comment: "4: session
slot, pending, activity events and error codes"). The new app relies on `slot`.
An older runtime that is still running must be reported as another build, as
`PROTOCOL` changes already are, rather than produce sessions without slots.

---

## 2. Group A: runtime and core (tasks 2.1, 2.3, 2.4, 2.5, carried-over items)

**Files:** `src/core/terminal.mjs`, `src/runtime/runtime.mjs`,
`src/runtime/protocol.mjs`, `src/desktop/runtime-client.mjs`,
`src/desktop/main.mjs` (only the `journal:request` catch, line ≈478),
`src/desktop/preload.cjs` (only the `request` rejection), `src/desktop/hook.mjs`
(comment and test only, see A2), `tests/terminal.test.mjs`,
`tests/runtime.test.mjs`, new `tests/hook.test.mjs`,
`docs/NATIVE-VALIDATION.md` ("To verify").

### A1. `lastOutputAt` and the activity event (2.1)

Entry fields added in `launch()` (line ≈131): `lastInputAt: 0`, `lastResizeAt: 0`,
`lastActivityEmit: 0`, `activityTimer: null`.

```js
export const ECHO_MS = 300;          // output this soon after input or resize is not "activity"
export const QUIET_MS = 10_000;      // output after this much quiet is a resume edge
export const ACTIVITY_THROTTLE_MS = 5_000;
```

- `write()` and `paste()` set `entry.lastInputAt = Date.now()`. `resize()` sets
  `entry.lastResizeAt`, because full-screen TUIs (Codex, Cursor) repaint on
  resize, and that is not agent output.
- In `output()`, after `buffer.append`:
  `if (now - max(lastInputAt, lastResizeAt) >= ECHO_MS) this.noteOutput(entry, now)`.
- `noteOutput(entry, now)`:
  - `const previous = Date.parse(session.lastOutputAt ?? 0)`; set
    `session.lastOutputAt = new Date(now).toISOString()`.
  - Only Codex and Cursor emit. Claude sets the field but has hook states.
  - **Leading edge:** if `now - previous >= QUIET_MS` (or this is the first
    output), emit immediately and set `lastActivityEmit = now`.
  - **Trailing heartbeat:** otherwise, if no timer is armed, arm one for
    `max(0, lastActivityEmit + ACTIVITY_THROTTLE_MS - now)`. It emits the latest
    `lastOutputAt` and is `unref()`ed.
- `exited()` and `dispose()` clear `activityTimer`.
- Persistence rides the existing five-second `persist()` in `output()`;
  `emitStatus` snapshots include the field.

**Deviation from the master plan:** the master plan emits only on the resume
edge. During ten minutes of continuous output, the renderer's last value would
then be ten minutes old, and it would show "quiet 10m" while output streams. The
trailing heartbeat (at most one event per 5 s per session) keeps the renderer
within 5 s of the truth. A flood within one throttle window still gives exactly
one event.

**Tests (`tests/terminal.test.mjs`; add `t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })`
or an injected `now()` on `TerminalManager`, whichever fits the existing
`runtime(t)` fixture):**
- `a flood of output emits one activity event per throttle window`: Codex
  session; 1,000 `callbacks.data('x')` calls at the same instant give exactly one
  `activity` event. After 5 s of further output, exactly one more (the
  heartbeat), carrying the latest `lastOutputAt`.
- `output after ten seconds of quiet emits at once`: output; advance 11 s; output
  gives a second event immediately (not after 5 s).
- `echo and resize repaint do not count as output`: `write('a')` then output
  within 300 ms leaves `lastOutputAt` unchanged. The same holds for `resize()`.
  Output 301 ms after them moves it.
- `Claude sessions record lastOutputAt but emit no activity events`.
- `lastOutputAt is persisted`: after output and 5 s, `store.getSession().lastOutputAt` is set.

### A2. Pending command detail (2.3)

**Fact check:** `src/desktop/hook.mjs` already forwards `tool_use_id` for every
event, `tool_input.command` for every Bash event (redacted to 600 characters),
and `tool_input.file_path`/`notebook_path` for file tools, including on
`PermissionRequest`. So no hook change is needed. Add a comment that
`PermissionRequest` relies on these fields, and add `tests/hook.test.mjs`, which
spawns `node src/desktop/hook.mjs <target> <token>` with `JOURNAL_SESSION_ID`
set and a JSON payload on stdin:
- `PermissionRequest for Bash keeps command, tool id and redaction`: the payload
  `{hook_event_name:'PermissionRequest', tool_name:'Bash', tool_use_id:'t1', tool_input:{command:'API_KEY=abcd1234 rm -rf build'}}`
  writes a line with `command: 'API_KEY=[redacted] rm -rf build'` and `toolUseId: 't1'`.
- `PermissionRequest for Write keeps filePath`.
- `a payload without tool_input gives command '' and no filePath`. Pin this
  current behaviour: `String(undefined ?? '')` gives `''`, and terminal.mjs must
  treat `''` as missing.

Changes in `ingest()`:

- `PermissionRequest` (line ≈343) computes the detail after the existing
  candidate match:
  ```js
  const matched = toolUseId ? entry.tools.get(toolUseId) : null;
  const rawCommand = event.command || matched?.command || null;   // '' counts as missing
  const rawPath = event.filePath || matched?.filePath || null;
  const detail = { tool: event.tool ?? null,
    command: rawCommand ? redact(rawCommand, 300) : null,
    path: rawPath ? this.relativePath(session, rawPath) : null,   // null outside the workspace
    at: new Date().toISOString(),
    ...(!event.command && !event.filePath && matched ? { inferred: true } : {}) };
  ```
  - Push `{toolUseId, tool, detail}` into `entry.pending` (the existing array; no
    new structure).
  - Set `session.pending = entry.pending[0].detail`: the banner shows the oldest
    open prompt, which is the one an answer settles.
  - Record `this.record(id, 'permission', { tool, command, path, toolUseId })`.
    Today it records only `{tool}`.
- Factor `relativePath(session, file)` out of the `PostToolUse` file branch
  (line ≈374): canonical, relative, `/`-separated, capped at 300 characters, and
  `null` when outside the workspace.
- One helper keeps `session.pending` in step:
  `syncPending(entry) { entry.session.pending = entry.pending[0]?.detail ?? null; }`.
  Call it everywhere `entry.pending` changes: `settlePermissions`, the
  `write()` fast path, `SessionStart`, `UserPromptSubmit`, `Stop`, `exited()`.
  It runs before the `observe()` that emits status, so one status event carries
  both.
- `recover()` sets `pending: null` on interrupted and orphaned sessions.

The master plan's fallback ("most recent unmatched `command-start`") is replaced
by the existing `entry.tools` match. It is the same data (`PreToolUse` command,
already redacted at 600) and already handles sibling tools.

**Tests (`tests/terminal.test.mjs`, using `hooked(t)`):**
- `a PermissionRequest with a command sets a redacted pending snapshot`:
  `send('PermissionRequest', {tool:'Bash', toolUseId:'b1', command:'TOKEN=abc123456 npm publish'})`
  gives `session.pending` `{tool:'Bash', command:'TOKEN=[redacted] npm publish', path:null}`,
  with no `inferred`. `PostToolUse b1` gives `pending === null`.
- `pending is inferred from the in-flight tool when the request has no command`:
  `PreToolUse b1 'npm test'`, then an id-less `PermissionRequest Bash`, gives
  `pending.command === 'npm test'` and `inferred === true`.
- `pending path is workspace-relative and null outside it` (Write inside and
  outside `session.cwd`).
- `pending clears on PreToolUse settlement, Stop, UserPromptSubmit, an answer key and exit`
  (table-driven).
- `with two open prompts pending shows the oldest, then the next`.
- `the permission timeline event carries tool, command, path and toolUseId`.
- Runtime (`tests/runtime.test.mjs:197`): extend the hook-file test with
  `line({ event:'PermissionRequest', tool:'Bash', toolUseId:'t9', command:'API_KEY=abcd1234 rm x' })`
  and assert that the stored session's `pending.command` is redacted.

### A3. Answer keys: decision on Esc and Ctrl+C (carried over)

**Decision:** when the only open prompt is answered with **Esc (`\x1b`) or
Ctrl+C (`\x03`, including `interrupt()`)**, the session becomes `running`/`idle`
("Your turn"). A digit or Enter still becomes `running`/`working`.

The same two keys typed while `running`/`working` with no open prompt also
become `running`/`idle`. Claude Code shows "esc to interrupt" while working, and
its `Stop` hook does not fire on a user interrupt, so today such a session stays
"Working" until the next prompt.

**Reasoning:**
- In Claude Code, Esc at a permission prompt rejects the tool and interrupts the
  turn, which returns to the input box. Ctrl+C does the same. No hook reports
  this (`Stop` is skipped on interrupts), so the current "Working" is wrong until
  the next prompt.
- A digit can mean approve or deny with feedback. Both normally continue the
  turn, or wait for typed feedback that ends with Enter, so Working stays the
  better guess.

**Self-correction guard (new, required by the decision):** `PreToolUse` or
`PostToolUse*` arriving while `running`/`idle` sets `running`/`working`. Today
`settlePermissions` only observes when `waiting`. If Esc did not actually end
the turn (for example it closed a menu), the next tool event restores Working,
so "Your turn" is never stuck. Do not apply this guard after `Stop`: `Stop`
clears `entry.tools`, and no tool events follow a real turn end.

`paste()` stays safe: it already needs `activity === 'idle'` for
`IDLE_SETTLE_MS`, and any `PermissionRequest` moves the session to `waiting`.

**Keep `answered` a boolean.** Changing it to a count waits on
`NATIVE-VALIDATION.md` "Whether Claude can show a second permission prompt…".
The `$.receiptId` expression index also stays deferred; nothing in Phase 2 calls
`listReceipts` more often.

**Tests (update the existing ones):**
- `answering the only open prompt shows Working at once…` (line ≈395): keys
  `['1']`, `['3','use rg instead\r']` and `['\r']` give `running/working`. A new
  sibling test gives `running/idle` for `['\x1b']` and `['\x03']`.
- `Journal's Interrupt counts as answering the prompt…` (line ≈384): expect
  `running/idle`. Then `PreToolUse g2` gives `running/working` (the guard).
- New: `Esc or Ctrl+C while working shows Your turn; a later tool event restores Working`.
- New: `arrow keys and Alt+letter while working do not change state`
  (`'\x1b[A'`, `'\x1bb'`).
- Add to `docs/NATIVE-VALIDATION.md` "To verify": "Esc and Ctrl+C at a single
  Claude permission prompt, and while Claude is working, return Claude to its
  input box with no hook. Journal shows Your turn; a following tool event shows
  Working."

### A4. Stable slots (2.4)

- `TerminalManager` gets `this.reservedSlots = new Set()`.
- `freeSlot()`: the lowest of 1–4 not used by `liveEntries()` slots or
  `reservedSlots`.
- `start()`: the existing capacity check becomes
  `throw fail(ERROR_CODES.SLOTS_FULL, …)` (same message). Then reserve
  synchronously, before any `await`:
  `const slot = this.freeSlot(); this.reservedSlots.add(slot);` and pass `slot`
  to `launch()`. In `finally`, `this.reservedSlots.delete(slot)`.
- `launch()` puts `slot` on the session object. The failure path sets
  `slot: null` with `status: 'failed'`.
- `exited()` sets `session.slot = null`. This covers stop (status `stopped`) and
  natural exit. `dispose()` and `recover()` write `slot: null` on interrupted and
  orphaned sessions.
- **Orphans hold no slot.** They do not count toward `MAX_SESSIONS` (only this
  runtime's `liveEntries()` do), so a slotted orphan would allow five sessions
  for four slots. The renderer lists them after the slotted rows, without a
  shortcut.
- A renderer reload or app restart keeps slots, because the runtime keeps
  `entries`. A runtime restart ends the live sessions, so no slot survives it.

**Tests:**
- `slots: lowest free slot, kept across stops of others`: start A, B and C
  (slots 1, 2, 3); stop B (fire `callbacks.exit`) and B's `slot` is `null`;
  start D, which gets slot 2; A is still 1.
- `concurrent starts never share a slot`: `Promise.all` of four starts gives
  slots {1, 2, 3, 4}. A fifth rejects with `code === 'SLOTS_FULL'`.
- `a failed launch frees its reserved slot` (spawn throws, then the next start
  gets slot 1).
- `recovered sessions have no slot` (seed the store with a foreign-runtime live
  session that has `slot: 2`, run `recover()`, and expect `slot === null`).

### A5. Identity source, persisted mismatch, error codes (2.5)

- `launch()` sets `nativeIdSource`:
  - Claude new session: `'preassigned'`.
  - Cursor new session: `'create-chat'`.
  - Codex new session: `null`.
  - Resume: `prior.nativeIdSource ?? null`. The ID comes from the prior session.
- `observe()`: if `nativeId === session.nativeId` and the source is
  `'preassigned'`, set `'preassigned-observed'`. On mismatch, set
  `session.identityMismatch = true` together with `entry.identityAmbiguous`.
  Keep the existing error event; give it `code: 'IDENTITY_CHANGED'`.
- `output()` banner capture (line ≈176): when it sets a hint, set
  `nativeIdSource = 'exit-banner'`. When it clears the hint, set `null`.
- `confirmNativeId()`: set `nativeIdSource = 'user'` and
  `identityMismatch = false`, on both the stored copy and the retained
  in-memory copy.
- Error codes:
  - Replace the `throw new Error(...)` calls listed in 1.3 with `fail(code, msg)`.
  - The `launch()` catch (line ≈154) keeps the code:
    `throw fail(error.code && Object.values(ERROR_CODES).includes(error.code) ? error.code : error.code === 'ENOENT' ? ERROR_CODES.PROVIDER_MISSING : ERROR_CODES.START_FAILED, \`Could not start …\`)`.
  - `owned()` uses `NOT_LIVE`.
- The code travels through every hop:
  - `src/runtime/runtime.mjs:189`: `connection.send({ id, error: …message, ...(error?.code ? { code: String(error.code).slice(0, 40) } : {}) })`.
  - `src/desktop/runtime-client.mjs:104`: `pending.reject(Object.assign(new Error(message.error), message.code ? { code: message.code } : {}))`.
  - `src/desktop/main.mjs:478`: `return { ok: false, error: …, ...(error?.code ? { code: error.code } : {}) }`.
  - `src/desktop/preload.cjs`: `if (!result.ok) throw Object.assign(new Error(result.error), result.code ? { code: result.code } : {});`.
    Electron's `contextBridge` copies own enumerable properties of thrown
    errors; B confirms this in its desktop spec.

**Tests:**
- `nativeIdSource transitions`: Claude new is `preassigned`; a matching
  `SessionStart` hook makes it `preassigned-observed`; Cursor (fake
  `cursor.createChat`) is `create-chat`; a Codex banner makes it `exit-banner`,
  then `confirmNativeId` makes it `user`; resume copies the source.
- `identity mismatch is persisted and cleared by confirmation`: a foreign UUID
  hook sets `store.getSession().identityMismatch === true`; stop, then
  `confirmNativeId` sets it to `false`. Extend the existing test at line ≈164.
- `error codes`: in-process, a fifth `start` gives `SLOTS_FULL`, resume without
  a confirmed ID gives `ID_UNCONFIRMED`, and `write` after exit gives `NOT_LIVE`.
- Runtime (`tests/runtime.test.mjs`): `the SLOTS_FULL code reaches the client`.
  Start four sessions over the socket; the fifth `c.call('start')` rejects with
  `error.code === 'SLOTS_FULL'` and the unchanged message. Also assert that
  `hello` reports `protocol: 4`.

### Group A acceptance

- `npm test` and `npm run check` pass.
- No renderer file changes except `preload.cjs`'s one line.
- The sessions in `list()` and `status` events carry `slot`, `lastOutputAt`,
  `pending`, `nativeIdSource` and `identityMismatch` as in 1.1.
- A Codex output flood produces O(1 event / 5 s).
- `NATIVE-VALIDATION.md` "To verify" lists the Esc/Ctrl+C item. Mark the
  `tool_input` item as still to verify natively; the fixture covers only Journal's
  handling.

---

## 3. Group B: renderer (task 2.2, the renderer half of 2.4, next-needs-you)

**Files:** new `src/ui/sessionState.ts`, new `tests/session-state.test.mjs`;
modify `src/ui/SessionList.tsx`, `src/ui/App.tsx`, `src/ui/types.ts`,
`src/ui/copy.ts` (state words), `src/desktop/shortcuts.mjs` (one row per
platform), `tests/shortcuts.test.mjs`, `tests/desktop-sessions.spec.ts`. Read
`emil-design-eng/SKILL.md` from the user's skill collection before the UI edits
(AGENTS.md).

### B1. `src/ui/sessionState.ts`

```ts
export type Tone = 'neutral' | 'active' | 'attention' | 'error' | 'muted';
export interface SessionState { word: string; tone: Tone; detail: string | null; limited: boolean }

export const OUTPUT_FRESH_MS = 10_000;
export function stateFor(session: Session, now: number, connected: boolean): SessionState;
export function needsYou(session: Session): boolean;
export function slotOrder(sessions: Session[]): Session[];      // replaces activeOrder
export function slotTarget(sessions: Session[], slot: number): Session | null;
export function nextNeedsYou(sessions: Session[], currentId: string | null): Session | null;
export function outputDetail(lastOutputAt: string | null | undefined, now: number): string;
```

**`stateFor`, first rule that matches:**

| Condition | word | tone | detail | limited |
|---|---|---|---|---|
| live && !connected | Disconnected | muted | state unknown | false |
| claude && waiting | Needs approval | attention | `pending.command` ?? `pending.path` ?? `pending.tool` ?? null | false |
| claude && running && activity idle | Your turn | active | null | false |
| claude && running (working or null) | Working | active | null | false |
| codex/cursor && (running \| waiting) | Running | active | `outputDetail(...)` | **true** |
| starting | Starting | neutral | null | false |
| stopping | Stopping | neutral | null | false |
| exited && exitCode 0/null | Exited 0 | neutral | null | false |
| exited && exitCode N | Exited N | error | null | false |
| failed | Failed to start | error | null | false |
| stopped | Stopped | muted | null | false |
| interrupted | Interrupted | muted | null | false |
| orphaned | Still running outside Journal | attention | null | false |

`outputDetail`:
- `null` gives "no output yet".
- Under 10 s: "output just now".
- Under 60 s: "quiet <1m".
- Under 60 m: "quiet Nm".
- Otherwise "quiet Nh".

Codex and Cursor are never `attention`, even with a stale `waiting`. Words come
from `copy.ts` (`copy.state.needsApproval`, …) so the copy test keeps working.

**`needsYou`** (master definition, scoped):
`!removed && !archived && ((claude && waiting) || failed || orphaned || survivors?.length > 0)`.
`failed` and `survivors` sessions stay "needs you" until archived or cleaned up,
as `needsAttention` does today.

**`slotOrder`:** sessions with `slot`, ascending by slot, then orphaned sessions
by `createdAt` (newest first), excluding `removed`. Pinning no longer reorders
Active; it still orders Recent and Archived (`byPin` stays in `SessionList.tsx`).

**`nextNeedsYou`:** the candidates are `slotOrder(sessions).filter(needsYou)`,
followed by any other `needsYou` sessions by `createdAt` (newest first), for
example failed ones. Return the first candidate after `currentId`, wrapping
around. If `currentId` is the only match, or there are none, return `null`.

**Live sessions without a slot** (an older runtime, which the protocol bump
prevents) sort after the slotted rows by `createdAt`. Slot keys never reach them.

**Test (`tests/session-state.test.mjs`):** transpile `sessionState.ts` with
`ts.transpileModule`, following `tests/provider-mark.test.mjs`. Inline a stub
for `./types` `isLive` and `./copy`, or transpile those files into the same
temp directory (`.cache/tmp`). Cases:
- `stateFor table`: every row above for each of the three providers × statuses ×
  activity ∈ {idle, working, permission, null} × connected ∈ {true, false}.
  Assert `{word, tone, limited}`. Codex and Cursor are never `attention`; Claude
  is never `limited`.
- `outputDetail boundaries`: 0 s, 9.9 s, 10 s, 59 s, 60 s, 59 m and 2 h; also
  `null`.
- `Needs approval detail prefers command, then path, then tool`.
- `needsYou`: true for Claude waiting, failed, orphaned and survivors; false for
  Codex waiting, archived and removed.
- `slotOrder`: slots 3, 1 and an orphan give [1, 3, orphan]. A pinned session
  with slot 2 sorts at position 2, not first.
- `nextNeedsYou cycles in slot order and wraps`: slots 1 (waiting), 2 (idle) and
  4 (waiting): from 1 to 4, from 4 to 1, from null to 1, and from 2 to 4.

### B2. Wire it in (minimal visible change)

- `SessionList.tsx`:
  - Delete `stateLabel`, `needsAttention`, `resumable` and `activeOrder`.
    `resumable` moves to `sessionState.ts` unchanged; App uses it.
  - Active rows render `stateFor(...).word` in `.session-status` and the detail
    as a `<small>` under the title when present.
  - `attention` comes from `needsYou(s) || state.tone === 'attention'` (this
    keeps Disconnected out of the attention dot, a small honest change).
  - A row that has a slot shows its shortcut label from `bootstrap.shortcuts`
    (`slot-N`) as `aria-keyshortcuts`.
  - The aria-label keeps the `Provider: title. word` format, so the provider
    prefixes in the desktop specs stay valid. Add `, limited status` for
    Codex/Cursor.
- Limited status: Codex/Cursor rows show "Running" plus the detail, and a
  `title` tooltip from `copy.tip.limitedStatus` ("Journal sees output, not the
  agent's state. Check the terminal for prompts."). There is no amber colour.
- `App.tsx`:
  - Replace the `activeOrder` uses (lines ≈113, 141) with `slotOrder`.
  - Slot command: `const target = slotTarget(ordered, n)`. The busy rule is
    unchanged; delete the "until Phase 2" comment.
  - New command `next-needs-you`: `const target = nextNeedsYou(ordered, selectedId); if (!busy && target) void selectSession(target);`.
  - Handle `{type:'activity'}`: patch `lastOutputAt` into `sessions[sessionId]`
    without bumping `version`. Status events stay the authority; an activity
    event only ever moves `lastOutputAt` forward.
  - Handle `{type:'focus-session', sessionId}`: `if (sessions[sessionId]) void selectSession(sessions[sessionId])`.
    It ignores `busy`, like a click.
  - Clock: keep the 15 s `now` tick, and use 5 s while any live Codex/Cursor
    session is visible, so "output just now" ends within 5 s of the 10 s
    threshold.
  - The header state label (line ≈278) uses `stateFor(...).word`.
  - On a `start` error with `code === 'SLOTS_FULL'`, show the existing message.
    This is the only code-specific UI in Phase 2; the States sheet is Phase 8.
- `types.ts`: add the 1.1 fields, the two 1.2 event variants, `'next-needs-you'`
  in `CommandId`, and `code?: string` documentation on `api` errors.

### B3. Shortcut row

In `src/desktop/shortcuts.mjs`, per section 2.1 of the master plan:
- MAC: `{ id: 'next-needs-you', meta: true, key: 'j', label: '⌘J', aria: 'Meta+J' }`.
- OTHER: `{ id: 'next-needs-you', control: true, shift: true, key: 'j', label: 'Ctrl+Shift+J', aria: 'Control+Shift+J' }`.

The handler in B2 lands in the same commit, as the file header requires.

**Tests (`tests/shortcuts.test.mjs`, table rows):**
- `⌘J` on darwin and `Ctrl+Shift+J` on win32/linux give `next-needs-you`.
- `Ctrl+J` (no Shift) on win32/linux gives `null`: newline in shells, must reach
  the terminal.
- `⌘⇧J` on darwin gives `null`.
- The parity tests at lines 59, 63 and 98 then pass with the new `CommandId`
  member.

### B4. Desktop spec (`tests/desktop-sessions.spec.ts`, headless)

- `slot shortcuts keep their session across a renderer reload`: start two
  fixture sessions, press `Meta+2`/`Alt+2` and record the selected title, reload
  the window (`page.reload()`), press it again, and expect the same title.
  Replaces nothing; it complements the Phase 1 test.
- `next needs-you jumps to a waiting Claude session`: drive the fixture hook
  file to `PermissionRequest` with a command for session 2 while session 1 is
  selected. The row shows "Needs approval" and the command text. `Meta+J`/
  `Control+Shift+J` selects session 2.
- `Codex shows Running with output detail and limited status` (fake Codex
  fixture prints once). The row text matches `/Running/` and `/output just now|quiet/`.
- `a fifth start reports SLOTS_FULL`: catch the rejection in
  `page.evaluate(() => window.journal.request('start', …))` and assert
  `error.code === 'SLOTS_FULL'`. This confirms the contextBridge hop.

### Group B acceptance

- The master plan's board B8 state table is reproduced by `stateFor`.
- `npm test`, `npm run check`, `npm run build` and `npm run test:desktop`
  (hidden windows) pass.
- ⌘1–4 / Alt+1–4 never move after another session stops or the renderer reloads.
- ⌘J / Ctrl+Shift+J cycles the sessions that need you, in slot order.
- No hover or transition is added; any new hover is inside
  `@media (hover:hover) and (pointer:fine)`.

---

## 4. Group C: desktop notifications and badge (task 2.6, D14)

**Files:** new `src/desktop/notify.mjs`, new `tests/notify.test.mjs`; modify
`src/desktop/main.mjs` (subscribe, focus, preferences, AppUserModelId),
`src/desktop/menu.mjs` (two checkbox items), `tests/menu.test.mjs`, new
`tests/desktop-notify.spec.ts`. No renderer changes: B handles `focus-session`.

### C1. `src/desktop/notify.mjs` (pure; Electron injected)

```js
export const PREFERENCE_DEFAULTS = Object.freeze({ notifications: true, notificationCommand: false });

export function createNotifier({
  Notification,            // constructor: new Notification({ title, body, silent }) with .show(), .close(), .on('click', fn)
  isSupported = () => true,
  isFocused,               // () => boolean
  onClick,                 // (sessionId) => void : focus the window and send focus-session
  setBadge,                // (count) => void
  titleFor = s => s.title, // (session) => string | Promise<string>
  preferences,             // () => { notifications, notificationCommand }
}) → {
  seed(sessions),          // full list at connect/reconnect: sets the badge, never notifies
  update(session),         // each status event (ignores versions older than seen)
  dispose(),               // close every open notification
}
```

**Rules:**
- **Episode.** A Claude session moves from not-`waiting` to `waiting`. Seeing
  `waiting` again (a second stacked prompt, or a newer version) inside the same
  episode never notifies. The episode ends when the status leaves `waiting`; any
  open notification for it is then `close()`d.
- Notify only if all of these hold: `provider === 'claude'`,
  `preferences().notifications`, `!isFocused()` at the moment of entry, and
  `isSupported()`. A session that enters `waiting` while the window is focused
  is not notified later, even if the user then unfocuses: the episode is spent.
- Content:
  - `title: 'Claude needs approval'`.
  - `body: <session title>`, plus `\n<pending.command ?? pending.path>` only when
    `notificationCommand` is true.
  - The command is already redacted by the runtime; truncate it to 120
    characters here.
  - `silent: false`. `seed()` never notifies, so a restart does not replay
    episodes.
- `titleFor` lets `main.mjs` use the store's `displayName ?? title`. The runtime
  copy has `displayName` stripped (`fromRuntime`). On rejection, fall back to
  `session.title`.
- Hold a reference to each shown notification in a `Map` keyed by session ID.
  Otherwise it can be garbage-collected before its click on Windows.
- **Badge** = the number of sessions with (`claude && waiting`) or `orphaned`.
  Exclude removed sessions; track by ID with the latest version. Call
  `setBadge` only when the count changes.
  - **Deviation from the master plan ("badge = needsYou"):** `needsYou` also
    counts failed and survivor sessions, which stay so until archived. A Dock
    badge that never clears trains people to ignore it. The badge means "a live
    agent is blocked or unaccounted for"; the in-app `needsYou` keeps the wider
    set.

### C2. Wiring in `src/desktop/main.mjs`

- **Preferences:** `userData/preferences.json`, read and written like
  `appearance.json` (line ≈47):
  `readPreferences() → { ...PREFERENCE_DEFAULTS, ...validated }` and
  `writePreferences(patch)`. Only booleans are accepted. The file is local to
  the device, not in SQLite: it is a display preference, not project data, and
  the main process must read it without a store round trip.
- **Menu:** `menuTemplate({ …, preferences, setPreference })` adds, under
  Window on Windows/Linux and under the app menu on macOS:
  - checkbox `Notify When Claude Needs Approval` (id `notify-approval`);
  - checkbox `Show Commands in Notifications` (id `notify-command`), disabled
    while the first is off.

  Each click calls `setPreference` and then rebuilds the menu. The Settings
  dialog absorbs these items in Phase 3; this keeps the setting reachable now
  without renderer work.
- **Construction,** after `runtime` exists:
  ```js
  const notifier = createNotifier({
    Notification: headless && globalThis.__journalNotification ? globalThis.__journalNotification : Notification,
    isSupported: () => Notification.isSupported(),
    isFocused: () => !!window && !window.isDestroyed() && window.isFocused(),
    onClick: id => { if (!window) return; if (window.isMinimized()) window.restore(); window.show(); window.focus(); send({ type: 'focus-session', sessionId: id }); },
    setBadge: count => { app.setBadgeCount(count); if (process.platform !== 'darwin') window?.flashFrame(count > 0 && !window.isFocused()); },
    titleFor: s => store.getSession(s.id).then(row => row.displayName || row.title, () => s.title),
    preferences: readPreferences,
  });
  ```
  - The existing `runtime.on('event')` line (≈123) also calls
    `notifier.update(fromRuntime(event.session))` for `status` events.
  - After a successful `runtime.connect()`, and on `reconnected`:
    `notifier.seed([...await runtime.call('list'), ...await store.activeSessions()])`.
  - On `before-quit`: `notifier.dispose()`.
  - `window.on('focus')` calls `window.flashFrame(false)`.
- **Windows:** `if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? 'io.github.adirz101.journal' : process.execPath);`
  near the top, before `whenReady`.
  - The packaged value must equal `appId` in `electron-builder.config.cjs:20`.
    Export the constant from there, or assert equality in
    `tests/release.test.mjs` so the two cannot drift.
  - Without it, Windows toasts from the packaged app are dropped or attributed
    to Electron.
- `app.setBadgeCount` is a no-op on Windows (it returns false), so Windows gets
  `flashFrame` instead. On Linux it works only under Unity-compatible launchers.
  No overlay icon in Phase 2.

### C3. Tests

`tests/notify.test.mjs` uses a `FakeNotification` that records instances, with
`show`, `close` and `on('click')`.
- `one notification per waiting episode`: running, waiting, waiting (v+1),
  waiting (v+2) shows 1. Then running, waiting shows 2.
- `none when the window is focused at entry, and none later in that episode`.
- `none for Codex or Cursor waiting`.
- `none when notifications are off`.
- `command hidden by default, shown when allowed`: the body excludes
  `pending.command` by default and includes it (truncated to 120) when
  `notificationCommand` is true.
- `leaving waiting closes the open notification`.
- `click calls onClick with the session id`.
- `older versions are ignored`: v5 waiting, then v4 running, keeps the episode
  open and the badge at 1.
- `seed sets the badge and never notifies`: a seed with two waiting Claude
  sessions and one orphan gives a badge of 3 and 0 notifications.
- `badge counts Claude waiting and orphaned only`: failed, survivors and Codex
  waiting are excluded; `setBadge` is called only on change.
- `titleFor rejection falls back to session.title`.

`tests/menu.test.mjs`: the two checkbox items exist with ids `notify-approval`
and `notify-command`, reflect `preferences`, and the second is disabled when the
first is off, on darwin and win32.

`tests/desktop-notify.spec.ts` (headless; follows the `__journalMenuHook`
pattern):
- Install `globalThis.__journalNotification` (capturing constructor) through
  `electronApp.evaluate` before the session starts.
- `an unfocused window gets one notification and a click selects the session`:
  start a fixture Claude session and blur the window (`BrowserWindow.blur()`;
  hidden windows report unfocused. If `isFocused()` is unreliable headless,
  inject `globalThis.__journalFocused = () => false` in the same way). Write two
  `PermissionRequest` lines; exactly one captured notification exists, with no
  command in its body. Invoke its click handler; the session is selected in the
  renderer.
- `the badge follows waiting sessions`: capture `app.setBadgeCount` through
  `globalThis.__journalBadge` in headless mode; it is 1 while waiting and 0
  after `PostToolUse`.

### Group C acceptance

- One notification per waiting episode, unfocused only, Claude only, with the
  command hidden unless the menu setting allows it. Click focuses the window and
  selects the session. The badge clears when nothing is blocked.
- `npm test`, `npm run check` and `npm run test:desktop` (hidden windows) pass.
- **Native check:** add to `docs/NATIVE-VALIDATION.md` "To verify": "Packaged
  macOS and Windows builds show the approval notification (Windows needs the
  AppUserModelId), and clicking it focuses Journal on the session." Fixture
  tests do not prove the OS behaviour.

---

## 5. Risks

| Risk | Mitigation |
|---|---|
| Esc/Ctrl+C → "Your turn" is wrong if Claude keeps working (Esc closed a sub-menu, or a subagent continues) | The A3 guard: any tool event restores Working. Native check listed. |
| TUIs repaint on their own (spinners, elapsed timers), so a "quiet" Codex never looks quiet | This is acceptable: a timer that is ticking means Codex is running. Record in the native check what idle Codex/Cursor emit. If the idle screen redraws periodically, add a minimum chunk size or ignore cursor-only sequences in a follow-up. |
| Echo suppression hides real output that starts within 300 ms of a key | Only the first chunk is missed; any later chunk counts. |
| Protocol bump: an old runtime keeps running sessions after an app update | The existing mismatch path reports another build. Running sessions continue in the old runtime; nothing is killed. |
| `contextBridge` might drop `code` on thrown errors | B4's desktop spec asserts it. Fallback: preload returns `{ok:false}` objects and `api()` rethrows with the code. |
| Notification objects garbage-collected before click (Windows) | Kept in the notifier's `Map` until the episode ends. |
| Headless `isFocused()` differs per platform | Injected `isFocused` hook in headless mode. |
| Shared files across worktrees (`main.mjs`, `preload.cjs`, `types.ts`) | A merges first. B owns `types.ts` and `App.tsx`; C owns `notify.mjs`, `menu.mjs` and the new `main.mjs` blocks. Rebase B and C on A before starting. |
| Badge semantics differ from the master plan | Documented as a decision (C1); revisit in the Phase 3 sidebar review. |

---

## 6. Corrections to the master plan

1. **2.3 hook change is already done.** `hook.mjs` forwards `tool_use_id`, the
   Bash `command` and the file tools' `file_path` on every event, including
   `PermissionRequest`. Only a test and a comment remain. The
   "unmatched `command-start`" fallback duplicates the existing `entry.tools`
   match; use that instead.
2. **2.1 throttle as written gives stale "quiet Nm" during continuous output.**
   Add the trailing 5 s heartbeat (A1). Echo suppression must also cover resize
   repaints.
3. **2.6 click via `{type:'command', id:'select-session'}` breaks the
   `CommandId`/`COMMAND_IDS` parity test.** Use a separate `focus-session`
   event.
4. **2.6 badge = `needsYou`** would count failed and survivor sessions
   indefinitely. The badge counts Claude waiting and orphaned only.
5. **2.4 orphans:** they don't count toward `MAX_SESSIONS`, so they cannot hold
   slots. Slots are assigned only within this runtime's live entries, and
   reserved synchronously so concurrent starts can't collide.
6. **2.5 error codes are lost at four hops,** not one: the `launch()` catch
   wrapper (`terminal.mjs:154`), the runtime reply (`runtime.mjs:189`),
   `runtime-client.mjs:104`, and the `main.mjs` IPC catch plus `preload.cjs`.
7. **`nativeIdSource` values:** section 4.2 lists four values and Task 2.5 lists
   five. Use five (`preassigned` before the first matching hook).
8. **Line references have drifted.** `terminal.mjs:316` (`PermissionRequest`) is
   now ≈343. The App keydown switch cited in Phase 1 no longer exists; the
   handler is `command.current` at ≈162.
9. **Pinning reordered Active slots before Phase 2.** With stable slots, pins
   order only Recent and Archived. The master plan does not say this, and the
   Phase 3 sidebar task should state it.
