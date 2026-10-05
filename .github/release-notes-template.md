Journal is a local-first workspace for Claude Code, Codex and Cursor that carries reviewed project knowledge across agent sessions. This is an **alpha pre-release**.

## Download

| Platform | File |
| --- | --- |
| macOS (Apple Silicon) | `Journal-<version>-arm64.dmg` (or `.zip`) |
| Windows x64 installer | `Journal-Setup-<version>-x64.exe` |
| Windows x64 portable | `Journal-Portable-<version>-x64.exe` |

Journal does not include Claude Code, Codex or Cursor: install the ones you use (Journal shows which it found, and can install the Cursor CLI for you with Cursor's official installer after you confirm).

## Signing

- **macOS:** signed with an Apple Developer ID and notarized by Apple. Open the DMG, drag Journal to Applications and open it.
- **Windows:** not code-signed yet. SmartScreen may show "Windows protected your PC": click **More info**, then **Run anyway**. The installer installs for your user only and needs no administrator rights.

Only open builds downloaded from this release page, and check them against `SHA256SUMS.txt`:

```sh
# macOS
shasum -a 256 -c SHA256SUMS.txt --ignore-missing
```
```powershell
# Windows (PowerShell): compare with the line for the file in SHA256SUMS.txt
Get-FileHash .\Journal-Setup-<version>-x64.exe -Algorithm SHA256
```

## Highlights
- …

## Known limitations
- Real Claude Code, Codex and Cursor behavior is verified manually on macOS; Windows provider behavior is unverified (see docs/WINDOWS.md).
- Automatic updates work from 0.1.0-alpha onward (macOS app and Windows installer); the Windows portable build links to new versions instead. Earlier test builds (0.2.0-alpha.x) are not updated: install this version by hand once.

## Third-party notices
`THIRD-PARTY-NOTICES.txt` (also inside the app).
