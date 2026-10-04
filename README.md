# Journal

Journal is a local-first workspace for Claude Code, Codex and Cursor that carries reviewed project knowledge across agent sessions.

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

- **Local Git projects and native terminals:** open an existing checkout and run Claude Code, Codex or the Cursor Agent CLI with its existing login, settings, and permission prompts.
- **Cursor:** shown as a provider even before its CLI is installed. Install and sign-in run Cursor's own official commands in a visible terminal, only after you confirm; Journal never handles Cursor credentials. Each Cursor chat is created first so Journal can resume that exact chat; Research starts Cursor in Ask mode and Plan in Plan mode. See [providers](docs/PROVIDERS.md); authenticated validation is still manual.
- **Up to four sessions at once:** a separate local runtime owns the terminals, so reloading the UI, an app crash, or choosing *Keep running in background* on quit leaves agents running; reopening Journal reconnects. A runtime crash is recovered explicitly, without resending prompts.
- **Session views:** per-session state and attention markers, a changes view against the session's starting commit, and an activity timeline with observed commands and exit codes (Claude Code hooks; unknown for Codex).
- **Status-update helper:** propose a branch update or repo overview drafted from Git history; nothing is saved until you review and approve it.
- **Projects:** rename how a project appears in Journal, pin it, add related folders (another repository, docs, a plugin) as context, or remove it from Journal. Your files are never deleted or renamed.
- **Sessions and menus:** rename, pin, archive or remove sessions, and right-click projects or sessions for common actions (reveal, copy path, copy native session ID, resume, stop). Removing never touches files and never silently stops a running agent.
- **Files:** a read-only explorer in the right panel follows the session's workspace, shows Git state, previews files, and hands files or selected lines to the agent as references (paths and line ranges, never pasted contents). It does not edit files.
- **Workspaces:** run a session in the current checkout, a Journal-managed Git worktree created from a base you choose, or an existing worktree. Journal never force-removes, stashes or copies your uncommitted work. Research mode starts each CLI in its own read-only mode (Claude plan mode, Codex read-only sandbox, Cursor Ask mode); it can be changed inside the session, so it is an intent rather than enforcement.
- **Knowledge controls:** pin rules, leave a claim out for one task, mark it incorrect, supersede it, or propose a branch rule for all branches. A deterministic inbox suggests rules you stated in tasks and observed passing test commands, for your review.
- **Data:** integrity-checked backups and restore, knowledge export/import (imports wait for review), session purge, and automatic trimming of old timelines.
- **Reviewed project knowledge:** manually add and approve repo overviews, branch updates, decisions, constraints, conventions, lessons, and issues, backed by a source note or tracked-file excerpt.
- **Checkout and exact-branch scope:** eligible project briefs orient Journal-launched sessions, including empty tasks; task-specific knowledge uses bounded lexical retrieval and source-freshness checks.
- **Context visibility:** preview selected knowledge and exclusions; immutable receipts preserve the launch prompt and delivery state. A receipt records transport, not model acknowledgment.
- **Exact native resume:** explicitly resume a confirmed native session instead of selecting the latest conversation. Codex requires confirmation of its native UUID.
- **Persistent local storage:** knowledge, source excerpts, tasks, session metadata, and receipts stay in Journal's local data directory. Native CLIs send supplied context to their providers according to their own settings.
- **Desktop controls:** blue-accented light/dark themes, keyboard shortcuts, and resizable sidebars retain the live terminal when appearance or layout changes.
- **Apache-2.0 licensing:** Journal's code is licensed under the [Apache License 2.0](LICENSE).

## Download and install

Download the latest build from [GitHub Releases](https://github.com/adirz101/Journal/releases). No Node.js, npm or source checkout is needed. Journal does not include the agent CLIs: install Claude Code, Codex and/or the Cursor Agent CLI with their own installers and logins (Journal shows which it found, and can run Cursor's official installer for you after you confirm).

**macOS (Apple Silicon)**
1. Download `Journal-<version>-arm64.dmg`.
2. Open it.
3. Drag **Journal** to **Applications**.
4. Open Journal from Applications. macOS builds are signed with an Apple Developer ID and notarized by Apple, so they open without security warnings.

**Windows (x64)**
1. Download `Journal-Setup-<version>-x64.exe` (installs for your user in one click, no administrator rights, Start Menu shortcut, uninstall from Settings → Apps) or `Journal-Portable-<version>-x64.exe` (runs without installing).
2. Run it.
3. Alpha builds are unsigned, so SmartScreen may warn ("Windows protected your PC"): choose **More info** → **Run anyway**.

Journal keeps its data per user (macOS `~/Library/Application Support/journal-desktop`, Windows `%APPDATA%\journal-desktop`), also for the portable build; uninstalling keeps it. Verify a download against the release's `SHA256SUMS.txt` (macOS: `shasum -a 256 -c SHA256SUMS.txt --ignore-missing`; Windows: `Get-FileHash <file> -Algorithm SHA256`). Intel Macs are not built yet. See [releasing](docs/RELEASING.md) for signing status.

## Current limitations

- Alpha software: Windows builds are not code-signed yet (macOS builds are signed and notarized), and there are no automatic updates. Sessions in the same checkout share its working tree; use a worktree for isolation.
- Local validation is on macOS. Native Windows operation is unverified; see the [Windows audit](docs/WINDOWS.md).
- Knowledge and status updates require manual review. Automatic extraction, cloud sync, background agent orchestration, and cross-worktree knowledge promotion are not implemented.
- Retrieval is lexical (stemmed, with identifier and path aliases), with finite context limits. Source fingerprints detect changes; they do not establish whether a claim is true. Journal does not inject context into conversations launched outside the app.
- Observability depends on what the native CLI exposes. Interactive Codex approvals, broader running-tool cancellation, crash cleanup, and detached child processes remain validation gaps.

## Run from source

Requirements (development only; release builds need none of these):

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

Data remains in the `journal-desktop` directory under Electron's application-data location; set `JOURNAL_DATA_DIR` to use another directory. Terminal output and keystrokes are volatile and live only in the runtime's bounded memory. Reloading or reopening reconnects to running sessions; quitting asks whether to stop them or keep them running; a stopped session needs explicit native resume.

## Basic workflow

1. **Open a repo.** Select an existing Git checkout.
2. **Add and review knowledge.** Use **Add project brief** for a checkout-wide overview or current-branch update. Attach a source note or 1–30 lines from a tracked file, then review and **Approve**. Keep branch status current by revising and approving it when work changes.
3. **Preview context.** Enter a task and select **Preview context** to inspect the proposed knowledge packet. Eligible briefs are considered even without task text; context is revalidated at launch.
4. **Start Claude or Codex.** Work and approve tools in the native terminal.
5. **Run several agents.** Start up to four sessions, across projects or providers. Each receives the current reviewed overview, applicable branch update, and relevant task knowledge for its own project and branch.
6. **Resume explicitly.** Select the session and confirm its exact native ID where required. For Codex, confirm the UUID from the native CLI after stopping. Journal never falls back to the latest session.

Keyboard shortcuts: Cmd/Ctrl+O opens a project, Cmd/Ctrl+N starts a new session (focuses the task), ⌘1–4 (macOS) or Alt+1–4 switches active sessions, and Cmd/Ctrl+Shift+K adds knowledge. Ctrl+C in the terminal or **Interrupt** sends an interrupt to the native process.

Use **Light mode** / **Dark mode** in the sidebar to change appearance. Drag either sidebar's inner edge to resize it, or focus the divider and use arrow keys (Shift for larger steps), Home/End for limits, or Enter to reset. Double-click also resets. Theme and widths are saved locally.

## Development / verification

Fixture-only GitHub Actions run CI on macOS, Linux and (experimentally) Windows, and the release workflow packages and smoke-tests macOS and Windows builds; they never use provider logins. Provider trials stay manual and local. See [CONTRIBUTING.md](CONTRIBUTING.md).

```sh
npm test
npm run check
npm run build
npm run test:desktop
npm run smoke:agents
npm run pilot:memory
```

The [current implementation status](docs/IMPLEMENTATION-STATUS.md) records 164 passing core tests, a passing typecheck and production build, and sixteen passing desktop scenarios (run headless). Desktop checks use real Electron, the runtime process and node-pty with controlled fixture CLIs: they cover context delivery, resume, four concurrent sessions, reload, app and runtime crashes, process cleanup, worktrees, research mode, and the changes view. These fixtures do not establish authenticated provider behavior.

`smoke:agents` checks installed native CLI startup without submitting a task or accepting trust prompts. `pilot:memory` evaluates local retrieval against 28 frozen synthetic claims and 20 labelled tasks without provider requests; it measures scope/evidence exclusion and lexical relevance, not model quality or time savings.

Separate [authenticated native trials](docs/NATIVE-VALIDATION.md) observed Codex/Claude tasks, reviewed knowledge handoff, exact resume, Claude manual approval/refusal, and Codex inference interruption. A [follow-up](docs/LIFECYCLE-AND-MEMORY-VALIDATION.md) observed native UUID-hint capture and background-command stopping with CLI exit. Codex used invocation-only `gpt-5.6-luna` for these bounded trials; permanent settings were unchanged. These results do not establish universal process cleanup or Windows support.

## Architecture / docs

Journal uses Electron and React for the app, a separate local runtime process with node-pty for terminals, xterm.js for display, and SQLite for reviewed knowledge, session metadata and immutable receipts. See [ARCHITECTURE.md](docs/ARCHITECTURE.md).

- **Providers:** [Versions and observability](docs/PROVIDERS.md).
- **Releasing and benchmarks:** [Release process](docs/RELEASING.md) and [usefulness benchmark](docs/BENCHMARK.md).
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
