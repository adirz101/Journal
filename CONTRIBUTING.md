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

## Checks

Run these before opening a pull request:

```sh
npm test              # unit and integration tests (node --test)
npm run check         # TypeScript
npm run build         # production renderer
npm run test:desktop  # Playwright Electron tests with fixture CLIs
```

On Linux without a display, run desktop tests with `xvfb-run -a npm run test:desktop`.

## CI and provider trials

CI is prepared to run the checks above on macOS, Linux and Windows using **fixture CLIs only** (staged in `ci/github-actions/` until it can be activated; see the README there). It never uses real Claude Code or Codex logins, provider requests or secrets. Windows desktop tests are experimental and do not fail the run.

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

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
