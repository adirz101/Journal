# Releasing Journal

Status, 2 October 2026: release infrastructure is prepared; no release has been published. Signing is **BLOCKED** on certificates (see below).

## Version and naming
- The single version source is `version` in `package.json`; the app reports it through Electron.
- Artifacts are named `Journal-<version>-<os>-<arch>.<ext>` (`electron-builder.yml`), for example `Journal-0.1.0-mac-arm64.dmg`.
- Targets: macOS `dmg` and `zip` (arm64, x64), Windows `nsis` (x64), Linux `AppImage` and `deb`.

## Local build
```sh
npm ci
npm test && npm run check && npm run test:desktop
npm run dist:dir   # unpacked app in release/ for a quick check
npm run dist       # installers in release/
```
`npm run dist` regenerates `THIRD_PARTY_NOTICES.md` (production dependencies and Electron) and bundles it with `LICENSE` and `NOTICE`. The runtime, hooks and node-pty are unpacked from `app.asar` because a separate Node-mode process executes them; a packaged macOS build was verified to start its runtime.

## Tagged builds (staged)
`ci/github-actions/release.yml` builds on macOS, Windows and Linux, writes `SHA256SUMS-<os>.txt`, uploads workflow artifacts, and for a pushed `v*` tag creates a **draft pre-release** using `.github/release-notes-template.md`. A maintainer reviews and publishes it by hand. The workflow is not active until it is moved to `.github/workflows/` (see `ci/github-actions/README.md`; requires a token with the `workflow` scope).

## Release checklist
1. Update `version` in `package.json`, `docs/IMPLEMENTATION-STATUS.md` and the README if behavior changed.
2. Run the full local suite (above) and, on macOS, the manual native trials in `docs/NATIVE-VALIDATION.md` that cover changed areas.
3. Tag `vX.Y.Z` and push the tag; review the draft pre-release, its checksums and notes; publish manually.

## BLOCKED: signing and notarization
- macOS: requires an Apple Developer ID Application certificate and notarization credentials (App Store Connect API key). Then set `mac.identity`, `hardenedRuntime: true`, entitlements for node-pty, and a notarize step; provide credentials as repository secrets.
- Windows: requires an Authenticode code-signing certificate (or a signing service) and removing `signAndEditExecutable: false`.
- Until then builds are unsigned: macOS Gatekeeper and Windows SmartScreen warn, and auto-update is intentionally not implemented.
