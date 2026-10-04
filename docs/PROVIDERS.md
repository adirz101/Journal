# Provider support and observability

Journal runs the user's installed `claude`, `codex` and Cursor `agent` CLIs in a real terminal with their own login, settings and permission prompts. It never extracts credentials, passes permission-bypass flags or calls provider APIs. Anything not listed as observed is **unknown** and shown as unknown.

## Versions
| CLI | Tested manually | How Journal detects it |
| --- | --- | --- |
| Claude Code | 2.1.284–2.1.286 (macOS) | `PATH` lookup (`PATHEXT` on Windows), `claude --version` |
| Codex CLI | 0.154.0 (macOS) | `PATH` lookup, `codex --version`; Windows npm shims run their Node script directly |
| Cursor Agent CLI | 2026.10.01-e373342 (macOS): authenticated launch, first turn and exact resume checked (3 October 2026); the rest of the manual list below remains | `agent`, then `cursor-agent`, on `PATH`, then the installers' locations (`~/.local/bin`, `%LOCALAPPDATA%\cursor-agent`). Accepted only when `--version` is a Cursor build (`YYYY.MM.DD-hash`) and `--help` names Cursor; builds without `create-chat` and `--resume` are unsupported |

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

## Claude Code and Codex: detection, install and sign-in (Phase 7)
- Detection is asynchronous and never blocks startup: every row starts as "Checking…", then `--version` (4 s) decides installed or not. One `--help` read (4 s) decides what Journal may run: Claude's sign-in and status check need an `auth` command in its help; Codex's sign-in needs `login` in its top-level help and its status check needs `status` in `codex login --help`. Nothing else is tried, because an unknown subcommand could reach the CLI as a prompt (a model request) or start a login flow.
- Sign-in state comes from `claude auth status --json` (only a boolean `loggedIn` counts) and `codex login status` (a line starting `Not logged in` is signed out; a line starting `Logged in` with exit code 0 is signed in; an exit code alone never decides). Both run with stdin closed, an 8-second limit that ends the whole process tree, and `NO_OPEN_BROWSER=1`. The output is parsed in memory to "signed in", "signed out" or "unknown" and is never logged, stored, sent or put in an error; anything unrecognized, a timeout or a spawn error is "unknown". Journal never reads credential files. Real output shapes are a manual check (see [native validation](NATIVE-VALIDATION.md)).
- **Sign in** runs a constant command per provider in a visible terminal: `claude auth login`, `codex login`, `agent login` (Cursor). The executable is the one detection found, never one named by the window.
- **Install** commands, checked against the official pages on 4 October 2026 and shown verbatim before anything runs (native confirmation, visible terminal, no shell startup files, no elevation, no execution-policy change):

| Provider | macOS and Linux | Windows | Source |
|---|---|---|---|
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash` | `irm https://claude.ai/install.ps1 \| iex` (PowerShell) | https://code.claude.com/docs/en/setup |
| Codex | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` | none: the official command (`powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 \| iex"`) changes the execution policy, which Journal never does; the row offers **Open install page** | https://developers.openai.com/codex/cli (redirects to learn.chatgpt.com/docs/codex/cli) |
| Cursor | `curl https://cursor.com/install -fsS \| bash` | `irm 'https://cursor.com/install?win32=true' \| iex` | https://cursor.com/docs/cli/installation |

  Without `curl` on `PATH` the Claude and Codex rows offer the install page instead. Claude Code and Codex installed outside `PATH` are not looked up in known locations (Cursor's are); the row says so after an install.

## Terminal colours (light and dark)
Each CLI draws its own interface colours; Journal never edits a provider's settings or theme. Journal's part is to describe its terminal correctly, and the runtime does it for every session, whether or not a window shows it:
- **`COLORFGBG`** is set at launch to Journal's appearance: `0;15` for light and `15;0` for dark (foreground;background as ANSI indexes, rxvt's convention). It replaces any value inherited from the terminal Journal was started from.
- **Colour queries** (OSC 10, 11 and 12: foreground, background, cursor) are answered by the runtime as soon as the CLI asks, with the colours of Journal's terminal theme. The window's terminal no longer answers them, so a query gets exactly one reply. DA1 (`CSI c`) is answered by the runtime only while no window shows the session; otherwise the window's terminal answers it in order with any other device query. A replayed buffer (a reload or reattach) never produces replies.
- **Theme reports** (mode 2031): a CLI that enables it receives `CSI ? 997 ; 1 n` (dark) or `CSI ? 997 ; 2 n` (light) when Journal's appearance changes, and can ask for the background again.

What each CLI does with this (read from the installed binaries on 5 October 2026: Claude Code 2.1.286, Codex 0.159.3, Cursor 2026.10.01):
- **Claude Code**: the `theme` setting is unset by default, and unset means its fixed **dark** theme, which ignores the terminal. Only **Auto (match terminal)** (`/theme`, stored as `"theme": "auto"` in `~/.claude/settings.json`) follows it: Claude asks OSC 11 followed by a DA1 sentinel and waits for both without a timeout, then uses the answer (light when its luminance is above 0.5); without an answer it falls back to `COLORFGBG` (last field 0-6 or 8 is dark, otherwise light), then to dark. With Auto it enables mode 2031 and asks again on each theme report, so a switch in Journal reaches a running session. Journal's Settings say so next to Appearance. In light mode with the default theme, Claude Code's own blocks (for example the prompt echo and "Jump to bottom") stay dark; Journal cannot change that without changing Claude's settings, which it never does.
- **Codex** asks OSC 10 and 11 at start for its own palette; `COLORFGBG` appears only in its diagnostics.
- **Cursor** asks OSC 11 and gives up after 60 ms, then reads `COLORFGBG`. A reply later than that would arrive as typed input, which is why the runtime answers at once.

## Known gaps
- Whether a model read or used a supplied claim is not observable for either provider.
- Hidden reasoning and full model context are never shown.
- Codex interactive allow/deny under an approval-capable profile and cancelling a running foreground tool remain manual validation gaps (see [native validation](NATIVE-VALIDATION.md)).
- Windows behavior is unverified (see [Windows audit](WINDOWS.md)).
- Cursor on Windows is unverified: Journal prefers `agent.exe` and reports a launcher it cannot start safely (for example a non-npm `.cmd`) as "cannot be started" rather than guessing; the real layout of `%LOCALAPPDATA%\cursor-agent` still needs a Windows check.
- Cursor: an empty chat created by `create-chat` stays in Cursor's history if the CLI then fails to start.
- Cursor, checked with an authenticated 2026.10.01 CLI on macOS (3 October 2026): `create-chat` prints the new ID at once but keeps running, so Journal takes the ID and ends it; `agent --resume=<id> -- <prompt>` submits the prompt as the first turn (so `--` ends options); exiting prints `To resume this session: agent --resume=<id>` with the same ID; `--resume=<id>` reopens that exact chat with its history; an idle session exits on the second Ctrl+C ("Press Ctrl+C again to exit"); `status --format json` reports `isAuthenticated` (Journal keeps only that). A new folder first shows Cursor's own **Workspace Trust** prompt in the terminal, which the user answers; Journal never answers it. Cursor accounts on the free plan reject named default models ("Free plans can only use Auto") — choose Auto in Cursor; Journal never passes `--model`.
- Cursor, still unverified: Ask-mode strictness, allow/deny of a command prompt, and the steps below that need Journal's UI.

## Manual validation remaining: Cursor (needs the user's Cursor login)
Already checked outside Journal's UI with the same arguments Journal uses: chat creation, first turn, exit hint, exact resume and Ctrl+C. Still to do in Journal:
1. Install or update the CLI from Journal's Cursor row and sign in with **Sign in to Cursor**.
2. Start Cursor from Journal with a harmless task (for example "List the files in the repo root"), answer the workspace-trust prompt, and confirm the task and Journal's context reached the first turn.
3. Ask for a shell command; deny it once and approve it once in Cursor's own prompt.
4. Interrupt with Ctrl+C or the Interrupt button.
5. Stop, then Resume, and confirm it is the same chat (same conversation history).
6. Start a Cursor session in a Journal worktree and confirm its working directory.
7. Reference a file from the Files tab, paste it into Cursor, and confirm Cursor reads that path.
8. Confirm the Context tab shows the approved brief and that Cursor's first reply reflects it.
9. Run a Cursor session at the same time as a Claude or Codex session and confirm input and output stay separate.
10. Start with Research (Ask mode) and with Plan, and confirm the mode Cursor shows.
