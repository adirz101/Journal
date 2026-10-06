# Coordinated runs on macOS

Coordinated runs are an off-by-default experiment. Enable **Coordinated runs** in Settings, open a named Git branch, choose **Coordinate**, enter a goal, and start Claude Code or Codex. The coordinator uses the project's checkout; each requested worker receives an isolated folder. Ordinary sessions, the coordinator and workers share the same capacity limit.

Windows team implementation and acceptance are deferred at the user's request on 6 October 2026. Existing ordinary Windows terminal behavior is unchanged.

## Working with a team

- **Plan** shows tasks, dependencies and recorded decisions. Creating a task does not start a worker. Request workers explicitly; blocked tasks occupy no session slot. Requests can include a model, references, a soft time limit or alternative attempts.
- **Workers** shows work state separately from process presence. Open a terminal, stop a worker, continue its exact conversation, retry from a captured result, or transfer its settled folder to another provider. Unknown surviving processes prevent folder reuse.
- **Results** separates the worker's report from captured files, isolated check evidence and review claims. Review tasks pin an exact result or branch head. A later result does not inherit an earlier verdict. Taking in a new review subject invalidates readiness until a new turn reports again.
- **Messages** records receipt, delivery uncertainty and held reasons. Reading and acknowledging a message proves receipt, not completion. Never automatically resend an uncertain delivery; inspect and clear the recipient's input first.
- **Capacity** shows measured resource signals and explicit fallback limitations. Global limits remain at most four pending calibration. Soft time limits issue reminders; they do not kill a worker or declare success.
- **Policy** controls integration guards and the per-run worker cap. Only the user can loosen policy. Changing policy expires pending Apply approvals.
- **Story** reconstructs decisions and outcomes from durable events. Worker memory proposals appear with their exact result and require a visible user review before they are remembered. An unapplied result does not acquire provenance from another result's Apply.

Claude's **Allow Journal team tools without prompts for this run** checkbox only adds the Journal MCP tool namespace to that launch's settings. Shell, file, network and other native provider permissions remain authoritative. Codex and Cursor keep their native tool permission behavior. No provider settings file in the user's home is rewritten.

## Integration and recovery

Use **Preview Apply** for a specific result. The preview binds result, target branch head, policy and check evidence. An approval applies only to that subject and is consumed once. A changed subject requires another preview. Pausing stops new orchestration actions without answering a native permission prompt.

When live capture or folder mutation cannot be qualified, stop and settle the worker, capture/accept the result, then continue the exact conversation after integration or take-in. Automatic input and Stop-hook continuation remain disabled on production adapters pending authenticated native validation. The pull inbox remains available: ask the coordinator or worker to read its Journal inbox when it needs to continue.

Recovery adopts saved sessions by exact launch identity, preserves immutable captures and reconciles landed Apply operations. A take-in that reached a durable merge checkpoint resumes its metadata and notification once; a crash inside an uncheckpointed Git mutation remains held. It never repeats an ambiguous merge or admits another writer into that folder. Inspect the retained folder and use a separate retry from the base or an immutable result when the original mutation cannot be established. Historical work and results remain retained.

## Isolated result checks

**Run tests in isolation** materializes the pinned Git tree into a disposable folder and runs `npm test`. The coordinator's `verify_result` tool also accepts an explicit argv array. Commands are not interpolated through a shell by Journal; package scripts retain npm's normal shell semantics inside the sandbox.

On macOS, a deny-by-default Seatbelt profile permits writes only in that disposable folder and reads only there and in the required system/Node/npm runtime files. The environment has private homes and temporary directories, no inherited credentials and no provider PATH. Before every execution, synthetic canaries verify that outside file reads/writes and network connections are denied. A failed probe refuses execution. Checks have a deadline and their process group is stopped on timeout or runtime shutdown.

This is not a dependency installer: ignored `node_modules`, a mutable worker folder, the user's npm cache and network access are not copied or granted. A test requiring unavailable dependencies fails instead of borrowing them from the checkout. npm must be available in the runtime's PATH; unsupported layouts fail closed. Linked/nested/sensitive trees and trees beyond the materialization limits are refused. `npm test`/`npm run test` evidence is tied to the immutable package test configuration; another successful command cannot certify that suite. A timeout or interrupted check remains unknown, never passed.

## Acceptance boundary

Automated tests use fixture CLIs, real temporary Git repositories, SQLite and Electron-native node-pty. They do not use provider logins, provider requests or secrets. Passing these checks is not authenticated provider acceptance.

Still required before enabling the gated production transports or declaring M10b complete: local authenticated provider/version trials for MCP permissions, exact resume, continuation and live boundaries; mixed-provider conflict/review workflows; higher-cap calibration; and the real usefulness trial. No public release or merge is implied by the implementation PR.
