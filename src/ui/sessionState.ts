// What a session's state means to the user (design board B8), and which
// sessions need them. Pure: the sidebar, the header and the shortcuts share it.
import { isLive, type Session } from './types';
import { copy } from './copy';

export type Tone = 'neutral' | 'active' | 'attention' | 'error' | 'muted';
// limited: Journal sees only output for this provider (Codex, Cursor), not its state.
export interface SessionState { word: string; tone: Tone; detail: string | null; limited: boolean }

export const OUTPUT_FRESH_MS = 10_000;
const words = copy.state;
const state = (word: string, tone: Tone, detail: string | null = null, limited = false): SessionState => ({ word, tone, detail, limited });

// Time since Codex or Cursor last printed (lastOutputAt excludes echo and resize repaints).
export function outputDetail(lastOutputAt: string | null | undefined, now: number) {
  if (!lastOutputAt) return words.noOutput;
  const quiet = now - Date.parse(lastOutputAt);
  if (!(quiet >= OUTPUT_FRESH_MS)) return words.outputNow;
  if (quiet < 60_000) return words.quiet('<1m');
  if (quiet < 3_600_000) return words.quiet(`${Math.floor(quiet / 60_000)}m`);
  return words.quiet(`${Math.floor(quiet / 3_600_000)}h`);
}

// The first matching row of the state table wins. While the runtime is
// disconnected, a live session's real state is unknown.
export function stateFor(session: Session, now: number, connected: boolean): SessionState {
  const claude = session.provider === 'claude';
  if (isLive(session) && !connected) return state(words.disconnected, 'muted', words.unknown);
  if (claude && session.status === 'waiting') { const p = session.pending; return state(words.needsApproval, 'attention', p?.command ?? p?.path ?? p?.tool ?? null); }
  if (claude && session.status === 'running') return session.activity === 'idle' ? state(words.yourTurn, 'active') : state(words.working, 'active');
  // Codex and Cursor have no state hooks: never "needs approval", even with a stale waiting status.
  if (session.status === 'running' || session.status === 'waiting') return state(words.running, 'active', outputDetail(session.lastOutputAt, now), true);
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
export const needsYou = (session: Session) => !session.removed && !session.archived
  && ((session.provider === 'claude' && session.status === 'waiting') || session.status === 'failed' || session.status === 'orphaned' || !!session.survivors?.length);

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
