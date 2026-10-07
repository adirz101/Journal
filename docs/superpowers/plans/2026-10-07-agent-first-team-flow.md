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
- [ ] Red: test live coordinator binding, worker rejection, stale launch rejection, bounded/redacted text, durable idempotency.
- [ ] Implement and pass targeted model/router tests.

## Task 2: Conversation and persistent task summary
Files: TeamPanel.tsx, new TeamConversation.tsx, team.css, run story model.
Interface: real message/update events with chronological cursor order and explicit source labels; existing TeamAction input route.
- [ ] Red: fixture desktop flow starts in Conversation, shows published update, queues/cancels instruction honestly, opens native terminal and returns, preserves draft.
- [ ] Implement summary rail, attention cards, short heading, mission expansion and advanced controls without mandatory tabs.

## Task 3: Contextual result review and recovery
Files: TeamPanel.tsx/result component and fixture desktop team specs.
Interface: unchanged preview/apply expect token and exact result IDs, contextual acceptance/stop when actually required.
- [ ] Red: fixture result has adjacent changes/reported checks/preview; explicit Apply and stale protection remain.
- [ ] Implement and update docs; preserve legacy evidence access.

## Task 4: Integration and validation
- [ ] Merge parent-approved capacity and verification removal branches.
- [ ] npm test; npm run check; npm run build; npm run test:desktop with Electron-native node-pty.
- [ ] Independent parent-arranged review, fixes, PR and merge coordination. No release.

