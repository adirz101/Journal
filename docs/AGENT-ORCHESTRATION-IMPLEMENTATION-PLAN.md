# Agent orchestration: implementation plan

Status: **plan only; no production code yet.** It derives from [AGENT-ORCHESTRATION](AGENT-ORCHESTRATION.md) (the spec, "§" references below point there) and from the repository as of `main` at 0.1.2-alpha (6 October 2026). Each phase is meant to be executable by a separate implementer without redesigning the architecture: it names the files, the functions to extend, the new modules, the migrations, the tests and what is out of scope.

## 1. Implementation principles

Non-negotiable in every phase:

1. **The coordinator decides the workflow.** Journal never advances a workflow on its own: it does not start work, integrate, review, retry or complete anything without a request.
2. **Journal owns deterministic state, safety and resources:** state machines, snapshots, verified evidence, delivery timing, admission, gates, conflict detection, persistence, recovery.
3. **No completion by session exit.** Process lifetime is *presence* (`live`/`paused`/`lost`), separate from work state.
4. **No state from free text.** Only hooks, Git, process facts and tool calls change state. Terminal output and `last_assistant_message` are at most claims shown to the coordinator.
5. **Messages only at safe boundaries:** a turn-end continuation or a verified idle moment. Never during a pending approval, and never into a terminal whose approvals Journal cannot see (Cursor).
6. **A blocked task is not a queued worker.** Unmet dependencies mean no attempt exists. Only a launch already requested and queued for capacity may start without a new request.
7. **Ready needs an explicit report.** A captured result without `report_result` is `result_available`, which is visible and recoverable, never `ready` by inference.
8. **Workers integrate through Journal.** A worker's brief forbids push, merge, pull requests and branch switching unless the task has `hostingAllowed`.
9. **Git hosting is shell work.** No pull request, CI or merge subsystem is built.
10. **No real provider accounts in automated tests.** Every spec and helper uses `fixtureEnv` (AGENTS.md, `tests/isolation.test.mjs`). Real logins are for manual validation only.
11. **Additive.** A normal Build, Research or Plan session, and today's single isolated session, keep working exactly as today, apart from the deliberate M1 improvement.
12. **Repository rules:** English; no competitor names; Node ≥ 24; `npm test`, `npm run check`, `npm run build` and `npm run test:desktop` (headless) for every desktop change; CI stays on free runners.

## 2. Repository map

| Area | File / module | Current responsibility | Why it matters | Plan |
| --- | --- | --- | --- | --- |
| Store, schema | `src/core/store.mjs` (`JournalStore`, `migrate()` steps 1–8, `appendEvent`, event kind allow-list, sessions, receipts, memory, proposals) | Single SQLite writer, migrations, all records | Orchestration tables, run events, session `role/runId/attemptId` | **Extend** (migration 9+, new delegating methods) |
| Store plumbing | `src/core/store-methods.mjs` (`STORE_METHODS`), `src/core/store-worker.mjs`, `src/desktop/store-client.mjs` (`StoreClient`) | One list of worker-callable methods; the worker thread; the main and runtime clients | Every new store method must be listed once | **Extend** |
| Isolated environments | `src/core/environments.mjs` (`Environments`: `createNow`, `syncFromSession`, `snapshot`, `preview`, `apply`, `updateFromBranch`, `unresolved`, `branchBusy`, `abandon`, `restore`, `cleanup`, `kept`, `reconcile`, `finishLanded`, `rollBack`, `lock`, `view`; `TRANSITIONS`; `allocatePortBlock`) | Worktree, refs, results, previewed Apply, conflicts, cleanup, recovery | M1 changes readiness and Apply; M3 reuses port allocation; M7 builds gates on preview/apply | **Extend** (M1), **reuse** |
| Workspace view | `src/core/workspaces.mjs` (`workspaceView`, `isolated: { id, logicalBranch, base, lifecycle }`) | What a session in a workspace sees | Coordinator and worker views | **Reuse** |
| Terminal manager | `src/core/terminal.mjs` (`TerminalManager`: `start`, `freeSlot`, `launch`, `ingest`, `apply`, `observe`, `write`, `paste`, `stop`, `recover`, `recheckOrphans`, `trackDescendants`; `MAX_SESSIONS = 4`, `IDLE_SETTLE_MS`, `LIVE_STATES`, `ERROR_CODES`) | PTYs, launch, hook ingestion, activity, approvals, recovery | Turn boundaries (M1), capacity (M3), delivery (M4), role launch (M5) | **Extend**; split capacity out (M3) |
| Runtime | `src/runtime/runtime.mjs` (`METHODS`, `startRuntime`, recovery report), `src/runtime/protocol.mjs` (`PROTOCOL = 4`, `buildId` file list) | Detached process, socket API | New methods (capacity, deliver, tool calls); protocol bump; build id includes new runtime files | **Extend** |
| Observers and hooks | `src/runtime/observers.mjs` (launcher script, `Observers.prepare`, event files), `src/desktop/hook.mjs` (hook script, 1.5 s bound, output discarded) | Per-launch hook registration and event capture | The launcher discards output and prints a neutral response: Stop continuation (M4) must change this narrowly | **Extend** (M4) |
| Provider adapters | `src/runtime/adapters/{claude,codex,cursor,common,index}.mjs` (`events`, `response`, `register`, `extract`, `normalize`, `observes`, `turnStarts`, `toolStarts`) | Hook vocabulary per provider | Stop continuation response per provider, MCP registration per provider | **Extend** |
| Agent launch | `src/core/agents.mjs` (`buildAgentLaunch`, providers, `CODEX_RESUME_MARKER`), `src/core/cursor.mjs` | argv per provider | `--mcp-config` / `-c mcp_servers.*` / Cursor plugin; per-launch permission configuration | **Extend** (M5) |
| Process facts | `src/core/process.mjs` (`processTable`, `descendants`, `processIdentity`, `isAlive`) | Process trees and identity | Footprint measurement (M3) | **Reuse** (add RSS to the table read) |
| Story | `src/core/story/story.mjs` (`buildStory`, `isolationOf`), `classify.mjs`, `shell.mjs`, `story.d.mts` | Deterministic session Story | Run Story (M6), worker rows | **Extend**; new `run-story.mjs` |
| Files / Changes | `src/core/changes.mjs`, `store.sessionChanges`, `savedEnvironmentChanges`, `src/ui/ChangesPanel.tsx`, `FilesTab.tsx` | Diffs per session | Worker Changes unchanged | **Reuse** |
| Memory | `store.prepareContext`, `retrieval.mjs`, `proposals.mjs`, `store.prepareMemory`, `originFor`, `withOrigin` | Packets, receipts, proposals, origins | Task packets, run memory, discovery candidates (M5/M9) | **Extend** |
| Main process | `src/desktop/main.mjs` (IPC `actions`, `startSession`, isolated `start`, `followEnvironment`, `reconcileEnvironments` interval, `removeSession` dialog, notifier) | App orchestration and IPC | Run IPC, coordinator start, capacity UI wiring | **Extend** |
| Preload | `src/desktop/preload.cjs` (`allowed` set) | IPC allow-list | New actions | **Extend** |
| Runtime client | `src/desktop/runtime-client.mjs` | Socket client from main | New runtime methods | **Extend** |
| Notifications | `src/desktop/notify.mjs` | Attention and dock badge | Only user decisions raise attention | **Extend** |
| Sidebar | `src/ui/Sidebar.tsx`, `src/ui/sidebarModel.ts` (`recentGroups`, `byPin`), `AgentRow.tsx` | Flat Active/Recent lists, slot meter "n of 4" | Nested runs, queued/presence markers | **Extend**; new `runTreeModel.ts` |
| Inspector | `src/ui/Inspector.tsx` (`TABS`: session, files, memory), `SessionTab.tsx`, `EnvironmentPanel.tsx`, `StoryPanel.tsx` | Right-hand tabs | Team tab; worker header; Apply-while-idle UI (M1) | **Extend** |
| App shell | `src/ui/App.tsx` (`MAX_SESSIONS = 4`, `canStart`, `startBlocked`), `Composer.tsx` (Isolated option), `SessionHeader.tsx`, `copy.ts`, `types.ts`, `useSessionData.ts` | Session start and state | Capacity copy, Coordinate mode, run types | **Extend** |
| Desktop tests | `tests/desktop-*.spec.ts` (notably `desktop-isolated.spec.ts`, `desktop-notify.spec.ts` which plays real Claude hooks through Journal's launcher, `desktop-sessions.spec.ts`, `desktop-sidebar.spec.ts`), `tests/support/{env,ui,a11y,keys}.ts` (`fixtureEnv`, `slotsUsed` "n of 4") | End-to-end with fixture CLIs | Fixture coordinator and workers | **Extend** |
| Unit tests | `tests/environments.test.mjs` (30 tests), `terminal.test.mjs`, `turns.test.mjs`, `hook.test.mjs`, `codex-hooks.test.mjs`, `cursor-hooks.test.mjs`, `runtime.test.mjs`, `storage-worker.test.mjs`, `story.test.mjs`, `sidebar-model.test.mjs`, `copy.test.mjs`, `isolation.test.mjs` | Core behaviour | Extended per milestone | **Extend** |

New modules (by milestone):
- `src/core/orchestration/` (`model.mjs` for state machines; `runs.mjs`, `tasks.mjs`, `attempts.mjs`, `messages.mjs`, `results.mjs`, `gates.mjs`, `events.mjs`);
- `src/runtime/capacity.mjs` and `src/runtime/probes/macos.mjs`;
- `src/runtime/delivery.mjs`;
- `src/agent-tools/` (`server.mjs` for MCP over stdio, `cli.mjs`, `client.mjs` for the runtime socket with a token, `tools.mjs` for definitions and role checks);
- `src/core/story/run-story.mjs`;
- in the UI: `src/ui/runTreeModel.ts`, `TeamTab.tsx`, `WorkerHeader.tsx`, `MessageBox.tsx`.

## 3. Dependency graph between milestones

```
M1 Ready without exit ───────────────────────────────────────────┐
  ↓                                                               │
M2 Durable orchestration model (schema, state machines, events)   │
  ├──► M3 Capacity manager ──────────┐                            │
  └──► M4 Message engine ────────────┤                            │
                                     ↓                            │
                         M5 ToolServer + worker spawning ◄────────┘
                                     ↓
              ┌──────────────────────┼──────────────────────┐
              ↓                      ↓                      ↓
   M6 GUI hierarchy + Team   M7 Coordinator-managed   M8 Dependencies, conflicts,
                                integration              retries, handoffs
                                     ↓                      ↓
                                     └──────► M9 Review ◄────┘
                                                  ↓
                                     M10 Recovery hardening + real validation
```

**Safe in parallel:**
- M3 and M4, after M2: they touch different runtime areas (capacity vs delivery) and share only the run-event writer.
- M6, M7 and M8, after M5: UI, gates and the workflow tools are separate modules. M6's Team tab can start against M2's projections earlier, with mocked data.
- M1's UI part and M2's schema work have no shared files beyond `environments.mjs`. Do M1 first anyway: it changes the semantics M2 builds on.

## 4. M1 — Ready without exit

Scope: single isolated sessions (no runs). Shippable on its own; it fixes "Apply appears only after the agent exits".

**Migration risk: none.** M1 needs no new table. Its changes:
- **Isolated `workspaces` body (JSON):** `result.report` stays absent in M1; `lastTurnSnapshotAt`; `appliedResult` (the result the base advanced to).
- **`environments.mjs`:** two transitions are added to `TRANSITIONS`.

### 4.1 Changes

1. **Settled turn end → snapshot.**
   - In `TerminalManager.apply()` (`turn-end` case), after `observe(... 'idle')`, schedule a check after `IDLE_SETTLE_MS`.
   - If the session is still `running` + `idle` with no `entry.pending` and no `entry.tools`, emit a new runtime event `{ type: 'turn-settled', sessionId, environmentId }`. Only for sessions with `environmentId` and `observation === 'live'`.
   - Main (`followEnvironment` in `src/desktop/main.mjs`) handles it: `store.environments.syncFromSession(session, { boundary: 'turn' })`.
2. **`Environments.syncFromSession(session, { boundary })`:**
   - **New branch:** `boundary === 'turn'` with a live session in `running/waiting` → `snapshot(id)`, then `transition(id, 'completed')`. The session is not required to have ended.
   - **Next turn:** `turn-start` (status `running`, activity `working`) moves `completed → running`, which is already allowed. `integrated → running` is new: add it to `TRANSITIONS.integrated`.
   - **Ended session:** unchanged.
3. **Apply while live but idle.**
   - In `Environments.apply()`, replace the `liveSessions(id).length` refusal with an "idle at a boundary" check. Every live session in the environment must be `status === 'running' && activity === 'idle'` with no pending approval, read from the session record.
   - Otherwise refuse with `NOT_IDLE` ("The agent is working; apply when its turn ends").
   - `apply()` still re-snapshots first, and `expect` (already implemented) protects against a change after the preview.
   - `updateFromBranch`, `abandon` and `cleanup` keep requiring no live session in M1. Cleanup never stops a live session.
4. **Result superseding.** This already works: `snapshot()` is idempotent and creates a new result commit when the tree changes. Add `supersededAt` to the previous result in the body (history), and emit the environment event `result` with `supersedes`.
5. **Base advance after Apply.** After `integrated`, set `env.base = env.result.sha` (the applied result) and `appliedResult = { sha, commit }`, and `update-ref REF(id,'base')`. The next preview uses `--merge-base=<applied result>`.
   - Unit-test that a follow-up previews only the new work, and that the branch's other changes are not reverted.
6. **Follow-up after Apply.** `integrated → running` on `turn-start` (point 2); the next turn end produces `completed` with a new result.
7. **Cleanup interplay.** `main.mjs` `applyEnvironment` currently calls `cleanupEnvironment` right after an Apply. In M1, skip cleanup when a session is live (presence live); clean up when the session ends and the environment is `integrated`, which `reconcile` already handles.
8. **GUI** (`EnvironmentPanel.tsx`, `copy.ts`):
   - show **Apply** when `state === 'completed' && folder` regardless of session liveness, and disable it with "Applies when the agent's turn ends" while the session is `working`;
   - after an Apply, show "Applied. The agent can continue; its next changes will show here.";
   - for unobserved providers (`session.observation !== 'live'`), show "Journal can't see when this agent finishes a turn. Its result is saved when the session ends, or with **Save result now**." The **Save result now** button calls `snapshotEnvironment`, which exists.
9. **Recovery.** `reconcile()` keeps working: `running/waiting` with no live session → snapshot + `completed`. A `completed` environment with a live session after a restart stays `completed`; the next `turn-start` moves it.
10. **Providers without reliable turn hooks:**
    - Cursor without level 2, and Codex with untrusted hooks: no `turn-settled` events, so the behaviour is as today plus **Save result now**.
    - Claude: full M1.
    - Codex with trusted hooks: full M1, with `Stop`/`Interrupt` as the turn end.

### 4.2 Acceptance tests

- **Unit, `tests/environments.test.mjs`:**
  - a live session, a turn-settled snapshot → `completed`;
  - Apply while live and idle → `integrated`;
  - a follow-up turn → `running` → turn end → `completed` with a new result whose preview lists only the new file;
  - a second Apply → `integrated`;
  - the branch's own commits made between the two Applies are kept;
  - Apply while working → `NOT_IDLE`, nothing written;
  - Apply with a stale `expect` → `RESULT_CHANGED`;
  - `integrated → running` allowed; cleanup refuses while live.
- **Unit, `tests/terminal.test.mjs` / `turns.test.mjs`:**
  - `turn-settled` emitted once per settled turn end;
  - not emitted with a pending approval, an in-flight tool, an unobserved session, or a new turn within the settle time.
- **Desktop, `tests/desktop-isolated.spec.ts`** (a new test, using the hook-playing helper from `desktop-notify.spec.ts`): the fixture agent stays alive, the test plays `UserPromptSubmit`/`Stop`, the panel shows Apply, Apply lands, the test plays another turn, a second Apply lands, and the terminal is still running throughout.
- **Regression:** all existing isolated tests pass. "Worker trying to work after Apply" is covered by the `integrated → running` test plus "the new result previews only new work".

## 5. M2 — Durable orchestration model

New module `src/core/orchestration/` used by `JournalStore` (delegating methods, as with `Environments`). No agents and no UI.

### 5.1 Migration 9 (one transaction; idempotent like the existing steps)

Tables as in spec §32: `runs`, `tasks`, `dependencies`, `attempts` (with `presence` column), `results`, `messages`, `approvals`, `run_events`, `capacity_samples`. Indexes as listed there. The `events` kind allow-list gains `'orchestration'` for session-level rows (worker Story).

### 5.2 Entities

| Entity | Store methods | Transition validation | Recovery | Retention |
| --- | --- | --- | --- | --- |
| Run | `createRun` (intent first: `state: 'creating'`), `getRun`, `listRuns(projectId)`, `setRunState`, `setPolicy` (tighten/loosen split), `pauseRun`/`resumeRun`, `finishRun` | `RUN_TRANSITIONS` in `model.mjs` | `creating` without a coordinator session → `failed` (no side effects yet) | Kept; events 90 days after end |
| Task | `createTask` (computes `pending` or `blocked` from dependencies), `updateTask`, `cancelTask`, `completeTask` (preconditions: an integrated result, or `reason` with no changes), `listTasks(filter)` | `TASK_TRANSITIONS`; `create_worker` precondition `state === 'pending'` | Recomputes `blocked/pending` from dependencies on open | Kept |
| Dependency | `addDependency` (refused if the task has an active or queued attempt; cycle check by DFS over `dependencies`), `removeDependency` | DAG check | — | With task |
| Attempt | `createAttempt` (state `requested`, then `queued` or `starting` by admission in M3), `setAttemptState`, `setPresence`, `listAttempts` | `WORKER_TRANSITIONS` (spec §7B) incl. `result_available`; presence independent | §14 rules (M10) | Kept |
| Result | `recordResult` (from the environment snapshot; `report` bound to the turn), `getResult`, `supersede` | `RESULT_TRANSITIONS` | Rebuilt from environment refs if a row is missing | Kept |
| Run event | `appendRunEvent` (inside the same transaction as each change), `runEvents(runId, afterId, limit)` | Kind allow-list | — | 90 days after the run ends |

### 5.3 Blocked task vs capacity-queued attempt (explicit)

- A task with unmet dependencies is `blocked` and **has no attempt row**.
- `requestWorker(taskId)` (the M2 core of `create_worker`) checks `task.state === 'pending'` and refuses `TASK_BLOCKED` otherwise. Only then does it create an attempt in `requested`.
- When a dependency is met, `onTaskIntegrated` moves dependents `blocked → pending` and appends `task.unblocked`. **It creates nothing else.** A unit test asserts that the attempts table is unchanged.
- `queued` is an attempt state, set only by admission (M3) on an existing `requested` attempt.

### 5.4 Tests (M2)

`tests/orchestration-model.test.mjs`:
- every allowed and refused transition;
- cycle refusal; adding a dependency to a task with an active attempt is refused;
- blocked → `TASK_BLOCKED`; unblock creates no attempt;
- `get_run` reconstruction;
- migration 9 on a database copied from an existing fixture, with sessions, workspaces, environments and memory intact (extend the `storage-worker.test.mjs` pattern);
- all store methods listed in `STORE_METHODS`.

## 6. M3 — Capacity manager

New `src/runtime/capacity.mjs` (`CapacityManager`) in the runtime process, persisting through the store.

### 6.1 Parts

1. **Sampling layer:**
   - `src/runtime/probes/macos.mjs`: `vm_stat` (pages free, inactive, speculative × page size), `sysctl -n kern.memorystatus_vm_pressure_level`, `os.loadavg()`, `os.cpus().length`, `fs.statfs(dataDir)` for disk;
   - `src/runtime/probes/generic.mjs`: an `os.freemem()` fallback, no pressure;
   - every 5 s and at each decision; samples ring-buffered into `capacity_samples` (24 h).
   - Probes are injected for tests (constructor option, like `TerminalManager`'s `table`/`identify`).
2. **Footprint measurement:**
   - extend `processTable()` in `src/core/process.mjs` to read RSS: today it runs `ps -A -ww -o pid= -o ppid= -o pgid= -o lstart= -o command=`; add `-o rss=` before `command=` and parse it;
   - per live session, sum the RSS of the provider process tree from `descendants(table, pid)`. That tree includes the ToolServer, which the provider spawns as an MCP stdio child.
   - Add the per-session Journal overhead constant for runtime bookkeeping: the PTY, the observer buffer and hook launcher runs. It is measured once in a benchmark and set conservatively (e.g. 40 MB) until then.
   - `estimatedSessionFootprint(provider, mode)` = the rolling median of measured trees + overhead, or the conservative defaults (Claude 1.2 GB, Codex 0.8 GB, Cursor 1.0 GB; to calibrate) before 3 samples exist.
   - A worker whose tree grows (dev servers) updates its own current footprint, used for "launches in cool-down" and for available memory.
3. **Admission** (`admit(request)`): the gates of spec §11.2 in order. It returns `{ verdict, reasons[], estimate }`. It is pure over (state, samples, config), so it is unit-testable.
4. **Durable queue:**
   - attempts in `queued` with `admission.queuedAt`, priority and run id; the order is round-robin across runs, then priority, then age;
   - `reevaluate()` runs on session exit, on presence changes, on a settled launch, when pressure drops, and every 15 s;
   - it admits at most one launch per pacing window.
5. **Cool-down:** a launched attempt stays "launching" for 10 s or until its first footprint sample, counting its estimate against memory.
6. **Back-off:** a spawn failure with a resource code (`ENOMEM`, `EAGAIN`, `EMFILE`), or an exit within 5 s of launch with no hook event, starts an exponential back-off (15 s → 4 min). It is recorded as `capacity.backoff`.
7. **Port reservations:** reuse `allocatePortBlock`. Admission checks that a block is free; the environment is created at admission, which reserves it (the existing `creating` serialization in `Environments.create` prevents duplicates).
8. **Automatic start of queued attempts:** on admission, call WorkerManager's `launchAdmitted(attemptId)`, which creates the environment and starts the session (M5). Before M5, a test hook stands in for it.
9. **Restart and recovery:**
   - the queue is durable;
   - on runtime start, `launching` attempts whose session record exists become `starting/working` (from the session), and those without one go back to `queued`;
   - back-off state is not persisted, so a restart starts clean, with pacing still applied.

### 6.2 Migrating away from `MAX_SESSIONS = 4`

1. **M3a:**
   - introduce `maxLiveSessions` (setting, default **4**: unchanged behaviour) and route `TerminalManager.freeSlot()` through `CapacityManager.staticCap()`;
   - keep slot numbers 1..n (the slot field is used by the UI);
   - the UI reads the cap from `bootstrap` instead of the constants in `App.tsx`, `Sidebar.tsx` and `copy.ts`, and `slotsUsed` in `tests/support/ui.ts` takes the cap;
   - the meter shows n dots;
   - no other behaviour changes, so all existing tests pass with 4.
2. **M3b:** add the memory, pressure, load, disk and port gates for **orchestrated worker launches only**. A user's own Start keeps today's behaviour: the static cap only, plus a non-blocking warning when memory is low.
3. **M3c:** raise the default `maxLiveSessions` to 6 (hard ceiling 12), configurable in Settings. Ship M3c only after M3b's gates are validated on real machines.

### 6.3 Tests

`tests/capacity.test.mjs`:
- each gate with injected probes;
- 5 requested → 3 admitted, 2 queued with reasons;
- re-evaluation starts queued attempts in fair order;
- **a blocked task never enters the queue**;
- no kills;
- the footprint includes the ToolServer and the overhead; measured values replace defaults;
- hysteresis; pacing; back-off;
- **concurrent admission race:** two `admit` calls in the same tick reserve distinct slots and port blocks;
- restart: `launching` without a session → `queued`.

`terminal.test.mjs`: `freeSlot` with caps 4 and 6.

## 7. M4 — Message engine

### 7.1 Parts

1. **Durable messages** (`src/core/orchestration/messages.mjs`): `queueMessage`, `nextBatch(recipient)`, `markDelivering`, `markDelivered(turnStartAt)`, `markUncertain`, `ack`, `hold`/`release`, `cancel`. A message renders deterministically with its id (§12.3).
2. **Coordinator digests:**
   - built from `run_events` since the coordinator's last delivered digest, filtered by the run's subscriptions (default kinds in spec §9);
   - coalesced: one digest per 10 s at most;
   - stored as a message (`kind: digest`), so delivery, deduplication and `uncertain` work the same way.
3. **Idle delivery** (`src/runtime/delivery.mjs`, used by `TerminalManager`):
   - `deliver(sessionId, text)` reuses `paste()`'s guards: Claude, or Codex with turns and approvals observed; `observation === 'live'`; `activity === 'idle'` for at least `IDLE_SETTLE_MS`; no `entry.pending`; not `stopping`;
   - it then writes the bracketed-paste text plus `\r`;
   - it is triggered on `turn-settled` (M1) when a batch is queued, and when a message is queued for an idle recipient.
4. **Stop-hook continuation:**
   - **`src/runtime/observers.mjs`:** the launcher may print the script's stdout **only** for the `Stop` event and only when the script printed a line that begins with `{"journalContinuation":`. In every other case its behaviour is unchanged (exit 0, the neutral response). Launcher tests cover both.
   - **`src/desktop/hook.mjs`:** for `Stop`, before appending the event, connect to the runtime socket with `JOURNAL_HOOK_TOKEN`; call `takeContinuation(sessionId)`, which returns the rendered batch or null within 800 ms; print the provider-specific JSON (Claude `{"decision":"block","reason":…}`, Codex's documented equivalent) wrapped as above. On a timeout, print nothing.
   - **Runtime:** `takeContinuation` marks the batch `delivering`. The next `turn-start` within 15 s marks it `delivered`; otherwise it becomes `uncertain`.
   - **Adapters:** a `continuation(text)` function per adapter; Cursor's returns null until it is verified natively.
   - **Kill switch:** a `continuation: false` flag per session after one timeout or malformed answer, and a global setting.
5. **Fallback when continuation is unavailable** (Cursor, untrusted Codex hooks, the flag off): idle delivery only. For Cursor, no automatic delivery at all: the message is shown in the worker's view with "Journal can't deliver this automatically; it will be offered when you type into this session". The coordinator is told the worker is not reachable automatically.
6. **Acknowledgement and deduplication:** ids in the text; `ack` tool (M5); a delivered id is never re-pushed automatically; resend is an explicit action that reuses the id.
7. **Held delivery:** presence `paused`/`lost` → `held`. On `resumeWorker` the held batch becomes the resume's first prompt; the launch prompt argument of `buildAgentLaunch` is used for this.
8. **Approval-prompt safety:**
   - never write while `entry.pending.length > 0` or `status === 'waiting'`;
   - re-check right before the write (the same tick);
   - never write into Cursor;
   - frames contain no control characters (validated as in `paste`).
9. **request_result flow:**
   - `requestResult(workerId)` queues a fixed message: "Journal: please verify your task is complete. If it is, call report_result now; if not, continue and call report_result when done."
   - The attempt records `resultRequestedAt` and emits `worker.result_requested`.
   - The next turn end with a report → `ready`; without one → it stays `result_available` and the coordinator is told again.

### 7.2 Tests

- **`tests/messages.test.mjs`:** state machine; batch rendering; digest coalescing; deduplication; `uncertain`; held and released; restart keeps queues.
- **`tests/delivery.test.mjs`:** refuses during a pending approval (including a prompt that arrives between check and write, simulated); refuses for Cursor; refuses when unobserved; writes once per idle period.
- **`tests/hook.test.mjs` (extended):** the Stop continuation through the real launcher and script prints the JSON for Claude and Codex fixtures; a timeout prints nothing; any other event's output is still discarded.
- **Regression:** "approval prompt injection" (a message never answers a prompt), and "message duplicate" (no double delivery after a restart during `delivering`).

## 8. M5 — ToolServer and orchestration tools

### 8.1 Parts

1. **`src/agent-tools/server.mjs`:**
   - an MCP server over stdio (JSON-RPC 2.0, `initialize`, `tools/list`, `tools/call`);
   - small and dependency-free, or using the official MCP SDK only if the dependency audit allows it (decide in the PR);
   - it runs with Electron's Node (`ELECTRON_RUN_AS_NODE`), like the hook script.
2. **`src/agent-tools/cli.mjs`:** `journal <tool> --json '<args>'`, on the same client.
3. **`src/agent-tools/client.mjs`:** connects to the runtime socket (`socketPath(dataDir)`). It authenticates with a **per-launch tool token** (a new one, separate from the hook token) and calls `toolCall({ sessionId, tool, args })`.
4. **Authentication and authorization (runtime → main → store):**
   - the runtime maps token → `{ sessionId, role, runId, attemptId }`, recorded at launch;
   - every tool call is checked: the role allows the tool; IDs in the arguments belong to the caller's run; a worker may act only on its own attempt (report tools) and send only to the coordinator.
5. **Per-launch configuration** (`buildAgentLaunch` and adapters):
   - **Claude:** `--mcp-config <file>` (a per-launch JSON file in the observers folder, mode 0600), and the permission allow-list `mcp__journal__*` in the existing per-launch settings file when the run allows tools without prompts.
   - **Codex:** `-c mcp_servers.journal.command=…` and `-c mcp_servers.journal.env.JOURNAL_TOOL_TOKEN=…`, or an env-file indirection if tokens must not appear in argv. They must not: use an inherited environment variable that the server reads. Verify that Codex passes the parent environment to MCP servers.
   - **Cursor:** through the plugin directory if the CLI loads MCP servers from plugins (to verify). Otherwise no tools, and the worker is one-shot.
6. **Tool sets:**
   - **Coordinator:** `get_run`, `get_capacity`, `create_task`, `update_task`, `cancel_task`, `complete_task`, `list_tasks`, `create_worker(s)`, `get_worker`, `list_workers`, `resume_worker`, `send_message`, `subscribe`, `inbox`, `ack`, `wait_for_events`, `snapshot_worker`, `request_result`, `accept_result`, plus the M7/M8 tools as they land, `record_decision`, `set_policy`, `request_approval`, `finish_run`.
   - **Worker:** `report_progress`, `ask`, `report_blocked`, `report_result`, `inbox`, `ack`, `get_message`.
7. **`report_result`:** validated against spec §13's claim schema (bounded sizes). It is bound to the current turn (`entry.currentTurn`, or the last `turn-start` time) and applied at the turn's settled end (M1 hook) → `ready`.
8. **Threat model (cross-run and cross-role):**
   - a token is tied to one session and one role, has a lifetime equal to the session, and is never written to the repository or to argv;
   - wrong role → `FORBIDDEN`; a foreign run id → `NOT_FOUND`, without revealing that it exists;
   - per-session tool rate limits;
   - a leaked token gives only that session's role in that run;
   - a worker cannot call coordinator tools even when the coordinator's text tells it to.

### 8.2 Tests

`tests/agent-tools.test.mjs` (scripted MCP client against a fixture runtime and store):
- the tools list per role;
- a worker calling `create_worker` → `FORBIDDEN`;
- another run's worker id → `NOT_FOUND`;
- `report_result` bound to the turn;
- the token is not in argv (inspect the launch);
- malformed arguments are refused.

## 9. M5/M6 — Worker spawning

Lifecycle, with the code that owns each step:

1. `create_task` → `tasks.state` = `pending` or `blocked` (M2).
2. Dependency check in `requestWorker`: `TASK_BLOCKED` unless `pending` (M2). **A blocked task cannot launch.**
3. An attempt is created in `requested` with the options. **Queued attempts exist only after this request.**
4. `CapacityManager.admit` (M3) → `queued` (stop here; reasons recorded) or `admitted`.
5. **Only at admission:** `Environments.create({ projectId, logicalBranch: run.logicalBranch, task })` (existing). The environment is never created for a queued attempt.
6. Memory packet: `store.prepareContext(projectId, taskText, { workspaceId: env.id })` (existing; the receipt records the environment).
7. Fixed worker prompt (spec §10), rendered in `src/core/orchestration/prompts.mjs`, with snapshot-tested copy.
8. Launch: main's `startSession({ projectId, provider, task: prompt, workspaceId: env.id, role: 'worker', runId, attemptId, permissionConfig })`, which reaches `TerminalManager.start` with `role` and the tool token (M5).
9. Session binding: `attachEnvironmentSession` (existing), `attempts.currentSessionId`, presence `live`.
10. Events: `worker.admitted`, `worker.started`, then the worker states from hooks.

The coordinator is started in the same way with `role: 'coordinator'`, a run, the checkout as cwd, the user's chosen permission configuration and the coordinator brief (spec §34.4). Main adds a **Coordinate** mode to the composer (M6 UI; M5 provides the IPC `createRun`).

## 10. M6 — GUI hierarchy and Team view

**Projections** (main → renderer):
- `runsTree(projectId)`: runs with their coordinator session, tasks and attempts, plus derived badges. Built in the store from tables, not from events, so a reload is exact.
- `runEvents(runId, afterId)` for the Run Story and live updates; the renderer subscribes through the existing `onEvent` with `{ type: 'run', runId, lastEventId }` and refetches the tree.

**Components:**
- `runTreeModel.ts`: pure, tested like `sidebarModel.ts`. It produces rows (run, worker, task-without-worker) and badges:
  - work states: Working, Idle, Result not reported, Ready, Waiting for you, Waiting for coordinator, Blocked (worker), Conflict, Integrated, Done;
  - Queued (capacity reason);
  - task rows: "Waiting for <task>" (dependency) and "Not started";
  - a presence marker.
- `Sidebar.tsx`: a run row with collapse (state in `localStorage` per run, wrapped in try/catch), nested rows, keyboard Right/Left. Attention badges come only from user decisions (`notify.mjs`).
- `TeamTab.tsx`: Plan, Workers, Results (verified/claim columns), Capacity (`getCapacity`), Approvals (M7), Policy (M7), Run Story. `Inspector.tsx` `TABS` gains `team`, shown only for coordinator sessions.
- `WorkerHeader.tsx`: "Worker of <run> · task · ← Coordinator", the presence marker and Resume.
- `MessageBox.tsx`: send to a worker (queue).
- `src/core/story/run-story.mjs`: fixed titles from run events (spec §23).

**Reload:** the tree and badges come from tables, and the Story from `run_events` since 0. No renderer state is authoritative.

**Tests:**
- `tests/run-tree-model.test.mjs`;
- `tests/run-story.test.mjs`;
- desktop `tests/desktop-orchestration.spec.ts`: nesting, collapse, keyboard, queued markers, result-not-reported badge, attention only for decisions, reload reconstruction.

## 11. M7 — Coordinator-managed integration

- **`src/core/orchestration/gates.mjs`:**
  - `hardGates(preview, attempt, run)` → `{ pass, failures[] }`, from `Environments.preview` fields (`clean`, `unresolved`, `blockedBy`, `busy`, `excluded`, `nested`) plus the attempt's idleness and the run's pause;
  - `guards(preview, task, run.policy)` → `[{ guard, outcome: allow | ask | refuse, detail }]`.
- **`preview_result` tool:** `Environments.preview` + gates + guards + `testsVerified` (from session events: the last test command after the last edit, using the Story's classification).
- **`apply_result({ expect })`:** hard gates → guards → `ask` → an approval row and `APPROVAL_REQUIRED` (the coordinator is told; the user approves in the Team tab, then Journal applies with the same `expect`, or refuses if anything changed) → `Environments.apply` → audit (`integrations` view: requester, gates, guards) → re-preview the other ready attempts (`result.stale` / `conflict.detected`).
- **Ask me before applying:** run policy `integration: 'ask'`, so every coordinator Apply becomes an approval.
- **Manual Apply:** the existing `EnvironmentPanel` path, through the same gates, with requester `user`.
- **Pause:** `pauseRun` blocks `apply_result` (`RUN_PAUSED`).
- **Not in this milestone:** any automatic integration. The spec removed it.

**Tests:** each hard gate refuses with its code; each guard outcome; the coordinator applies without a user click in the default policy; an approval flow; audit rows; a stale preview after another Apply; pause.

## 12. M8 — Dependencies, conflicts, retries, handoffs

- **DAG validation** (M2): exposed as tool errors.
- **`task.unblocked`:**
  - emitted in `onTaskIntegrated` (M7's post-Apply hook) and for `when: 'ready'` on `worker.ready`;
  - added to the digest;
  - **no worker creation:** a regression test asserts no attempt or environment is created.
- **Take-in:** the `take_in(workerId)` tool runs `Environments.updateFromBranch` only when the worker is idle (M1's idle definition). Otherwise it queues and runs on the next `turn-settled` (a deferred action in the attempt body). It always queues a message.
- **Conflict loop:** `resolve_conflict(workerId)` = take-in + a fixed message (files, kinds). After the worker's turn end → snapshot → `unresolved` empty → `conflict.resolved` event. A rounds counter on the attempt adds `repeatedConflict` after 3 rounds.
- **Retry:** `request_retry(taskId, { provider, from })` → a new attempt with `retryOf`; the old one → `retired`. `from: 'environment'` makes it a handoff.
- **Handoff:** the new attempt adopts `environmentId`. It is admitted only when the old attempt's presence is not `live`; the coordinator must stop it first (`INVALID_STATE`).
- **Variants:** `variants: n` creates n `requested` attempts (each admitted separately). `choose_result` marks the others `superseded`.
- **Provenance:** `retryOf`, `handoffFrom`, provider, base and results on each attempt; memory origins carry `attemptId`.

**Tests:** spec §37 #11–13, plus the regressions "dependency-blocked task accidentally starting" and "stale preview".

## 13. M9 — Review

- A review task: `kind: 'review'`, `subjectTaskId`, `dependsOn: [{ subject, when: 'ready' }]` by default (unblocked when the subject is ready; the coordinator still starts the reviewer).
- The reviewer environment is created at the subject's current result commit: `Environments.create` with `base = subject.result.sha`. This needs a small extension: `createNow({ baseCommit })` with a validated commit that belongs to the project.
- The reviewer's mode is `review` (the provider's read-only/plan mode, where available).
- Findings come in the `report_result` claim (`verdict`, `findings[]`), stored as a claim, plus `review.verdict`.
- Coordinator feedback: `send_message(subject, 'review_feedback', …)`. On recheck, the coordinator asks the reviewer to take in the subject's new result. `take_in_result(reviewerId, subjectWorkerId)` is a variant of take-in that merges a result commit instead of the branch.
- Whole-run review: a review task whose subject is the run's branch (the reviewer environment at the branch head).

**Tests:** the review loop with the scripted coordinator; a reviewer cannot apply (role); verdicts are never interpreted by Journal.

## 14. M10 — Recovery

| Crash point | Durable before the side effect | Recovery rule | Idempotency |
| --- | --- | --- | --- |
| Coordinator dies | Run + `coordinatorSessionId` | `coordinator.detached`; digests held; Continue or a new coordinator; `get_run` | Digest ids deduplicate |
| Worker dies | Attempt + presence | Presence `paused`/`lost`; the work state is kept; the result is captured at session end; mid-turn with changes → `result_available` | Snapshot is idempotent |
| Runtime crash | Sessions (existing), deliveries `delivering`, admissions `launching` | `recover()` (existing) + `delivering → uncertain`; `launching` with a session → follow the session, without one → `queued` | Delivery never auto-resends `uncertain` |
| UI reload | — | Projections from tables; events from the last id | — |
| Message delivery | `delivering` row before the write | `uncertain` if no `turn-start`; explicit resend with the same id | Ids in text |
| Capacity admission | `admitted` + reserved slot before environment creation | No environment → create; environment `creating` → existing reconcile | `Environments.create` is serialized; the slot is recomputed |
| Environment creation | Existing intent-first record | Existing `reconcile` (`creating` → `ready`/`failed`) | Existing |
| Apply | Existing durable phases | Existing `reconcile` (`finishLanded`/`rollBack`) | Existing (CAS, `expect`, lock marker) |
| Queue | `queued` rows | Re-evaluated after start | Admission is pure |
| ToolServer | No state | The provider restarts the MCP server; the token stays valid while the session lives | Tool calls with side effects carry a `requestId` and are deduplicated for 10 minutes |
| Approval | `approvals` row before execution | On approval, Journal re-validates (gates, `expect`) before acting | The approval executes at most once |

**Tests:** inject a crash at each point (hooks like `Environments`' `hooks`); the M10 desktop spec closes and reopens the app mid-run.

## 15. Provider-by-provider work

| | Claude Code | Codex | Cursor |
| --- | --- | --- | --- |
| Launch changes | `--mcp-config <file>`; `permissions.allow` for `mcp__journal__*` (opt-in per run) in the existing settings file; permission configuration per run | `-c mcp_servers.journal.*`; hooks as today; permission configuration flags | Plugin dir as today; MCP through the plugin (to verify) |
| Hooks required | Existing set; `Stop` used for continuation | Existing set (≥ 0.131, trusted); `Stop` for continuation | Level 2 for turn ends |
| MCP setup | Documented; **verify** tool prompts and the allow-list | Documented; **verify** env inheritance and the trust prompt | **Unverified** |
| Idle detection | **Verified today** (`Stop`, settle) | **Verified today** with hooks | Only level 2 |
| Permission detection | **Verified today** (`PermissionRequest`) | **Verified today** | **Not available** |
| Safe delivery | Idle write: verified rules; Stop continuation: **must be proven** natively | Same; Codex continuation format **must be proven** | None automatic |
| Resume | **Verified today** (exact ID) | **Verified today** (ID from hook or banner) | **Verified today** |
| Known limitations | Agent teams/subagents inside a worker are just activity | Hooks need trust; older versions lack `Interrupt`/`SessionEnd` | No approvals and no turn start; one-shot worker unless proven |
| Manual validation before shipping | Stop continuation in a real session (text appears as a new turn, no prompt is answered); MCP tools with and without the allow-list; resume with held messages | The same, with trusted hooks; continuation JSON; MCP env | Plugin MCP; `stop` follow-up |

## 16. Tests by milestone

| Milestone | Unit | Core/integration | Desktop (headless) | Fixture changes | Real-provider smoke (manual) |
| --- | --- | --- | --- | --- | --- |
| M1 | environments (live snapshot, Apply while idle, base advance, `NOT_IDLE`), turns (`turn-settled`) | store + runtime fixture | desktop-isolated: two turns, two Applies, terminal alive | Fixture CLI that stays alive and edits on each line typed; the hook helper from desktop-notify moved to `tests/support/hooks.ts` | Claude: two turns, two Applies |
| M2 | orchestration-model (transitions, DAG, blocked vs queued, reconstruction) | Migration on an existing database | — | — | — |
| M3 | capacity (gates, queue, fairness, races, back-off, footprint with ToolServer) | runtime with injected probes | Slot meter with cap n; queued badge (after M6) | Probe injection | Real machine: calibrate footprints |
| M4 | messages, delivery, hook continuation | runtime + hook launcher | Delivery to a fixture agent at idle and at Stop | Fixture agent prints what it receives | Claude/Codex continuation |
| M5 | agent-tools (roles, tokens, `report_result` binding) | Scripted MCP coordinator + fixture workers | Coordinator starts workers; blocked task refused | MCP-capable fixture worker (a script calling tools through the CLI) | Claude coordinator with tools |
| M6 | run-tree-model, run-story | — | desktop-orchestration (nesting, badges, reload) | — | — |
| M7 | gates, guards, approvals | Apply audit | Approve a guard in the Team tab | — | — |
| M8 | dependencies, conflicts, retries | Conflict loop end to end | Conflict sent back and resolved | — | Two real workers, same file |
| M9 | review | Review loop | Reviewer row and verdict | — | Real reviewer |
| M10 | crash points | Restart mid-run | Close and reopen mid-run | — | §19 stage D |

**Regression tests required:**

| Regression | Milestone | Test file |
| --- | --- | --- |
| A dependency-blocked task accidentally starting (via `create_worker`, the queue, or unblocking) | M2, M3, M8 | orchestration-model, capacity |
| A result captured with no `report_result` → `result_available`, never `ready`, never stuck "working" | M2, M5 | orchestration-model, agent-tools |
| A worker continuing after Apply (base advance, `integrated → running`) | M1 | environments |
| Stale preview after another Apply | M1, M7 | environments, gates |
| Concurrent admission races (slots, ports) | M3 | capacity |
| Capacity after restart (`launching` → `queued`) | M3, M10 | capacity |
| No duplicate message after a crash during `delivering` | M4 | messages |
| Approval-prompt injection (a message never answers a prompt) | M4 | delivery |
| A worker cannot call coordinator tools | M5 | agent-tools |
| A worker cannot access another run | M5 | agent-tools |
| A normal worker's brief forbids push, merge, pull requests and branch switching unless `hostingAllowed` | M5 | prompts (snapshot) |
| Text "done" never changes state | M2, M5 | orchestration-model |
| A non-orchestrated Build session is unchanged | every milestone | sessions, desktop-sessions |

Every desktop spec uses `fixtureEnv({ root, bin, extra })`. `tests/isolation.test.mjs` already enforces this. New support helpers (`tests/support/hooks.ts`, `tests/support/mcp.ts`) read no `process.env` other than `JOURNAL_*`.

## 17. Migration and compatibility

- **Additive schema:** migration 9 only creates tables and indexes and extends the event-kind allow-list. Existing rows are untouched. Session bodies without `role` are ordinary sessions.
- **Isolated environments** created before M1 keep working: the new transitions only add paths, and `base` advancement applies only after a new Apply.
- **The four-slot cap** stays 4 until M3c, and is then a setting.
- **Memory:** origins gain optional `runId`/`attemptId`. `withOrigin` ignores missing fields.
- **The runtime protocol** is bumped (`PROTOCOL` 4 → 5) for the new methods. A runtime from an older build keeps its sessions (the existing runtime-switch behaviour). Orchestration features are disabled until the app runs on the new runtime (`OTHER_BUILD` message).
- **A normal Build session** is unchanged in launch arguments, hooks and UI, except M1's Apply-while-idle for isolated sessions.
- **Downgrade:** an older app ignores the new tables. The risk is an older runtime meeting orchestrated sessions; it treats them as normal sessions, and nothing is lost.

## 18. Feature flags and rollout

- **M1:** on for everyone. It is a correctness improvement to an existing feature, with a narrow change.
- **Orchestration (M2+):** behind **Settings → Experimental → Coordinated runs** (off by default), stored in `preferences.json`. The flag hides the Coordinate mode and the run UI; the schema exists regardless (harmless).
- **Stop-hook continuation:** a separate setting, **Deliver messages at turn end** (on when orchestration is on, off otherwise), so it can be disabled alone if a provider changes behaviour. Idle delivery remains.
- **Coordinator-managed Apply during early validation:** run policy default `integration: 'ask'` while experimental; switch the default to coordinator-managed when manual validation (§19 C–E) passes. The user can choose either at any time.
- **M3c (default cap 6):** shipped only after footprint calibration on at least two real machines.
- Flags are removed when the feature leaves experimental. No per-provider flags beyond the adapters' verified/unverified gating.

## 19. Manual validation sequence

Use a real repository (for example Unfiled on a disposable branch), real Claude Code and Codex logins on the user's machine, and the packaged app.

| Stage | Steps | Pass criteria |
| --- | --- | --- |
| **A. M1** | One isolated Claude session; ask for a small change; wait for its turn to end (do not exit); Apply; ask for a follow-up change; Apply again | The Apply button appears at the turn end; two commits land; the second contains only the follow-up; the terminal stays alive throughout; the checkout stays clean |
| **B. Two workers** | Two isolated sessions on the same branch: independent files, then the same line | Both independent Applies land; the same-line case conflicts with nothing written; Resolve in the session works while alive |
| **C. Coordinator + workers** | Experimental on; start a Claude coordinator: "add three small tests in different areas; one depends on another"; set the cap so only two run | Two workers start, one is queued with a reason; the dependent task is "waiting" with no worker; a worker asks a question and the coordinator answers (message delivered at turn end); a worker becomes ready without exiting; a turn without `report_result` shows "Result not reported" and the coordinator recovers it; the coordinator applies (ask mode: approve); after the dependency integrates the coordinator starts the dependent worker; a review worker runs and the coordinator acts on its verdict |
| **D. Restart** | Close Journal mid-run; reopen | Workers kept running (runtime) or are paused-resumable; queued workers still queued; the coordinator (resumed) answers "what's going on?" correctly from `get_run` |
| **E. Mixed providers** | Claude coordinator + Claude and Codex workers (Codex hooks trusted) | Codex worker readiness, delivery and Apply behave like Claude's; the Codex continuation verified |
| **F. Hosting** | Ask the coordinator to open a draft PR from the integrated branch and report `gh pr checks` | Workers never push; the coordinator's `gh` commands appear in its Story; Journal state is unaffected |

## 20. Pull request strategy

| PR | Scope | Prerequisites | Acceptance | Deliberately not included |
| --- | --- | --- | --- | --- |
| 1 | M1: Ready without exit (environments, `turn-settled`, EnvironmentPanel, copy) | — | §4.2 tests; existing suites green | Any orchestration table |
| 2 | M2: orchestration schema, model, store methods, run events | 1 | §5.4 | Agents, UI, capacity |
| 3 | M3a: configurable cap (default 4), UI reads the cap | 2 | Existing tests pass with cap 4; cap 6 test | New gates |
| 4 | M3b: capacity manager gates, queue, probes, footprints (orchestrated launches only) | 3 | §6.3 | Raising the default cap |
| 5 | M4a: messages + idle delivery + digests + "Send to this session" | 2 | §7.2 without the Stop tests | Stop continuation |
| 6 | M4b: Stop-hook continuation (launcher, hook script, adapters) | 5 | Hook tests; manual Claude check documented | Cursor continuation |
| 7 | M5: ToolServer, CLI, tokens, roles, coordinator/worker tools, worker spawning, Coordinate mode (behind the flag) | 4, 6 | §8.2; scripted coordinator end to end | Gates, review |
| 8 | M6: sidebar tree, Team tab, worker header, Run Story | 7 | §10 tests | Approvals UI (only placeholders) |
| 9 | M7: gates, guards, approvals, pause, audit | 7 | §11 tests | Automatic integration (never) |
| 10 | M8: dependencies, conflicts, retries, handoffs, variants | 9 | §12 tests | Review |
| 11 | M9: review | 10 | §13 tests | PR review tooling (agents use `gh`) |
| 12 | M10: recovery hardening, manual validation report, M3c default cap | 11 | §14 + §19 A–F documented | — |

Each PR is reviewed by a fresh agent, has its own regression tests, and is not merged without the user's go-ahead.

## 21. Risk register

| Risk | Likelihood | Impact | How detected | Mitigation | Fallback |
| --- | --- | --- | --- | --- | --- |
| Stop-hook continuation behaves differently from the docs (ignored, double turn, shown to the user oddly) | Medium | High | M4b manual check; `delivering → uncertain` rates | Narrow launcher change; per-session kill switch | Idle delivery only |
| Codex hook versions (missing events, trust prompts, format changes) | Medium | Medium | `codexEvents(version)`; observation `unobserved` | Version gating (existing) | Worker without automatic readiness |
| Message written into the wrong prompt (an approval appears just before the write) | Low | High | Delivery tests; `turn-start` vs `permission-wait` order in events | Same-tick re-check; settle time; never Cursor | Disable idle delivery; Stop continuation only |
| Stale provider permission state (an approval missed by hooks) | Low | Medium | Observation `lost`; aging | Delivery refuses unless `live` | User notified; delivery held |
| Inaccurate capacity estimates | High (early) | Medium | Samples vs outcomes; resource back-offs | Conservative defaults, measured medians, reserve, pacing | Lower the cap; queue more |
| Queue starvation (one run, or high-priority tasks forever) | Low | Medium | Queue age metrics in `get_capacity` | Round-robin across runs; aging boost | User cancels or reprioritises |
| Session resume failure (native ID or provider change) | Medium | Medium | Resume errors; `lost` presence | Exact-ID checks (existing) | Handoff to a new attempt in the same environment |
| Schema migration problems on user databases | Low | High | Migration tests on copies of real-shape databases; backup before migrate (existing backups) | Additive only; one transaction | Restore from the automatic backup |
| Apply race (branch moved; worker turn started during Apply) | Low | High | CAS, `expect`, `NOT_IDLE` | Existing durable Apply | Refuse; re-preview |
| Coordinator context drift (stale beliefs) | High | Medium | Coordinator claims vs `get_run` | Brief: read state before answering; digests carry facts | User asks; the coordinator re-reads |
| MCP setup failure (provider refuses config, trust prompt, env not passed) | Medium | High | Tool server never initialises; `report_result` never arrives (→ `result_available`) | Per-provider launch tests; manual checks | `accept_result`; CLI fallback through the shell |
| Token leakage through argv or logs | Low | High | Launch inspection tests | Environment only, redaction | Rotate per session |
| Too many prompts for tool calls | Medium | Low | User feedback | Per-run allow-list (opt-in) | Prompts remain |

## 22. Critical path

The shortest path to a meaningful coordinator:

1. **First internal prototype (headless):** M1 + M2 + M4a (idle delivery, digests) + minimal M5 (ToolServer with `get_run`, `create_task`, `create_worker` without capacity gates, using cap 4, `send_message`, `report_result`, `request_result`), plus basic worker spawning. Validated with the scripted fixture coordinator and fixture workers. Capacity gates and Stop continuation are not needed yet.
2. **First UI prototype:** the above + minimal M6 (the nested sidebar rows and the worker header; no Team tab yet) + manual Apply through the existing panel.
3. **First real-agent prototype:** the above + M4b (Stop continuation for Claude) + `apply_result` with hard gates only (a slice of M7), in "ask me before applying" mode. Run §19 C with a Claude coordinator and Claude workers at the default cap.
4. **Production-ready:** all of M3 (capacity), M7 (guards, approvals, audit), M8, M9 and M10, plus §19 A–F passing, flags lifted.

## 23. Decisions still required

**Before M1:**
- None that block it. The spec settles readiness, Apply while idle, base advance and the unobserved-provider fallback. The only copy to confirm is the Apply-panel wording; it can be decided in the PR.

**Before the orchestration prototype:**
1. Accept the Stop-hook continuation as the first hook path that returns a decision (Journal messages only). Recommended: yes, behind its own setting.
2. Journal's tools without provider prompts by default in a run (per-run allow-list). Recommended: yes, shown in the run dialog.
3. One logical branch per run. Recommended: yes for the MVP.
4. The ToolServer implementation: a dependency-free minimal MCP server, or the official SDK (bundle size and audit).
5. Apply authorship in runs. Recommended: the user as author, with `Journal-Run`, `Journal-Task` and `Journal-Worker` trailers (consistent with today's Apply message).

**Can defer:**
- Capacity default values (calibrated during M3, before M3c).
- Guard defaults beyond the spec's proposals.
- Idle reclamation (off by default; decide whether to keep it after M10).
- Cost and token visibility per worker.
- Cursor as an orchestrated worker with tools (after native verification).
- Claude's cross-session inbox socket (only if documented).
- Nested coordinators.
