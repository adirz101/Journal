# Releasing Journal

Status, 4 October 2026: packaging and the release pipeline are implemented and active (`.github/workflows/release.yml`; pull requests that change packaging also run it, without releasing). macOS release builds are signed with the Developer ID of Adir Zak (team N859VCGPS7) and notarized; Windows builds are unsigned.

## Version: one source
- `version` in `package.json` (for example `0.2.0-alpha`) is the only version. Electron reports it as the app version (`CFBundleShortVersionString` on macOS, file and product version on Windows), artifact names come from it, and the release tag must be exactly `v<version>`.
- `scripts/release-check.mjs` fails a release when the tag, `package.json` and the packaging configuration's artifact names disagree, or when a platform produced missing or unexpected installers.

## Artifacts
| Platform | Files | Notes |
| --- | --- | --- |
| macOS arm64 | `Journal-<version>-arm64.dmg`, `Journal-<version>-arm64.zip` | DMG shows Journal.app and an Applications link (drag to install); the ZIP holds the same app. Intel (x64) is not built yet: it needs node-pty compiled for x64 and its own smoke test. |
| Windows x64 | `Journal-Setup-<version>-x64.exe`, `Journal-Portable-<version>-x64.exe` | One-click NSIS installer: per user (`%LOCALAPPDATA%\Programs\journal-desktop`), no administrator rights and no all-users choice, Start Menu shortcut, uninstaller (Settings → Apps); Journal data is kept on uninstall. Portable: runs without installing and still stores data per user. |
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
Packaging the macOS app needs Xcode 26 or later: electron-builder compiles the Icon Composer icon (`assets/branding/Journal.icon`) with `actool`, which the command-line tools alone do not include. If `xcode-select -p` points at the command-line tools, prefix the build with `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`. The icon is shaped by the system on macOS 26 and later, and ships pre-rounded (`icon.icns`, up to 256 px) for earlier versions.
Windows packages are built on a Windows machine or runner with `npm run dist:win` (the workflow does this on `windows-latest`).

## CI notes
- Hosted macOS runners have a 1024×768 virtual display; test runs (`JOURNAL_HEADLESS=1`) size Journal's window after creation so layouts match a normal screen. `scripts/ci-diagnose.mjs` prints the window and terminal geometry on a runner when this needs checking again.
- electron-builder skips all signing for pull-request builds; unsigned builds set `CSC_FOR_PULL_REQUEST=true` so the ad-hoc signature (which the app needs) is still applied, and empty signing secrets are unset before packaging.

## Release procedure
1. Set `version` in `package.json` (and `package-lock.json` with `npm install --package-lock-only`), update `docs/IMPLEMENTATION-STATUS.md`, and merge to `main`.
2. Run the local suite and, on macOS, the manual native trials that cover changed areas (`docs/NATIVE-VALIDATION.md`, `docs/PROVIDERS.md`).
3. Tag and push: `git tag v<version> && git push origin v<version>`.
4. The `Release` workflow verifies, packages, smoke-tests and creates a **draft** release with the six assets. Review the notes (from `.github/release-notes-template.md`), download and check the assets, then publish by hand. Workflow artifacts are kept for three days only; GitHub Releases is the download location.

## Automatic updates
Journal updates itself with [electron-updater](https://www.electron.build/auto-update) (MIT) from GitHub Releases, starting with 0.2.0-alpha.2; earlier builds must be replaced by hand once.
- The release workflow uploads the update feed with the installers: `latest-mac.yml` (macOS, pointing at the ZIP), `latest.yml` (Windows installer) and the `.blockmap` files for differential downloads. `release-check --artifacts` fails if a feed file is missing. Builds never upload anything themselves (`--publish never`); the `publish` entry in `electron-builder.config.cjs` only writes the feed location into the app.
- Drafts are invisible to the updater: nothing reaches users until a maintainer publishes the release. Publishing is the release decision.
- Installed builds check 30 seconds after launch and every six hours (switchable in **Data and backups**; a manual check is in Data and backups and in the menu: **Journal → Check for Updates…** on macOS, **Help → Check for Updates…** on Windows), download in the background and show **Restart to update** in the sidebar. Journal never restarts on its own; installing asks what to do with running sessions, as quitting does, shuts down normally, and only then starts the installer. On Windows sessions are always stopped for an update: the NSIS installer ends every process started from the install folder, including the runtime.
- Prereleases (`-alpha.N`) follow newer prereleases and releases; a release version ignores prereleases; downgrades are never offered. Journal sets no update channel (the GitHub provider would then match only tags with that channel name): an alpha looks for `alpha*.yml` and falls back to the one feed Journal publishes, `latest*.yml`.
- The Windows portable EXE cannot replace itself: it shows that a version is available and links to the release. Development builds and tests never check (`JOURNAL_HEADLESS=1` or `JOURNAL_DISABLE_UPDATES=1` also switch updates off).
- macOS installs updates only when the new build is signed by the same Developer ID, so the release workflow refuses to build a tag without the macOS signing secrets.
- To verify end to end: install version N, publish N+1, and confirm the notice, the download and the restart on both platforms.

## Signing and notarization
macOS signing and notarization are configured (4 October 2026): the release workflow signs tag builds with the Developer ID Application certificate and the hardened runtime, notarizes and staples them, and checks the result with `spctl` and `stapler validate`. Pull-request builds never receive the certificate: they are ad-hoc signed. Keep all macOS secrets configured together: a signed but not notarized build fails the workflow's Gatekeeper check (`spctl`). `APPLE_API_KEY_P8` holds the raw `.p8` text of a Team API key (it has an issuer ID); `MAC_CSC_LINK` is a base64 `.p12` that includes the private key. Windows builds remain unsigned (SmartScreen may warn) until a code-signing certificate is added; this never blocks a release.

Local signed builds (optional): `CSC_NAME="Adir Zak (N859VCGPS7)" npm run dist:mac` signs with the keychain identity (macOS asks once to allow `codesign` to use the key). Adding `APPLE_KEYCHAIN_PROFILE=journal-notary` also notarizes, after `xcrun notarytool store-credentials journal-notary --key <AuthKey.p8> --key-id <id> --issuer <issuer>`.

| Secret | Purpose |
| --- | --- |
| `MAC_CSC_LINK` | Developer ID Application certificate and key as a base64-encoded `.p12` |
| `MAC_CSC_KEY_PASSWORD` | Password of that `.p12` |
| `APPLE_API_KEY_P8` | App Store Connect API key (`.p8` contents) for notarization |
| `APPLE_API_KEY_ID` | Its key ID |
| `APPLE_API_ISSUER` | Its issuer ID |
| `WIN_CSC_LINK` | Authenticode code-signing certificate as a base64-encoded `.pfx` (optional) |
| `WIN_CSC_KEY_PASSWORD` | Its password |

With the macOS certificate, the app is signed with the hardened runtime and `assets/entitlements.mac.plist` (JIT, unsigned executable memory for V8, and library validation off for node-pty); with the API key it is also notarized and stapled, and the workflow checks `spctl` and `stapler validate`. Windows signing is not required for alpha releases and never blocks them.
