# Contributing to Journal

Journal is early-stage alpha software. Contributions are welcome, especially small, focused fixes. For larger changes, open an issue first so the approach can be agreed before you invest time.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the desktop shell, terminal runtime and knowledge store fit together.

## Prerequisites

- Node.js **24 or newer** and Git.
- A C++ toolchain for building `node-pty`: Xcode command-line tools on macOS, Visual Studio C++ build tools on Windows, or `build-essential` and `python3` on Linux.
- Network access during install: `postinstall` downloads Electron and rebuilds `node-pty` for it.
- Optional: an installed `claude` and/or `codex` CLI with its own native login, for manual provider trials only.

## Setup

```sh
npm ci
npm run dev
```

If `node-pty` was rebuilt for system Node, restore Electron compatibility with `npm run rebuild`.

### A sandbox warning on macOS

`npm run dev` on macOS 27 may print one line such as:

```
sandbox_extension_issue_file failed for …/.cache/electron-runtime/<version>/Journal.app/Contents/Frameworks/Electron Helper.app/Contents/Resources: 1 (Operation not permitted)
```

It is harmless. macOS's own sandbox library prints it when a system framework asks it to grant access to a folder that the development Electron bundle does not have (Electron's npm build ships helpers without a `Contents/Resources` folder and with an ad-hoc, linker-only signature). Journal's code asks for no such grant: a bare Electron app that opens one hidden sandboxed window prints it too, and the unmodified `node_modules/electron` binary prints a sibling line (`sandbox_extension_issue_file_to_process failed for …/Electron.app`) on every start. It may appear only on some starts. Nothing fails: the renderer, the runtime and the tests run normally. Journal does not filter it, because hiding it would mean rewriting Electron's standard error stream. `codesign --verify --deep --strict` reports "code has no resources but signature indicates they must be present" for the stock Electron bundle as well, so that message is not caused by Journal's copy either.

## Checks

Run these before opening a pull request:

```sh
npm test              # unit and integration tests (node --test)
npm run check         # TypeScript
npm run build         # production renderer
npm run test:desktop  # Playwright Electron tests with fixture CLIs
```

On Linux without a display, run desktop tests with `xvfb-run -a npm run test:desktop`.

## Data, releases and benchmarks

- `npm run data:restore -- <backup.sqlite>` restores a backup made in the app (Journal must be closed).
- `npm run notices` regenerates third-party notices; see [docs/RELEASING.md](docs/RELEASING.md).
- `node scripts/benchmark.mjs <suite> …` runs a usefulness benchmark with real paid Claude requests on your own account; never in CI. See [docs/BENCHMARK.md](docs/BENCHMARK.md).

## CI and provider trials

CI (`.github/workflows/ci.yml`) runs the checks above on macOS, Linux and Windows using **fixture CLIs only**; the release workflow (`.github/workflows/release.yml`) packages and smoke-tests macOS and Windows builds (see [RELEASING](docs/RELEASING.md)). It never uses real Claude Code or Codex logins, provider requests or secrets. Windows desktop tests are experimental and do not fail the run.

Some trials exercise the real native CLIs. They are manual and local only:

- `npm run smoke:agents` launches your installed CLIs.
- `npm run trial:usefulness` makes real, paid model requests on your own account.

Never add these to CI. When reporting their results, say clearly which behavior came from fixtures and which came from an authenticated native CLI.

## Code style

- Match the surrounding code: dense ES modules, no new abstractions without a concrete need.
- Keep comments short and use them to explain *why*, not *what*.
- Add or update tests with behavior changes.
- Preserve native settings and permission prompts, exact-ID resume, reviewed evidence and immutable receipts. Journal must never read credential files or bypass a CLI's own permissions.
- Repository documents and authored text are in English.

## UI guidance

Journal is a dense developer tool used under terminal load.

- Every action must be reachable by keyboard, with a clearly visible focus state.
- No decorative motion on frequent interactions or keyboard commands. Use simple CSS transitions only where they aid understanding.
- Respect `prefers-reduced-motion`, and gate hover effects behind `(hover: hover)` pointer capability.
- Design for both macOS and Windows rather than a single platform's style.

## Pull requests

- Keep each PR focused on one change, and describe what changed and why.
- List the checks you ran, including desktop tests when you touched `src/desktop`, `src/ui` or terminal behavior.
- Call out any effect on providers, permissions, stored data or receipts.
- Update `README.md` or `docs/` when user-visible behavior changes.
- Do not include screenshots or logs that contain private terminal output, tokens or paths you do not want public.

## Commit messages

Use a short imperative summary line (for example, "Add exact-ID resume for Codex"), followed by a blank line and a body explaining the reason when it is not obvious.

## Labels

| Label | Meaning |
| --- | --- |
| `good first issue` | Small, well-scoped task suited to a first contribution. |
| `help wanted` | Maintainers would welcome an outside contribution. |
| `bug` | Something does not work as documented. |
| `enhancement` | New capability or improvement to existing behavior. |
| `docs` | Documentation only. |
| `windows` | Specific to Windows behavior or tooling. |
| `provider:claude` | Concerns Claude Code integration. |
| `provider:codex` | Concerns Codex integration. |
| `security` | Security hardening (report vulnerabilities privately; see [SECURITY.md](SECURITY.md)). |

## License

Journal is source-available under the [Elastic License 2.0](LICENSE). By contributing, you agree that your contributions are licensed under the same Elastic License 2.0 terms and that you have the right to submit them.
