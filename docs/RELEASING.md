# Releasing Journal

Status, 4 October 2026: packaging and the release pipeline are implemented. macOS arm64 packages are built and validated locally. The workflows are staged in `ci/github-actions/` until a token with the `workflow` scope activates them, so Windows packages have not been built yet. Builds are unsigned (macOS ad-hoc). No release has been published.

## Version: one source
- `version` in `package.json` (for example `0.2.0-alpha`) is the only version. Electron reports it as the app version (`CFBundleShortVersionString` on macOS, file and product version on Windows), artifact names come from it, and the release tag must be exactly `v<version>`.
- `scripts/release-check.mjs` fails a release when the tag, `package.json` and the packaging configuration's artifact names disagree, or when a platform produced missing or unexpected installers.

## Artifacts
| Platform | Files | Notes |
| --- | --- | --- |
| macOS arm64 | `Journal-<version>-arm64.dmg`, `Journal-<version>-arm64.zip` | DMG shows Journal.app and an Applications link (drag to install); the ZIP holds the same app. Intel (x64) is not built yet: it needs node-pty compiled for x64 and its own smoke test. |
| Windows x64 | `Journal-Setup-<version>-x64.exe`, `Journal-Portable-<version>-x64.exe` | NSIS installer: per user (`%LOCALAPPDATA%\Programs\Journal`), no administrator rights, Start Menu shortcut, uninstaller; Journal data is kept on uninstall. Portable: runs without installing and still stores data per user. |
| All | `SHA256SUMS.txt`, `THIRD-PARTY-NOTICES.txt` | Checksums in `sha256sum` format; notices for every shipped package (runtime modules, the libraries bundled into the UI, Electron). |

- Bundle identifier / AppUserModelID: **`io.github.adirz101.journal`**. Never change it after a release.
- Data directory: `journal-desktop` under the per-user application-data folder (macOS `~/Library/Application Support`, Windows `%APPDATA%`), the same for installed, portable and development builds. `JOURNAL_DATA_DIR` overrides it.
- Packaging config: `electron-builder.config.cjs`. Only `node-pty` ships as a Node module: the UI libraries are bundled by Vite and are `devDependencies` (listed in `package.json` `journal.rendererBundle` so their licenses ship). node-pty is rebuilt for the bundled Electron, its unused sources and prebuilds are excluded, and an `afterPack` hook (`scripts/after-pack.cjs`) fixes node-pty's spawn-helper path for an unpacked module (without it, every packaged terminal failed with `posix_spawnp failed`).
- Packaged macOS apps opened from Finder get a minimal `PATH`; Journal appends the usual CLI folders that exist (`~/.local/bin`, Homebrew, npm, Bun, Volta, pnpm, nvm, fnm and others) without running shell startup files (`src/desktop/environment.mjs`).

## Verification
- `npm run release:audit -- <Journal.app or win-unpacked>`: every file inside `app.asar` and `app.asar.unpacked` must match an allow-list; `.env`, databases, logs, source maps, keys, tests, fixtures, docs, caches and the renderer sources fail it, as do local absolute paths and private keys in text files.
- `npm run smoke:packaged -- <executable>`: runs the packaged app with fixture CLIs and a temporary data folder (in a path with spaces): launch, version, data folder, provider detection, opening a project, a terminal session through the runtime and node-pty, the file explorer, and a restart that keeps the project and session.
- The release workflow runs both on the DMG's app (macOS) and on the installed app (Windows), checks the portable EXE's version and data folder, and checks that uninstalling keeps Journal's data.

## Local build (macOS)
```sh
npm ci
npm test && npm run check && npm run build && npm run test:desktop
npm run dist:mac                     # release/Journal-<version>-arm64.dmg and .zip
npm run release:check -- --artifacts release --platform mac
npm run release:audit -- release/mac-arm64/Journal.app
npm run smoke:packaged -- release/mac-arm64/Journal.app/Contents/MacOS/Journal
```
Windows packages are built on a Windows machine or runner with `npm run dist:win`.

## Release procedure
1. Set `version` in `package.json` (and `package-lock.json` with `npm install --package-lock-only`), update `docs/IMPLEMENTATION-STATUS.md`, and merge to `main`.
2. Run the local suite and, on macOS, the manual native trials that cover changed areas (`docs/NATIVE-VALIDATION.md`, `docs/PROVIDERS.md`).
3. Tag and push: `git tag v<version> && git push origin v<version>`.
4. The `Release` workflow verifies, packages, smoke-tests and creates a **draft** release with the six assets. Review the notes (from `.github/release-notes-template.md`), download and check the assets, then publish by hand. Workflow artifacts are kept for three days only; GitHub Releases is the download location.

## Signing and notarization (pending)
No certificates are configured, so builds are unsigned. Nothing is faked: unsigned macOS builds are ad-hoc signed (required to run on Apple Silicon; Gatekeeper still warns), and Windows builds carry no signature (SmartScreen may warn). The pipeline signs automatically once these repository secrets exist:

| Secret | Purpose |
| --- | --- |
| `MAC_CSC_LINK` | Developer ID Application certificate and key as a base64-encoded `.p12` |
| `MAC_CSC_KEY_PASSWORD` | Password of that `.p12` |
| `APPLE_API_KEY_P8` | App Store Connect API key (`.p8` contents) for notarization |
| `APPLE_API_KEY_ID` | Its key ID |
| `APPLE_API_ISSUER` | Its issuer ID |
| `WIN_CSC_LINK` | Authenticode code-signing certificate as a base64-encoded `.pfx` (optional) |
| `WIN_CSC_KEY_PASSWORD` | Its password |

With the macOS certificate, the app is signed with the hardened runtime and `assets/entitlements.mac.plist` (JIT, unsigned executable memory for V8, and library validation off for node-pty); with the API key it is also notarized and stapled, and the workflow checks `spctl` and `stapler validate`. Windows signing is not required for alpha releases and never blocks them. Auto-update is not implemented.
