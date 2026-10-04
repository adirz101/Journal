# Windows readiness audit

2 October 2026. Journal has **not** been run on a real Windows machine. This audit lists how the code handles Windows and what remains unverified. Fixture CI on `windows-latest` runs install, unit tests, typecheck and build. Its desktop job is non-blocking because the fixture CLIs are POSIX scripts.

| Area | Implementation | Status |
| --- | --- | --- |
| Data paths | `app.getPath('appData')/journal-desktop` or `JOURNAL_DATA_DIR` | Expected to work |
| Runtime transport | Named pipe `\\.\pipe\journal-runtime-<hash of data dir>`, HMAC challenge-response with the token from `runtime.json` | Unverified. The pipe name is predictable and Node cannot set an owner-only ACL; the handshake prevents an impostor from learning the token or receiving input, but it can deny service by squatting first. The token file relies on the user-profile ACL. |
| Runtime launch | `process.execPath` with `ELECTRON_RUN_AS_NODE=1`, `detached`, `windowsHide` | Unverified |
| Executable lookup | `resolveExecutable` searches `PATH` with `PATHEXT` | Unit tested with Windows inputs |
| npm `.cmd` shims | `launchTarget` reads the shim and launches its Node script directly, so multi-line prompts never pass through `cmd.exe`. A shim without a recognizable script is refused with an explanation. | Unit tested with a sample shim; unverified against current Claude and Codex installers. Native `.exe` installs need no shim handling. |
| PTY | node-pty with ConPTY | Unverified for resize, Unicode and IME, Ctrl+C, and flood |
| Stop | `pty.kill()` (ConPTY close), then `taskkill /T /F` only through identity verification | Unverified |
| Process identity | PowerShell `Get-Process` start time (UTC file time) | Unverified, and slow (about 300 ms per call). Called asynchronously at every launch (and again on first output), during recovery, every 5 s per orphan, and before verified signals, so it does not block terminals, but it adds PowerShell processes. |
| Descendant tracking | Not implemented: there is no cheap process table. Leftovers are reported as unknown. | Known gap |
| Hooks | `set ELECTRON_RUN_AS_NODE=1&& "<electron>" "<hook.mjs>" ...` | Unverified. If Claude Code runs hook commands through Git Bash instead of cmd.exe, this syntax would not set the variable and would launch the Electron app instead of the hook script. Must be checked on a real machine. |
| Path comparison | Hook `cwd` and file paths compared after `realpath`; Git paths use `/` | Expected to work; case-insensitive drive letters unverified |
| Evidence and changes | Git with `-z` output, `relativePath` rejects `\` and drive letters | Unit tested on POSIX only |

Before advertising Windows support:

1. Install, build and run on Windows 11 with the npm-installed and native-installer versions of both CLIs.
2. Run the desktop scenarios with Windows fixture CLIs (`.cmd` and `.exe`).
3. Manually check ConPTY input (IME, Ctrl+C, resize), runtime survival after closing the app window, runtime crash recovery, and named-pipe access by another local user (it must be refused).
4. Verify that Claude permission answer keys (digit, Enter, Esc, Ctrl+C) reach Journal's `write()` as plain characters on Windows ConPTY, not win32-input-mode sequences, since detecting an answered prompt depends on it.

## Windows on CI (4 October 2026)
The unit tests run on hosted `windows-latest` runners and are required. Their first run found 37 failures, now fixed:
- **Path identity** (real defects): Windows can name one folder two ways (`C:\Users\RUNNER~1` and `C:\Users\runneradmin`, `\` or `/`). Journal now compares paths through the native resolver (`src/core/paths.mjs`), so projects, additional folders and worktrees match the paths Git reports; worktrees had been marked failed.
- **Backups**: Node 24 (Electron's) rejects `rate: -1`, which broke online backups; a positive page count is used.
- **Test portability**: temporary folders are removed after stores close, fake CLIs are npm-style `.cmd` shims, and tests no longer assume POSIX quoting or separators.

On Windows 164 of 172 unit tests pass and 8 skip because they exercise macOS- or POSIX-only behavior: the macOS app launcher, symlink races (two), PID-reuse-safe signalling, UTC start times from `ps`, orphan termination, SIGTERM-to-SIGKILL escalation and the runtime lock's POSIX identity. Their Windows counterparts (Job Objects, Windows process identity) remain open items in this audit. The desktop scenarios use POSIX fixture CLIs and skip on Windows; the packaged Windows app is covered by the release workflow instead: per-user installation, a smoke test of the installed app with fixture CLIs (project, provider detection, a terminal through ConPTY, the file explorer, restart), the portable build and uninstalling.
