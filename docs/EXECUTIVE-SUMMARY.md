# Journal — research and planning conclusions

Research-stage snapshot, 1 October 2026. This document records the planning conclusions before product implementation or agent experiments. For subsequent implementation and validation, see [current status](IMPLEMENTATION-STATUS.md).

## Recommendation: MODIFY, then a conditional GO

The idea warrants investigation, but a workspace that runs Codex and Claude is no longer sufficient differentiation. Superset, Conductor, dev-3.0, Emdash and T3 Code already cover much of that experience. Persistent memory also exists in provider products and tools such as Engram and claude-mem. The research examined documentation and architecture/adapter files from open repositories, as well as marketing pages. [Sources and checks](RESEARCH.md).

The potential opportunity is **project knowledge that can be trusted and inspected**: sources and evidence for every claim, scope appropriate to the branch and checkout, freshness checks against current code, and an exact record of what each agent received and why. This combination has not yet been shown to outperform an existing workspace paired with an external memory tool.

## An integration constraint that must be addressed

Codex offers a documented app-server interface, with different boundaries for an open-source local application and a commercial/hosted service. Anthropic's Claude documentation restricts third-party products that offer subscription login or quota usage through the SDK. Launching the user's existing CLI is a different technical route, but does not prove blanket permission. Do not promise subscription usage before clarifying that route. [Codex](https://learn.chatgpt.com/docs/app-server#authentication), [SDK policy](https://code.claude.com/docs/en/agent-sdk/overview), [Authentication usage](https://code.claude.com/docs/en/legal-and-compliance).

The clear SDK alternative is a separately billed provider API. A CLI alternative can preserve terminal interaction with partial observation, without promising complete chat and traces. Do not extract tokens or treat competitors' behavior as proof of authorization.

## What to build first

First, a temporary experiment with both agents on local Mac and Windows machines: startup, context, action approval/refusal, file changes and tests, interruption and resume. Then one repository, one session, manually approved memories linked to evidence, text search and a Context Inspector. The first test is knowledge learned while working with Codex and supplied to Claude reviewing the same implementation.

The proposed research-stage stack was **Tauri 2, Rust, React/TypeScript/Vite and SQLite FTS5**, with Git CLI, portable-pty and xterm.js. Electron is a serious alternative if SDK bridging and process packaging erase the advantage. Performance advantages require measurement. The subsequent terminal-only implementation chose Electron; see [ADR 002](adr/002-terminal-first-foundation.md).

## Key memory decisions

- Run history is not persistent memory. Most output will not become future knowledge.
- Decisions and root causes need evidence and approval when their meaning is ambiguous. Passing tests do not prove a root cause.
- Failures retain the environment conditions in which they occurred, rather than becoming universal bans on an approach.
- Knowledge from an experimental branch is not repository-wide truth. Promotion requires appropriate checks and approval.
- Stale or contradictory claims are excluded from automatic injection until resolved. Pinning or importance does not override validity checks.
- The MVP starts without embeddings or a vector database. The context budget is small, and users can inspect every selected item.

## What not to build now

No IDE, task board, complete Git system, large plugin framework, cloud or agent-quality ranking. No view claiming to expose internal reasoning or the model's complete context. SQLite encryption is not guaranteed in the MVP; provider data and history are outside Journal's control.

**The product was renamed Journal at the user's request.** The previous name, Blackbox, was replaced; the original research identified a naming collision with BLACKBOX AI in coding agents. No availability or trademark check has been performed for Journal. [Existing product under the previous name](https://www.blackbox.ai/agents).

## Full documents

- [Research and architecture](JOURNAL-DESIGN.md): memory design, interfaces and schemas, Git, processes, Windows, security, recovery, UX and risks.
- [Implementation plan](IMPLEMENTATION-PLAN.md): feasibility experiments, milestones, deliverables and go/stop criteria.
- [Sources and research limitations](RESEARCH.md): official documentation and code examined.

The development decision should rest on two proofs: a supported integration route for both agents, and a useful improvement over native memory, instruction files or combinations of existing tools. If the advantage lies only in memory, a small companion product may be a better starting point than a complete application.
