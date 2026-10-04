# Journal terminal-first implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline. User authorized continuous execution; no additional approval between investigation and implementation.

**Goal:** Working terminal-only first slice with reviewed, source-backed knowledge shared between Claude and Codex.

**Architecture:** Narrow desktop IPC calls a local SQLite knowledge service and owned PTY manager. Native agents keep their settings and permissions. Original Journal launchers use official CLI contracts; reuse node-pty/xterm. User explicitly rejected reusing third-party application code.

**Tech Stack:** Electron, React, Vite, Node >=24, node:sqlite/FTS5, node-pty, xterm.js.

**Spec:** `docs/TERMINAL-FIRST-SPEC.md`; ADR `docs/adr/002-terminal-first-foundation.md`.

## Global Constraints

Terminal only. One active terminal at a time. Native settings/permissions/login preserved. No raw terminal/keystroke persistence. No global hook edits, bypass flags, automatic input replay or --last resume. Immutable revisions/receipts. 6000-byte context ceiling. Real Windows smoke is unverified until available.

## Review Focus

1. Reopened sessions must not receive duplicated prompts or resume another native session.
2. Unapproved, stale, wrong-branch and symlink-backed knowledge must not enter packets.
3. Terminal flood/reload must stay bounded, accept Ctrl-C, and disclose gaps.
4. Malicious renderer calls and terminal escape sequences must not cross the desktop boundary.
5. File changes between context preview and launch must trigger revalidation.

### Task 1 — Implement official launch/session contracts

Files: `src/core/agents.mjs`, `tests/agents.test.mjs`.
Produces `buildAgentLaunch({provider,nativeId,resume,prompt,settingsFile}) -> {executable,argv}` and exact-ID capture helpers.
- [x] Write failing tests for fresh/resumed UUIDs, literal argv, missing-ID refusal and absence of bypass flags; run `npm test`.
- [x] Write original launch code against official CLI contracts; add native CLI detection. Run tests. No vendor directory or third-party application code.

### Task 2 — Evidence-backed SQLite knowledge

Files: `src/core/{store,evidence,project,validation}.mjs`, `tests/knowledge.test.mjs`.
Produces `JournalStore`, `inspectProject(root)`, immutable `prepareContext(projectId,query)` receipt and memory revisions.
- [x] Fail tests for candidate exclusion, branch/stale/traversal/symlink/secret checks, revision history and reopen persistence.
- [x] Implement migrations, evidence capture, admission, safe FTS and bounded receipt selection. Run `npm test`.

### Task 3 — Owned native terminal

Files: `src/core/terminal.mjs`, `src/desktop/{main,preload,hook}.mjs`, `tests/terminal.test.mjs`.
Consumes launch spec, project IDs and receipts; produces owned session launch/input/resize/stop/reconnect plus volatile bounded output.
- [x] Fail tests for ring bounds, exact resume and spawn failure receipts; implement and verify.
- [x] Implement native PTY, IPC validation, reload handshake, capability-bound Claude observer, close/restart behavior. Preserve hooks/settings; no Codex hook overrides.

### Task 4 — Terminal cockpit and manual knowledge flow

Files: `src/ui/*`, `index.html`, `vite.config.mjs`, `scripts/dev.mjs`, `tests/desktop.spec.ts`.
Consumes a narrow `window.journal` bridge; views projects/sessions, terminal, knowledge inbox and exact context receipts.
- [x] Write desktop acceptance for project selection, file evidence, manual admission and safe PTY launch with selected knowledge.
- [x] Implement accessible responsive cockpit with xterm/FitAddon, keyboard shortcuts, source inspection and visible errors. Run build/typecheck/desktop tests.

### Task 5 — Verify and record limits

Files: `README.md`, `docs/IMPLEMENTATION-STATUS.md`. Current user instruction removes HANDOFF.md and the GitHub workflow; do not recreate them.
- [x] Run full core suite, typecheck, production build and Electron desktop test against native PTY.
- [x] Smoke real provider startup without task submission and report observed outcomes. Review final diff for security/validity defects; fix with regression tests.
- [x] Update instructions/docs to implementation phase, record Windows/authenticated-handoff limits and provide start command. No push or public release.

## Completion evidence

Local macOS: clean npm ci (Electron installer and native rebuild), 33 core tests, typecheck, production build and real Electron/PTY fixture acceptance passed. Native Claude/Codex startup smoke produced output without task submission. Exact native authenticated resume and Windows interactive behavior remain unverified; The former workflow was later disabled and removed at the user's request; checks are now manual and local only. Details: docs/IMPLEMENTATION-STATUS.md. Work is published in draft PR #1 from codex/terminal-first; no merge or public release.
