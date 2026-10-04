# File explorer design

Approved by the user on 3 October 2026, together with the scope amendment in [JOURNAL-DESIGN.md](JOURNAL-DESIGN.md) (read-only text previews) and the new dependencies below. Implementation details are in [ARCHITECTURE.md](ARCHITECTURE.md#file-explorer).

## Goal

A small, reliable, read-only explorer that makes agent context more precise without turning Journal into an IDE: browse the session's workspace, see Git state, read a file, and hand a file, folder or line range to the agent as a reference.

Non-goals: editing; creating, deleting or renaming files; editor tabs; language servers, IntelliSense, refactoring or debugging; extensions; source-control actions beyond status and diff; a terminal replacement.

## Decisions

| Area | Choice | Why |
|---|---|---|
| Tree | `@headless-tree/core` and `@headless-tree/react` 1.7.0 (MIT), rendered with Journal's own fixed-row virtualization | W3C tree keyboard model, type-ahead, `aria-level`/`aria-setsize`/`aria-posinset` on a flat list; about 7 KB gzipped, no forced dependencies. react-arborist forces react-dnd and redux; react-complex-tree and react-accessible-treeview do not virtualize. |
| Preview | CodeMirror 6, read-only (`@codemirror/state`, `view`, `language`, `search`, `commands`, five Lezer languages and `legacy-modes`, `@lezer/highlight`; MIT), lazy-loaded | Line numbers, a real selection model, search and viewport-only rendering. About 104 KB gzipped, loaded on first preview; languages load per file. Shiki has no gutter or selection and tokenizes whole files (seconds for multi-megabyte files); Monaco is about 1.2 MB with worker and CSP friction. |
| Git | Git CLI, porcelain v2 (no Git library) | Correct with worktrees, sparse checkouts and submodules; fsmonitor-aware; collapsed untracked and ignored folders. |
| Menus | Electron `Menu.popup`, as for projects and sessions | Native feel and accessibility; no new code path. |
| Watching | Node `fs.watch` with `recursive` (no native module) | FSEvents and ReadDirectoryChangesW without packaging native watchers; `@parcel/watcher` only if measurements require it. |

## Behavior

- **Panel:** the right panel is collapsible to a rail (⌘I / Ctrl+Shift+B); ⌥⌘2 / Alt+Shift+2 opens Files and focuses the tree. Files sits first among Files, Memory, Context, Changes and Activity. A preview widens the panel to at most 720 px or half the window (not saved) and returns afterwards. No panel or tree animations: these are frequent, keyboard-driven actions.
- **Roots:** the explorer follows the selected session's workspace; with no session it shows the checkout. A root selector picks the checkout or a ready worktree ("Browsing", with a way back to "Follow"). Additional folders are separate top-level roots; worktrees are alternatives, never shown together.
- **Tree:** folders load when expanded; `.git` is never listed; dotfiles are shown; ignored folders are dimmed and not scanned until expanded; links are marked and never followed; sensitive files carry a lock and cannot be previewed or referenced.
- **Git decorations:** a letter plus color, never color alone: `!` conflict, `D` deleted (Changed filter only), `M` modified, `R` renamed (tooltip shows the source), `T` type change, `A` added, `U` untracked, `S` submodule; ignored names are dimmed. Folders show a dot in the color of their highest-priority changed descendant. Tooltips say staged or unstaged.
- **Preview:** read-only text with line numbers, selection (click or Shift-click line numbers), search (⌘F / Ctrl+F) and a File/Diff toggle for changed files (diff against HEAD). Limits: no read for sensitive files or files over 5 MB; plain text over 1 MB; binary detection; invalid UTF-8 shown with replacement characters and a notice; BOM removed; CRLF reported.
- **References:** paths, ranges and hashes, never contents; the agent reads files itself.
  - *Add to next task*: a chip under the task; the receipt records `references` (root, path, range, content and range hashes, HEAD) and the packet lists them. Referenced folders and files also make area-scoped knowledge for that area eligible.
  - *Reference in session*: Claude Code gets `@path`, `@path#L10-20` or `@folder/` typed as a bracketed paste without Enter, only when its hooks report it idle at its prompt (for at least 750 ms). While it works (a permission prompt can open before its hook is observed), during a permission request, before readiness is known, or for Codex (`path (lines 10-20)`), the reference is copied for the user to paste. A `reference` timeline event records it.
  - The Context Inspector lists references for the task and during the session, and whether each file or range changed since.
  - A primary-repository reference must come from the session's own checkout or worktree, so the agent never edits the wrong copy.
  - *Save as knowledge…* prefills the knowledge form with the selected lines (checkout and folder roots, up to 30 lines).
- **Menus:** files: Open Preview, View Diff, Reference in Session, Add to Next Task, Copy Relative Path, Copy Path, Reveal, Open in Editor. Folders: Reference Folder in Session, Focus Next Task on This Folder, copy and reveal. Shift+F10 and the context-menu key open them at the focused row.

## Security

Roots resolve from records (checkout, a ready worktree of the same project, or a folder of the same project); the renderer passes only a root key and a relative path. Paths reject traversal, absolute paths, backslashes and control characters (and colons on Windows). Every component is checked for links (junctions report as links on Windows) and containment is re-checked with `realpath`; reads use `O_NOFOLLOW` and verify the file did not change while read. Sensitive paths (`.env*`, keys, credential files, `.npmrc`, `.netrc`, `.git-credentials`, keystores and similar) are never read, previewed, diffed or referenced; Open on a changed sensitive file now only reveals it. References refuse control characters, so typed text cannot carry escape sequences or a newline. Editors launch from PATH without a shell; Windows command shims fall back to revealing.

## Implemented differently from the first proposal

- **No separate files worker:** listing, status and preview use asynchronous `fs` and `execFile` in the main process, which never blocks it; the store worker only resolves roots and fingerprints references.
- **Small windows:** instead of an overlay drawer, the existing width constraints keep the terminal at its minimum width and the panel can be collapsed to a rail.
- **Watching** covers the shown primary root on macOS and Windows; additional folders (and Linux) refresh on focus, after agent turns and commands, on Refresh and on reopening.
- **Editor:** detected on PATH or named by `JOURNAL_EDITOR`; a settings screen is deferred.

## Deferred

Fuzzy file search (⌘P); excerpt inlining for small selections; image and Markdown rendering; staged/unstaged split views and a per-session "changed by this session" marker; multi-select references and drag into the terminal; blame; expanding submodules; watching additional folders; renaming Knowledge to Brain; an editor setting; `@parcel/watcher`; Linux and Windows hardware verification. Manual authenticated checks still needed: that Claude Code resolves `@path#L10-20` typed into its input, and that Codex reads a quoted path.
