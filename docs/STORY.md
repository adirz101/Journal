# The Story (Session tab)

The Session tab's **What it did** section shows a short, deterministic Story of a session instead of the raw hook log. The Story is a presentation layer over the events Journal records. It uses no model and does no summarizing, and the same events always give the same Story. The raw evidence (exact commands, exit codes, durations and the full timeline) stays under **Details**.

## Layers

| Layer | Where | What it does |
| --- | --- | --- |
| Collection | `src/runtime/adapters/*.mjs`, `src/core/terminal.mjs` | Hooks report events; the hook process keeps only bounded, redacted fields; the runtime records timeline events |
| Shell reading | `src/core/story/shell.mjs` | Splits a recorded command line into simple commands: quotes, escapes, `$(...)`, backticks, heredoc bodies (skipped), redirections, `&&`, `\|\|`, `;`, `\|`, `&` |
| Classification | `src/core/story/classify.mjs` | Each simple command gets one fixed category; commit messages and push targets are read from the arguments |
| Results | `partResults` in `src/core/story/story.mjs` | What one exit status proves about each command in the line |
| Grouping and Story | `atomsOf`, `phasesOf`, `buildStory` in `src/core/story/story.mjs` | Events → atoms → turns → phases (or plan items) |
| Rendering | `src/ui/StoryPanel.tsx`, `RawActivity` in `src/ui/ActivityPanel.tsx` | Rows, steps on expansion, Details |

## What is recorded

| Provider | Commands | Files | Other tools | Plan |
| --- | --- | --- | --- | --- |
| Claude Code | Bash: command, working folder, exit code, duration, Claude's `description` | Edit, Write, MultiEdit, NotebookEdit paths | Read (path), Grep, Glob, Agent (`description`), WebFetch, WebSearch, MCP and other tools by name | TodoWrite (titles and statuses); TaskCreate and TaskUpdate (unverified natively) |
| Codex | Shell tools from PostToolUse with `exit_code`, recorded when they end | `apply_patch` header paths and their operation (add, update, delete); never the patch | Other tools by name | None (no plan event is verified) |
| Cursor | `afterShellExecution` (no exit status: always "unknown") | `afterFileEdit` path | `postToolUse` tools by name (shell and edit tools skipped: they arrive through the events above) | None |

Never recorded: prompts, the agent's messages, tool output, file content and transcript paths. Descriptions and plan titles are redacted like commands and shortened to 120 characters.

## Classification

The categories, from most to least significant:

commit, push, pr, ci, test, build, install, delete, create, edit, git, script, agent, web, git-inspect, search, explore, noise.

When one command line contains several commands, it is described by its most significant one, after a fixed order of precedence. Milestones (commit, push, pr, ci, test, build, install) each become their own atom: `git commit && git push` is both a commit and a push.

| Category | Examples |
| --- | --- |
| noise (hidden, kept in Details) | `cd`, `pwd`, `echo`, `printf`, `true`, `sleep`, `export`, assignments, `for`/`while`/`if` headers, function definitions |
| explore | `cat`, `head`, `tail`, `sed` (without `-i`), `ls`, `wc`, `awk`, `jq`, `diff`, Read |
| search | `grep`, `rg`, `ag`, `find`, `fd`, Grep, Glob |
| git-inspect | `git status/diff/log/show/branch/blame/rev-parse/remote/ls-files/...`, `gh pr view/list/diff` |
| edit | a file written with `>` or `>>`, `tee`, `sed -i`, `perl -i`, `cp`, `mv`, `git mv`, `git apply`, `patch`; Edit, Write, MultiEdit, NotebookEdit; `apply_patch` updates; Cursor edits |
| create | `mkdir`, `touch`; `apply_patch` "Add File" |
| delete | `rm`, `rmdir`, `unlink`, `git rm`; `apply_patch` "Delete File" |
| test | `npm/pnpm/yarn/bun test`, scripts named `test*` or `*:test`, `node --test`, `vitest`, `jest`, `mocha`, `playwright test`, `pytest`, `python -m pytest`, `go test`, `cargo test`, `dotnet test`, `mvn test`, `gradle test`, `make test`, `xcodebuild test` |
| build (kind: build, typecheck, lint) | scripts named `build`, `check`, `typecheck`, `lint`; `tsc`, `mypy`, `pyright`; `eslint`, `biome`, `ruff`, `prettier --check`, `clippy`; `cargo build/check`, `go build/vet`, `make`, `vite build`, `xcodebuild` |
| install | `npm install/ci/add/update/remove`, `pnpm/yarn/bun add/install`, `pip install`, `uv add/sync`, `poetry add`, `go get`, `go mod tidy`, `cargo add`, `brew install`, `bundle` |
| commit | `git commit` (message: `-m`, `-am`, `--message=`, `-m "$(cat <<EOF ...)"`, `-F - <<EOF`: first line) |
| push | `git push` (remote and branch from the arguments) |
| pr | `gh pr create/merge/ready/close/reopen` |
| ci | `gh pr checks`, `gh run watch/view`, `gh run/workflow ...` |
| web | `curl`, `wget`, WebFetch, WebSearch |
| script | Anything else: `python3`, `node`, local scripts, MCP tools |
| agent | Claude's Agent/Task tool |

Package-runner prefixes are unwrapped first: `npx`, `bunx`, `pnpm dlx`, `uv run`, `poetry run`, `bundle exec`, `python -m`, `env`, `sudo`, `time`, `timeout`, `xargs`. Paths are counted only when they are literal: a word with `$`, a glob or a substitution is not a path.

## What an exit status proves

A shell reports one exit status for a whole line:
- **Exit 0** proves a command passed only if nothing is piped after it and every connector from it to the end is `&&`. `npm test | tail` proves nothing about `npm test`, and neither does `npm test; echo done`.
- **A failure** is pinned on a command only when nothing else could have failed:
  - in a line joined only by `&&`, when it is the only command that is not noise (`cd`, `echo` and assignments are assumed not to fail) and nothing is piped after it;
  - otherwise, when it is the last command of a line joined by `;` or `||`.
- **A command cut at the recording limit** (300 characters) proves nothing per part. Its last fragment is not read unless the cut fell inside a heredoc body.
- **Everything else** is "unknown". Rows say so ("result not visible", "result unknown") and never claim success.

CI is a result only when the command's exit status means one:
- `gh pr checks`: 0 is passed, 8 is pending, anything else is failed.
- `gh run watch --exit-status` and `gh run view --exit-status`: 0 is passed, anything else is failed.
- Anything else is "Checked CI".

## Grouping

1. **Turns:** a user prompt starts a turn. Cursor without turn status reports no prompts, so its activity is one turn.
2. **Plan (when the agent reported one):** the plan's items are the rows, in the plan's order, with their latest status (done, in progress, not started). Every atom recorded while an item was in progress belongs to it. Activity while no item is in progress falls back to step 3.
3. **Phases (no plan):** one row per phase type in a turn, in order of first occurrence:

   | Phase | From | Title |
   | --- | --- | --- |
   | investigate | explore, search, git-inspect, web, before any other phase | Investigated |
   | change | edit, create, delete | Implemented changes |
   | install | install | Installed dependencies |
   | test | test | Ran tests |
   | build | build | Built, Type-checked, Linted or Checked build |
   | commit | commit | Committed changes, or Commit failed |
   | push | push | Pushed, or Push failed |
   | pr | pr | Opened, Merged or Updated pull request, or Pull request command failed |
   | ci | ci | CI passed, CI failed, CI pending or Checked CI |
   | agent | agent | Ran sub-agents |
   | other | script, git | Ran commands (only when the turn has nothing else) |

   - Investigation after another phase has started (re-reading while fixing) belongs to that phase.
   - Unclassified commands belong to the phase they happen in ("N other commands").
4. **Metadata:** one line built only from counts, paths, exit codes, the commit message and the push target, for example:
   - "14 files read · 6 searches · 42s"
   - "3 files changed · 1 created · 1 deleted"
   - "4 runs · 3 passed · 1 failed"
   - "typecheck · lint · build · 3 runs · all passed"

   The row shows at most three parts and the duration; a failure is never the part left out. The full line is in the row's tooltip.
5. **Status:**
   - test, build and CI rows: from the last run whose result is known;
   - commit, push and pull-request rows: from the last command;
   - other rows: failed if any of their commands is known to have failed.
6. **Steps:** expanding a row lists its steps (the newest 12), using the provider's description when there is one, otherwise the command (without `cd`).
7. **Approvals:** counted on the turn. The open request is shown as "Waiting for approval" while the session waits.

The panel shows:
- the plan (if any) and the latest turn with activity;
- earlier turns one line each, under "Earlier turns";
- quiet turns (no tool activity) are omitted;
- the raw list, test exits and the full timeline under Details.

## Example

Raw events (Claude):

```
cd src · cd .. · sed -n 1,40p src/upload.ts · grep -rn retry src · Read src/upload.ts
Edit src/upload.ts · Write src/retry.ts
npm test ("Run the test suite") → exit 1 · Edit src/retry.ts · npm test → exit 0
git add -A && git commit -m "Add retry to the uploader" → exit 0
```

Story:

```
Turn 1 · 11:05 PM · 2s
· Investigated          1 file read · 1 search
· Implemented changes   2 files changed
✓ Ran tests             2 runs · 1 passed · 1 failed
✓ Committed changes     Add retry to the uploader
```

## Limitations

- **Hidden test results.** Test results piped into another command (`npm test 2>&1 | tail`) are not visible: the exit status belongs to the last command. Agents often do this.
- **Unknown file changes.** A Write may create or overwrite a file, so it counts as changed. Python or Node scripts that edit files count as "other commands"; their files are unknown.
- **Unverified natively:**
  - Claude's TaskCreate/TaskUpdate field names;
  - Codex's shell tool names and the `apply_patch` input shape;
  - Cursor's `afterShellExecution` payload.

  Fixtures for Codex and Cursor follow their documentation.
- **Retention.** A session keeps its newest 2000 timeline events. Read and Grep tools add to that count, so very long sessions lose their earliest turns.
