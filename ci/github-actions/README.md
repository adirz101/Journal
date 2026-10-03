# Staged GitHub Actions workflows (not active yet)

- `ci.yml`: fixture-only checks on macOS, Linux and experimental Windows for pushes and pull requests.
- `release.yml`: for a pushed `v*` tag, verifies the tag against `package.json`, runs the tests, packages Journal on hosted macOS (arm64) and Windows (x64) runners, smoke-tests the packaged apps (DMG app, per-user installer, portable EXE, uninstall), and creates a **draft** GitHub Release with the installers, `SHA256SUMS.txt` and `THIRD-PARTY-NOTICES.txt`. Nothing is published automatically. Manual runs build and test without releasing.

Both use only standard hosted runners and fixture CLIs: no provider logins, provider requests or secrets (signing secrets are optional; see `docs/RELEASING.md`).

## Activating them (needs the `workflow` token scope)

Pushing files under `.github/workflows/` requires a GitHub token with the `workflow` scope. The current token has `repo`, `gist`, `project`, `read:org` and `admin:public_key`.

```sh
gh auth refresh -h github.com -s workflow   # interactive: shows a one-time code and opens github.com to approve
mkdir -p .github/workflows
git mv ci/github-actions/ci.yml ci/github-actions/release.yml .github/workflows/
git commit -m "Activate CI and release workflows"
git push
```

Until then, run the same checks locally: `npm ci && npm test && npm run check && npm run build && npm run test:desktop`, and package with `npm run dist:mac` (on a Mac) followed by `npm run release:audit -- release/mac-arm64/Journal.app` and `npm run smoke:packaged -- <app executable>`.
