# Journal: primary-source research ledger

Checked **1 October 2026**, using the user's Asia/Jerusalem date context. This is a targeted market/technical investigation, not exhaustive competitive due diligence. Primary official docs were read through web retrieval; open-source architecture and adapter files were also fetched directly from upstream GitHub. No product was installed or benchmarked, no authenticated coding task was run, and no provider or third party was contacted.

## What the evidence supports

### Follow-up: reuse existing agent integrations

The user's follow-up asked specifically how Superset, dev3 and Conductor connect
Claude and Codex. The recommendation is **reuse first**. Their implementations
establish technical feasibility; Journal does not need a new agent loop or a new
subscription-login implementation. Runtime validation should test compatibility
of the selected existing route, not investigate basic feasibility from scratch.

Sources below were inspected at Superset commit
`71c6ec8ad6a61425c139ca7309a99d97d1d0d6c0` and dev3 commit
`ff63aa8a5ab7982f5b56672dd488ed49e06b607b`.

| Product | Launch and authentication | Events, approvals and resume | Reuse conclusion |
|---|---|---|---|
| Superset | Two paths: real CLI wrappers with inherited config/environment, and structured chat adapters using Claude Agent SDK `query()` / Codex `app-server --stdio`. The inspected SDK adapter does not implement its own OAuth login. | Claude maps SDK messages into adapter events, waits for `canUseTool` decisions, supports interruption and resumes by harness session ID. Codex exchanges JSON-RPC messages, handles server requests, starts/resumes threads and starts turns. Terminal wrappers merge lifecycle hooks without deleting user hooks. | Strong reference for the structured adapter boundary. Root license is ELv2, not a permissive OSS license; copying these adapters would carry its conditions. Do not describe direct copying as an Apache/MIT reuse route. |
| dev3 | Agent descriptors generate commands for the existing `claude` and `codex` binaries. No new provider login is part of those descriptors. Backend credentials remain in the user's agent setup. | Claude receives a preassigned session ID and resumes with `--resume <id>`; Codex gets its real session ID from hooks and uses `codex resume <id>`. Hooks report working, waiting for permission and turn completion. Permissions remain agent-native. Terminal runtime has explicit tmux/native backends. | Best direct code-reuse candidate among these three: Apache 2.0 root license. Extract descriptors, hook integration and exact-session mapping first; a full fork is a candidate, not yet an approved decision. |
| Conductor | Public docs describe bundled Claude/Codex executables, existing CLI login or explicit API-key mode, and direct local provider requests. Subscription billing belongs to the selected provider account. | Public docs describe tool approvals, modes and isolated workspaces. The precise event transport, approval bridge and restart implementation cannot be established without public implementation source. | Useful behavioral/onboarding reference. Do not claim its internal transport is SDK, PTY or app-server solely from the presence of bundled executables. No implementation code was available to reuse. |

Pinned implementation evidence:

- [Superset Claude SDK wiring](https://github.com/superset-sh/superset/blob/71c6ec8ad6a61425c139ca7309a99d97d1d0d6c0/packages/chat-runtime/src/harness/claude/createClaudeAdapter/createClaudeAdapter.ts) and [adapter](https://github.com/superset-sh/superset/blob/71c6ec8ad6a61425c139ca7309a99d97d1d0d6c0/packages/chat-runtime/src/harness/claude/claudeAdapter/claudeAdapter.ts).
- [Superset Codex transport](https://github.com/superset-sh/superset/blob/71c6ec8ad6a61425c139ca7309a99d97d1d0d6c0/packages/chat-runtime/src/harness/codex/rpcClient/rpcClient.ts) and [adapter](https://github.com/superset-sh/superset/blob/71c6ec8ad6a61425c139ca7309a99d97d1d0d6c0/packages/chat-runtime/src/harness/codex/codexAdapter/codexAdapter.ts).
- [Superset terminal wrappers/hooks](https://github.com/superset-sh/superset/blob/71c6ec8ad6a61425c139ca7309a99d97d1d0d6c0/packages/agent-setup/src/agent-wrappers-claude-codex-opencode.ts) and [ELv2 license](https://github.com/superset-sh/superset/blob/71c6ec8ad6a61425c139ca7309a99d97d1d0d6c0/LICENSE.md).
- [dev3 Claude descriptor](https://github.com/h0x91b/dev-3.0/blob/ff63aa8a5ab7982f5b56672dd488ed49e06b607b/src/shared/agent-adapters/claude.ts), [Codex descriptor](https://github.com/h0x91b/dev-3.0/blob/ff63aa8a5ab7982f5b56672dd488ed49e06b607b/src/shared/agent-adapters/codex.ts), [session mapping](https://github.com/h0x91b/dev-3.0/blob/ff63aa8a5ab7982f5b56672dd488ed49e06b607b/src/bun/pane-session-capture.ts), [terminal backend selection](https://github.com/h0x91b/dev-3.0/blob/ff63aa8a5ab7982f5b56672dd488ed49e06b607b/src/bun/task-terminal-backend.ts), and [Apache 2.0 license](https://github.com/h0x91b/dev-3.0/blob/ff63aa8a5ab7982f5b56672dd488ed49e06b607b/LICENSE).
- [Conductor provider configuration](https://www.conductor.build/docs/guides/providers), [FAQ](https://www.conductor.build/docs/faq) and [harness overview](https://www.conductor.build/docs/reference/harnesses).

Important integration details from actual code: dev3's Claude launcher makes
permission bypass available as a toggle, while Codex hook setup can use a
hook-trust bypass flag. Do not copy those defaults without deciding Journal's
permission behavior. Superset's inspected Claude adapter uses `settingSources:
[]`, treats accept-for-session like a single allow response, and its `setMode`
only emits a session event. Its Codex adapter explicitly ignores some native
notifications, including diff updates. Thus these are existing foundations, not
proof that every Journal capability is already implemented.

Next implementation decision: compare extending dev3 against extracting its
small agent/hook modules into a separate runtime. Do not freeze Tauri before
that comparison: dev3 is Bun/Electrobun and Superset is Node/Electron; forcing
either runtime into Rust would consume the savings. For a structured chat UI,
use official SDK/app-server contracts with our own narrow adapter, or select an
appropriately licensed existing adapter. Keep native CLI permissions/login and
exact session IDs. Reuse upstream test fixtures where their licenses allow it.
The compatibility check should cover login mode, tool allow/deny, interrupt,
exact-session resume, app restart and both target operating systems.

Static source inspection was performed; no agents were launched and no runtime
tests passed as part of this research. Existing technical implementations do not
establish provider-policy approval for a new product. That remaining release
question should not be conflated with an unresolved technical connection.

Execution/worktree cockpits and persistent agent memory already exist. The proposed product's remaining hypothesis is checkout-aware, evidence-backed memory integrated with explainable delivery and actual observed execution. A claim that no competitor offers these capabilities would exceed the evidence. The design uses “not established in inspected sources” rather than false absence claims.

### Workspace and agent products

| Source inspected | Direct primary evidence | Finding and limit |
|---|---|---|
| Superset | [Repo](https://github.com/superset-sh/superset), [host architecture](https://github.com/superset-sh/superset/blob/71c6ec8ad6a61425c139ca7309a99d97d1d0d6c0/apps/desktop/docs/HOST_SERVICE_ARCHITECTURE.md), [desktop dependencies](https://github.com/superset-sh/superset/blob/71c6ec8ad6a61425c139ca7309a99d97d1d0d6c0/apps/desktop/package.json), [Codex adapter](https://github.com/superset-sh/superset/blob/71c6ec8ad6a61425c139ca7309a99d97d1d0d6c0/packages/chat-runtime/src/harness/codex/codexAdapter/codexAdapter.ts), [Claude adapter](https://github.com/superset-sh/superset/blob/71c6ec8ad6a61425c139ca7309a99d97d1d0d6c0/packages/chat-runtime/src/harness/claude/claudeAdapter/claudeAdapter.ts) | Electron desktop, separate host/runtime ownership, Codex RPC and Claude SDK adapters are concrete source evidence. Not just a PTY wrapper. Brain validity/admission features not established; “memory” file names can refer to RAM, not durable knowledge. |
| Conductor | [Current product](https://www.conductor.build/), [docs](https://www.conductor.build/docs), [security](https://www.conductor.build/docs/reference/security-and-permissions), [privacy](https://www.conductor.build/docs/reference/privacy) | Current docs cover local and cloud workspaces, parallel agents and review. Privacy distinguishes provider-bound local chat from server-stored cloud sessions. Proprietary implementation was unavailable; marketing subscription claims do not settle our provider-policy obligations. |
| dev-3.0 | [Repo](https://github.com/h0x91b/dev-3.0), [agent matrix](https://github.com/h0x91b/dev-3.0/blob/ff63aa8a5ab7982f5b56672dd488ed49e06b607b/agent-support-matrix.md), [package](https://github.com/h0x91b/dev-3.0/blob/ff63aa8a5ab7982f5b56672dd488ed49e06b607b/package.json), [releases](https://github.com/h0x91b/dev-3.0/releases) | Electrobun/Bun/React/Vite source; agent-specific launch/resume/trust/hooks matrix. Repo states Mac ARM/Intel, native Windows x64 and Linux headless support. Windows release availability is verified, runtime quality is not. |
| Codex | [App-server](https://learn.chatgpt.com/docs/app-server), [customization](https://learn.chatgpt.com/docs/customization/overview), [Memories](https://learn.chatgpt.com/docs/customization/memories), [commands](https://learn.chatgpt.com/docs/developer-commands), [sandbox](https://learn.chatgpt.com/docs/sandboxing) | First-party workspace/memory/instruction capabilities substantially overlap. Structured local integration is available; hidden reasoning/full context visibility is not a universal contract. Local OSS versus commercial/hosted auth boundary matters. |
| Claude Code | [Memory](https://code.claude.com/docs/en/memory), [hooks](https://code.claude.com/docs/en/hooks), [setup](https://code.claude.com/docs/en/setup), [SDK](https://code.claude.com/docs/en/agent-sdk/overview) | Explicit repo rules and auto memory already exist; repo worktrees share auto memory. Hooks/SDK offer observable integration. Native Windows setup and sandbox limitations are documented. A complete cross-agent Brain is not established. |
| Claude Squad | [Repo](https://github.com/smtg-ai/claude-squad), [Windows tmux path](https://github.com/smtg-ai/claude-squad/blob/ce1ffb4392b01f38e2c4599c7c84d2a93973b138/session/tmux/tmux_windows.go) | Go/TUI, tmux, worktree workflow. Multiple CLI agents documented. Windows-specific source does not prove native ConPTY/product parity; do not import its tmux assumptions into Journal. |
| OpenCode | [Repo](https://github.com/anomalyco/opencode), [README snapshot](https://github.com/anomalyco/opencode/blob/e9f8a210b9e2b1e13d375b84906069886eb3b767/README.md) | Own open-source coding-agent runtime with terminal/desktop and model providers. Official installed-agent hosting is a different promise from calling models under another harness. |
| Emdash | [Repo](https://github.com/generalaction/emdash), [architecture source](https://github.com/generalaction/emdash/blob/b179913b8c80e075a70141d1646cda769b99dfa5/AGENTS.md), [docs](https://emdash.com/docs) | Source describes Electron, isolated worktrees, CLI providers, ACP, terminal/process runtime and shared packages. A direct local-first cross-platform competitor; no basis to market Windows support as unique. |
| T3 Code | [Repo](https://github.com/pingdotgg/t3code), [architecture](https://github.com/pingdotgg/t3code/blob/d5980a0ff1511e6ae1f1876406a7c45a7a989cdb/docs/internals/overview.md), [Codex adapter](https://github.com/pingdotgg/t3code/blob/d5980a0ff1511e6ae1f1876406a7c45a7a989cdb/apps/server/src/provider/Layers/CodexAdapter.ts), [Claude adapter](https://github.com/pingdotgg/t3code/blob/d5980a0ff1511e6ae1f1876406a7c45a7a989cdb/apps/server/src/provider/Layers/ClaudeAdapter.ts), [installation](https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md) | Electron/web/mobile control surface, provider adapter abstraction, durable transactional orchestration and server-owned execution. Code specifically uses Codex app-server and Claude Agent SDK. Existing implementations support technical feasibility, not policy entitlement for our application. |

### Memory and observability products

| Source inspected | Direct primary evidence | Finding and limit |
|---|---|---|
| Engram | [Repo](https://github.com/jsflax/Engram), [memory model](https://github.com/jsflax/Engram/blob/5e0862b6af90578a0e2899bd379fb2b9be9f9703/Sources/EngramModels/Memory.swift), [ranking/conflicts](https://github.com/jsflax/Engram/blob/5e0862b6af90578a0e2899bd379fb2b9be9f9703/Sources/EngramMemoryCore/Ranking.swift) | Swift memory model/source/expiry, recall ranking and conflict thresholds; repo documents MCP, local embeddings, Codex learning and desktop visualization. Strong partial substitute. No complete multi-agent worktree execution cockpit established. |
| claude-mem | [Repo](https://github.com/thedotmack/claude-mem), [architecture](https://github.com/thedotmack/claude-mem/blob/478e5774d1793faef0f103fd07a60077e5205977/docs/architecture-overview.md), [adapter contract](https://github.com/thedotmack/claude-mem/blob/478e5774d1793faef0f103fd07a60077e5205977/docs/adapters.md) | Hooks → worker → SDK extraction → SQLite/Chroma → context/search; adapter docs and tree include Codex/general integrations. Do not dismiss it as Claude-only just from the name. Tree presence is not proof that all platforms/providers have equivalent behavior. |
| Mem0 | [Repo](https://github.com/mem0ai/mem0) | General memory infrastructure; useful design baseline, not an integrated Git/PTY desktop workflow. Do not equate installing a memory library with solving repo validity. |
| Graphiti | [Repo](https://github.com/getzep/graphiti), [MCP architecture/tools](https://github.com/getzep/graphiti/blob/main/mcp_server/README.md), [tool implementation](https://github.com/getzep/graphiti/blob/main/mcp_server/src/graphiti_mcp_server.py) | Temporal fact filters, episode provenance and graph memory are existing capabilities. Borrow concepts; mandatory graph runtime/LLM operations would add desktop installation and maintenance burden. |
| Langfuse | [Current deployment](https://github.com/langfuse/langfuse/blob/main/docker-compose.yml), [contributor architecture](https://github.com/langfuse/langfuse/blob/main/CONTRIBUTING.md) | Multi-component observability infrastructure illustrates why a full hosted analytics backend is disproportionate for MVP. No inference that it can observe private CLI internals without instrumentation. |
| Phoenix | [Repo](https://github.com/Arize-ai/phoenix), [tracing tutorial](https://github.com/Arize-ai/phoenix/blob/main/js/examples/apps/tracing-tutorial/README.md), [OpenInference migration](https://github.com/Arize-ai/phoenix/blob/main/MIGRATION.md) | Existing trace/retrieval/evaluation tooling; instrumentation/export patterns can be reused later. Not a substitute for native process/workspace ownership. |

## Official integration facts used in the design

| Question | Primary source | What is established / what remains open |
|---|---|---|
| Can Codex be hosted through a documented protocol? | [App-server protocol](https://learn.chatgpt.com/docs/app-server) | Yes: stdio JSONL, lifecycle/events/approvals, installed-version schema generation. Real supported-version compatibility/resume must be spiked. Experimental transports/features should not anchor MVP. |
| Can the product reuse Codex auth locally? | [App-server authentication](https://learn.chatgpt.com/docs/app-server#authentication) | Docs distinguish local/open-source applications from commercial or hosted services. Our future cloud auth is a separate design decision. Do not extract auth files. |
| Is Claude SDK subscription reuse safe to assume? | [SDK overview](https://code.claude.com/docs/en/agent-sdk/overview), [credential policy](https://code.claude.com/docs/en/legal-and-compliance) | No: third-party login/rate-limit offering requires approval; SDK third-party route should use supported API/cloud authentication. Hosting the user's interactive CLI remains a separately qualified policy question. |
| What structured CLI output exists? | [Claude programmatic CLI](https://code.claude.com/docs/en/headless), [CLI reference](https://code.claude.com/docs/en/cli-reference) | JSON/stream-json, partial messages and native resume/options documented. CLI print mode is described as SDK usage; it is not an automatic subscription-policy exemption. |
| How can Claude get context without changing repo files? | [Hooks reference](https://code.claude.com/docs/en/hooks) | `additionalContext` is a documented channel. Character limits, event delivery and acknowledgment vary; preserve receipts and avoid claiming full effective context visibility. |
| What can be observed with Claude monitoring? | [Monitoring](https://code.claude.com/docs/en/monitoring-usage) | Documented telemetry surfaces exist; activation/output still needs a selected-route/version test. They do not reveal hidden reasoning. |
| What is Windows support today? | [Claude native setup](https://code.claude.com/docs/en/setup), [Codex sandbox](https://learn.chatgpt.com/docs/sandboxing) | Native CLI operation is documented. Claude native versus WSL2 sandbox differences and agent-specific shells matter. “Windows requires WSL” is not a justified blanket assumption. |
| Should ACP be evaluated? | [ACP introduction](https://agentclientprotocol.com/get-started/introduction), [Claude ACP bridge](https://github.com/agentclientprotocol/claude-agent-acp) | Real interoperable client protocol, but bridges can depend on SDKs and their policy/capability limits. Use as a later transport, not an invented universal vendor API. |

Exact API details can change. The plan requires generating/reviewing version-specific Codex schemas and using actual SDK typings. The proposed `AgentAdapter` DTOs and normalized events are our design, not invented vendor methods.

## Stack, persistence, terminals, licensing and name

- [Tauri 2 overview](https://v2.tauri.app/start/): system-webview frontend with native core; compare actual application footprint, not tiny hello-world bundle marketing.
- [Electron security](https://www.electronjs.org/docs/latest/tutorial/security): privileged desktop UI needs a strict renderer boundary; Electron remains a mature practical fallback.
- [Electrobun platform guide](https://github.com/blackboardsh/electrobun/blob/main/docs/src/content/docs/electrobun/guides/cross-platform-development.mdx): native runner/build/rendering differences and current release targets; Intel Mac support must not be assumed from old descriptions.
- [portable-pty](https://docs.rs/portable-pty/latest/portable_pty/): portable PTY interface; [Microsoft ConPTY session guide](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session): native process/pseudoconsole lifecycle. Journal must validate its chosen library's lifecycle integration on real Windows.
- [xterm security](https://xtermjs.org/docs/guides/security/) and [flow control](https://xtermjs.org/docs/guides/flowcontrol/): reuse terminal rendering; privileged JS/output boundaries and fast-producer backpressure need application-level handling.
- [SQLite FTS5](https://www.sqlite.org/fts5.html) and [WAL](https://www.sqlite.org/wal.html): lexical search and local transactional persistence are suitable; keep live backups, writer contention, checkpoints and version fixes in scope.
- [Git worktree](https://git-scm.com/docs/git-worktree): real lifecycle/ownership operations; a worktree is filesystem/Git isolation, not a process sandbox.
- [Apache-2.0 text](https://www.apache.org/licenses/LICENSE-2.0), [MIT text](https://opensource.org/license/mit): alternatives evaluated for original code during research. The user subsequently selected Apache-2.0 for Journal, and on 4 October 2026 moved it to the source-available Elastic License 2.0; see [LICENSE](../LICENSE) and [NOTICE](../NOTICE).
- [BLACKBOX AI agents](https://www.blackbox.ai/agents), [developer product docs](https://docs.blackbox.ai/features/vscode-agent/introduction): direct developer/coding-agent brand collision. Actual trademark search/clearance was not conducted.

## Repository snapshots

Repository trees were queried through the GitHub API, and relevant files read directly. HEAD moved during the investigation for some actively developed repos; links above preserve an inspected snapshot where available. These are identifiers for source inspection, not tested product versions.

| Repo | Inspected snapshot identifier |
|---|---|
| superset-sh/superset | `71c6ec8ad6a61425c139ca7309a99d97d1d0d6c0` |
| h0x91b/dev-3.0 | `ff63aa8a5ab7982f5b56672dd488ed49e06b607b` |
| smtg-ai/claude-squad | `ce1ffb4392b01f38e2c4599c7c84d2a93973b138` |
| anomalyco/opencode | `e9f8a210b9e2b1e13d375b84906069886eb3b767` |
| generalaction/emdash | `b179913b8c80e075a70141d1646cda769b99dfa5` |
| pingdotgg/t3code | `d5980a0ff1511e6ae1f1876406a7c45a7a989cdb`; later HEAD `bd89c1302026255c62cc09278207bfaf2664da4a` |
| jsflax/Engram | `5e0862b6af90578a0e2899bd379fb2b9be9f9703` |
| thedotmack/claude-mem | `478e5774d1793faef0f103fd07a60077e5205977`; later HEAD `9b1e276752feb5d619edf09de89f9acd03c9ae5b` |

## Research limitations and reproducibility

Only selected source files/sections were inspected. This is not a security audit, full license inventory or exhaustive examination of every repo. Missing path matches never count as proof of missing features. User issue reports about performance were discovered but are not used as benchmarks or verified current regressions.

Some old docs URLs redirected to current official domains (OpenAI to `learn.chatgpt.com`, Claude SDK to `code.claude.com`, Conductor to its own current docs). Markdown endpoints and oversized SDK pages could not always be fetched through web retrieval; canonical rendered pages and official overview/CLI/hook sources were used. Guessed T3/Emdash repo names returned 404 and were corrected to the primary repos listed above. A guessed Codex protocol source path also failed; no claims rely on that missing file. No local implementation depends on undocumented source paths.

No authenticated feasibility probe, model extraction eval, Windows process test, installer test, user interview, provider permission request or trademark clearance occurred. Scores, budgets, latency/retention targets and time estimates are **proposed policies**, not published empirical results. Recheck integration/policy/docs immediately before Phase 0 execution and before any public release; maintain a dated supported-version matrix.

## Questions that require evidence rather than more architecture prose

1. Which Claude integration route is policy-supported for the desired subscription experience?
2. What approval, resume, conversation and context acknowledgments survive on actual supported versions and native Windows?
3. Do scoped validated memories prevent repeat mistakes better than curated repo docs/native memory/existing memory tools?
4. Does the Tauri runtime/SDK bridge actually reduce resource/maintenance cost versus Electron in this product?
5. Can strict admission yield enough useful knowledge with less than two minutes of median review burden per task?

Answers determine GO/MODIFY/ABANDON. They were deliberately not invented in the design.
