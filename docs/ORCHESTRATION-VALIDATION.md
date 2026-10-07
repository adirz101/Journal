# Orchestration validation record

Status: expanded macOS fixture acceptance; authenticated native acceptance remains **not run**. Windows orchestration is deferred. This record distinguishes evidence from implementation and from the larger acceptance target in the [plan](AGENT-ORCHESTRATION-IMPLEMENTATION-PLAN.md#14-m10--recovery-delivered-throughout-then-validated-together).

## Evidence and its limits

| Contract | Executable evidence | Limit |
| --- | --- | --- |
| Durable task identity and scoped tools | `tests/orchestration-model.test.mjs`, `tests/agent-tools.test.mjs` | Fixture credentials and provider launches |
| Actual MCP stdio process replacement | `tests/runtime.test.mjs`: MCP stdio restart | Initialize/list/call through the shipped SDK; repeating a request returns the same task, changed arguments refuse, desktop stays connected. No native provider client involved |
| Renderer reload and Main process death | `tests/desktop-team-recovery.spec.ts` | A fixture coordinator requests its worker after Main has died; the new desktop reads the same run and result without another launch |
| Runtime process death with a settled worker | Same desktop spec | Immutable result ID, task, attempt and queued message survive; no prompt replay |
| Runtime process death with a live worker | Same desktop spec | After a real process inventory, the ended fixture is captured as `result_available`, never made ready by exit. A crash before inventory cannot prove absence of surviving writers and must remain held |
| Cold restart from persisted state | `tests/desktop-team-recovery.spec.ts` | Main and runtime are both killed before relaunch; persisted tasks/results/messages reconstruct without a surviving owner. This simulates process loss, not physical power loss or filesystem corruption |
| Leftover-process cleanup | `tests/terminal.test.mjs`, `tests/desktop-sessions.spec.ts` | Unknown process sets refuse cleanup; failed signals and still-running children remain blockers; observed absence is required before folder reuse |
| Request queues, shared capacity and resource holds | `tests/capacity.test.mjs`, `tests/coordinator-queue.test.mjs`, `tests/orchestration-model.test.mjs` | Injected resource signals; not higher-concurrency calibration |
| Interrupted delivery, human takeover and stale launches | `tests/delivery.test.mjs`, `tests/continuation.test.mjs`, `tests/orchestration-model.test.mjs` | Fixture-qualified boundaries only; all production push/continuation capabilities disabled |
| Capture, Apply and take-in publication seams | `tests/environments.test.mjs` | Injected failures at durable boundaries; does not prove an arbitrary power loss inside every Git mutation |
| Approval subject and one-time integration | `tests/orchestration-workflows.test.mjs`, `tests/integration-gates.test.mjs` | Real temporary Git repositories, stopped writers and synthetic reports |
| Review/fix/recheck and memory provenance | `tests/orchestration-workflows.test.mjs` | The verdict on A remains historical after B; the proposal stays tied to A and needs user review |
| Retired verifier and historical checks | `tests/agent-tools.test.mjs`, `tests/runtime.test.mjs`, `tests/orchestration-workflows.test.mjs`, `tests/desktop-team.spec.ts` | Execution routes are unavailable; completed receipts survive and pending legacy checks become interrupted without replay. Native reports remain claims |
| Packaged app | `scripts/package-audit.mjs`, `scripts/smoke-packaged.mjs` | Ad-hoc ARM64 app: startup, fixture detection, PTY, files and restart; not notarization or authenticated team acceptance |

All automated provider behavior uses isolated fixture homes and executables. No test uses a provider login, sends a provider request or reads a secret. Logs record test results and synthetic state; do not add account details, access tokens or native conversation transcripts to this repository.

## Local native session worksheet

These trials are manual and local, as required by `AGENTS.md`. They are deliberately not an automated provider harness. Record the Journal commit, app form (development or packaged), macOS version, provider versions, scenario, observed result and any limitation. Leave an unexecuted row **not run**. A fixture pass cannot fill a native row.

Use a disposable local Git project containing a tiny dependency-free test suite and a clean named branch. Open Journal manually with the normal user setup. Enable **Coordinated runs**. Use the provider's existing authentication and permissions; do not edit or copy credential files. Do not use a production project for fault drills.

| Trial | Actions | Required observation | Current result |
| --- | --- | --- | --- |
| Claude tool permission boundary | Start a Claude coordinator without the Journal-tool allow-list. Ask it to inspect its run and create one task. Repeat in a separate run with the per-run allow-list selected | Native tool review appears when required. The opt-in affects Journal tools only; shell/file/network approval behavior is preserved | Not run |
| Codex MCP and trust | Start a Codex coordinator, complete native trust prompts manually, ask for `get_run`, a task and an isolated worker | Tools address this run; normal Codex permissions remain authoritative | Not run |
| Worker role boundary | Ask a worker to inspect its task, report a result, then attempt a coordinator-only operation | Valid worker actions work; the privileged action is refused without changing state | Not run |
| Stopped-worker integration and exact resume | Make a small worker change, stop the worker, inspect/accept its exact captured result, preview and Apply, then Continue | Only reviewed changes land. Continue resumes the displayed native conversation ID and preserves history; another captured result receives a new ID | Not run |
| Two conflicting workers | Give two workers overlapping edits. Stop/capture them, integrate one, return the other's conflict for correction, then capture and preview again | No forced overwrite, no automatic conflict success, and the new result needs fresh evidence | Not run |
| Review/fix/recheck | Pin a review to result A, obtain changes requested, fix into B, and refresh/recheck | A's verdict never certifies B. The reviewer names B's exact identity before a new verdict | Not run |
| Permission and human intervention | Leave a provider permission prompt pending; queue a message; type a draft without submitting | Journal shows attention and does not answer the permission or submit the draft. The message stays available through the pull inbox | Not run |
| Main absence and process turnover | In the disposable project, close Journal with Keep running and reopen. Then exercise explicit coordinator/worker Stop and Continue | No duplicate launches or original-task replay; exact run, conversation and result history reconstruct | Not run |
| Packaged team and project checks | Repeat a small team flow in the built app. Ask the native worker to choose and run a useful project check, then report its command and outcome | Report is labeled as a worker claim; capture, acceptance and Apply do not certify that the captured tree passed. Journal has no separate test runner | Not run |
| Usefulness | Complete a small feature including a dependency, conflict, review and one deliberate intervention; compare with the ordinary terminal workflow | Record task outcome, interventions, failures and elapsed time. A successful fixture is not evidence that the feature is useful | Not run |

## Capability qualification still required

Successful use of the stopped-worker path does not enable automatic PTY input, Stop continuation or live-folder mutation. Each needs the provider/version-specific M0 contract: exact launch/turn correlation, native permission visibility, input ownership including human drafts, a serialized reservation, a supported continuation response, and writer exclusion for the particular Git operation. An idle timer, a turn-end hook or one successful demonstration is insufficient.

Keep the production capability flags disabled until the adversarial native cases and their supported-version boundaries are recorded. If a provider cannot establish a contract, record the capability as unsupported and retain pull messaging plus explicit stopped-worker integration. Do not silently count it as complete.

The remaining M10b evidence includes the combined authenticated feature trial, native permission and resume trials, additional fault seams including power-loss/filesystem behavior beyond the cold-process restart drill, and resource calibration on another supported macOS machine before lifting the cap of four. Windows remains separate future work. Unknown outcomes inside an uncheckpointed Git mutation remain held for inspection; recovery must not infer success or launch another writer.
