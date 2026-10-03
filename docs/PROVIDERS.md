# Provider support and observability

Journal runs the user's installed `claude`, `codex` and Cursor `agent` CLIs in a real terminal with their own login, settings and permission prompts. It never extracts credentials, passes permission-bypass flags or calls provider APIs. Anything not listed as observed is **unknown** and shown as unknown.

## Versions
| CLI | Tested manually | How Journal detects it |
| --- | --- | --- |
| Claude Code | 2.1.284–2.1.286 (macOS) | `PATH` lookup (`PATHEXT` on Windows), `claude --version` |
| Codex CLI | 0.154.0 (macOS) | `PATH` lookup, `codex --version`; Windows npm shims run their Node script directly |
| Cursor Agent CLI | Fixture-tested only; authenticated validation is manual (below) | `agent`, then `cursor-agent`, on `PATH`, then the installers' locations (`~/.local/bin`, `%LOCALAPPDATA%\cursor-agent`). Accepted only when `--version` is a Cursor build (`YYYY.MM.DD-hash`) and `--help` names Cursor; builds without `create-chat` and `--resume` are unsupported |

Other versions may work. The launch bar shows the detected version and what Journal can observe.

## Capabilities
| | Claude Code | Codex | Cursor |
| --- | --- | --- | --- |
| Launch | `claude --session-id <UUID> [--settings <per-launch hooks>] -- <prompt>` | `codex -- <prompt>` | `agent create-chat` in the session folder, then `agent --resume=<UUID> [--mode=ask\|plan] -- <prompt>` |
| Exact resume | `--resume <UUID>`; ID known at launch | `codex resume <UUID>` after the user confirms the exit-banner hint | `--resume=<UUID>`; ID known at launch. If the chat cannot be created first, the exit hint `To resume this session: agent --resume=<UUID>` needs confirmation. Never `resume`, `--continue` or `ls` |
| Research mode (starting mode, not enforcement) | `--permission-mode plan`; can be left in-session | `--sandbox read-only`; approvals may escalate under approval-capable profiles | `--mode=ask` (Ask: read-only exploration); Plan uses `--mode=plan`. Builds without `--mode` cannot start in these modes |
| Status | Working, idle, waiting for permission (hooks) | Running or exited | Running or exited |
| Commands | Bash command text (redacted), working directory, exit code, duration for foreground commands; background commands report unknown | Unknown | Unknown |
| File edits | Edit, Write, MultiEdit, NotebookEdit paths | Unknown (the Changes view shows Git state) | Unknown (the Changes view shows Git state) |
| Tests | Exit status of recognized test commands; no report parsing | Unknown | Unknown |
| Interrupt | Ctrl+C to the PTY (native interrupt) | Ctrl+C to the PTY (native interrupt) | Ctrl+C to the PTY (native interrupt) |
| Permissions | Native prompts in the terminal; Journal never answers them | Native prompts and sandbox profile | Native prompts and Cursor's own permission config; Journal never passes `--force`, `--yolo`, `--sandbox` or `--approve-mcps` |
| Context delivery | Initial prompt argument; receipt records exact text; not acknowledged by the model | Same | Same |

Hooks are added per launch through `--settings`; existing user and project hooks are untouched. Journal does not configure Codex or Cursor hooks, so their activity beyond start, exit, interrupt and stop is not observed. Cursor documents hooks (including per-launch plugins via `--plugin-dir`), but their CLI behavior is unverified, so Journal does not rely on them; File Explorer references for Codex and Cursor are therefore always copied for the user to paste, never typed.

## Cursor installation and sign-in
- Cursor appears as a provider even when its CLI is missing. **Install Cursor CLI** shows the exact official command (`curl https://cursor.com/install -fsS | bash` on macOS and Linux; `irm 'https://cursor.com/install?win32=true' | iex` in Windows PowerShell), runs it only after confirmation, without shell startup files, elevation or execution-policy changes, in a visible terminal with its exit code, then detects the CLI again with `--version`. If the CLI landed outside Journal's `PATH`, Journal uses it from the installer's location and says how to add it to `PATH`; it never edits shell startup files.
- **Sign in to Cursor** runs `agent login` in a visible terminal. Sign-in state comes from `agent status` (JSON when available) and only "signed in", "signed out" or "unknown" is kept; Journal never reads, copies or stores Cursor credentials, and sign-in output is not saved.

## Known gaps
- Whether a model read or used a supplied claim is not observable for either provider.
- Hidden reasoning and full model context are never shown.
- Codex interactive allow/deny under an approval-capable profile and cancelling a running foreground tool remain manual validation gaps (see [native validation](NATIVE-VALIDATION.md)).
- Windows behavior is unverified (see [Windows audit](WINDOWS.md)).
- Cursor: whether a prompt passed with `--resume=<id>` after `create-chat` starts the first turn, whether `--` ends options, Ask-mode strictness, and Ctrl+C behavior are unverified without an authenticated run.

## Manual validation remaining: Cursor (needs the user's Cursor login)
1. Install or update the CLI from Journal's Cursor row and sign in with **Sign in to Cursor**.
2. Start Cursor from Journal with a harmless task (for example "List the files in the repo root"); confirm the task and Journal's context reached the first turn.
3. Ask for a shell command; deny it once and approve it once in Cursor's own prompt.
4. Interrupt with Ctrl+C or the Interrupt button.
5. Stop, then Resume, and confirm it is the same chat (same conversation history).
6. Start a Cursor session in a Journal worktree and confirm its working directory.
7. Reference a file from the Files tab, paste it into Cursor, and confirm Cursor reads that path.
8. Confirm the Context tab shows the approved brief and that Cursor's first reply reflects it.
9. Run a Cursor session at the same time as a Claude or Codex session and confirm input and output stay separate.
10. Start with Research (Ask mode) and with Plan, and confirm the mode Cursor shows.
