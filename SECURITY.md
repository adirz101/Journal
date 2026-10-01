# Security policy

## Supported versions

Journal is pre-release alpha software. Only the latest `main` branch is supported; there are no maintained release branches or packaged releases yet.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub private vulnerability reporting: open the [Security Advisories page for adirz101/Journal](https://github.com/adirz101/Journal/security/advisories/new) and submit a draft advisory.

**Do not file a public issue** for a suspected vulnerability.

Include what you can: the affected commit, your OS, steps to reproduce, and the impact you expect. Remove tokens, credentials and private terminal output from anything you send.

## What to expect

This is a small project maintained on a best-effort basis. We aim to acknowledge reports within a week, keep you informed while we investigate, and credit you in the fix if you wish. We cannot promise fixed timelines.

## Scope notes

These describe how Journal is designed to behave; reports showing it does otherwise are in scope.

- Journal's data (knowledge, source excerpts, tasks, session metadata and receipts) is stored locally in Journal's application-data directory, or in `JOURNAL_DATA_DIR` when set.
- Terminal output and keystrokes are not persisted. The runtime keeps at most 256 KiB of recent output per session in memory.
- The terminal runtime listens only on a local Unix socket or Windows named pipe and requires a random token stored in `runtime.json` (mode 0600 on macOS and Linux).
- Session timelines keep bounded metadata only: command text with credential-like values redacted, exit codes, durations and edited file paths. No prompts, tool output or file contents.
- Reviewed knowledge stays local. Journal has no cloud sync.
- Claude Code and Codex run as your installed native CLIs. Context that Journal supplies to them is sent to their providers according to each CLI's own settings and terms.
- Journal never reads provider credential files and does not bypass a native CLI's permission prompts or settings.

Vulnerabilities in Claude Code, Codex, Electron or other dependencies should be reported to those projects directly.
