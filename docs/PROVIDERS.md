# Provider support and observability

Journal runs the user's installed `claude` and `codex` CLIs in a real terminal with their own login, settings and permission prompts. It never extracts credentials, passes permission-bypass flags or calls provider APIs. Anything not listed as observed is **unknown** and shown as unknown.

## Versions
| CLI | Tested manually | How Journal detects it |
| --- | --- | --- |
| Claude Code | 2.1.284–2.1.286 (macOS) | `PATH` lookup (`PATHEXT` on Windows), `claude --version` |
| Codex CLI | 0.154.0 (macOS) | `PATH` lookup, `codex --version`; Windows npm shims run their Node script directly |

Other versions may work. The launch bar shows the detected version and what Journal can observe.

## Capabilities
| | Claude Code | Codex |
| --- | --- | --- |
| Launch | `claude --session-id <UUID> [--settings <per-launch hooks>] -- <prompt>` | `codex -- <prompt>` |
| Exact resume | `--resume <UUID>`; ID known at launch | `codex resume <UUID>` after the user confirms the exit-banner hint |
| Research mode | `--permission-mode plan` | `--sandbox read-only` |
| Status | Working, idle, waiting for permission (hooks) | Running or exited |
| Commands | Bash command text (redacted), working directory, exit code, duration for foreground commands; background commands report unknown | Unknown |
| File edits | Edit, Write, MultiEdit, NotebookEdit paths | Unknown (the Changes view shows Git state) |
| Tests | Exit status of recognized test commands; no report parsing | Unknown |
| Interrupt | Ctrl+C to the PTY (native interrupt) | Ctrl+C to the PTY (native interrupt) |
| Permissions | Native prompts in the terminal; Journal never answers them | Native prompts and sandbox profile |
| Context delivery | Initial prompt argument; receipt records exact text; not acknowledged by the model | Same |

Hooks are added per launch through `--settings`; existing user and project hooks are untouched. Journal does not configure Codex hooks, so Codex activity beyond start, exit, interrupt and stop is not observed.

## Known gaps
- Whether a model read or used a supplied claim is not observable for either provider.
- Hidden reasoning and full model context are never shown.
- Codex interactive allow/deny under an approval-capable profile and cancelling a running foreground tool remain manual validation gaps (see [native validation](NATIVE-VALIDATION.md)).
- Windows behavior is unverified (see [Windows audit](WINDOWS.md)).
