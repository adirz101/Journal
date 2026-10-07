# Agent-first team flow implementation plan

> Execution: superpowers:executing-plans, inline; parent coordinates independent final review.

**Goal:** Implement the user-approved conversation-first team workflow with persistent tasks, contextual attention, adjacent review and native terminals.
**Architecture:** Render durable user messages and explicit coordinator updates, not a manufactured native transcript. Reuse launch-bound tools, addressed delivery receipts and exact-result integration.
**Tech stack:** Existing React/Electron, CSS, SQLite model and provider PTYs.
**Spec:** User-approved external HTML options document (7 October 2026), recommended option 01. No external comparison text is copied into this repository.

## Global constraints
Node >=24; fixtureEnv for all Electron launches; no real provider access. English copy. Preserve permissions, exact-ID resume, immutable evidence and integration guards. No numeric worker limits, idle reclamation or standalone test executor UI; integrate concurrent removal branches before final checks.

## Review focus
- Forged or obsolete coordinator updates must never appear as current agent authority.
- Queued/submitted messages must not be labeled read; ambiguous delivery must not replay.
- Multiple results, stale previews and approvals must keep the exact identity reviewed.
- Long goals, empty plans and narrow layouts must remain understandable and keyboard accessible.
- Drafts, selected detail and scroll context must survive live updates.

## Task 1: Durable coordinator updates
Files: orchestration/runs.mjs, store facade/method list, tool-router, definitions, prompts; tests/orchestration-model.test.mjs and agent-tools.test.mjs.
Interface: publishUpdate({runId,callerId,requestId,sessionId,launchId,summary}) records coordinator.update event.
- [x] Regression coverage: test live coordinator binding, worker rejection, stale launch rejection, bounded/redacted text, durable idempotency.
- [x] Implement and pass targeted model/router tests.

## Task 2: Conversation and persistent task summary
Files: TeamPanel.tsx, new TeamConversation.tsx, team.css, run story model.
Interface: real message/update events with chronological cursor order and explicit source labels; existing TeamAction input route.
- [x] Fixture desktop flow starts in Conversation, shows published update, queues/cancels instruction honestly, opens native terminal and returns, preserves draft.
- [x] Implement summary rail, attention cards, short heading, mission expansion and advanced controls without mandatory tabs.

## Task 3: Contextual result review and recovery
Files: TeamPanel.tsx/result component and fixture desktop team specs.
Interface: unchanged preview/apply expect token and exact result IDs, contextual acceptance/stop when actually required.
- [x] Fixture result has adjacent changes/reported checks/preview; explicit Apply and stale protection remain.
- [x] Implement and update docs; preserve legacy evidence access.

## Task 4: Integration and validation
- [x] Merge parent-approved capacity and verification removal branches.
- [x] npm test; npm run check; npm run build; npm run test:desktop with Electron-native node-pty.
- [x] Independent parent-arranged review and fixes.
- [ ] PR checks and merge coordination. No release.


## Validation record
- Model/router/conversation/cursor regressions: 22 passed after the review fixes.
- Full unit suite: Node 26.10.0, 908 passed, 2 skipped (910 total).
- Type checking and build passed; existing Vite bundle-size warning remains.
- Focused Electron conversation/result fixture passed using Electron-native node-pty.
- Full Electron suite: 162 passed, 1 skipped (8.8 minutes). Final focused flow passed after review fixes (23.2 seconds), covering inspector/terminal shortcuts, remount-safe drafts, real decisions, immutable diffs and explicit Apply.
- Parent visual review and independent high-risk code review found no remaining blockers.
- No authenticated provider trial or release was performed.
