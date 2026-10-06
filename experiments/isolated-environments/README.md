# Isolated environments: feasibility prototype

**Not shipping code.** A throwaway prototype of [docs/ISOLATED-AGENT-ENVIRONMENTS.md](../../docs/ISOLATED-AGENT-ENVIRONMENTS.md). It runs against temporary Git repositories and fixture worker processes only: no provider CLIs, logins or network. Nothing in `src/` or the app imports it. The one exception runs the other way: its memory test reads Journal's real store.

```sh
node --test experiments/isolated-environments/test/*.test.mjs   # 26 pass, 3 Windows-only skipped elsewhere
node experiments/isolated-environments/bench/bench.mjs          # timings and disk cost
```

## Layout

| File | Role |
| --- | --- |
| `src/environments.mjs` | `EnvironmentManager`: the headless control surface (below) and lifecycle |
| `src/git.mjs` | Git with argument lists, a cleaned environment, Journal's commit identity, worktree listing |
| `src/records.mjs` | Durable record (atomic JSON replace; SQLite in a real implementation), Apply lock |
| `src/ports.mjs` | Port blocks: lowest free block, bind probe, Windows excluded ranges |
| `src/links.mjs` | Find links that Git does not track; delete each as a link (junction-safe) |
| `fixtures/worker.mjs` | Fixture worker: listens on `JOURNAL_PORT`, writes in its folder and `TMPDIR` |
| `test/*.test.mjs` | 29 tests (environments, Apply, cleanup, ports and processes, memory, coordinator, Windows) |
| `bench/bench.mjs` | Timings on a clone of this repository and a 10,000-file repository |

## Control surface

Callers think in workers, tasks, states, results and conflicts. Paths and refs appear only under `details`. Errors carry a `code` to branch on: `NOT_FOUND`, `INVALID_STATE`, `NO_RESULT`, `CONFLICT`, `DIRTY_OVERLAP`, `BRANCH_MOVED`, `LOCKED`, `CHECKOUT_REFUSED`, `UNSAFE_CLEANUP`, `UNSAFE_PATH`, `GIT_TOO_OLD`.

| Method | What a caller gets |
| --- | --- |
| `createEnvironment({ projectId, logicalBranch, sessionId?, task?, base? })` | A `ready` environment from the branch's current commit (or `base`) |
| `getEnvironment(id)`, `listEnvironments(projectId, { states? })` | `{ id, task, state, base, result, conflict, integration, ports, … }` |
| `overview(projectId)` | `running`, `waiting`, `completed`, `failed`, `unapplied`, `conflict`, `integrated`, `cleanable` |
| `markRunning(id, { pid? })`, `markWaiting`, `markStopped`, `markFailed`, `markCompleted` (captures the result) | Explicit, durable lifecycle transitions; invalid ones are refused |
| `snapshotEnvironment(id)` | The result: committed + uncommitted + untracked work, with provenance |
| `previewApply(id)` | `{ clean, conflicts: [{ path, kind }], changes, moved, commitsSince, baseOnBranch, blockedBy, canApply }`; writes nothing |
| `applyEnvironment(id)` | `integrated`, or an error with the reason; never a partial write |
| `updateFromBranch(id)` | The branch brought into the environment, with conflicts left there for its worker |
| `markEnvironmentAbandoned(id)`, `cleanupEnvironment(id)` | Result kept in refs; folder removed only when provably safe, else `cleanup_pending` with the reason |
| `environmentVariables(id)`, `spawnWorker(id, command, args)` | `JOURNAL_ENV_ID`, `JOURNAL_ENV_BASE`, `JOURNAL_LOGICAL_BRANCH`, `JOURNAL_PORT(S)`, `JOURNAL_PORT_COUNT`, `TMPDIR`/`TEMP`/`TMP`, `JOURNAL_ENV_LOG_DIR`; a process group recorded as the environment's |
| `contextRequest(id)`, `provenance(id)` | What the memory store needs: the logical branch, base, environment, session, result, whether it is applied |
| `reconcile()` | After a crash: finish creation, return dead workers to `ready`, finish or roll back an Apply |

States: `creating → ready ⇄ running ⇄ waiting → completed → integrating → integrated → cleanup_pending → removed`. Side branches: `conflict`, `abandoned`, `failed`.

## Results (macOS, Git 2.50, Node 25)

**Tests: 26 passed, 3 skipped (Windows-only).** They cover:
- 3 environments from one branch;
- isolated concurrent writes;
- refs surviving worktree removal and `gc`;
- the result's content and that the worker's index is untouched;
- clean Apply, same file with different lines, same-line conflict, delete/edit conflict;
- a moved branch and a rewritten branch;
- an Apply race: the user's commit is refused through the index lock, and another writer is refused by compare-and-swap;
- unrelated dirty state preserved, overlapping dirty state refused;
- sequential application of two workers, worker commits plus leftovers, and a branch that isn't checked out;
- conflict resolved in the environment;
- crash before and after landing;
- every cleanup refusal, link-safe cleanup, a held-file retry (simulated), and no repository-wide prune;
- unique port blocks, Windows exclusions, two fixture workers side by side;
- memory integration;
- the coordinator scenario.

| | Journal repo (330 files) | Synthetic (10,000 files) |
| --- | --- | --- |
| Create environment | ~100 ms | 0.7–1.2 s |
| Snapshot (first / unchanged) | ~110 / ~50 ms | ~320 / ~240 ms |
| Preview | ~50 ms | ~50 ms |
| Apply (checkout updated) | ~100 ms | ~105 ms |
| Cleanup | ~200 ms | ~1.1 s |
| Disk per environment | 7.8 MB (working files only; objects shared) | 39 MB |

## Windows

Covered by `test/windows.test.mjs`, which is skipped elsewhere:
- short paths inside the data root;
- a directory junction removed as a link with its target kept;
- a file held open with `FileShare.None` by another process gives `cleanup_pending`, and the retry succeeds once it is closed.

**Not run yet:** this machine is macOS, and the brief said not to push. Run it on Windows with `node --test experiments/isolated-environments/test/windows.test.mjs`, or in CI once a branch is pushed.

Also still to validate natively:
- `taskkill /T` process-tree ownership;
- ConPTY;
- port reuse after a kill (TIME_WAIT);
- Defender and indexer locks during cleanup;
- `core.longpaths` with deep trees.

## Missing primitives for a coordinator

Scenario: create workers A, B and C from feature/auth with memory, monitor them, follow up with B, preview A and C, apply A, re-preview C, surface the conflict, keep B running.

`test/coordinator.test.mjs` runs everything the prototype has. These are missing:
1. **launchWorker(environment, task, provider):** start a Journal session in an environment with its memory packet, and get the session ID back.
2. **Task-done signal:** "the worker finished its task" as distinct from "a turn ended". Today, idle or turn-end does not mean done; the coordinator needs a structured completion, from a tool call or a convention.
3. **sendToWorker / follow-up:** deliver a message to a running worker's conversation, safely (never while an approval is open) and auditably. Today Journal only types references, guarded by turn state.
4. **Worker event stream:** subscribe to a worker's state, Story rows, approvals and results, rather than polling `overview`.
5. **Approvals for workers:** route approval prompts to the user, or to a coordinator policy that is never auto-yes. Journal never answers approvals today.
6. **Coordinator identity and permissions:** which session may create, apply or abandon environments. Apply should stay user-confirmed by default.
7. **Memory hooks:**
   - receipts with environment and base fields;
   - the packet selected for the logical branch, not the checkout's;
   - structured proposal provenance;
   - "unapplied" marking on evidence.

   The memory test shows these gaps.
8. **Queue and verification:** an Apply queue per branch, and an optional test run at the merged tree before landing (semantic conflicts).
9. **Limits:** `MAX_SESSIONS = 4` per runtime caps parallel workers.
10. **The coordinator's access path:** a transport such as a CLI or MCP server exposing this surface to an agent, with the same refusals.
