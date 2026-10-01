# Windows readiness audit

2 October 2026. Journal has **not** been run on a real Windows machine. This audit lists how the code handles Windows and what remains unverified. Fixture CI on `windows-latest` runs install, unit tests, typecheck and build. Its desktop job is non-blocking because the fixture CLIs are POSIX scripts.

| Area | Implementation | Status |
| --- | --- | --- |
| Data paths | `app.getPath('appData')/journal-desktop` or `JOURNAL_DATA_DIR` | Expected to work |
| Runtime transport | Named pipe `\\.\pipe\journal-runtime-<hash of data dir>`, token from `runtime.json` | Unverified. The token file relies on the user-profile ACL rather than POSIX mode bits. |
| Runtime launch | `process.execPath` with `ELECTRON_RUN_AS_NODE=1`, `detached`, `windowsHide` | Unverified |
| Executable lookup | `resolveExecutable` searches `PATH` with `PATHEXT` | Unit tested with Windows inputs |
| npm `.cmd` shims | `launchTarget` reads the shim and launches its Node script directly, so multi-line prompts never pass through `cmd.exe`. A shim without a recognizable script is refused with an explanation. | Unit tested with a sample shim; unverified against current Claude and Codex installers. Native `.exe` installs need no shim handling. |
| PTY | node-pty with ConPTY | Unverified for resize, Unicode and IME, Ctrl+C, and flood |
| Stop | `pty.kill()` (ConPTY close), then `taskkill /T /F` only through identity verification | Unverified |
| Process identity | PowerShell `Get-Process` start time and path hash | Unverified, and slow (about 300 ms per call). It is used only during recovery and orphan termination. |
| Descendant tracking | Not implemented: there is no cheap process table. Leftovers are reported as unknown. | Known gap |
| Hooks | `set ELECTRON_RUN_AS_NODE=1&& "<electron>" "<hook.mjs>" ...` | Unverified quoting with spaces in paths |
| Path comparison | Hook `cwd` and file paths compared after `realpath`; Git paths use `/` | Expected to work; case-insensitive drive letters unverified |
| Evidence and changes | Git with `-z` output, `relativePath` rejects `\` and drive letters | Unit tested on POSIX only |

Before advertising Windows support:

1. Install, build and run on Windows 11 with the npm-installed and native-installer versions of both CLIs.
2. Run the desktop scenarios with Windows fixture CLIs (`.cmd` and `.exe`).
3. Manually check ConPTY input (IME, Ctrl+C, resize), runtime survival after closing the app window, runtime crash recovery, and named-pipe access by another local user (it must be refused).
