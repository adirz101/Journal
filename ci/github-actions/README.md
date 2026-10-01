# Staged GitHub Actions workflows (BLOCKED: not active)

`ci.yml` (fixture-only checks on macOS, Linux and experimental Windows) and `release.yml` (unsigned build artifacts, no publishing) are ready but **not active**. Pushing files under `.github/workflows/` requires a GitHub token with the `workflow` scope, and the token available on 2 October 2026 had only `repo`, `gist`, `project`, `read:org` and `admin:public_key`.

To activate them:

```sh
gh auth refresh -h github.com -s workflow
mkdir -p .github/workflows
git mv ci/github-actions/ci.yml ci/github-actions/release.yml .github/workflows/
git commit -m "Activate fixture-only CI and release workflows"
git push
```

Until then, run the same checks locally: `npm ci && npm test && npm run check && npm run build && npm run test:desktop`.
