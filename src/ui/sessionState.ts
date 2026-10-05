// What a session's state means to the user (design board B8), and which
// sessions need them. Pure: the sidebar, the header and the shortcuts share it.
import { isLive, type Session } from './types';
import { copy } from './copy';

export type Tone = 'neutral' | 'active' | 'attention' | 'error' | 'muted';
// limited: Journal sees only output (Codex and Cursor, or any session whose observer is not live), not its state.
export interface SessionState { word: string; tone: Tone; detail: string | null; limited: boolean }

export const OUTPUT_FRESH_MS = 10_000;
// Working not confirmed by a hook event for this long says so; it stays Working (silence is not an end).
export const HOOK_QUIET_MS = 5 * 60_000;
const words = copy.state;
const state = (word: string, tone: Tone, detail: string | null = null, limited = false): SessionState => ({ word, tone, detail, limited });

const span = (ms: number) => ms < 60_000 ? '<1m' : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 3_600_000)}h`;
// Time since Codex or Cursor last printed (lastOutputAt excludes echo and resize repaints).
export function outputDetail(lastOutputAt: string | null | undefined, now: number) {
  if (!lastOutputAt) return words.noOutput;
  const quiet = now - Date.parse(lastOutputAt);
  if (!(quiet >= OUTPUT_FRESH_MS)) return words.outputNow;
  return words.quiet(span(quiet));
}

// A current state (Working, Your turn, Needs approval) needs a live observer. A runtime from
// before observation states sends none: Claude is shown as it was then.
export const observed = (session: Session) => session.observation === 'live' || (session.observation === undefined && session.provider === 'claude');

// What a session's hooks can report. Claude reports turns and approvals (a runtime from before
// capabilities sends none); Codex reports both; Cursor reports turn end only with Journal's
// entries in the user's hooks.json, and approvals never.
export const reports = (session: Session, what: 'turns' | 'approvals') =>
  session.provider === 'claude' ? session.observes?.[what] !== false : !!session.observes?.[what];
// A state shown as current needs a live observer that reports it.
const shows = (session: Session, what: 'turns' | 'approvals') => observed(session) && reports(session, what);
// Journal sees only the session's output (no live observer that reports its turns).
export const outputOnly = (session: Session) => !shows(session, 'turns');

// The limited model's detail: output time, or how long the state has been unknown, then the
// last observed fact as past evidence ("last seen: tool finished, 12m ago").
export function limitedDetail(session: Session, now: number) {
  const last = session.lastObserved; const at = last ? Date.parse(last.at) : NaN;
  const first = session.observation === 'lost' && Number.isFinite(at) ? words.unknownSince(span(Math.max(0, now - at))) : outputDetail(session.lastOutputAt, now);
  return last && Number.isFinite(at) ? `${first} · ${words.lastSeen(words.facts[last.fact] ?? last.fact, span(Math.max(0, now - at)))}` : first;
}

// The first matching row of the state table wins. While the runtime is
// disconnected, a live session's real state is unknown.
export function stateFor(session: Session, now: number, connected: boolean): SessionState {
  if (isLive(session) && !connected) return state(words.disconnected, 'muted', words.unknown);
  if (session.status === 'waiting' && shows(session, 'approvals')) { const p = session.pending; return state(words.needsApproval, 'attention', p?.command ?? p?.path ?? p?.tool ?? null); }
  // An unknown activity (a prompt sent to an agent that announces no turn start) is not shown as current.
  if (session.status === 'running' && shows(session, 'turns') && session.activity) {
    if (session.activity === 'idle') return state(words.yourTurn, 'active');
    // A long tool run can be silent: confidence ages, the state is never declared finished.
    const at = session.lastObserved ? Date.parse(session.lastObserved.at) : NaN;
    return state(words.working, 'active', now - at >= HOOK_QUIET_MS ? words.noHookActivity(span(now - at)) : null);
  }
  // Without a live observer that reports it: never "needs approval" or "your turn", even with an earlier waiting or idle state.
  if (session.status === 'running' || session.status === 'waiting') return state(words.running, 'active', limitedDetail(session, now), true);
  switch (session.status) {
    case 'starting': return state(words.starting, 'neutral');
    case 'stopping': return state(words.stopping, 'neutral');
    case 'exited': return session.exitCode ? state(words.exited(session.exitCode), 'error') : state(words.exited(0), 'neutral');
    case 'failed': return state(words.failed, 'error');
    case 'stopped': return state(words.stopped, 'muted');
    case 'interrupted': return state(words.interrupted, 'muted');
    default: return state(words.orphaned, 'attention');
  }
}

// Failed sessions and leftover processes stay "needs you" until archived or cleaned up.
// Archiving hides only ended sessions: a live one that waits still needs the user,
// so the badge, the attention dot and the next-needs-you shortcut agree.
export const needsYou = (session: Session) => !session.removed && (!session.archived || isLive(session))
  && ((session.status === 'waiting' && shows(session, 'approvals')) || session.status === 'failed' || session.status === 'orphaned' || !!session.survivors?.length);

export const resumable = (session: Session) => !isLive(session) && session.status !== 'orphaned' && session.nativeIdConfirmed && !!session.nativeId;

const slotted = (session: Session) => isLive(session) && !!session.slot;
const newestFirst = (a: Session, b: Session) => b.createdAt.localeCompare(a.createdAt);
// The Active group: live sessions by their stable slot, then orphans (which hold
// no slot) and any live session without one (an older runtime), newest first.
// Pins do not reorder it.
export function slotOrder(sessions: Session[]) {
  const shown = sessions.filter(s => !s.removed);
  return [...shown.filter(slotted).sort((a, b) => (a.slot! - b.slot!) || newestFirst(a, b)),
    ...shown.filter(s => !slotted(s) && (isLive(s) || s.status === 'orphaned')).sort(newestFirst)];
}

export const slotTarget = (sessions: Session[], slot: number) => slotOrder(sessions).find(s => slotted(s) && s.slot === slot) ?? null;

// The next session that needs the user after the current one, in slot order,
// then other such sessions (failed ones) newest first; wraps around.
export function nextNeedsYou(sessions: Session[], currentId: string | null) {
  const ordered = slotOrder(sessions);
  const order = [...ordered, ...sessions.filter(s => needsYou(s) && !ordered.includes(s)).sort(newestFirst)];
  const start = order.findIndex(s => s.id === currentId);
  for (let step = 1; step <= order.length; step++) {
    const candidate = order[(start + step) % order.length];
    if (candidate.id !== currentId && needsYou(candidate)) return candidate;
  }
  return null;
}
