# Isolated agent environments: technical specification

Status: **the macOS MVP is implemented** (`src/core/environments.mjs`; see [IMPLEMENTATION-STATUS](IMPLEMENTATION-STATUS.md#isolated-sessions-macos-mvp)). Windows is not part of this milestone: its findings, tests and risks below stay as documentation. Orchestration (a coordinator agent) is not implemented. The original research status was "do not implement yet" (see [that section](#do-not-implement-yet)). Written 6 October 2026 against `main` at the 0.1.1-alpha line. A feasibility prototype (`experiments/isolated-environments/`) tested this design; [§21](#21-prototype-findings) lists what it confirmed and what it corrected, and the sections below are updated accordingly.

## 1. Executive summary

**Goal.** Several write-capable agents work in parallel on what the user sees as one project and one branch, without overwriting each other's files, killing each other's processes or fighting over ports. All of them share Journal's project memory.

**Recommendation.**
- **One Journal-managed environment per write-capable session.** An environment is:
  - a Git worktree in detached HEAD at a recorded base commit, with Journal-private refs pinning its commits;
  - its own process group and Journal-allocated port block;
  - its own temporary and log folders.
- **One logical branch.** Results come back to it only through an explicit, previewed, serialized **Apply**. Apply is a three-way merge against the environment's base commit, computed first without touching any working tree.
- **Memory is shared and append-only.** Proposals carry the environment's provenance, and conflicting proposals are kept side by side.
- **No containers in the MVP.**

**Is "one logical branch, isolated execution snapshots per agent" sound?** Yes, with four rules:
1. The logical branch is checked out in exactly one place: the user's checkout or one Journal worktree.
2. Only Apply writes to it, one Apply at a time.
3. Every environment records its base commit at creation.
4. Nothing is merged silently.

It is the model one major provider already ships: Codex works in detached-HEAD worktrees with an explicit handoff to the local checkout. It is stronger than coordinating agents in one shared worktree, which cannot prevent two agents writing one file between reads, or one agent's `git checkout`, formatter or test run disturbing another's.

**What this does not isolate.** Sub-agents that a provider starts inside one session (Claude's Agent tool, Codex sub-agents) run in that session's process and folder. Journal cannot place them in separate environments. Providers can do it themselves: Claude Code's `isolation: worktree` creates its own worktrees under `.claude/worktrees/`. Journal's job there is to observe, which the Changes view already does for worktrees inside the project. In this document, "agent" means a Journal session.

## 2. Research findings

Sources: provider documentation, Git documentation, and public documentation of dedicated parallel-agent desktop tools. Product names of the latter are omitted here by project policy. No code was copied; only architecture and behaviour were studied.

| Topic | What mature systems do |
| --- | --- |
| Branch model | Claude Code: a new branch `worktree-<name>` per worktree under `.claude/worktrees/<name>/`, based on the default branch (`worktree.baseRef: "fresh"`) or the current HEAD (`"head"`) ([docs](https://code.claude.com/docs/en/worktrees)). Codex: **detached HEAD** worktrees under `$CODEX_HOME/worktrees`, "so Codex can create several worktrees without polluting your branches" ([docs](https://learn.chatgpt.com/docs/environments/git-worktrees)). Desktop workspace tools: one branch per workspace (for example `agent/<name>`); a branch can be in one workspace only, so the same branch twice needs a derived name. |
| Why detached | Git refuses to check out a branch that another worktree has checked out ([git-worktree](https://git-scm.com/docs/git-worktree)). Several agents "on the same branch" are therefore only possible as detached snapshots or as private branches. |
| Creation | Fresh checkout of tracked files only. Gitignored local files (`.env`) are copied through a `.worktreeinclude` list (both providers). A per-project **setup script** installs dependencies (desktop tools; Codex local environments). |
| Cleanup | Claude Code removes a worktree automatically only when it has no changes, untracked files, unpushed commits or dirty submodules. It prompts otherwise. It **locks** (`git worktree lock`) worktrees while an agent runs, marks the worktrees it created, never sweeps unmarked ones, and releases locks of dead sessions. Codex keeps the 15 most recent managed worktrees and **saves a snapshot before deleting** one. Desktop tools delete on archive, and their docs warn that uncommitted changes are lost. |
| Windows | Claude Code: removing a worktree deletes only links (junctions, directory symlinks) inside it, not their targets (an earlier version deleted targets). It refuses to create worktrees through symlinked paths, and never resumes into a worktree at a network path. |
| Safety checks | Claude Code refuses to adopt a folder whose Git metadata resolves into the main checkout (`.git` file or `core.worktree` pointing back). Otherwise `git reset --hard` there would hit the user's checkout. It also blocks commands that redirect Git into the main checkout (`git -C`, `GIT_DIR`). Filter drivers from the repository config are not run on creation. |
| Ports and env | Desktop tools give each workspace a port base in an environment variable (for example `<TOOL>_PORT`) used by setup and run scripts. None documents enforcement: it is a convention, not a sandbox. |
| Integration | Mostly branch → pull request → merge on the hosting service. Codex additionally moves work between worktree and local checkout ("handoff"), carrying uncommitted changes. No surveyed tool documents automatic conflict resolution. Conflicts surface in normal Git flows. |
| Crash/resume | Claude Code re-enters a session's worktree on resume after verifying it is still a separate checkout. It clears the binding when the folder is gone. Codex restores deleted worktrees from snapshots. |
| Isolation claims | Desktop tools state explicitly that workspace isolation is development isolation, not a security boundary: agents run with the user's permissions. |

**Takeaways for Journal:**
- Detached snapshots plus private refs avoid branch pollution and the one-branch-one-worktree limit.
- Copy-ignored-files and setup scripts are table stakes.
- Locks, markers and "never delete work" cleanup are essential.
- Integration is the gap. Journal can make it its differentiator: previewed, three-way, provenance-tracked, and memory-aware.

## 3. Isolation layers

| Layer | Must be isolated | Can be shared | MVP | Stronger later |
| --- | --- | --- | --- | --- |
| A. Git/filesystem | Working tree, index, HEAD | Object store, refs (namespaced), remote config | Linked worktree per environment, detached at base; private refs `refs/journal/env/<id>/{base,head,result}` | Sparse checkouts for huge repos; copy-on-write clones (APFS `clonefile`, ReFS block clone) for fast `node_modules` |
| B. Processes | Process tree of the agent and everything it spawns | Nothing | Existing PTY process group (POSIX) or ConPTY + `taskkill /T` (Windows); identity-verified survivor cleanup (`src/core/process.mjs`) | Windows Job Objects (needs a native module, already a known gap); cgroups (Linux) |
| C. Ports/network | Listening ports of dev servers | Outbound network | Allocated block per environment in env vars; bind-probed; not enforced | Per-environment loopback alias or network namespace (Linux); containers |
| D. Temp/cache | `TMPDIR`/`TEMP`, build outputs, tool state inside the tree | Content-addressed package caches (npm, pnpm store, Cargo registry, Go module cache) | Per-environment `TMPDIR`/`TEMP`/`TMP`; build outputs live in the worktree already | Per-environment cache dirs where tools are not concurrency-safe; CoW-cloned `node_modules` |
| E. Env/config | Environment variables that name ports, paths, URLs | User's global config, provider logins | Journal adds variables (§9); `.worktreeinclude`-style copy of ignored local files | Per-environment `.env` templating; secrets broker |
| F. Agent session | Conversation, terminal, hooks, receipts | Provider install and login | One Journal session per environment (already: `session.workspaceId`) | Several sessions per environment (sequential hand-over) |
| G. Project memory | Nothing (deliberately shared) | Notes, proposals, receipts, history | Existing store; provenance gains environment and base commit | Branch-of-knowledge views per environment |
| H. Integration | The logical branch is written by Apply only | | Preview with `git merge-tree --write-tree`; Apply one at a time | Queue with automatic verification (tests) before landing |

## 4. Architecture options

| | A. Worktree + temporary branch | B. Worktree, detached at base SHA | C. Full clone per agent | D. Container per agent | E. Shared worktree + locking |
| --- | --- | --- | --- | --- | --- |
| Correctness | High | High | High | Highest | **Low**: no lock covers formatters, `git checkout`, generated files, test databases |
| Complexity | Medium | Medium (private refs to pin commits) | Medium-high (remotes, fetch between clones) | High (images, mounts, credentials, PTY bridging) | Deceptively high |
| Performance | Fast create (no object copy) | Same as A | Slow create, double objects unless `--shared`/`--reference` | Slow start; file sync costs on macOS/Windows | Fastest |
| Disk cost | Working tree only | Working tree only | Full repository each | Image + tree | None |
| Cleanup | `worktree remove` + branch delete | `worktree remove` + ref delete | `rm -rf` (riskier: no Git guard) | Container + volume | None |
| Windows | Good (long paths and file locks need care) | Same as A | Same, plus disk | Poor: Docker Desktop/WSL dependency, Linux-only toolchains | Good |
| Crash recovery | `git worktree list` reconciles | Same; refs survive the worktree | Directory scan | Runtime-dependent | N/A |
| Mental model | Users see extra branches | **Users see one branch; internals hidden** | Confusing remotes | Opaque | Simple but surprising failures |
| Integration | Merge/cherry-pick branches | Three-way from recorded base; commits on private refs | Fetch + merge | Export patch | None needed, but no isolation |
| MVP fit | Possible | **Best** | No | No | No |

**Choice: B.** It keeps branch namespaces clean, allows any number of environments from the same logical branch, and has the fewest moving parts. The trade-off: detached commits are unreferenced and can be garbage-collected after the worktree goes, which is why Journal pins them with private refs (`refs/journal/...` are invisible in `git branch` and never pushed by default). If an agent explicitly creates or switches to a branch inside its environment, that is allowed and recorded (§8.4). It does not change the model.

## 5. Concepts and identifiers

- **Logical branch**: the branch the user chose, for example `feature/auth`. It may be checked out in the user's checkout or in one Journal worktree. Memory scope "this branch" refers to it.
- **Environment**: `{ id, projectId, logicalBranch, base, path, kind: 'isolated', state, sessionId, ports, tmpDir, logDir, createdAt, refs, result, integration }`. Stored like workspaces today (intent first, reconciled from Git).
- **Base**: the logical branch's commit when the environment was created. Pinned at `refs/journal/env/<id>/base`.
- **Result**: an immutable snapshot of the environment's work. It is the commits the agent made plus uncommitted and untracked changes, captured as a commit on `refs/journal/env/<id>/result` (§8.1).
- **Integration**: the record of applying a result: preview, outcome, resulting commit on the logical branch, conflicts.

## 6. Lifecycle

```
creating ──► ready ──► running ◄──► waiting
   │           │          │
   │           │          ▼
   │           │      completed ──► integrating ──► integrated ──► cleanup_pending ──► (removed)
   │           │          │              │
   │           │          │              ▼
   │           │          │           conflict ──► (resolve in environment) ──► completed
   │           ▼          ▼
   └──────► failed    abandoned ───────────────────────────────► cleanup_pending
```

| State | Meaning | Persisted before | Recovery after a crash |
| --- | --- | --- | --- |
| `creating` | Intent recorded; worktree being added | Any Git side effect | Reconcile: worktree registered at the planned path → `ready`; otherwise → `failed`, partial folder kept for inspection |
| `ready` | Worktree exists at base, ports and folders allocated, setup script done | Session launch | Stays `ready` |
| `running` / `waiting` | A session is live in it (waiting = approval) | Session start | Same as sessions today: `interrupted` or `orphaned`, process identity verified (`TerminalManager.recover`); the environment returns to `ready` with its result still capturable |
| `completed` | The user (or the session's end) marked the work done; result snapshot taken | Snapshot ref written | Idempotent: re-snapshot if the ref is missing |
| `integrating` | Apply in progress (one per logical branch, lock held) | Lock row with environment id and logical HEAD before | Lock older than the process is released; the logical branch is checked against the recorded expected commit (§8.3). Never half-applied: Apply ends in one atomic ref update or the working-tree step is re-run from the recorded plan |
| `conflict` | Preview found conflicts; nothing written to the logical branch | Conflict list | Stays |
| `integrated` | Result is on the logical branch; integration commit recorded | Integration record | Stays |
| `abandoned` | User discarded the work (result snapshot kept) | Snapshot | Stays |
| `cleanup_pending` | Worktree to be removed when safe (no process, no lock, result captured) | | Sweep retries; never forces |
| `failed` | Creation or setup failed | Error | Stays until the user retries or forgets it |

Rules:
- An environment never leaves `running` or `waiting` while its process tree is alive.
- Cleanup requires: no live or orphaned session, `git worktree lock` released by Journal, result snapshot captured (or proven empty), and the folder still verified as this environment (§11).
- Removing a worktree never removes the private refs. They are retained for a configurable period (default 30 days), and the result stays restorable (as Codex does with snapshots).

## 7. Filesystem and Git model

- **Location:** outside the user's checkout, under Journal's data folder: `<data>/env/<project-short>/<env-short>/`. Folders are short on purpose for Windows `MAX_PATH`. This avoids the problem fixed in #27: worktrees inside the checkout are invisible to its Git status, and editors index them.
- **Creation:** `git worktree add --detach --lock --reason "journal env <id>" <path> <base>`, after recording intent. Journal writes a marker into the worktree's admin directory (`$GIT_DIR/worktrees/<name>/journal-env` with the id). Cleanup removes only marked worktrees, and Journal unlocks only locks it set.
- **Ignored local files:** copy the files matching the project's `.worktreeinclude` (same semantics the providers use: only files that are gitignored). Show the list in the creation preview; never copy files flagged sensitive by `isSensitivePath` without the user's confirmation.
- **Setup:** an optional per-project setup command runs in the environment with its env vars (§9) as a visible process (like provider installs today). A failure leaves the environment `failed` with the log.
- **No filter drivers on creation** for repositories whose own config defines them (provider precedent: a filter driver is a shell command).
- **Private refs:** `refs/journal/env/<id>/base` at creation, `.../head` updated on every snapshot, `.../result` at completion. They are excluded from push by default (refs outside `refs/heads` and `refs/tags` are not pushed by `git push`).
- **Requirements:** Git ≥ 2.40 for `merge-tree --write-tree --merge-base`, checked at feature start, with a clear message (prototype: Git 2.50). The `extensions.worktreeConfig` setting is not required.

## 8. Integration model

### 8.1 Capturing a result

At completion (or on demand), Journal snapshots the environment without disturbing the agent's index:
1. A temporary index (`GIT_INDEX_FILE`) is filled from the environment's HEAD, then from the working tree including untracked, non-ignored files (`git add -A`).
2. `write-tree`, then `commit-tree` with the environment's HEAD as parent, recorded at `refs/journal/env/<id>/result`.
3. Sensitive paths are listed in the preview and excluded unless the user includes them.

This works whether the agent committed, never committed, or both. The result tree is `base + agent commits + uncommitted changes`.

### 8.2 Approaches compared

| Approach | Works without agent commits | Logical branch moved | History | Safety | Verdict |
| --- | --- | --- | --- | --- | --- |
| Apply patch (`git apply --3way`) | Yes | Partly (falls back to three-way per file) | One change | Touches the working tree directly | Fallback only |
| Cherry-pick agent commits | No (uncommitted work lost) | Yes, per commit | Preserves the agent's commits | Stops mid-sequence on conflict | Optional "keep the agent's commits" |
| Temporary merge commit | Yes (via result commit) | Yes | Merge bubble per agent | Clean | Optional for teams that like merges |
| Rebase worker result | Yes | Yes | Linear | Rewrites; conflicts mid-way | Used inside the environment to refresh it, not to land |
| **Three-way merge from the recorded base, previewed** | **Yes** | **Yes** | One commit per Apply (message lists the agent's commits) | **Computed in memory first; nothing written on conflict** | **Default** |
| Agent-assisted conflict resolution | | | | Must run in an isolated environment, never on the logical branch | For conflicts (§9) |

### 8.3 Default Apply

1. **Freshness check:** read the logical branch's current commit `L`. Count the commits since the base (`base..L`), and show them with their authors ("feature/auth moved 3 commits since Agent B started").
2. **Preview:** `git merge-tree --write-tree --merge-base=<base> L <result>`.
   - Clean → a tree `T` and the list of changed paths.
   - Conflicts → the conflicted paths with their kind (content, modify/delete, rename/rename, binary). Nothing is written.
3. **Checkout guard:** where the logical branch is checked out, the working tree must not have uncommitted changes in any path `T` changes relative to `L`. Unrelated uncommitted changes are allowed and preserved. Overlap → refuse with the list ("Your uncommitted changes to a.ts would be overwritten").
4. **Land** (corrected by the prototype: the order matters):
   1. Create commit `C = commit-tree T -p L`. The message carries the task, agent, environment, base and result.
   2. Record the plan durably.
   3. Take the checkout's own `index.lock`, the lock Git itself uses. From then on, a `git commit` in the checkout fails cleanly instead of capturing half-applied files.
   4. Copy the index to a side file and run `git read-tree -m -u L C` against that side index. This updates exactly the changed files and keeps unrelated staged, unstaged and untracked work.
   5. Move the branch with a compare-and-swap, `git update-ref refs/heads/<logical> C L`. It fails if anything moved the branch meanwhile.
   6. On success, rename the side index into place through `index.lock`. On failure, run `read-tree -m -u C L` with the side index to put the files back and drop the lock; the real index never changed.

   Updating the files and index first and the ref second lets a concurrent `git commit` in the checkout capture the half-applied change; the prototype's race test showed it. Moving the ref first leaves a window in which a commit would revert the agent's change. Holding the index lock closes both windows.
5. **Record** the integration (environment → `integrated`, `C`), audit entry, Story event, and receipts/memory provenance (§10).
6. **One Apply at a time per logical branch** (a lock row in the store).

**Options:**
- "Keep the agent's commits": cherry-pick sequence, falling back to the default on conflict.
- "Apply as uncommitted changes": checkout only, no commit. It is for users who want to edit before committing, and is allowed only when the checkout guard passes.

### 8.4 Agents that create branches

If the agent ran `git switch -c x` in its environment, Journal records it. The result is still captured from the environment's HEAD, and integration is unchanged. The branch stays, as the agent's own.

### 8.5 Stale work

An environment is stale when its base is not an ancestor of the current logical commit (the branch was rewritten), or when commits were added since the base. Stale is shown, not blocking:
- Added commits → the three-way preview handles them.
- Rewritten history (force-push, rebase of the logical branch) → the preview still uses the recorded base. Journal warns that the base is no longer on the branch and offers **Update from branch** (§9.2) before Apply.

## 9. Conflict handling

No silent overwrites in any case.

| Situation | Behaviour |
| --- | --- |
| Two agents, different files | Each previews clean; Applies land one after the other (the second's preview recomputed against the new `L`) |
| Same file, different lines | Three-way merge resolves it in memory; the preview shows "merged with Agent A's change in the same file" |
| Same lines | Conflict; nothing written; options below |
| Delete vs edit | Modify/delete conflict; listed with which side deleted |
| Logical branch moved after start | Freshness note; three-way preview; conflict only where it really overlaps |
| User edits the logical checkout during agent work | Committed edits behave like "branch moved". Uncommitted edits hit the checkout guard only if they overlap; otherwise preserved |
| Worker made commits | Included in the result; optional "keep commits" |
| Worker left uncommitted changes | Included via the snapshot (§8.1) |
| Clean merge that breaks behaviour (semantic conflict) | Not detectable by Git. **Verify** runs the project's test command in a verification environment at `T` before landing (optional in the MVP, default later) |

### 9.1 Resolving a conflict

- **Resolve in the environment** (default): Journal creates the merged state inside the agent's environment. It merges `L` into the environment, leaving conflict markers there, not in the user's checkout. The prototype showed that `git merge` refuses while the worker has uncommitted edits. So the environment's result commit first becomes its HEAD: the worker's uncommitted work becomes a commit and the worker's index is reset to it; nothing is lost. The same or a fresh agent session resolves it with a prompt that names the conflicted paths. The result is re-snapshotted, and Apply previews again.
- **Open in editor:** show both sides and the base for each path.
- **Keep unapplied:** the environment stays `conflict`, and its result stays restorable.

### 9.2 Update from branch

This moves an environment's base forward without landing anything: three-way merge of `L` into the environment, then the base ref moves to `L` and the next preview uses it. It is useful for long-running agents.

## 10. Shared memory

The memory store is already shared and append-only by design:
- notes have revisions;
- `candidate` → `active` needs the user;
- `supersedes` links replace one note with another;
- receipts are immutable;
- proposals are deduplicated by fingerprint;
- branch-scoped notes are bound to a branch.

What changes:
- **Startup:** each environment's session gets the same context packet a session gets today, selected for the **logical branch** (branch-scoped notes use the logical branch, never a private ref or detached HEAD). The receipt records the environment id and base commit.
- **Proposals:** a note proposed in an environment records `{ sessionId, environmentId, base, resultRef }` in its source.
  - **File evidence** points at the result commit and path, not at the environment folder (which will be removed).
  - **Before Apply:** such evidence is marked "from unapplied work", so it is never checked against the logical branch's files until applied.
  - **After Apply:** it is rebased to the integration commit.
  - **Abandoned environment:** its candidates are flagged and offered for dismissal.
- **Concurrent proposals:** two candidates on the same subject, for example the same file area with different statements, are both kept. They are linked as "conflicting candidates" and shown together in the review. Remembering one does not delete the other: the user chooses, or remembers both with scopes. No last-writer-wins.
- **Edits to active notes from environments:** always proposals (supersede candidates), never in-place edits. This is already the rule.
- **Concurrent remembers:** the store's single writer (store worker) serializes them. A supersede of a revision that changed meanwhile is refused with "this note changed; review again" (same rule as today's revision checks).

## 11. Process, port and folder ownership

- **Ownership record:** the environment record holds `{ sessionId, pid, processIdentity, pgid }` from the session that runs in it. `TerminalManager` already starts each PTY as its own process group (POSIX) and verifies identity before signalling (`signalVerified`, survivors). Signals go to that group or verified PIDs only, so one environment can never signal another's processes.
- **Ports:** Journal allocates a block of 10 ports per environment from a reserved range (default 42000–45999), persisted with the environment. Before allocation it bind-probes each port on `127.0.0.1` and `::1`. It skips ports in Windows' excluded ranges (`netsh int ipv4 show excludedportrange protocol=tcp`, read once). The environment variables are `JOURNAL_PORT` (first), `JOURNAL_PORT_COUNT` (10) and `JOURNAL_PORTS` (comma list). Journal never sets `PORT` globally; the setup script or the agent maps it. Ports are released at cleanup. Allocation is advisory: Journal can show which listening ports belong to an environment's process tree (`lsof`/`netstat` mapped to the tree) but does not block others.
- **Temp, logs and other variables:**
  - `TMPDIR`/`TEMP`/`TMP` = `<data>/env/<p>/<e>.tmp/`;
  - setup and run logs under `<data>/env/<p>/<e>.log/`;
  - `JOURNAL_ENV_ID`, `JOURNAL_ENV_BASE` and `JOURNAL_LOGICAL_BRANCH` are set for scripts.
- **After a Journal crash:** the runtime survives app crashes by design (sessions keep running). After a runtime crash, `recover()` marks sessions `interrupted` or `orphaned` by process identity. Environments follow their session, and an `orphaned` session's environment is never cleaned up. On restart, Journal reconciles environments with `git worktree list --porcelain`, its markers, and its own locks.
- **Cleanup safety** (all must hold, else `cleanup_pending` with the reason):
  1. The path is inside `<data>/env/`, reached without symlinks (realpath under the root).
  2. Git lists it as a linked worktree of this project's repository, its admin directory has Journal's marker with this id, and its `.git` file resolves to that admin directory, not to the main checkout.
  3. No live or orphaned process has its cwd in it.
  4. The result is captured.
  5. Removal never uses `--force`. HEAD and the index are pointed at the captured result, whose tree equals the folder's content, so the worktree is clean. Ignored files such as `node_modules` do not block `git worktree remove`; untracked ones would, and this step makes them tracked. Then `git worktree remove`. If anything changed after the check, Git refuses and the environment stays `cleanup_pending`.
     - Links that Git does not track (inside ignored folders) are deleted as links first: unlink, or `rmdir` for a Windows junction. Tracked links are left to Git.
     - A folder already deleted by hand: remove only this environment's own admin entry (identified by its marker). Never run a repository-wide `git worktree prune`, which would also drop other missing worktrees, such as one on an unmounted drive.
  6. Imported or user-created worktrees are never removed.

## 12. Windows considerations

- **Paths:**
  - Short environment roots; `core.longpaths=true` set per worktree only if the user's Git supports it. Journal never changes global config.
  - Refuse UNC/network roots, as one provider does.
  - Paths are case-insensitive: compare realpaths case-insensitively.
- **Links:**
  - `node_modules` from pnpm and others use junctions. Removal must delete junctions as links, never their targets (a provider shipped exactly this bug once).
  - Symlink creation needs Developer Mode or elevation, so `.worktreeinclude` copies files and never links.
- **Git:**
  - New worktrees inherit `core.autocrlf`; diffs and result snapshots must use the same settings.
  - The Changes view already normalizes line endings in tests.
- **Processes:**
  - Process groups do not exist. Today's tree kill is `taskkill /T` with a ConPTY close.
  - Job Objects are the reliable way to own a tree, but they need a native module; this is the known blocker in [WINDOWS.md](WINDOWS.md).
  - The MVP uses `taskkill /T` plus survivor scans, and documents that grandchildren that detach may survive.
- **Ports:**
  - Hyper-V/WSL excluded port ranges.
  - `SO_EXCLUSIVEADDRUSE` differences; TIME_WAIT after kill.
  - Re-probe ports at each launch.
- **File locking:**
  - Antivirus (Defender), the search indexer and editors hold files open, so removal can fail with EBUSY/EPERM. Retry with backoff, then stay `cleanup_pending` and surface it.
  - Recommend a Dev Drive for the data folder (Defender performance mode) in docs, not in code.
- **Temp:** `TEMP`/`TMP` must be absolute, short and on the same volume as the environment for tools that rename across folders.
- **Shells:** setup commands run through the same shell resolution as hooks (PowerShell or cmd). Keep the documented rule that paths with spaces are not used unquoted.

## 13. Security and safety

| Risk | Control |
| --- | --- |
| Path traversal in environment paths | Paths are generated, never taken from the renderer; realpath containment under `<data>/env/` |
| Deleting the wrong worktree | Marker + Git registration + `.git` resolution checks (§11); never `--force` without the user; never delete imported or unmarked worktrees |
| Worktree whose metadata points into the main checkout | Refuse adoption (provider precedent): verify `git rev-parse --git-dir` and `--show-toplevel` from inside the environment |
| Symlink escape (committed symlink making `.journal` paths point elsewhere) | Environment roots are outside the repository; creation refuses symlinked components |
| Secrets | `.worktreeinclude` copies need confirmation for sensitive names; result snapshots exclude sensitive paths unless included; previews hide their content (existing `isSensitivePath`) |
| Agents editing outside their environment | Not preventable without a sandbox. Journal detects edits recorded outside the environment (hook paths and cwd) and marks the session "worked outside its environment" in the Story. Claude Code's own worktree checks can be used where available. Not a security boundary; documented as such |
| Malicious repository config | No filter drivers or hooks run on creation; setup script only when the user approved it |
| Stale processes | Verified-identity signals only (existing) |
| Crash-safe state | Intent before side effects; refs and records reconciled from Git; Apply guarded by `update-ref` compare-and-swap |

## 14. UX

- **When isolation is on:**
  - New sessions on a project choose **Isolated** (default once the feature ships, for write-capable modes) or **In this checkout** (today's behaviour).
  - Read-only and plan modes always use the checkout; they do not write.
  - The sidebar shows "Agent A · isolated".
  - Internal paths, refs and detached HEAD appear only under **Details**.
- **Files view:**
  - For an isolated session, the Files tab shows the environment's tree (as a worktree root today) and **Changed** shows its result against its base.
  - A header line says "Isolated from feature/auth at abc1234 · feature/auth has moved 2 commits".
- **Apply:**
  - Each completed session shows **Apply to feature/auth…**.
  - The preview lists files, the commit message, freshness and conflicts. Buttons: Apply, Apply as uncommitted changes, Resolve in the environment, Keep for later.
  - Only one Apply runs at a time; others queue.
- **Story:**
  - New fixed rows: "Isolated from feature/auth at abc1234", "Applied to feature/auth (def5678)", "Conflict in 2 files", "Updated from branch".
  - Edits outside the environment appear as a warning row.
- **Conflicts:** a banner on the session ("2 files conflict with changes on feature/auth"), with the paths and their kinds; no markers ever appear in the user's checkout unless they choose to resolve there.
- **Cleanup:** after Apply, the environment is removed automatically once safe. Abandoned results stay restorable for 30 days ("Restore Agent B's work").

## 15. MVP scope (recommended)

**In:**
1. Environment record, intent-first creation, detached worktree at a recorded base outside the checkout, private refs, marker and lock.
2. `.worktreeinclude` copy (with sensitive-file confirmation) and an optional setup command.
3. Per-environment `TMPDIR`, logs, `JOURNAL_PORT*` block, `JOURNAL_ENV_*` variables.
4. Result snapshot (§8.1); Changes and Story per environment.
5. Apply with `merge-tree` preview, checkout guard, compare-and-swap landing, one at a time.
6. Conflict: keep unapplied; resolve in the environment with markers there.
7. Memory provenance (environment id, base, result ref); conflicting candidates kept side by side.
8. Conservative cleanup with all checks; restore from refs.
9. macOS first; Windows with the same model plus short paths, link-safe removal and `taskkill /T`.

**Out (later):**
- Verification environment before landing.
- Keep-commits mode and update-from-branch automation.
- CoW clones, cache isolation, containers.
- Several sessions per environment.

**Validating the initial instinct.** Git worktree per write-capable agent, detached HEAD, known base SHA, process isolation, port allocation, deterministic diffs, explicit integration, shared memory, no containers: all confirmed.

Three changes to it:
- **Private refs, not temporary branches.** Use refs to pin the work, so the user's branch list stays clean and the same logical branch can have many environments.
- **Environments outside the checkout.** Placing them inside it repeats today's `.worktrees/` invisibility problem.
- **Previewed three-way Apply with compare-and-swap** is the core of the feature and must be in the MVP, not a follow-up.

## 16. Future levels

| Level | Adds | Cost |
| --- | --- | --- |
| 1 | Worktree + process group + ports + temp (the MVP) | Low-medium |
| 2 | Per-environment caches where tools are unsafe concurrently; CoW-cloned dependencies; setup script templating; verification before Apply | Medium |
| 3 | Container per environment (Linux tools, network namespace, real port isolation, filesystem confinement) | High; platform-dependent (Docker Desktop/WSL on macOS/Windows) |
| 4 | Remote sandbox (cloud machine per environment; Journal as controller; results come back as refs) | High; changes the local-first promise, so opt-in only |

## 17. Feasibility against the current codebase

| Area | Today | Reuse | Refactor needed |
| --- | --- | --- | --- |
| Worktrees | `src/core/workspaces.mjs`: intent-first creation, reconcile from `git worktree list`, never `--force`, removal blockers (dirty, untracked, ignored), `workspaceView` checks the same common directory | Creation, reconcile, blockers, views | Detached creation (today `planWorkspace` requires a branch name), lock + marker, location under the data folder, private refs |
| Sessions | One session ↔ `workspaceId`; `MAX_SESSIONS = 4` per runtime | Session per environment | Raise or make configurable; per-environment slots |
| Processes | PTY per session as its own group; verified signals; survivors; Windows `taskkill /T` | All | Environment-level ownership record; Job Objects remain a known gap |
| Recovery | `TerminalManager.recover()`, runtime survives app restarts, orphan detection | All | Environment states follow sessions; reconcile at startup |
| Changes | `src/core/changes.mjs` diff vs session base; nested trees (#27) | Diff, file diff, open | Result snapshot ref; diff against `refs/journal/env/<id>/base` |
| Story | Deterministic rows from events (`src/core/story`) | All | New fixed rows (§14) |
| Branches | `src/core/branches.mjs` list/switch with refusals | Refusal patterns | Apply engine is new (`merge-tree`, `update-ref` CAS, checkout update) |
| Memory | Revisions, candidates, supersedes, fingerprints, branch scope, receipts | All | Provenance fields; "conflicting candidates" link; evidence pointing at result commits |
| Launch env | `agentTerminalEnv` builds the agent's environment | Hook point for variables | Add `TMPDIR`/ports/`JOURNAL_ENV_*` |
| Store | SQLite in a worker, single writer, audit log | All | `environments` table or workspace `kind: 'isolated'`; Apply lock row |
| Windows | Hooks, ConPTY, line endings handled; Job Objects blocked | | Long-path and link-safe removal checks |

**Current risks found:**
- Sessions in the same checkout share its working tree; this is the problem this feature solves.
- Worktrees inside the checkout are invisible to its Git status. Since #27 the Changes view handles it, but environments must live outside.
- `MAX_SESSIONS = 4` caps parallelism.

## 18. Test plan

Fixture-only, real Git, no provider logins (project rule).

| # | Area | Test | Level |
| --- | --- | --- | --- |
| 1 | Create | Intent then worktree; crash between (kill after intent) reconciles to `failed` or `ready`; path, lock, marker, base ref exist | Unit (real Git) |
| 2 | Create | Same logical branch, three environments at once; the branch stays checked out in one place only | Unit |
| 3 | Snapshot | Result includes commits, uncommitted edits, new files; excludes ignored files; the agent's index untouched | Unit |
| 4 | Apply | Clean, different files; second Apply recomputed against the new logical commit | Unit |
| 5 | Apply | Same file, different lines → merged | Unit |
| 6 | Apply | Same lines → conflict, nothing written (branch ref, index and files byte-identical) | Unit |
| 7 | Apply | Delete vs edit; rename vs edit; binary | Unit |
| 8 | Apply | Logical branch moved meanwhile → CAS refuses; preview redone | Unit (simulated race) |
| 9 | Apply | User's uncommitted edits: unrelated preserved; overlapping refused with the list | Unit |
| 10 | Apply | Logical branch rewritten (base not ancestor) → warning, update-from-branch path | Unit |
| 11 | Conflict | Resolve in environment: markers only in the environment; re-snapshot; Apply | Unit |
| 12 | Memory | Proposal provenance; evidence at the result commit; conflicting candidates both kept; abandoned environment flags candidates | Unit |
| 13 | Memory | Branch-scoped notes use the logical branch in an environment | Unit |
| 14 | Processes | Stop environment A never signals B (two fixture agents, verified PIDs) | Integration |
| 15 | Ports | Blocks unique across environments; bind-probe skips busy ports; released on cleanup; Windows excluded ranges parsed | Unit |
| 16 | Cleanup | Refuses: live session, orphan, missing marker, imported worktree, path outside root, symlinked root, `.git` resolving to main checkout, uncaptured result | Unit (destructive-safety) |
| 17 | Cleanup | Junction/symlink inside the environment: target survives removal (POSIX symlink; Windows junction) | Unit, both platforms |
| 18 | Recovery | Runtime killed mid-session → `interrupted`/`orphaned`; environment returns to `ready`; result still capturable | Desktop (headless) |
| 19 | Recovery | App crash during Apply → lock released, no half-applied state | Unit + desktop |
| 20 | UX | Isolated session start, Files shows environment, Apply preview, conflict banner, Story rows | Desktop (headless, fixture agents) |
| 21 | Concurrency | Four environments editing and applying in random order; final branch equals sequential merges | Integration (property-style) |
| 22 | Windows | Long paths, CRLF, file lock on removal (held handle) → `cleanup_pending` then success | Windows CI |
| 23 | Git version | Git < 2.40 → feature refuses with a clear message | Unit (stubbed version) |

## 19. Open questions

1. Default for new write-capable sessions: isolated or checkout? (Proposed: isolated, after the MVP has proven itself; checkout stays available.)
2. Apply message and authorship: the user as author with an agent trailer, or the agent's configured identity?
3. Should **Verify** (tests before landing) block Apply by default once available?
4. Retention period for private refs of abandoned work (proposed 30 days), and whether `git gc` interactions need a periodic `reflog`-free check.
5. Should the logical branch be allowed to live in a Journal worktree, so the user's own checkout can stay on another branch?
6. Projects that are not Git repositories: isolated environments unavailable (proposed), or full copies?
7. Monorepos with sparse checkout: environments inherit sparse patterns?

## Do not implement yet

This document is the output of a research and design task. No code, schema or UI change follows from it until the user approves the design and the MVP scope (§15). The first step after approval is a prototype that proves the riskiest parts (§20), not the feature.

## 20. Prototype first

A throwaway script against real temporary repositories proves the three risky mechanisms before any product code:
1. **Detached worktrees with private refs.** Create three environments from one branch, commit in them, remove the worktrees, run `git gc --prune=now`, and verify the results survive through the refs.
2. **Previewed Apply.** `merge-tree --write-tree` preview, then compare-and-swap `update-ref`, and a checkout update that preserves unrelated uncommitted edits. Run it against every case in rows 4–10 of the test plan.
3. **Link-safe removal on Windows.** A junction inside an environment, plus a file held open by another process; prove the target survives and the retry path ends in `cleanup_pending`.

## 21. Prototype findings

The feasibility prototype, `experiments/isolated-environments/` (see its README), has 26 tests on real temporary repositories with fixture workers; 3 more are Windows-only and not run yet.

**Confirmed:**
- Detached worktrees from one recorded base, private refs and a clean branch list.
- Concurrent writes isolated.
- Work survives removal and `git gc --prune=now` through the refs.
- The result snapshot captures commits, uncommitted and untracked work, leaves the worker's index byte-identical and is idempotent.
- The previewed three-way Apply handles:
  - clean merges, including the same file on different lines;
  - same-line and delete/edit conflicts, with nothing written (branch, index and files compared byte for byte);
  - a moved branch and a rewritten branch;
  - a race, refused by compare-and-swap;
  - unrelated staged, unstaged and untracked edits, which survive;
  - overlapping edits, which are refused;
  - a second worker re-previewed after the first lands.
- Crash recovery for the creation, Apply-before-landing and Apply-after-landing cases.
- Cleanup refusals: a live process, a folder outside the root, a user-created worktree, work added after the result.
- Link targets survive cleanup.
- A held file gives `cleanup_pending`, and the retry succeeds.
- Port blocks are unique and two workers run side by side.

**Corrected:**
1. **Apply landing order** (§8.3): hold the checkout's index lock; side index; compare-and-swap; then swap the index in.
2. **Cleanup without `--force`** (§11): point HEAD and the index at the result, delete untracked links, `git worktree remove`; never a repository-wide prune.
3. **Resolve in the environment** (§9.1): the worker's uncommitted work is committed first.
4. **Snapshot idempotency:** identified by tree and HEAD, including after cleanup pointed HEAD at the result.

**Memory gaps, now asserted in tests** (§10 stands; these are the work items):
- Receipts cannot record the environment and base.
- The packet follows the checkout's branch, not the worker's logical branch.
- Proposal provenance has no structured fields.
