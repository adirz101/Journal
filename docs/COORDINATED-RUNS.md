# Coordinated runs on macOS

Coordinated runs are an off-by-default experiment. Enable **Coordinated runs** in Settings, open a named Git branch, choose **Coordinate**, enter a goal, and start Claude Code or Codex. The coordinator uses the project's checkout; each requested worker receives an isolated folder. Ordinary sessions, the coordinator and workers share the same capacity limit.

Windows team implementation and acceptance are deferred at the user's request on 6 October 2026. Existing ordinary Windows terminal behavior is unchanged.

## Working with a team

- **Plan** shows tasks, dependencies and recorded decisions. Creating a task does not start a worker. Request workers explicitly; blocked tasks occupy no session slot. Requests can include a model, references, a soft time limit or alternative attempts.
- **Workers** shows work state separately from process presence. Open a terminal, stop a worker, continue its exact conversation, retry from a captured result, or transfer its settled folder to another provider. Unknown surviving processes prevent folder reuse.
- **Results** separates the worker's report from captured files, agent test reports and review claims. Review tasks pin an exact result or branch head. A later result does not inherit an earlier verdict. Taking in a new review subject invalidates readiness until a new turn reports again.
- **Messages** records receipt, delivery uncertainty and held reasons. Reading and acknowledging a message proves receipt, not completion. Never automatically resend an uncertain delivery; inspect and clear the recipient's input first.
- **Capacity** shows measured resource signals and explicit fallback limitations. Global limits remain at most four pending calibration. Soft time limits issue reminders; they do not kill a worker or declare success.
- **Policy** controls integration guards and the per-run worker cap. Only the user can loosen policy. Changing policy expires pending Apply approvals.
- **Story** reconstructs decisions and outcomes from durable events. Worker memory proposals appear with their exact result and require a visible user review before they are remembered. An unapplied result does not acquire provenance from another result's Apply.

Claude's **Allow Journal team tools without prompts for this run** checkbox only adds the Journal MCP tool namespace to that launch's settings. Shell, file, network and other native provider permissions remain authoritative. Codex and Cursor keep their native tool permission behavior. No provider settings file in the user's home is rewritten.

## Integration and recovery

Use **Preview Apply** for a specific result. The preview binds result, target branch head, policy and check evidence. An approval applies only to that subject and is consumed once. A changed subject requires another preview. Pausing stops new orchestration actions without answering a native permission prompt.

When live capture or folder mutation cannot be qualified, stop and settle the worker, capture/accept the result, then continue the exact conversation after integration or take-in. Automatic input and Stop-hook continuation remain disabled on production adapters pending authenticated native validation. The pull inbox remains available: ask the coordinator or worker to read its Journal inbox when it needs to continue.

Recovery adopts saved sessions by exact launch identity, preserves immutable captures and reconciles landed Apply operations. A take-in that reached a durable merge checkpoint resumes its metadata and notification once; a crash inside an uncheckpointed Git mutation remains held. It never repeats an ambiguous merge or admits another writer into that folder. Inspect the retained folder and use a separate retry from the base or an immutable result when the original mutation cannot be established. Historical work and results remain retained.

## Project checks and test reports

The agent chooses project-appropriate checks when useful for the task and runs them through its native tools and permissions. Journal does not choose a test command, require tests for every task, install dependencies or run a separate test suite against the user's repository.

Worker reports retain the command and reported outcome, including checks that were not run or were unavailable. **Worker test report** is an agent claim. Observed terminal commands and their exits are session activity, not proof that an immutable captured result passed a test suite. Accepting or applying a result never upgrades those claims.

The earlier standalone verifier and its desktop/MCP execution routes have been removed. Completed check receipts remain visible under **Earlier check results** for their original captured tree. An unfinished legacy check is recorded as interrupted after restart and is never rerun.

The obsolete internal test-certification guard no longer applies, including saved runs whose historical policy still contains it. Conflict, writer, scope, infrastructure, executable, deletion, rate and user-approval guards are unchanged. Existing receipts and policy history are retained.

## Acceptance boundary

Automated tests use fixture CLIs, real temporary Git repositories, SQLite and Electron-native node-pty. They do not use provider logins, provider requests or secrets. Passing these checks is not authenticated provider acceptance.

Still required before enabling the gated production transports or declaring M10b complete: local authenticated provider/version trials for MCP permissions, exact resume, continuation and live boundaries; mixed-provider conflict/review workflows; higher-cap calibration; and the real usefulness trial. The user separately authorized merge and a v0.1.3 testing package on 7 October 2026; that authorization does not establish native acceptance or enable the gated transports.

See the [validation record and native worksheet](ORCHESTRATION-VALIDATION.md) for executable evidence and the remaining manual trials.
