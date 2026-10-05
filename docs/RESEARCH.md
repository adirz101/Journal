# Journal: primary-source research ledger

Checked **1 October 2026**, using the user's Asia/Jerusalem date context. This is a targeted technical investigation, not exhaustive due diligence. Primary official docs were read through web retrieval; open-source architecture and adapter files were also fetched directly from upstream GitHub. No product was installed or benchmarked, no authenticated coding task was run, and no provider or third party was contacted.

## What the evidence supports

### How agent workspaces connect to Claude and Codex

Existing desktop agent workspaces use two technical routes, both documented by the providers:

- **Wrap the real CLI.** Launch the user's installed `claude` or `codex` binary in a terminal with its own login, settings and permission prompts; observe it through native hooks; resume with the native session ID (`claude --resume <id>`, `codex resume <id>`). No new provider login is needed.
- **Structured adapters.** Use the Claude Agent SDK and the Codex app-server (JSON-RPC over stdio) to render a chat UI, approvals and resumable threads. This route carries provider-policy questions about subscription use (see below).

Journal took the first route with original code: native terminals, native permissions and exact-ID resume ([ADR 002](adr/002-terminal-first-foundation.md)). No third-party application code is included. Compatibility checks cover login mode, tool allow/deny, interrupt, exact-session resume, app restart and both target operating systems. Existing technical implementations do not establish provider-policy approval for a new product; that release question is separate from the technical connection.

Execution/worktree cockpits and persistent agent memory already exist. The proposed product's remaining hypothesis is checkout-aware, evidence-backed memory integrated with explainable delivery and actual observed execution. A claim that no competitor offers these capabilities would exceed the evidence. The design uses “not established in inspected sources” rather than false absence claims.

### Agent products

| Source inspected | Direct primary evidence | Finding and limit |
|---|---|---|
| Codex | [App-server](https://learn.chatgpt.com/docs/app-server), [customization](https://learn.chatgpt.com/docs/customization/overview), [Memories](https://learn.chatgpt.com/docs/customization/memories), [commands](https://learn.chatgpt.com/docs/developer-commands), [sandbox](https://learn.chatgpt.com/docs/sandboxing) | First-party workspace/memory/instruction capabilities substantially overlap. Structured local integration is available; hidden reasoning/full context visibility is not a universal contract. Local OSS versus commercial/hosted auth boundary matters. |
| Claude Code | [Memory](https://code.claude.com/docs/en/memory), [hooks](https://code.claude.com/docs/en/hooks), [setup](https://code.claude.com/docs/en/setup), [SDK](https://code.claude.com/docs/en/agent-sdk/overview) | Explicit repo rules and auto memory already exist; repo worktrees share auto memory. Hooks/SDK offer observable integration. Native Windows setup and sandbox limitations are documented. A complete cross-agent Brain is not established. |

### Memory and observability products

| Source inspected | Direct primary evidence | Finding and limit |
|---|---|---|
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

## Research limitations and reproducibility

Only selected source files/sections were inspected. This is not a security audit, full license inventory or exhaustive examination of every repo. Missing path matches never count as proof of missing features. User issue reports about performance were discovered but are not used as benchmarks or verified current regressions.

Some old docs URLs redirected to current official domains (OpenAI to `learn.chatgpt.com`, Claude SDK to `code.claude.com`). Markdown endpoints and oversized SDK pages could not always be fetched through web retrieval; canonical rendered pages and official overview/CLI/hook sources were used. A guessed Codex protocol source path also failed; no claims rely on that missing file. No local implementation depends on undocumented source paths.

No authenticated feasibility probe, model extraction eval, Windows process test, installer test, user interview, provider permission request or trademark clearance occurred. Scores, budgets, latency/retention targets and time estimates are **proposed policies**, not published empirical results. Recheck integration/policy/docs immediately before Phase 0 execution and before any public release; maintain a dated supported-version matrix.

## Questions that require evidence rather than more architecture prose

1. Which Claude integration route is policy-supported for the desired subscription experience?
2. What approval, resume, conversation and context acknowledgments survive on actual supported versions and native Windows?
3. Do scoped validated memories prevent repeat mistakes better than curated repo docs, native memory or general memory libraries?
4. Does the Tauri runtime/SDK bridge actually reduce resource/maintenance cost versus Electron in this product?
5. Can strict admission yield enough useful knowledge with less than two minutes of median review burden per task?

Answers determine GO/MODIFY/ABANDON. They were deliberately not invented in the design.
