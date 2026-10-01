# Journal

Journal is a local-first workspace for Claude Code and Codex that carries reviewed project knowledge across agent sessions.

Switching agents should not mean rediscovering architecture decisions, constraints, failed approaches, and current project context.

**Early-stage alpha.** The terminal-first workflow works today; the larger roadmap is still in development. No packaged or signed public release is available yet.

![Journal](assets/branding/journal-banner.png)

<!-- TODO: Add a product screenshot or GIF at docs/assets/journal-preview.png. The banner above is branding, not an application preview. -->

## Why Journal?

- Coding agents repeatedly rediscover the same project context.
- Decisions and lessons get trapped inside individual sessions.
- Switching between Claude Code and Codex can lose continuity.
- Journal keeps reviewed knowledge local and selectively supplies it to future sessions.
- Context previews and receipts show the exact knowledge packet and launch text supplied to the CLI.

## What works today

- **Local Git projects and native terminals:** open an existing checkout and run Claude Code or Codex with its existing login, settings, and permission prompts.
- **Reviewed project knowledge:** manually add and approve repo overviews, branch updates, decisions, constraints, conventions, lessons, and issues, backed by a source note or tracked-file excerpt.
- **Checkout and exact-branch scope:** eligible project briefs orient Journal-launched sessions, including empty tasks; task-specific knowledge uses bounded lexical retrieval and source-freshness checks.
- **Context visibility:** preview selected knowledge and exclusions; immutable receipts preserve the launch prompt and delivery state. A receipt records transport, not model acknowledgment.
- **Exact native resume:** explicitly resume a confirmed native session instead of selecting the latest conversation. Codex requires confirmation of its native UUID.
- **Persistent local storage:** knowledge, source excerpts, tasks, session metadata, and receipts stay in Journal's local data directory. Native CLIs send supplied context to their providers according to their own settings.
- **Desktop controls:** blue-accented light/dark themes, keyboard shortcuts, and resizable sidebars retain the live terminal when appearance or layout changes.
- **Apache-2.0 licensing:** Journal's code is licensed under the [Apache License 2.0](LICENSE).

## Current limitations

- Alpha software, with one active terminal at a time and no packaged/signed release, installer, or automatic updates.
- Local validation is on macOS. Native Windows operation is not yet fully validated.
- Knowledge and status updates require manual review. Automatic extraction, cloud sync, background agent orchestration, and cross-worktree knowledge promotion are not implemented.
- Retrieval is lexical, with finite context limits. Source fingerprints detect changes; they do not establish whether a claim is true. Journal does not inject context into conversations launched outside the app.
- Observability depends on what the native CLI exposes. Interactive Codex approvals, broader running-tool cancellation, crash cleanup, and detached child processes remain validation gaps.

## Quick start

Requirements:

- Node.js **24 or newer** and Git.
- An installed `claude` and/or `codex` CLI on `PATH`, with its native login configured.
- A C++ toolchain for native modules: Xcode command-line tools on macOS, or Visual Studio C++ build tools on Windows.

From the repository root:

```sh
npm ci
npm run dev
```

To run the production renderer:

```sh
npm run build
npm start
```

If node-pty has been rebuilt for system Node, restore Electron compatibility with `npm run rebuild`.

On macOS, development and start commands use a cached local `Journal.app` runtime. It opens this checkout directly, including when launched without CLI arguments. This checkout-bound runtime is not a distributable or signed release.

Data remains in the `journal-desktop` directory under Electron's application-data location; set `JOURNAL_DATA_DIR` to use another directory. Terminal output and keystrokes are volatile. Reloading reconnects to the terminal; quitting stops it, and reopening requires explicit native resume.

## Basic workflow

1. **Open a repo.** Select an existing Git checkout.
2. **Add and review knowledge.** Use **Add project brief** for a checkout-wide overview or current-branch update. Attach a source note or 1–30 lines from a tracked file, then review and **Approve**. Keep branch status current by revising and approving it when work changes.
3. **Preview context.** Enter a task and select **Preview context** to inspect the proposed knowledge packet. Eligible briefs are considered even without task text; context is revalidated at launch.
4. **Start Claude or Codex.** Work and approve tools in the native terminal.
5. **Switch providers.** Stop the active terminal before starting the other CLI. Journal supplies the current reviewed overview, applicable branch update, and relevant task knowledge.
6. **Resume explicitly.** Select the session and confirm its exact native ID where required. For Codex, confirm the UUID from the native CLI after stopping. Journal never falls back to the latest session.

Keyboard shortcuts: Cmd/Ctrl+O opens a project, Cmd/Ctrl+N focuses the task, and Cmd/Ctrl+Shift+K adds knowledge. Ctrl+C in the terminal or **Interrupt** sends an interrupt to the native process.

Use **Light mode** / **Dark mode** in the sidebar to change appearance. Drag either sidebar's inner edge to resize it, or focus the divider and use arrow keys (Shift for larger steps), Home/End for limits, or Enter to reset. Double-click also resets. Theme and widths are saved locally.

## Development / verification

Run checks manually on your own computer. There is no CI, hosted-runner, nightly, or scheduled verification at this stage.

```sh
npm test
npm run check
npm run build
npm run test:desktop
npm run smoke:agents
npm run pilot:memory
```

The [current implementation status](docs/IMPLEMENTATION-STATUS.md) records 48 passing core tests, a passing typecheck and production build, and five passing local desktop scenarios. Desktop checks use real Electron/native node-pty with controlled fixture CLIs: they cover context delivery, resume, terminal lifecycle, reload/replay handling, output load, and appearance/layout persistence. These fixtures do not establish authenticated provider behavior.

`smoke:agents` checks installed native CLI startup without submitting a task or accepting trust prompts. `pilot:memory` evaluates local retrieval against 28 frozen synthetic claims and 20 labelled tasks without provider requests; it measures scope/evidence exclusion and lexical relevance, not model quality or time savings.

Separate [authenticated native trials](docs/NATIVE-VALIDATION.md) observed Codex/Claude tasks, reviewed knowledge handoff, exact resume, Claude manual approval/refusal, and Codex inference interruption. A [follow-up](docs/LIFECYCLE-AND-MEMORY-VALIDATION.md) observed native UUID-hint capture and background-command stopping with CLI exit. Codex used invocation-only `gpt-5.6-luna` for these bounded trials; permanent settings were unchanged. These results do not establish universal process cleanup or Windows support.

## Architecture / docs

Journal uses Electron and React, node-pty and xterm.js for terminals, and SQLite for reviewed knowledge and immutable receipts. Git, evidence checks, and storage run in a worker so they do not block terminal handling.

- **Current contract:** [Terminal-first specification](docs/TERMINAL-FIRST-SPEC.md) and [foundation architecture decision](docs/adr/002-terminal-first-foundation.md).
- **Project orientation:** [Repo overviews and branch updates](docs/PROJECT-ORIENTATION.md).
- **Implementation status:** [What is implemented, verified, and still open](docs/IMPLEMENTATION-STATUS.md).
- **Native validation:** [Authenticated provider trials](docs/NATIVE-VALIDATION.md) and [lifecycle/retrieval follow-up](docs/LIFECYCLE-AND-MEMORY-VALIDATION.md).
- **Research:** [Source ledger](docs/RESEARCH.md).
- **Historical design / roadmap:** [Executive summary](docs/EXECUTIVE-SUMMARY.md), [original design](docs/JOURNAL-DESIGN.md), and [full-product roadmap](docs/IMPLEMENTATION-PLAN.md). These describe broader plans, not today's feature set.

## Contributing

Contributions, issues, and feedback are welcome. Contribution guidelines will be added as the project stabilizes.

## License

Journal is licensed under the [Apache License 2.0](LICENSE).

Copyright 2026 Adir Zak
