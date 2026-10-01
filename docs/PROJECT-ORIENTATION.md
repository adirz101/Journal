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

## Git-drafted updates

**Propose branch update** and **Propose overview** draft a revision from local Git facts; no model is called and nothing is stored. A branch draft lists commit subjects, changed areas and uncommitted files since the last update, or since the branch point from `origin/HEAD`, `main` or `master`. It carries the previous update's `Current work` and `Next` lines for confirmation, and otherwise leaves bracketed placeholders, which cannot be saved. An overview draft takes the README's first prose line and the tracked top-level structure; a later draft replaces only the `Structure:` line and lists added or removed directories and changed manifests. Commit subjects or paths that look like credentials are omitted, and drafts are capped at the 2,000-character statement limit.

The draft opens in the knowledge form. **Save for review** creates a candidate revision, and agents receive it only after **Approve**. Its evidence is the Git range: the update becomes stale when history is rewritten or reset so that its recorded HEAD is no longer an ancestor. A current-branch update shows how many commits were made after it was recorded; packets annotate it, and the receipt warns that it may be behind. Drift prompts a review; it never excludes the update.

Status is explicitly reviewed information, not an automatically inferred summary of terminal output. This slice does not admit generated status, modify native instruction files, promote context across worktrees, or admit generated claims. Those require a later design; reviewed status must be updated when work changes.

## Verification

Real Git/SQLite tests cover empty/unrelated tasks, precedence over task knowledge, freshness, branch separation, revision admission, withdrawal, limits and immutable receipts. A local Electron/native-PTY scenario adds and approves the overview/update through the UI, launches Claude with an empty task, switches branches, and launches Codex with the same overview plus only the new branch's update. These provider executables are controlled fixtures; this scenario verifies delivery, not independent native model comprehension.
