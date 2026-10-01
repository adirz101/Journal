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
2. Add a knowledge claim with your explicit source note or 1–30 lines from a tracked file. Review it and click **Approve**.
3. Enter an initial task and **Preview context**. Start Claude or Codex; interaction and tool approvals stay in the native terminal.
4. Stop before switching providers. Knowledge matching the next task is revalidated and supplied to either CLI.
5. **Resume** targets a confirmed exact session. Codex needs confirmation of the UUID from its native CLI after stopping; Journal never selects the latest session automatically.

Keyboard: Cmd/Ctrl+O opens a project, Cmd/Ctrl+N focuses the task, Cmd/Ctrl+Shift+K adds knowledge. Ctrl+C in the terminal or **Interrupt** reaches the native process.

Knowledge, source excerpts, initial tasks, session metadata and context receipts persist in Electron's user-data directory. `JOURNAL_DATA_DIR` selects a different directory. Terminal output and keystrokes are volatile. Window reload reconnects; quitting stops the terminal, and reopening offers explicit native resume.

## Verification and limits

```sh
npm test
npm run check
npm run build
npm run test:desktop
npm run smoke:agents
```

Verified locally on macOS: 33 core tests, typecheck, production build and desktop acceptance. The desktop scenario uses real Electron/node-pty with safe stand-in CLIs: Claude→Codex knowledge handoff, exact resume, 2.2 MB output flood, input/interrupt, renderer reload, device-query replay suppression and app restart.

Native startup smoke produced output from Claude Code 2.1.284 and Codex 0.154.0 without task submission. Claude reached a checkout trust prompt; Codex displayed its native header. An authenticated model turn, permission allow/deny and real-provider native resume are **not** verified end to end. Windows CI is configured but has not run; native Windows behavior remains unverified. No packaged or signed release.

One active terminal, manual knowledge entry, exact branch/checkout scope and lexical search. Automatic extraction, structured chat, cloud sync, background jobs, runtime sidecar and cross-worktree promotion remain roadmap work. Source fingerprints detect changes; they do not prove a claim is true. Receipts record launch text, not model acknowledgment.

## Documents

- [Current specification](docs/TERMINAL-FIRST-SPEC.md)
- [Foundation decision and source policy](docs/adr/002-terminal-first-foundation.md)
- [Implementation status and evidence](docs/IMPLEMENTATION-STATUS.md)
- [Continuation handoff](HANDOFF.md)
- [Executive summary — Hebrew](docs/EXECUTIVE-SUMMARY.he.md)
- [Original design proposal](docs/JOURNAL-DESIGN.md)
- [Historical full-product roadmap](docs/IMPLEMENTATION-PLAN.md)
- [Source ledger](docs/RESEARCH.md)

Earlier research records design alternatives. The current specification and later user instructions take precedence.
