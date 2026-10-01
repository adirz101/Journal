# Journal: phased implementation plan

**Current testing policy:** all checks are manual and local on the user's computer. No CI, hosted runners, nightly tests or scheduled verification. This policy supersedes historical testing proposals below.

Date: 1 October 2026. **Historical full-product roadmap.** The user approved a narrower terminal-only first slice and rejected all dev3 code reuse. The current [specification](TERMINAL-FIRST-SPEC.md), [plan](superpowers/plans/2026-10-01-terminal-first.md), [foundation decision](adr/002-terminal-first-foundation.md) and [verified status](IMPLEMENTATION-STATUS.md) supersede the initial stack, chat and reuse assumptions below. Later phases remain proposals.

## Execution principles

One maintainer can start the work, but public native Windows support requires access to a local Windows machine and a repeatable test owner. Budget substantial integration/maintenance time; do not treat a chat renderer plus a vector store as the product. Timeboxes below are rough engineering estimates for an experienced developer, not delivery commitments. Research/legal responses and external release/signing lead times are not included.

No product scaffolding before the feasibility decision. Keep spike code throwaway and outside the eventual core. Each milestone produces a reviewable result and evidence, not a percentage complete. Stop or reduce scope when a gate fails. Feature code follows the agreed design after this planning phase.

## Phase 0 — Feasibility and product proof

**Reuse-first revision after the focused source audit:** read the follow-up in
[RESEARCH.md](RESEARCH.md#follow-up-reuse-existing-agent-integrations) before
executing these spikes. Compare extending dev3 with extracting its Apache-licensed
agent/hook modules; use Superset as a structured-chat reference subject to ELv2.
Do not build a fresh agent loop, OAuth flow, or terminal runtime before assessing
that reuse. The Tauri proposal remains provisional. Agent connection spikes now
validate the selected existing route and Journal-specific behavior; basic
Claude/Codex integration is already demonstrated in upstream implementations.

Timebox: roughly 2–3 engineering weeks, with policy response times independent. Run in this order; Windows probe must not wait for a finished Mac UI.

### S0. Supported integration/authentication routes

Inputs: official Codex app-server/auth docs, Anthropic SDK/credential policy, target product mode.

Work: record exact executable/SDK versions, supported auth modes, redistribution constraints and third-party use boundaries; clarify whether a locally installed interactive Claude CLI may be hosted with hooks under existing subscription authentication. Do not extract credentials or test a prohibited use just because it works technically. API access is a supported alternative, but it changes onboarding/cost.

Output: `docs/adr/001-provider-integration.md`, dated support matrix and chosen Claude route. A contacted-provider response, if pursued, is a later explicitly authorized action; none was sent during planning.

Gate: choose one supportable Claude route. If subscriptions are essential and not supported, MODIFY to a memory companion or defer the promise. If no acceptable cross-provider route exists, do not release a supposed two-agent MVP.

### S1. First technical spike: two-provider transport and context loop

Build a throwaway console harness with Codex app-server and the chosen Claude SDK/CLI route. Small fixture Git repo; no personal source or secrets. Run the same scenarios on macOS and native Windows:

1. Detect executable/version/auth state without reading credentials.
2. Start in exact cwd and preserve native instruction behavior.
3. Submit a task containing a distinctive scoped context fact; record exact packet and available acknowledgment.
4. Observe assistant messages/tool commands/file changes where supported.
5. Require an approval, deny it, then allow a different safe operation through the native mechanism.
6. Run one failing and one passing fixture test; distinguish command exit from parsed test outcome.
7. Interrupt mid-turn, preserve session ID and workspace, resume with explicit new input.
8. Crash provider/harness and test what is actually recoverable; leave uncertain input delivery unresolved.
9. Send malformed/unknown events and large outputs; prove bounded handling and visible gaps.

Outputs: sanitized transcripts/events, redaction-safe fixture corpus, capability matrix, resume limitations and observed context channel. Do not save hidden reasoning.

Gate: repeated start/interrupt/resume/approve-deny cycles complete without wrong-session inputs or silent coverage claims; context text can be shown exactly. CLI mode may pass with partial conversation coverage if the product explicitly accepts that mode. Native control transport internals remain vendor-owned.

### S2. Cross-platform PTY/process/reconnect spike

Probe portable-pty + xterm.js in a minimal Tauri window and independent Rust runtime. Include ConPTY, process Job Objects, Unicode/IME, resizing, flood output, Ctrl-C, GUI environment/PATH, `.cmd` launch shims, spaces/long paths, window crash/reconnect and runtime crash.

Compare a minimal Electron/node-pty version only if an identified Tauri failure or Node SDK bridge cost justifies it. Do not implement two full shells.

Outputs: reproducible platform smoke scripts, actual measured memory/startup/input response, installer/sidecar launch smoke, lifecycle diagram. Gate: no orphan/unowned process kill, bounded output, preserved workspace and explicit reconnect versus resume semantics. A failed Tauri prototype triggers stack reevaluation, not a custom terminal emulator.

### S3. Memory usefulness experiment

Before a full shell, manually curate ~30–50 evidence-linked claims in 2–3 fixture/consented real projects. Include failures, decisions, explicit policies, stale paths, conflicting branches and malicious/noisy claims. Test ~20–30 task/review queries on frozen checkouts; keep claims/task labels separate from model-generated answers.

Compare: no injected memory; small human AGENTS/CLAUDE guidance; native memory; existing workspace + Engram/claude-mem; proposed scoped/validated packets. Use the same model/task conditions where feasible and state configuration differences. Measure relevant hits, stale/wrong-scope injections, repeated failed approaches, token overhead, manual correction time and user preference. This is a directional pilot, not a statistically strong provider benchmark.

Gate: proposed approach demonstrates a concrete benefit beyond curated docs and assembled tools, with manageable review burden. If not, ABANDON a new desktop and contribute the useful missing piece upstream. If scope/validation is useful but the shell is not, MODIFY to companion.

### S4. Schema and security/retention probe

Draft normalized events and memory/receipt DTOs from real fixtures; exercise test corpus through redaction before SQLite/blobs/logs. Benchmark FTS/path retrieval at 5k claims and paginated events at 500k records. Simulate disk full, WAL backup and migration failure. Validate Hebrew queries and English claims without embeddings first.

Gate: no known canary secret survives in any persisted/exported sink; scoped retrieval excludes planted branch/stale facts; bounded memory/DB behavior. Finite tests are not a guarantee of universal secrecy. Confirm stack/DB choices through an ADR.

### Phase 0 decision package

Deliver policy/support matrix, spike evidence, measured performance, baseline memory results, architecture adjustments and GO/MODIFY/ABANDON. Do not move all spikes into production. Retain sanitized fixtures and lessons, not experimental process control code.

## Phase 1 — Local runtime, trust and persistence foundation

UI work follows the user-selected local skill collection documented in
[AGENTS.md](../AGENTS.md): start with `emil-design-eng`, then read the relevant
component-selection, prototype, or motion skills for the specific task. Select
dependencies against actual requirements rather than installing the collection's
entire library catalog.

Dependencies: Phase 0 GO and reviewed contracts. Estimate: 1–2 weeks.

Create the minimal Tauri/React workspace, core crate and runtime executable. Implement authenticated local IPC, project/workspace identity, migrations, single writer, blob metadata, exclusions and pre-persistence redaction. Record session/turn state and process leases. UI is only projects + one task; no decorative dashboard.

Planned file areas: `apps/desktop`, `crates/journal-core/{storage,security,session}`, `crates/journal-runtime`, `packages/contracts`, `fixtures`.

Acceptance: reopen a project with persisted state; untrusted repo scripts cannot execute merely on open; messages/events are filtered; a window crash reconnects to runtime; DB migration/backup tests pass on Mac/Windows. Runtime route authorization uses IDs/root scopes rather than arbitrary commands.

## Phase 2 — One structured agent, one session

Dependencies: foundation, Codex spike fixtures. Estimate: 1–2 weeks.

Implement Codex adapter with version checks, handshake, lifecycle, approvals, interrupt, resume, bounded protocol parsing and native errors. Build a simple conversation/timeline plus command details. Save native thread ID, receipt and usage coverage. Current checkout only, one writer. Basic Git baseline diff and external editor link.

Acceptance: run/deny/approve/interrupt/resume from UI; exact input receipt and current diff available; unknown events do not crash UI or fabricate activities; restart after uncertain submit never automatically duplicates prompt. Compare actual structured events against fixture expectations.

## Phase 3 — Brain-first vertical slice

Dependencies: one agent + SQLite receipts. Estimate: 1–2 weeks.

Implement manual candidate creation and admission, immutable revisions, typed sources, two-axis scopes, category/status filters, path/content evidence validation, exact dedup and conflict inbox. No model extraction yet. Add FTS/path retrieval and the small adaptive budget. Context Inspector previews packet and delivery state, links revisions and allows disabling/incorrect flags.

Acceptance: save a scoped failed approach; a new session receives only relevant current claims; deleting/renaming a path excludes/revalidates the memory; a conflicting feature-branch claim never becomes main truth; editing/withdrawing memory leaves previous receipts historically accurate. Generic/noisy facts do not need a vector system.

## Phase 4 — Claude integration and provider handoff

Dependencies: policy choice + fixtures, manual Brain vertical slice. Estimate: 1–2 weeks, route-dependent.

Implement chosen Claude route behind capability interface. SDK route adds only a minimal packaged Node bridge; CLI route adds PTY/hooks and explicit partial-coverage UI. Approval handling stays native to the route. Attach exact context receipts and preserve native rules/settings. Reuse the same idle implementation workspace for review.

Acceptance: EngineForge-style fixture task implemented by Codex, memories reviewed, then Claude receives scoped knowledge and reviews the actual implementation. No unsupported OAuth login, credential reads or silent API charges. This is the first end-to-end proof of the product thesis.

## Phase 5 — Optional worktrees and a few independent sessions

Dependencies: both providers and single-workspace lifecycle are reliable. Estimate: 1–2 weeks.

Implement current/isolated/research modes, explicit base choice, dirty-repo notice, managed worktree intent/reconciliation and existing worktree import. Enforce writer leases and serialize Git mutations. Add grouped session navigation, waiting indicators and permission alerts. Test initial supported concurrency at four; no orchestration/team delegation.

Acceptance: independent edits cannot accidentally use another session's cwd/input; dirty/untracked/ignored/submodule cases are preserved; crash mid-create reconciles; no forced cleanup. Research mode reflects actual permission enforcement limitations.

## Phase 6 — Timeline, terminal, diff and tests polish

Dependencies: events + workspace process ownership. Estimate: 1–2 weeks.

Integrate real shell terminal separately from structured command panels; virtualize timeline; correlate known tools/commands/approvals; lazy-load diffs; show parsed test reports for one selected format plus generic command outcomes. Test count stays unknown without a supported report. Add event coverage details and local metrics with accounting scope.

Acceptance: terminal flood and large timeline remain bounded/responsive; native Windows keyboard/ConPTY operations work; test completion is not inferred from assistant text; structured agent terminals are not falsely presented as live attachable shells.

## Phase 7 — Bounded candidate extraction and maintenance

Dependencies: manual admission/retrieval and real trace evidence. Estimate: 1–2 weeks.

Implement deterministic evidence candidates, optional user-selected extraction provider, job cursor/idempotency, input/candidate/retry budgets, source validation and the inbox. Add narrow auto-save policy, no causal auto-promotion, lifecycle expiration/GC and branch→repo promotion proposals. Record extractor/policy version and quota consumption.

Acceptance: reprocessing one source range creates no duplicates; model-invented source IDs fail; conflicting/generic/secret claims never auto-admit; task completion does not wait on extraction; manual/deterministic workflows remain useful with extraction off. Review workload meets the pilot target or candidate scope is reduced.

## Phase 8 — Portable knowledge, privacy and recovery hardening

Dependencies: persistence, both providers, Brain lifecycle. Estimate: 1–2 weeks.

Implement versioned Brain export/import with quarantine, evidence availability, retention/size controls, no-content capture, purge workflow, local redacted diagnostics and crash recovery screen. Run kill-at-each-transition tests, disk-full migration/backup restore, process identity spoof/PID reuse, IPC/path traversal and secret sink scans.

Acceptance: export/import round trip preserves qualification without automatically trusting imported claims; sensitive purges remove derived FTS/blob copies; old retained traces do not claim deleted evidence remains available; crash never silently deletes work or resends uncertain input. Document provider-native history outside Journal's control.

## Phase 9 — Native release and adoption decision

Dependencies: full workflow and security/platform evidence. Estimate: 2–3 weeks plus external signing/pilot lead times.

Rename, choose license, add contribution/security/support docs and dependency notices; produce signed/notarized Mac release and signed Windows installer when ready; ensure packaged bridge/runtime versions launch without developer tools. Intel Mac preview only after native smoke. No cloud/telemetry/update agent in the MVP by default.

Run a 5–10 developer pilot on recurring tasks with matched baselines, measure usefulness/review burden and resource use. Publish honest provider capability/version matrix and release limitations. Fix integration/privacy failures before expanding features.

Release gates: supported provider routes; successful handoff workflow on both native platforms; no known critical secret/wrong-scope defects in corpus; preserved crash work; measurable benefit and continued-use demand. No public “full observability” or universal auth claim. If users mostly want an existing cockpit, change direction.

## V1 and later queues

**V1, after pilot evidence:** per-session local MCP, optional local semantic retrieval, targeted Tree-sitter symbols, richer test parsers, dirty snapshot transfer, reviewed full-history export, optional encrypted app storage, bounded mid-task context updates. Each requires its own measured problem and acceptance criteria.

**Later:** external adapter SDK, Linux/WSL/ARM targets, cloud sync/backups, remote runners, collaboration and matched provider metrics. They are not implied by the local implementation's authentication policy.

**Do not schedule:** IDE/language-server suite, Kanban/issue tracking, automatic merge/cleanup, model leaderboard, hidden reasoning viewer, custom terminal/vector database or mandatory cloud account.

## Planning estimate and likely critical path

Summing the timeboxes gives roughly **12–22 engineering weeks** for one experienced full-time developer, before external policy/signing delays and assuming modest scope. This is a rough capacity envelope with high uncertainty, not a quote. A team without Rust/Windows process experience should expect more. The first useful internal handoff slice comes earlier, after Phases 0–4; do not wait until polished terminal UI to evaluate the thesis.

Critical path: supported auth → real adapter capabilities → storage/security/runtime → manual scoped Brain → exact context delivery → second provider → native recovery/release → user usefulness. Automatic extraction and embeddings do not belong before that path.

## Deliverable coverage map

The founder requested 34 planning outputs. Their locations are explicit:

| Requested outputs | Location |
|---|---|
| 1–6 summary, market, thesis, non-goals, MVP, priorities | Design §§1–5; Research ledger |
| 7–12 architecture, stack, integrations, adapter and events | Design §§6–12 |
| 13–19 Brain, data model, admission, staleness, retrieval, budget, injection | Design §§13–19 |
| 20–25 DB, Git, terminal, security, platforms, recovery | Design §§22–27 |
| 26 UX | Design §§20, 29–30 |
| 27 repository structure | Design §31 |
| 28 tests | Design §32; milestone acceptance criteria |
| 29–30 open source and future paid boundary | Design §33 |
| 31 risks | Design §34 |
| 32 phased roadmap | This plan |
| 33 technical spikes | Phase 0 S0–S4 |
| 34 GO / MODIFY / ABANDON | Design §35 |
| Final requested starting section | Design §37 |

Planning is complete only when sources/links, coverage, contradictions and stated limitations have been checked. Product feasibility is still unproven until Phase 0 evidence exists.
