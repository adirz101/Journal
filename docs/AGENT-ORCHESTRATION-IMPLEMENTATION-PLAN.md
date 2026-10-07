# Agent orchestration: implementation plan

> Current scope, 7 October 2026: the user removed artificial session, active-run and worker ceilings, including saved limits. Resource measurements are advisory and idle agents are never reclaimed automatically. The capacity gates, mandatory pacing and reclamation milestones below are superseded; stable reservations, fair queues, pause, ports and actual launch-failure backoff remain. See [Coordinated runs](COORDINATED-RUNS.md).

> Delivery scope update, 6 October 2026: the user deferred Windows and requested completion of the macOS implementation with a pull request. Windows requirements below remain future work. Native capability gates and the separate M10b acceptance requirements still apply.
> **For agentic workers:** Use the executing-plans skill when implementation is authorized; work task by task with the unchecked acceptance gates below. This document update itself is not implementation authorization.

**Goal:** Deliver the complete hierarchical orchestration capability, in validated stages that share one production architecture.

**Architecture:** Provider sessions own reasoning; Journal owns durable state, immutable results, guarded delivery, admission and integration. Runtime-owned services continue without the desktop, using the existing store and isolated environments. Later capabilities extend these foundations rather than replace a temporary prototype.

**Tech stack:** Existing Electron/React, Node >=24, SQLite, Git, node-pty and provider adapters; evaluate the official MCP SDK before choosing the protocol implementation.

**Spec:** [AGENT-ORCHESTRATION.md](AGENT-ORCHESTRATION.md), including its full-scope staging contract (§35).

Status: **implementation started with the user's authorization on 6 October 2026.** The macOS implementation spans M0–M9 with recovery work throughout; production capability gates and final M10b acceptance remain explicit. See [implementation status](IMPLEMENTATION-STATUS.md#agent-orchestration-implementation-6-october-2026) for exact coverage, validation and remaining gates. The plan derives from [AGENT-ORCHESTRATION](AGENT-ORCHESTRATION.md) (the spec, "§" references below point there) and `main` at 0.1.2-alpha. Each phase names the files, interfaces, migrations, tests and remaining scope.

## Global constraints

- Repository documents and authored text use English; no external product names or copied source.
- Node >=24. Required implementation checks: `npm test`, `npm run check`, `npm run build`; desktop changes additionally require `npm run test:desktop` with Electron-native node-pty.
- Every Electron test/launcher uses `fixtureEnv({ root, bin, extra })`; no real provider executable, login, request or secret in automated checks. Native trials are separate, manual and local.
- Preserve native settings/permissions, exact-ID resume, reviewed evidence and immutable receipts.
- Product platforms are macOS and Windows. Existing fixture CI only; no Linux, scheduled jobs or release expansion.
- UI work follows the user-selected local design skill: keyboard access, clear focus, dense readable state, no decorative keyboard animation, reduced motion and pointer-gated hover.
- Preserve the full capability set. A later stage is required remaining work, not an implicit scope deletion.

## Review focus

Each failure class has an owning milestone and explicit acceptance below:
- Human drafts, permission transitions and partial input: M0/M4.
- Old launch hooks, concurrent tool calls and desktop absence: M1/M2/M5.
- Lost historical result refs and interrupted base advance: M1.
- Unbound test passes, stale review subjects and approval reuse: M7/M9.
- Capacity reservation races and process survival during handoff: M3/M8.

## 1. Implementation principles

Non-negotiable in every phase:

1. **The coordinator decides the workflow.** Journal never advances a workflow on its own: it does not start work, integrate, review, retry or complete anything without a request.
2. **Journal owns deterministic state, safety and resources:** state machines, snapshots, verified evidence, delivery timing, admission, gates, conflict detection, persistence, recovery.
3. **No completion by session exit.** Process lifetime is *presence* (`live`/`paused`/`lost`), separate from work state.
4. **No state from free text.** Only hooks, Git, process facts and tool calls change state. Terminal output and `last_assistant_message` are at most claims shown to the coordinator.
5. **Messages require an operation-specific contract:** a validated adapter, target launch, input ownership and boundary reservation; a quiet timer or Stop alone is insufficient. Never during a pending approval, and never into a terminal whose approvals Journal cannot see (Cursor).
6. **A blocked task is not a queued worker.** Unmet dependencies mean no attempt exists. Only a launch already requested and queued for capacity may start without a new request.
7. **Ready needs an explicit report or acceptance.** A captured result without `report_result` is `result_available` until a current-turn report or `accept_result` for that exact result ID; never `ready` by inference.
8. **Workers integrate through Journal.** A worker's brief forbids push, merge, pull requests and branch switching unless the task has `hostingAllowed`.
9. **Git hosting is shell work.** No pull request, CI or merge subsystem is built.
10. **No real provider accounts in automated tests.** Every spec and helper uses `fixtureEnv` (AGENTS.md, `tests/isolation.test.mjs`). Real logins are for manual validation only.
11. **Additive.** A normal Build, Research or Plan session, and today's single isolated session, keep working exactly as today, apart from the deliberate M1 improvement.
12. **Repository rules:** follow the global constraints above. Basic recovery ships with every stateful milestone; M10 completes system-wide fault coverage rather than introducing persistence late.

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
| Main process | `src/desktop/main.mjs` (IPC `actions`, `startSession`, isolated `start`, `followEnvironment`, `reconcileEnvironments` interval, `removeSession` dialog, notifier) | App orchestration and IPC | Forward run commands; UI and notifications only | **Refactor**: move launch/followEnvironment/reconcile ownership to surviving runtime services |
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
- `src/runtime/delivery.mjs`, `src/runtime/workers.mjs`, `src/runtime/environment-sync.mjs`;
- `src/agent-tools/` (`server.mjs` for MCP over stdio, `cli.mjs`, `client.mjs` for the runtime socket with a token, `tools.mjs` for definitions and role checks);
- `src/core/story/run-story.mjs`;
- in the UI: `src/ui/runTreeModel.ts`, `TeamTab.tsx`, `WorkerHeader.tsx`, `MessageBox.tsx`.

## 3. Staged delivery and milestone dependencies

Milestone IDs describe capabilities, not a mandate to finish all of M3 before M4. Preserve M1–M10's full scope; introduce M0 and explicit sub-milestones. The first useful team is a validation checkpoint, never the declaration that the full product is complete.

```
M0 Contract proof
  → M1 immutable live results + runtime-owned environment lifecycle
  → M2 durable model + operation deduplication
  → M3a fixed-cap admission/queue + M4a durable guarded delivery
  → M5 tools/spawning + essential M6 UI
  → M7 integration + M8a dependencies/conflicts + M9a pinned review
  → first useful team checkpoint
  → M3b/c/d adaptive capacity/caps/reclamation + M4b continuation
     + complete M6 + M8b retries/handoffs/variants + M9b whole-run review
  → M10b complete fault matrix and full-product acceptance

M10a = recovery delivered and tested inside every owning milestone above.
```

| Stage | Deliverable | Exit gate | Still required afterward |
| --- | --- | --- | --- |
| A — Foundations | M0/M1/M2/M3a/M4a with M10a | Identity, immutable refs, human takeover, partial outcomes, cap-4 durable queue, restart cases | First useful team and all later capabilities |
| B — Useful team | M5 + essential M6 + M7 + M8a + M9a | Coordinator + two workers; one dependency, review/fix/recheck, conflict, intervention and desktop restart | Full capacity, variants/handoffs, complete UI/review/continuation |
| C — Full capabilities | Remaining M3/M4/M6/M8/M9 | Milestone tests and provider/platform gates | Final combined validation |
| D — Full acceptance | M10b | Spec §37/§38, native trials and usefulness evidence | Separate release decision |

The cap remains four through Stage B, including coordinator and ordinary sessions. Use the fourth slot or a sequential reviewer. No temporary second state model, unsafe messaging path or special prototype launcher.

### 3.1 M0 — Prove the contracts before enabling dependent paths

**Files:** extend `tests/terminal.test.mjs`, `tests/turns.test.mjs`, `tests/hook.test.mjs`, `tests/environments.test.mjs`; add `tests/delivery.test.mjs` fixtures and isolated support helpers as needed. Record the capability matrix and native evidence in the implementation-status document when trials actually occur; never pre-mark native behavior as verified.

**Interfaces to establish:**
- Boundary identity: `{ sessionId, launchId, turnId, observationGeneration, inputGeneration }`.
- Delivery target: `{ runId, attemptId?, sessionId, launchId }`; ownership `automation | human | uncertain`.
- `qualifyBoundary(sessionId, operation)` → eligible reservation or typed held/refused reason; operations distinguish capture, delivery, Apply and folder mutation.
- Provider capabilities independently gate idle delivery, continuation and live folder mutation. No inferred universal continuation JSON or empty-prompt signal.

- [ ] Add fixture cases for a human draft, delayed/parallel Stop hooks, approval between paste and Enter, late events from an old launch, cancellation and partial input.
- [ ] Add live-result cases for shell/background writes, two captures, a moved target and interruption after landing but before base advance.
- [ ] Run focused fixture checks; document what each can prove. Use Node >=24 and the repository's isolation rules.
- [ ] Separately validate native provider/version/platform contracts only in the authorized local trial. Keep unsupported transports disabled; pull/held messages remain available.
- [ ] Gate M1 live behavior and M4 automatic delivery on the relevant evidence, not solely on 750 ms elapsing.

### 3.2 Implementation cycle for each milestone

- [ ] Add its named failure/regression fixtures; run the focused `node --test tests/<owning-file>.test.mjs` and confirm the new case fails for the intended reason.
- [ ] Implement the stated interface in the owning files, preserving existing behavior outside the approved scope.
- [ ] Run the focused cases, then the required global checks; desktop cases use `npx playwright test tests/<owning-spec>.spec.ts` and the required desktop suite.
- [ ] Inspect the diff, record limitations and native evidence separately, and review before integration. Commit/merge follow the user's approved workflow; this plan does not authorize either.
- [ ] Mark acceptance complete only when the milestone's recovery cases also pass.

## 4. M1 — Ready without exit, with immutable results

Scope: single isolated sessions, using the same result and recovery contracts later used by runs. Apply remains available while a supported session lives; unverified boundaries remain refused.

**Files:** `src/core/environments.mjs`, `src/core/store.mjs` (`originFor`/`withOrigin`), `src/core/terminal.mjs`, `src/runtime/runtime.mjs`, new `src/runtime/environment-sync.mjs`, `src/desktop/main.mjs`, and the existing environment panel/copy.

**Migration:** no orchestration tables are required yet, but this is a persisted-format change, not "no migration risk". Add versioned result history and operation records to isolated workspace JSON; retain backward reads. Backfill the current legacy result/ref where available without inventing lost history. M2 imports these IDs/refs rather than recapturing them.

### 4.1 Interfaces and changes

1. `TerminalManager` emits a qualified boundary candidate with session/launch/turn and generation IDs. Stop plus `IDLE_SETTLE_MS` is a debounce only; approvals, in-flight tools, new input/turn or unknown adapter capability invalidate eligibility.
2. `src/runtime/environment-sync.mjs` owns the per-environment serialized `syncFromSession(session, { boundary })` path through the runtime's StoreClient. Move Main's `followEnvironment` and periodic mutation/reconciliation responsibilities here; Main observes results. Closing Main cannot suppress capture.
3. `Environments.snapshot(id, { boundary })` persists capture intent, allocates a stable resultId and creates a distinct immutable private ref. Record result commit/tree, base and capture identity before publishing completion. Preserve every retained historical ref; a mutable latest pointer is optional compatibility data. Unchanged compatible content is idempotent.
4. Qualify/revalidate capture and store stability evidence. A detected concurrent change produces an invalidated/uncertain capture condition, not readiness. Unknown background writers prevent claims that the captured tree was coherently tested.
5. `preview(id, { resultId })` returns an opaque `expect` token bound to the exact result/tree, target branch/head, environment base, observation generation and applicable policy/evidence versions. `apply(id, { resultId, expect })` revalidates through the same serialized operation path before mutation. Refuse `NOT_IDLE`, `BOUNDARY_UNVERIFIED`, `RESULT_CHANGED` or `BRANCH_MOVED` as appropriate.
6. Keep a durable Apply operation: prepared → landed → base advanced → metadata complete. Record prior/new base, expected target and landed commit. Extend `finishLanded`/`reconcile` so a crash between any two phases resumes once. Advance the base ref with CAS before allowing the next capture/Apply; final metadata/events are idempotent.
7. Add `integrated → running` for follow-up turns, retain previous result/integration history, and preview subsequent work against the applied result as explicit three-way base. Do not assume `--merge-base=<sha>` expresses this operation.
8. Update `withOrigin`: applied status uses the origin's resultId and integration record. Any older Apply in the same environment is insufficient.
9. Keep `updateFromBranch`, abandon and cleanup's no-live-writer restriction until M8 proves folder-mutation eligibility. Skip post-Apply worktree cleanup while live. Normal cleanup retains immutable refs needed by result/review/memory history.
10. UI displays captured result separately from permission to Apply. Show typed refusal/unknown reasons; unsupported providers retain session-end/manual capture without gaining unsupported live Apply.

### 4.2 Acceptance gates

- [ ] `tests/environments.test.mjs`: two turns and two Applies while a supported fixture stays alive; follow-up diff includes only new work and preserves intervening target-branch changes.
- [x] Historical uncommitted snapshots remain reachable after superseding, worktree cleanup and a disposable-repo Git GC.
- [ ] Crash at capture-ref publication and each Apply/base-advance phase; reconstruction preserves IDs and lands exactly once.
- [ ] Stale preview, new turn/input, active approval and changed target refuse before mutation.
- [ ] `tests/terminal.test.mjs`/`tests/turns.test.mjs`: duplicate/late hooks and a continuing Stop cannot manufacture a valid boundary.
- [ ] `tests/storage-worker.test.mjs`: origin for applied result A stays applied; later unapplied B in the same environment stays unapplied; legacy bodies still read.
- [x] Runtime integration fixture with no desktop process captures results and reconciles through its own StoreClient.
- [ ] `tests/desktop-isolated.spec.ts`: capture/Apply/follow-up and unsupported-state copy; terminal alive throughout the supported case.
- [ ] Existing isolated/session tests and required global checks pass; native evidence is recorded separately.

## 5. M2 — Durable orchestration model

New module `src/core/orchestration/` used by `JournalStore` (delegating methods, as with `Environments`). No agents and no UI.

### 5.1 Migration 9 (one transaction; idempotent like the existing steps)

Tables as in spec §32, including durable `orchestration_operations` request identity/outcomes: `runs`, `tasks`, `dependencies`, `attempts` (with `presence` column), `results`, `messages`, `approvals`, `run_events`, `capacity_samples`. Indexes as listed there. The `events` kind allow-list gains `'orchestration'` for session-level rows (worker Story).

### 5.2 Entities

| Entity | Store methods | Transition validation | Recovery | Retention |
| --- | --- | --- | --- | --- |
| Run | `createRun` (intent first: `state: 'creating'`), `getRun`, `listRuns(projectId)`, `setRunState`, `setPolicy` (tighten/loosen split), `pauseRun`/`resumeRun`, `finishRun` | `RUN_TRANSITIONS` in `model.mjs` | Reconcile coordinator launch intent/process identity; absent session row alone does not prove no side effect | Kept; events 90 days after end |
| Task | `createTask` (computes `pending` or `blocked` from dependencies), `updateTask`, `cancelTask`, `completeTask` (preconditions: an integrated result, or `reason` with no changes), `listTasks(filter)` | `TASK_TRANSITIONS`; `create_worker` precondition `state === 'pending'` | Recomputes `blocked/pending` from dependencies on open | Kept |
| Dependency | `addDependency` (refused if the task has an active or queued attempt; cycle check by DFS over `dependencies`), `removeDependency` | DAG check | — | With task |
| Attempt | `createAttempt` (state `requested`, then `queued` or `starting` by admission in M3), `setAttemptState`, `setPresence`, `listAttempts` | `WORKER_TRANSITIONS` (spec §7B) incl. `result_available`; presence independent | §14 rules implemented now (M10a) | Kept |
| Result | `recordResult` (from the environment snapshot; `report` bound to the turn), `getResult`, `supersede` | `RESULT_TRANSITIONS` | Reconcile M1 capture intent + immutable refs; never infer a missing envelope from Git alone | Kept |
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
- all store methods listed in `STORE_METHODS`;
- M1 result-history import preserves result IDs, refs, receipts and applied provenance;
- `accept_result` requires current resultId; pending `ask` during working becomes waiting only after settling; every retry source state has an explicit transition/refusal;
- mutations store requestId + argument hash and their result in durable operation records, with unique caller/request identity; repeated requests return the prior outcome, mismatched arguments refuse;
- late launch events, two concurrent requests and restart reconstruction cannot double-launch or overwrite a newer attempt;
- basic run/attempt/outbox reconciliation is implemented here, not deferred to M10.

## 6. M3 — Capacity manager

New `src/runtime/capacity.mjs` (`CapacityManager`) in the runtime process, persisting through the store.

### 6.1 Full capacity implementation (M3b unless assigned below)

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
   - Defaults and the overhead are provisional calibration inputs, never native measurements. Record unknown platform signals explicitly; Windows uses supported process/disk/memory probes and must not reuse Unix load/ps assumptions.
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
   - on runtime start, reconcile launching attempts against durable launch intent, session, environment and process identity; only a proven not-started request returns to queued. Unknown outcomes stay held for reconciliation;
   - persist the back-off reason/deadline and admission reservations; restart revalidates process identity and pacing rather than clearing repeated-failure protection. Never relaunch solely because a session row is missing when a process/environment side effect may have occurred.

### 6.2 Staging the complete capacity manager

1. **M3a — first-team foundation:** default/global cap stays **4**, including coordinator and ordinary sessions. Implement atomic reservations, durable queued requested launches, cancellation, fair reevaluation and port allocation with restart reconciliation. `getCapacity` reports the static limiting gate honestly. Route `freeSlot()` and orchestration admission through the same reservation owner. The UI reads the configured cap rather than duplicating a constant. No adaptive claims yet.
2. **M3b — adaptive admission:** all memory/pressure/CPU/disk/footprint/back-off gates in §6.1 for orchestrated workers, with injected probes and platform coverage. A manual ordinary Start retains its existing static limit plus a non-blocking resource warning.
3. **M3c — validated higher limits:** implement configurable caps and validate proposed default 6 / hard ceiling 12 only after calibration on at least two machines and supported-platform evidence. Retain 4 if evidence does not support the proposed default; the configurable-cap capability itself remains required.
4. **M3d — optional idle reclamation:** implement spec §11.4's complete eight-condition policy, off by default. A user's explicit per-run enablement is required; verify process identity, result retention, queued messages and exact resume before stopping. No working/waiting worker is stopped to make room.

All four parts remain in the full delivery plan. M3b–d are not prerequisites for the first useful team.

### 6.3 Tests

`tests/capacity.test.mjs`:
- each gate with injected probes;
- 5 requested → 3 admitted, 2 queued with reasons;
- re-evaluation starts queued attempts in fair order;
- **a blocked task never enters the queue**;
- no kills under normal admission; only M3d's explicitly enabled reclamation can stop a qualifying idle worker;
- the footprint includes the ToolServer and the overhead; measured values replace defaults;
- hysteresis; pacing; back-off;
- **concurrent admission race:** two `admit` calls in the same tick reserve distinct slots and port blocks;
- restart: reconcile launch intent, session, process identity and environment; only proven no-spawn intent returns to queued; unknown side effects remain held.
- M3d: each reclamation condition independently refuses; enabled all-pass path stops only the intended idle process and preserves exact resume/result.

`terminal.test.mjs`: `freeSlot` with caps 4 and 6.

## 7. M4 — Durable message engine

**Files:** `src/core/orchestration/messages.mjs`, `src/runtime/delivery.mjs`, `src/core/terminal.mjs`, runtime role endpoints and adapter capability definitions. M4b additionally touches `src/runtime/observers.mjs`, `src/desktop/hook.mjs` and provider adapters.

### 7.1 M4a — required for the first useful team

**Interfaces:**
- `queueMessage(input, { requestId })` → durable messageId.
- `reserveDelivery(messageIds, target, generations)` → deliveryId and rendered bounded batch; records intent before the side effect.
- `recordDelivery(deliveryId, outcome)` where outcome is `staged | submitted | uncertain | not-written`; only proven not-written returns to queued.
- `ack({ messageId, deliveryId?, pullReceipt? })` validates authenticated recipient and launch. A turn-start alone never calls ack.
- `claimInput(sessionId)` / `resumeAutomaticMessages(sessionId)` implement spec §12's explicit ownership handoff; input generations invalidate pending reservations.
- `inbox`/`get_message` provide pull and receipt correlation when push is unsupported.

- [ ] Implement spec §7G's durable states and delivery-attempt history. Interrupted delivering/staged/unacknowledged submitted becomes uncertain; never auto-replay it.
- [ ] Serialize the entire paste/submit operation per launch. Recheck binding, ownership, observer, approval, boundary and cancellation at queue head and before each write. Keep partial-input recovery explicit.
- [ ] Route human writes through ownership before forwarding bytes. Handle a handoff during staged delivery without interleaving or blind Enter. Persist ownership metadata, never keystrokes.
- [ ] Implement bounded state-derived digests (2 KiB UTF-8), coalesced at most every 10 s, with omitted-count and event cursor. Receipt advances the acknowledged cursor; submission does not.
- [ ] Implement held reasons for paused/lost/human/unsupported recipients; validate new launch identity on resume. Never prepend uncertain input to the resume prompt.
- [ ] `request_result` queues the standard instruction; lack of a report remains visible as result_available. Generic message submission does not itself mark an attempt working.
- [ ] Provide visible human/uncertain input state and keyboard-accessible **Resume automatic messages** using existing session controls. Full Team UI follows in M6.

### 7.2 M4b — validated Stop-hook continuation

This capability remains required where supported, but does not block the first team if M4a provides a validated push path. If no push path is validated, do not claim autonomous awareness from a pull-only demonstration.

- [ ] Add a separate scoped hook endpoint; never authenticate a hook as the single desktop client.
- [ ] Use the adapter's M0-validated format only, with an 800 ms runtime-request deadline inside the existing launcher budget. No assumed Codex equivalent.
- [ ] Preserve user hooks/settings and neutral behavior on unsupported/timeout/error. Bound retries/continuations; disable the transport after an ambiguous/malformed response and record uncertainty.
- [ ] Validate parallel/blocking user hooks, cancellation, repeated Stop and receipt correlation. No permission decisions.
- [ ] Enable per provider/version/platform only after a separate native trial; fixture success is necessary but insufficient. Unsupported paths remain explicitly held/pull.

### 7.3 Acceptance gates

- [ ] `tests/messages.test.mjs`: transitions, byte bounds, receipt binding, digest cursor, late ack, explicit resend history and durable restart.
- [ ] `tests/delivery.test.mjs`: human draft, long pause, raw Enter, two senders, approval before/after paste, target replacement, cancellation, partial writes and observation loss; unknown always holds.
- [ ] `tests/hook.test.mjs`: launcher continuation whitelist and neutral fallback; tool/hook client cannot evict desktop or access foreign sessions.
- [ ] Desktop fixture: takeover and explicit handback, queue reasons and partial-input notice with keyboard focus preserved.
- [ ] Runtime-only fixture: delivery/recovery with Main absent.
- [ ] Native M4b behavior recorded separately; no automatic retry of uncertain delivery and no claim of exactly-once execution.

## 8. M5 — ToolServer and orchestration tools

### 8.1 Parts

1. **`src/agent-tools/server.mjs`:**
   - an MCP server over stdio (JSON-RPC 2.0, `initialize`, `tools/list`, `tools/call`);
   - small and dependency-free, or using the official MCP SDK only if the dependency audit allows it (decide in the PR);
   - it runs with Electron's Node (`ELECTRON_RUN_AS_NODE`), like the hook script.
2. **`src/agent-tools/cli.mjs`:** `journal <tool> --json '<args>'`, on the same client.
3. **`src/agent-tools/client.mjs`:** connects to the runtime socket (`socketPath(dataDir)`). It authenticates with a **per-launch tool token** (a new one, separate from the hook token) and calls `toolCall({ sessionId, tool, args })`.
4. **Authentication and authorization (role-scoped runtime endpoint → runtime-owned StoreClient):**
   - the runtime maps token → `{ sessionId, launchId, role, runId, attemptId }`, recorded at launch; tool and hook roles have separate allow-lists from desktop reconnect;
   - every tool call is checked: the role allows the tool; IDs in the arguments belong to the caller's run; a worker may act only on its own attempt (report tools) and send only to the coordinator.
5. **Per-launch configuration** (`buildAgentLaunch` and adapters):
   - **Claude:** `--mcp-config <file>` (a per-launch JSON file in the observers folder, mode 0600), and the permission allow-list `mcp__journal__*` in the existing per-launch settings file when the run allows tools without prompts.
   - **Codex:** `-c mcp_servers.journal.command=…` and `-c mcp_servers.journal.env.JOURNAL_TOOL_TOKEN=…`, or an env-file indirection if tokens must not appear in argv. They must not: use an inherited environment variable that the server reads. Verify that Codex passes the parent environment to MCP servers.
   - **Cursor:** through the plugin directory if the CLI loads MCP servers from plugins (to verify). Otherwise no tools, and the worker is one-shot.
6. **Tool sets:**
   - **Coordinator:** `get_run`, `get_capacity`, `create_task`, `update_task`, `cancel_task`, `complete_task`, `list_tasks`, `create_worker(s)`, `get_worker`, `list_workers`, `resume_worker`, `send_message`, `subscribe`, `inbox`, `ack`, `wait_for_events`, `snapshot_worker`, `request_result`, `accept_result`, plus the M7/M8 tools as they land, `record_decision`, `set_policy`, `request_approval`, `finish_run`.
   - **Worker:** `report_progress`, `ask`, `report_blocked`, `report_result`, `inbox`, `ack`, `get_message`.
7. **`report_result`:** validated against spec §13, bound to explicit launchId/turnId and then the qualified captured result. A timestamp fallback cannot prove identity. Only status done makes a qualified capture ready; other claims preserve partial/blocked/failed outcomes. `accept_result` requires the exact resultId and reason.
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
- malformed arguments are refused;
- concurrent tool connections preserve the desktop connection and per-run subscriptions;
- idempotent launch/report/Apply requests survive runtime restart beyond any short cache window;
- runtime-only scripted coordinator can start a worker and capture its result with Main absent.

## 9. M5/M6 — Worker spawning

Lifecycle, with the code that owns each step:

1. `create_task` → `tasks.state` = `pending` or `blocked` (M2).
2. Dependency check in `requestWorker`: `TASK_BLOCKED` unless `pending` (M2). **A blocked task cannot launch.**
3. An attempt is created in `requested` with the options. **Queued attempts exist only after this request.**
4. `CapacityManager.admit` (M3) → `queued` (stop here; reasons recorded) or `admitted`.
5. **Only at admission:** `Environments.create({ projectId, logicalBranch: run.logicalBranch, task })` (existing). The environment is never created for a queued attempt.
6. Memory packet: `store.prepareContext(projectId, taskText, { workspaceId: env.id })` (existing; the receipt records the environment).
7. Fixed worker prompt (spec §10), rendered in `src/core/orchestration/prompts.mjs`, with snapshot-tested copy.
8. Launch: `WorkerManager.launchAdmitted(attemptId)` in `src/runtime/workers.mjs` loads the durable request, records launch intent and calls `TerminalManager.start` with the environment, prompt, role/run/attempt/launch IDs, permissions and tool token. Extract shared preparation from Main; no dependency on Main being connected. A retry reconciles actual environment/session/process identity before any new spawn.
9. Session binding: `attachEnvironmentSession` (existing), `attempts.currentSessionId`, presence `live`.
10. Events: `worker.admitted`, `worker.started`, then the worker states from hooks.

Persist environment creation and session binding idempotently under the launch operation. If a Git post-checkout hook fails, inspect actual worktree registration/HEAD before retrying; a nonzero command exit can follow a successful checkout.

The coordinator is started in the same way with `role: 'coordinator'`, a run, the checkout as cwd, the user's chosen permission configuration and the coordinator brief (spec §34.4). The desktop adds a **Coordinate** mode to the composer (M6 UI; M5 provides the IPC `createRun`).

## 10. M6 — GUI hierarchy and Team view

**Staging:** Stage B includes Coordinate entry, nested workers, input ownership/held reasons, result/claim display, the approvals/pause controls required by M7 and basic Run Story. Stage C completes all Plan/Workers/Results/Capacity/Policy views and navigation below. These are the same projections/components, not a temporary UI.

Apply the user-selected local design skill before UI implementation. Keep keyboard actions immediate, focus stable under events and terminal load, and attention reserved for decisions. No new animation dependency is required.

| Before | After | Why |
| --- | --- | --- |
| Idle badge suggests input is free | Separate activity, input owner and held reason | Human drafts cannot be inferred from inactivity |
| Ready result obscures delivery outcome | Explicit queued/submitted/uncertain/acknowledged state | Users can resolve partial input without a hidden retry |
| Reload depends on local UI state | Store-derived projection and durable cursor | Reconnect preserves decisions and keyboard context |

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
- **`preview_result({ workerId, resultId })`:** pinned preview + gates/guards + revision-bound checks. Implement a check record in `src/core/orchestration/results.mjs` with resultId/treeOid, command, exit, start/end and execution provenance. An existing hook-observed pass remains a command observation unless a validated immutable-source verification checkout binds it to the result. Mutable-tree before/after equality and "last observed edit" do not suffice. Unbound observations yield unknown, never verified pass.
- **`apply_result({ resultId, expect })`:** opaque preview token pins result/tree, target head/base, policy version and evidence IDs. Approval is for that exact subject and expires on change. Revalidate at mutation and consume the approval once. Then hard gates → guards → `ask` → an approval row and `APPROVAL_REQUIRED` (the coordinator is told; the user approves in the Team tab, then Journal applies with the same `expect`, or refuses if anything changed) → `Environments.apply` → audit (`integrations` view: requester, gates, guards) → re-preview the other ready attempts (`result.stale` / `conflict.detected`).
- **Ask me before applying:** run policy `integration: 'ask'`, so every coordinator Apply becomes an approval.
- **Manual Apply:** the existing `EnvironmentPanel` path, through the same gates, with requester `user`.
- **Pause:** `pauseRun` blocks `apply_result` (`RUN_PAUSED`).
- **Not in this milestone:** any automatic integration. The spec removed it.

**Tests:** each gate and guard; default coordinator Apply and ask policy; changed result/target/policy/evidence expires approval; shell/background changes cannot inherit test success; isolated check provenance; audit; pause; concurrent requests; crash across landing/base advancement. These are Stage B gates, not late hardening.

## 12. M8 — Dependencies, conflicts, retries, handoffs

**M8a (Stage B):** dependencies, unblocking and one complete conflict loop. **M8b (Stage C):** the complete retry, cross-provider handoff and variant workflows below. All are retained full-scope commitments.

- **DAG validation** (M2): exposed as tool errors.
- **`task.unblocked`:**
  - emitted in `onTaskIntegrated` (M7's post-Apply hook) and for `when: 'ready'` on `worker.ready`;
  - added to the digest;
  - **no worker creation:** a regression test asserts no attempt or environment is created.
- **Take-in:** `take_in(workerId)` persists a deferred action and uses the M0 operation-specific folder-mutation boundary. An idle timer alone cannot authorize writes into a live worker folder. Serialize against launch, capture, delivery and human takeover; unknown writers hold the operation. Validate live take-in where supported; otherwise use explicit graceful-stop/exact-resume, with a clear held reason. Completion queues a durable message.
- **Conflict loop:** `resolve_conflict(workerId)` = take-in + a fixed message (files, kinds). After the worker's turn end → snapshot → `unresolved` empty → `conflict.resolved` event. A rounds counter on the attempt adds `repeatedConflict` after 3 rounds.
- **Retry:** implement exactly the allowed source states/refusals in spec §20; retire old and create new attempt in one state transaction with retryOf. Preserve immutable refs and prior integrations. A working/starting/integrating/permission-waiting attempt must first be stopped/settled; queued requests must first be cancelled.
- **Handoff:** the new attempt adopts `environmentId`. It is admitted only when verified process identity proves the previous process tree can no longer write; paused/lost metadata alone is insufficient. The coordinator must stop or resolve surviving processes first (`INVALID_STATE`).
- **Variants:** `variants: n` creates n `requested` attempts (each admitted separately). `choose_result` marks the others `superseded`.
- **Provenance:** `retryOf`, `handoffFrom`, provider, base and results on each attempt; memory origins carry `attemptId`.

**Tests:** spec §37 #11–13, plus the regressions "dependency-blocked task accidentally starting" and "stale preview".

## 13. M9 — Review and complete memory provenance

**M9a (Stage B):** review of a pinned worker result, feedback, owner fix and recheck. **M9b (Stage C):** whole-run review and completion of review/memory/Story presentation. The baseline result-specific memory-origin correction already ships in M1.

- A review task: `kind: 'review'`, `subjectTaskId`, `subjectResultId`, `subjectTreeOid`, `dependsOn: [{ subject, when: 'ready' }]` by default (unblocked when the subject is ready; the coordinator still starts the reviewer).
- The reviewer environment is created at the explicitly selected subject result commit: `Environments.create` with `base = subject.result.sha`. This needs a small extension: `createNow({ baseCommit })` with a validated commit that belongs to the project.
- The reviewer's mode is `review` (the provider's read-only/plan mode, where available).
- Findings come in the report_result claim with the pinned subjectResultId/treeOid, verdict and findings. Store review.verdict as a claim about that exact subject. A new result does not inherit it.
- Coordinator feedback: `send_message(subject, 'review_feedback', …)`. On recheck, the coordinator asks the reviewer to take in the subject's new result. `take_in_result(reviewerId, subjectWorkerId)` is a variant of take-in that merges a result commit instead of the branch.
- Whole-run review pins branch/head at request time; branch movement invalidates freshness.
- Recheck updates the subject only after the operation-specific safe environment refresh and a new review report. Provider plan/read-only mode is an intent where available, not an OS security sandbox.
- Complete run-memory decisions, worker memoryProposals, result-specific origins and review-gated candidate admission; verify receipts remain immutable and unapplied later results do not inherit earlier applied provenance.

**Tests:** scripted review/fix/recheck; verdict on A cannot certify B; whole-run branch head moves; safe refresh refused under a live writer; reviewer cannot Apply by role; verdict remains a claim; memory candidates/receipts/provenance and final Story reconstruct after restart.

## 14. M10 — Recovery delivered throughout, then validated together

**M10a** belongs to the milestone that introduces each side effect. **M10b** is the final combined fault matrix and usefulness trial. Do not postpone these durable records or recovery rules until the last PR.

| Failure point | Persisted intent / identity | Recovery contract | Owner |
| --- | --- | --- | --- |
| Capture/ref publication | ResultId, commit/tree, ref, base, launch/turn | Complete metadata from capture intent; preserve historical refs | M1 |
| Apply/base advance | OperationId, preview subject, old/new base, expected target, landed commit, phase | Reconcile landing then base CAS then metadata/events; never apply twice | M1/M7 |
| Coordinator dies | Run, session/launch, messages and digest cursor | Workers continue; new/resumed coordinator reconstructs; rebind only unattempted inbox items | M2/M5 |
| Worker dies | Attempt/presence/result and pending reports | Retain settled results; reconcile unfinished changes to result_available; no invented readiness | M1/M2 |
| Runtime dies | Launch/delivery operation records | Existing orphan/interrupted recovery; reconcile actual processes; never replay ambiguous input | M2/M4/M5 |
| Desktop absent | Runtime owns all required operations | Launch, capture, tools and queues remain functional; later GUI reconstruction | M1/M5/M6 |
| Paste or continuation interrupted | DeliveryId, target launch, phase | Delivering/staged/unacknowledged submitted → uncertain; explicit resolution/replay only | M4 |
| Launch/admission interrupted | Request identity, reservation, environment/session creation evidence | Discover actual outcome; resume idempotently; only proven no-spawn requests can requeue | M3a/M5 |
| ToolServer restarts or request times out | Caller/requestId, argument hash and outcome retained with run | Retry returns same operation/outcome; mismatch refuses; no 10-minute expiry that allows duplicates | M2/M5 |
| Approval granted before crash | Exact preview/policy/evidence subject and consumed operationId | Revalidate unchanged subject, consume once; otherwise expire | M7 |
| Take-in/handoff/recheck interrupted | Operation intent, prior process identity and pinned source | Reconcile before admitting another writer or refreshing subject | M8/M9 |
| Resource back-off/reclamation | Deadline, reason, reservation, intended idle target | Revalidate state and process identity; never reset into a launch storm | M3b/d |

Tests inject failure before and after each side effect, including process turnover rather than only in-process reload. Use the existing environment hooks pattern. The final desktop drill distinguishes renderer reload, Main exit with keep-running, runtime death and machine-restart simulation. Full native/platform validation is separate from fixture results.

## 15. Provider-by-provider work

| | Claude Code | Codex | Cursor |
| --- | --- | --- | --- |
| Launch changes | `--mcp-config <file>`; `permissions.allow` for `mcp__journal__*` (opt-in per run) in the existing settings file; permission configuration per run | `-c mcp_servers.journal.*`; hooks as today; permission configuration flags | Plugin dir as today; MCP through the plugin (to verify) |
| Hooks required | Existing set; `Stop` used for continuation | Existing set (≥ 0.131, trusted); `Stop` for continuation | Level 2 for turn ends |
| MCP setup | Documented; **verify** tool prompts and the allow-list | Documented; **verify** env inheritance and the trust prompt | **Unverified** |
| Observed idle | Existing hook signal; not proof of empty prompt | Existing signal with trusted hooks | Only level 2 |
| Permission detection | **Verified today** (`PermissionRequest`) | **Verified today** | **Not available** |
| Safe delivery | M0 ownership/adapter contract required; continuation separately proven | Same; no assumed continuation format | None automatic |
| Resume | **Verified today** (exact ID) | **Verified today** (ID from hook or banner) | **Verified today** |
| Known limitations | Agent teams/subagents inside a worker are just activity | Hooks need trust; older versions lack `Interrupt`/`SessionEnd` | No approvals and no turn start; one-shot worker unless proven |
| Manual validation before shipping | Stop continuation in a real session (text appears as a new turn, no prompt is answered); MCP tools with and without the allow-list; resume with held messages | The same, with trusted hooks; continuation JSON; MCP env | Plugin MCP; `stop` follow-up |

## 16. Tests by milestone

| Milestone | Unit | Core/integration | Desktop (headless) | Fixture changes | Real-provider smoke (manual) |
| --- | --- | --- | --- | --- | --- |
| M1 | environments (live snapshot, Apply while idle, base advance, `NOT_IDLE`), turns (`turn-settled`) | store + runtime fixture | desktop-isolated: two turns, two Applies, terminal alive | Fixture CLI that stays alive and edits on each line typed; the hook helper from desktop-notify moved to `tests/support/hooks.ts` | Claude: two turns, two Applies |
| M2 | orchestration-model (transitions, DAG, blocked vs queued, reconstruction) | Migration on an existing database | — | — | — |
| M3a/b/c/d | fixed-cap durable queue first; then gates, fairness, races, back-off, footprints and opt-in reclamation | runtime with injected probes | Slot meter with cap n; queued badge (after M6) | Probe injection | Real machine: calibrate footprints |
| M4a/b | ownership, partial outcomes, messages, delivery; continuation separately | runtime + hook launcher | Delivery to a fixture agent at idle and at Stop | Fixture agent prints what it receives | Claude/Codex continuation |
| M5 | agent-tools (roles, tokens, `report_result` binding) | Scripted MCP coordinator + fixture workers | Coordinator starts workers; blocked task refused | MCP-capable fixture worker (a script calling tools through the CLI) | Claude coordinator with tools |
| M6 | run-tree-model, run-story | — | desktop-orchestration (nesting, badges, reload) | — | — |
| M7 | gates, guards, approvals | Apply audit | Approve a guard in the Team tab | — | — |
| M8 | dependencies, conflicts, retries | Conflict loop end to end | Conflict sent back and resolved | — | Two real workers, same file |
| M9 | review | Review loop | Reviewer row and verdict | — | Real reviewer |
| M10a/b | Owned crash points tested with every milestone / combined fault matrix at the end | Desktop absent, runtime death and restart | Separate renderer/Main/runtime drills | — | §19 stage D |

**Regression tests required:**

| Regression | Milestone | Test file |
| --- | --- | --- |
| A dependency-blocked task accidentally starting (via `create_worker`, the queue, or unblocking) | M2, M3, M8 | orchestration-model, capacity |
| A result captured with no `report_result` → `result_available`, never `ready`, never stuck "working" | M2, M5 | orchestration-model, agent-tools |
| A worker continuing after Apply (base advance, `integrated → running`) | M1 | environments |
| Stale preview after another Apply | M1, M7 | environments, gates |
| Concurrent admission races (slots, ports) | M3 | capacity |
| Capacity after restart reconciles actual launch outcome before requeueing | M3, M10 | capacity |
| No automatic replay of an uncertain side effect; duplicate logical requests deduplicated | M4 | messages |
| Approval-prompt injection (a message never answers a prompt) | M4 | delivery |
| A worker cannot call coordinator tools | M5 | agent-tools |
| A worker cannot access another run | M5 | agent-tools |
| A normal worker's brief forbids push, merge, pull requests and branch switching unless `hostingAllowed` | M5 | prompts (snapshot) |
| Text "done" never changes state | M2, M5 | orchestration-model |
| A non-orchestrated Build session is unchanged | every milestone | sessions, desktop-sessions |

Every desktop spec uses `fixtureEnv({ root, bin, extra })`. `tests/isolation.test.mjs` already enforces this. New support helpers (`tests/support/hooks.ts`, `tests/support/mcp.ts`) read no `process.env` other than `JOURNAL_*`.

## 17. Migration and compatibility

- **Additive schema:** use the next available migration number (9 against the reviewed baseline), create tables/indexes and extend event kinds. Import M1 result history idempotently; test upgrade on legacy workspace bodies without inventing missing historical results. Session bodies without `role` are ordinary sessions.
- **Isolated environments** created before M1 keep working: the new transitions only add paths, and `base` advancement applies only after a new Apply.
- **The four-slot cap** stays 4 until M3c, and is then a setting.
- **Memory:** origins gain optional runId/attemptId/resultId. withOrigin resolves exact integration records; legacy records retain conservative existing provenance without certifying newer work.
- **The runtime protocol** is bumped (`PROTOCOL` 4 → 5) for the new methods. A runtime from an older build keeps its sessions (the existing runtime-switch behaviour). Orchestration features are disabled until the app runs on the new runtime (`OTHER_BUILD` message).
- **A normal Build session** is unchanged in launch arguments, hooks and UI, except M1's Apply-while-idle for isolated sessions.
- **Downgrade:** table compatibility does not imply workflow compatibility. A runtime lacking these contracts must refuse orchestration mutation/resume and cannot clean up retained result refs. Keep the new runtime attached or require explicit shutdown/recovery; never claim downgrade is lossless without a tested compatibility path.

## 18. Feature flags and rollout

- **M1:** enable supported live operations only after M0 and M1 acceptance. Retain conservative behavior for unknown capability; do not enable from a timer alone.
- **Orchestration (M2+):** behind **Settings → Experimental → Coordinated runs** (off by default), stored in `preferences.json`. The flag hides the Coordinate mode and the run UI; the schema exists regardless (harmless).
- **Stop-hook continuation:** separate setting, off until provider/version/platform native validation. Disable independently on failure. Fallback is a validated idle path or held/pull; never assume idle delivery is safe because continuation was disabled.
- **Coordinator-managed Apply during early validation:** run policy default `integration: 'ask'` while experimental; switch the default to coordinator-managed when manual validation (§19 C–E) passes. The user can choose either at any time.
- **M3c (proposed default cap 6):** adopt the higher default only after footprint calibration on at least two machines and supported-platform validation.
- Removing the experimental UI flag does not remove adapter capability gating or the continuation kill switch.

## 19. Manual validation sequence

For separately authorized manual trials, use a disposable branch in a chosen repository, real Claude Code and Codex logins on the user's machine, and the packaged app. These steps are not automated tests or authorization to run providers now.

| Stage | Steps | Pass criteria |
| --- | --- | --- |
| **A. M1** | One isolated Claude session; ask for a small change; wait for its turn to end (do not exit); Apply; ask for a follow-up change; Apply again | The Apply button appears at the turn end; two commits land; the second contains only the follow-up; the terminal stays alive throughout; the checkout stays clean |
| **B. Two workers** | Two isolated sessions on the same branch: independent files, then the same line | Both independent Applies land; the same-line case conflicts with nothing written; Resolve in the session works while alive |
| **C. Coordinator + workers** | Experimental on; start a Claude coordinator: "add three small tests in different areas; one depends on another"; set the cap so only two run | Two workers start, one is queued with a reason; the dependent task is "waiting" with no worker; a worker asks a question and the coordinator answers (receipt acknowledged through a validated transport); a worker becomes ready without exiting; a turn without `report_result` shows "Result not reported" and the coordinator recovers it; the coordinator applies (ask mode: approve); after the dependency integrates the coordinator starts the dependent worker; a review worker runs and the coordinator acts on its verdict |
| **D. Restart** | Separately reload renderer, close Main with keep-running, and interrupt runtime | With Main absent, tools/launch/capture/delivery still function; runtime death yields explicit uncertain/orphaned states; no duplicate side effect; coordinator reconstructs from get_run |
| **E. Mixed providers** | Claude coordinator + Claude and Codex workers (Codex hooks trusted) | Codex worker readiness, delivery and Apply behave like Claude's; the Codex continuation verified |
| **F. Hosting** | Ask the coordinator to open a draft PR from the integrated branch and report `gh pr checks` | Workers never push; the coordinator's `gh` commands appear in its Story; Journal state is unaffected |

## 20. Pull request strategy and full-scope coverage

PR numbers are sequencing guidance; each has an independently reviewable contract. No implementation, native trial, merge or release is authorized by this document alone.

| PR | Scope | Prerequisites | Required acceptance |
| --- | --- | --- | --- |
| 1 | M0 contract fixtures and capability evidence | Approved implementation scope | §3.1; no unverified path enabled |
| 2 | M1 immutable results, live eligibility, base-advance recovery, runtime lifecycle and provenance | 1 | §4.2 including historical ref retention and Main absent |
| 3 | M2 state machines, schema/import, operation deduplication and M10a reconstruction | 2 | §5.4; complete transition/refusal coverage |
| 4 | M3a cap-4 admission, durable queue, slot/port reservation | 3 | Concurrency/cancellation/restart; blocked tasks never launch |
| 5 | M4a durable delivery, ownership, receipts, digests, pull and minimal input controls | 1, 3 | §7.3; ambiguous side effects never auto-replayed |
| 6 | M5 runtime-owned tools/spawning + essential M6 coordinator/worker navigation | 2, 4, 5 | Scripted team works with Main absent |
| 7 | M7 pinned checks/previews, gates/guards, approvals/pause + required M6 controls | 6 | §11; stale evidence/approval refusal |
| 8 | M8a dependencies and conflict loop + M9a exact-result review | 7 | §12/§13; Stage B useful-team checkpoint |
| 9 | M3b adaptive probes/gates + M3c configurable limits/calibration | 8 | macOS/Windows evidence, injected gates and no launch storm |
| 10 | M3d opt-in idle reclamation | 9 | All eight conditions, process identity, result/receipt preservation |
| 11 | M4b Stop continuation on supported adapters | 1, 5 | Hook coexistence and separate native validation |
| 12 | M8b retries, cross-provider handoffs and variants | 8 | Explicit source states, no simultaneous writers, immutable history |
| 13 | Complete M6 Team/Capacity/Policy/Story and M9b whole-run review/memory | 8, 9, 12 | Full navigation and reconstruction, pinned branch review, reviewed memory |
| 14 | M10b combined failures, mixed-provider/platform and usefulness validation | 9–13 | Spec §37/§38 and §19 A–F with limitations recorded |

**Coverage rule:** M1–M10 remain in scope. Stage B is not completion: PRs 9–14 remain required. The fixed cap is replaced by the adaptive manager through the same admission interface; minimal views grow into the full UI; baseline recovery remains in place. No throwaway prototype branches in production code.

Reviews and integration follow the user's approved execution workflow. Passing an intermediate milestone does not authorize release.

## 21. Risk register

| Risk | Likelihood | Impact | How detected | Mitigation | Fallback |
| --- | --- | --- | --- | --- | --- |
| Stop-hook continuation differs from docs or coexisting hooks | Medium | High | M0/M4b native trials and uncertain outcomes | Capability gate; neutral fallback; kill switch | Validated idle path or held/pull |
| Codex hook versions (missing events, trust prompts, format changes) | Medium | Medium | `codexEvents(version)`; observation `unobserved` | Version gating (existing) | Worker without automatic readiness |
| Human draft or approval races automatic input | Material | High | Ownership/partial-input fixtures; native adapter trials | Serial lane, input ownership and launch/generation revalidation; unknown holds | Disable affected push path, retain pull/explicit handoff |
| Stale provider permission state (an approval missed by hooks) | Low | Medium | Observation `lost`; aging | Delivery refuses unless `live` | User notified; delivery held |
| Inaccurate capacity estimates | High (early) | Medium | Samples vs outcomes; resource back-offs | Conservative defaults, measured medians, reserve, pacing | Lower the cap; queue more |
| Queue starvation (one run, or high-priority tasks forever) | Low | Medium | Queue age metrics in `get_capacity` | Round-robin across runs; aging boost | User cancels or reprioritises |
| Session resume failure (native ID or provider change) | Medium | Medium | Resume errors; `lost` presence | Exact-ID checks (existing) | Handoff to a new attempt in the same environment |
| Schema migration problems on user databases | Low | High | Migration tests on copies of real-shape databases; backup before migrate (existing backups) | Additive only; one transaction | Restore from the automatic backup |
| Apply/base advance interrupted or result/target changed | Material | High | Phase crash injection; pinned preview checks | Immutable result refs, extended durable phases, CAS and serialized owner | Reconcile or refuse; re-preview |
| Coordinator context drift (stale beliefs) | High | Medium | Coordinator claims vs `get_run` | Brief: read state before answering; digests carry facts | User asks; the coordinator re-reads |
| MCP setup failure (provider refuses config, trust prompt, env not passed) | Medium | High | Tool server never initialises; `report_result` never arrives (→ `result_available`) | Per-provider launch tests; manual checks | `accept_result`; CLI fallback through the shell |
| Token leakage through argv or logs | Low | High | Launch inspection tests | Environment only, redaction | Rotate per session |
| Too many prompts for tool calls | Medium | Low | User feedback | Per-run allow-list (opt-in) | Prompts remain |

## 22. Critical path

1. **Prove the contracts:** M0. Capability failures do not silently relax safety; adapt the delivery mechanism or explicitly retain held/pull behavior.
2. **Build the shared foundations:** M1/M2/M3a/M4a with recovery. Global cap 4, immutable result identity and one runtime-owned command path.
3. **Validate useful coordination:** M5 + essential M6 + M7 + M8a + M9a. One coordinator, two workers, dependency, review, conflict, intervention and restart. This is the first usable subset of the final system.
4. **Complete the full spec:** M3b/c/d, M4b, full M6, M8b, M9b and M10b. Preserve provider/platform gates; document any unsupported capability as remaining work rather than calling the full product finished.

The reason for staging is to validate shared contracts before multiplying their consumers. It does not remove capabilities or require rebuilding the first stage.

## 23. Decisions and evidence required before execution

The full-scope, staged approach is settled by the user. This update does not reopen that decision.

**Before dependent live behavior:** M0 must resolve adapter input handoff, Stop-hook coexistence, capture stability and folder-mutation eligibility. Record provider/version/platform results; unknown is a disabled capability, not a guessed implementation detail.

**Implementation choices to settle in the owning PR:**
- M5: audited MCP SDK versus minimal implementation; token inheritance; tools-without-prompts stays an explicit user run setting preserving native policy.
- M7: Apply authorship/trailers and guard defaults, with revision-bound approval semantics fixed by the spec.
- M3b/c: measured footprint/reserve/load calibration and supported Windows probes; proposed higher default only after evidence.
- M3d: implement optional reclamation off by default with all specified gates.
- M4b: enable each continuation adapter only when its native contract passes; no blocking dependency on an undocumented provider response.

**Outside the current full scope, as before:** nested coordinators, provider cost/token visibility where unsupported, and an undocumented native cross-session inbox transport. These are distinct from required later milestones such as adaptive capacity, variants and full review/UI.

Follow the repository's authorization boundaries when moving from this plan to implementation, native trials, merge or release.
