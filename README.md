# Journal

Local desktop workspace for Claude Code and Codex, with manually reviewed project knowledge and visible context receipts.

**Current phase: first working terminal-only slice.** The larger roadmap remains in the research docs. Original Journal code uses Electron, React, SQLite, node-pty and xterm.js. There is no dev3 vendor or reused dev3 code.

## Run locally

Requires Node.js 24 or newer, Git, and an installed `claude` and/or `codex` CLI on PATH. Native module installation needs a C++ toolchain (Xcode command-line tools on macOS; Visual Studio C++ build tools on Windows). Journal uses existing CLI login, settings and permissions.

```sh
npm ci
npm run dev
```

For the production renderer, run `npm run build` followed by `npm start`. If node-pty has been rebuilt for system Node, restore Electron compatibility with `npm run rebuild`.

1. Open an existing Git checkout.
2. Click **Add project brief** to describe what the repo is, its structure and stable constraints once. Use checkout scope for the repo overview and branch scope for current progress/next steps. Attach an explicit source note or 1–30 lines from a tracked file, review and **Approve**. Current briefs orient every session, including empty tasks.
3. Enter an initial task and **Preview context**. Start Claude or Codex; interaction and tool approvals stay in the native terminal.
4. Stop before switching providers. The current repo overview, exact-branch update and relevant task knowledge are revalidated and supplied to either CLI. Revise/approve status when work changes; progress is not inferred automatically from terminal output.
5. **Resume** targets a confirmed exact session. Codex needs confirmation of the UUID from its native CLI after stopping; Journal never selects the latest session automatically.

Keyboard: Cmd/Ctrl+O opens a project, Cmd/Ctrl+N focuses the task, Cmd/Ctrl+Shift+K adds knowledge. Ctrl+C in the terminal or **Interrupt** reaches the native process.

Knowledge, source excerpts, initial tasks, session metadata and context receipts persist in Electron's user-data directory. `JOURNAL_DATA_DIR` selects a different directory. Terminal output and keystrokes are volatile. Window reload reconnects; quitting stops the terminal, and reopening offers explicit native resume.

## Verification and limits

Run checks manually on your own computer. CI, hosted runners, nightly tests and scheduled checks are disabled at this stage; the former GitHub Actions workflow has been removed.

```sh
npm test
npm run check
npm run build
npm run test:desktop
npm run smoke:agents
```

Verified locally on macOS: 47 core tests, typecheck, production build and three desktop scenarios. Real Electron/node-pty fixtures cover knowledge handoff, exact resume, separate resume-ID drafts, output flood, reload/replay suppression, running-child interrupt/stop/app exit and empty-task repo overview/current-branch delivery.

The [local native trial](docs/NATIVE-VALIDATION.md) completed authenticated Codex/Claude tasks, reviewed knowledge handoff, exact native resume, Claude manual refusal/approval and Codex inference interruption. The [follow-up](docs/LIFECYCLE-AND-MEMORY-VALIDATION.md) stopped a running native background command with CLI exit and observed fresh Codex UUID-hint capture. Codex used the user-selected `gpt-5.6-luna` for trials only. Interactive Codex approval, broader process/crash cases and native Windows remain unverified. No packaged or signed release.

`npm run pilot:memory` runs the manual offline retrieval pilot: 28 frozen synthetic claims and 20 labelled tasks, without provider requests. It demonstrates scope/evidence exclusion in this sample and remaining lexical relevance limits, not improved model quality or time savings.

One active terminal, manual knowledge entry, exact branch/checkout scope and lexical search. Automatic extraction, structured chat, cloud sync, background jobs, runtime sidecar and cross-worktree promotion remain roadmap work. Source fingerprints detect changes; they do not prove a claim is true. Receipts record launch text, not model acknowledgment.

## Documents

- [Current specification](docs/TERMINAL-FIRST-SPEC.md)
- [Repo overview and branch updates](docs/PROJECT-ORIENTATION.md)
- [Foundation decision and source policy](docs/adr/002-terminal-first-foundation.md)
- [Implementation status and evidence](docs/IMPLEMENTATION-STATUS.md)
- [Executive summary](docs/EXECUTIVE-SUMMARY.md)
- [Original design proposal](docs/JOURNAL-DESIGN.md)
- [Historical full-product roadmap](docs/IMPLEMENTATION-PLAN.md)
- [Source ledger](docs/RESEARCH.md)

Earlier research records design alternatives. The current specification and later user instructions take precedence.

## License

Journal is licensed under the [Apache License 2.0](LICENSE).

Copyright 2026 Adir Zak
