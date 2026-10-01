# Project orientation for every session

User goal, 1 October 2026: a new conversation should know what the repo means and where the project stands, without the user explaining it again. Journal still hosts native terminal interaction; this does not introduce a chat renderer or promise context in conversations launched outside Journal.

## Contract

- **Repo overview:** an approved `brief` with checkout scope. Describe the product purpose, repository structure, important conventions and stable constraints. It follows every branch in this canonical checkout.
- **Branch update:** an approved `brief` with branch scope. Describe completed work, current work, blockers and the next step. Only the exact current branch receives it; another branch never inherits its progress as truth.
- Current approved briefs are selected before task-specific lexical matches, even for empty or unrelated initial tasks and on exact native resume. The packet identifies the current project, branch and checkout HEAD.
- Checkout and current-branch entries alternate, with newest revisions first in each group. At most four brief entries share the existing 12-claim / 6000-byte packet budget. Budget/brief-limit exclusions remain visible; an omitted checkout overview produces a warning. Large briefs may not all fit: consolidate rather than silently truncate qualifiers.
- Admission, credential checks, evidence fingerprints and immutable revisions/receipts apply exactly as for other knowledge. A changed source excludes a stale brief. A revised brief returns to candidate until approved. Withdrawal changes future packets, not historical receipts.
- Briefs apply to the whole checkout and cannot carry an area filter. Task-specific decisions/lessons keep the existing lexical and area rules.

## User workflow

Click **Add project brief**, write the overview once, attach a tracked source excerpt or explicit source note, and approve it. The form defaults to **Repo overview · all branches in this checkout**. Add another brief with **Current branch update** to record current progress. Revise/approve it when the branch state changes. A new provider session receives both applicable summaries automatically; there is no need to paste them into each task.

Suggested overview:

```text
Purpose: what this repo delivers and for whom.
Structure: the main components and where they live.
Constraints: decisions the next session must preserve.
```

Suggested branch update:

```text
Completed: what is implemented and verified.
Current work: what this branch changes.
Next: the next concrete task and any known blocker.
```

Status is explicitly reviewed information, not an automatically inferred summary of terminal output. This slice does not automatically extract progress, modify native instruction files, promote context across worktrees, or admit generated claims. Those require a later design; reviewed status must be updated when work changes.

## Verification

Real Git/SQLite tests cover empty/unrelated tasks, precedence over task knowledge, freshness, branch separation, revision admission, withdrawal, limits and immutable receipts. A local Electron/native-PTY scenario adds and approves the overview/update through the UI, launches Claude with an empty task, switches branches, and launches Codex with the same overview plus only the new branch's update. These provider executables are controlled fixtures; this scenario verifies delivery, not independent native model comprehension.
