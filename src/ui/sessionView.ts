// What the session header, status bar and inspector derive from a session's
// records. Pure: tests/session-view.test.mjs checks it.
import type { Changes, Receipt, Session, TimelineEvent } from './types';
import { shell } from './copy';

export const packetBytes = (packet: string) => new TextEncoder().encode(packet).length;
const kilobytes = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

// Stored and live timeline events of one session, each once, oldest first.
// Live events carry no id; one that was also stored is recognised by its time, kind and body.
const eventKey = (event: TimelineEvent) => `${event.at}\u0000${event.kind}\u0000${JSON.stringify(event.body)}`;
export interface EventIndex { ids: Set<number>; keys: Set<string>; events: TimelineEvent[] }

// The stored events of one session, each once, with their ids and keys: built
// once per fetch, so a live event never re-serializes the whole stored history.
export function indexEvents(stored: TimelineEvent[], sessionId: string): EventIndex {
  const index: EventIndex = { ids: new Set(), keys: new Set(), events: [] };
  for (const event of stored) {
    if (event.sessionId !== undefined && event.sessionId !== sessionId) continue;
    if (event.id !== undefined && index.ids.has(event.id)) continue;
    const k = eventKey(event); if (index.keys.has(k)) continue;
    if (event.id !== undefined) index.ids.add(event.id); index.keys.add(k); index.events.push(event);
  }
  return index;
}

export function mergeEvents(stored: TimelineEvent[], live: TimelineEvent[], sessionId: string, index: EventIndex = indexEvents(stored, sessionId)): TimelineEvent[] {
  const ids = new Set<number>(); const keys = new Set<string>(); const merged = [...index.events];
  for (const event of live) {
    if (event.sessionId !== undefined && event.sessionId !== sessionId) continue;
    if (event.id !== undefined && (index.ids.has(event.id) || ids.has(event.id))) continue;
    const k = eventKey(event); if (index.keys.has(k) || keys.has(k)) continue;
    if (event.id !== undefined) ids.add(event.id); keys.add(k); merged.push(event);
  }
  return collapseTurns(merged.sort((a, b) => a.at.localeCompare(b.at)));
}

// One entry per turn: turn ends that name the same turn (a stronger outcome reported after the
// first, or a repeat) collapse into the first, with the strongest outcome. The runtime records
// each for audit; turn ends without a turn key (Claude) are left as they are.
const PRECEDENCE: Record<string, number> = { completed: 1, error: 2, interrupted: 3 };
export function collapseTurns(events: TimelineEvent[]): TimelineEvent[] {
  const first = new Map<string, number>(); const out: TimelineEvent[] = [];
  for (const event of events) {
    const turn = event.kind === 'turn-end' && typeof event.body?.turn === 'string' ? event.body.turn : null;
    if (turn === null) { out.push(event); continue; }
    const at = first.get(turn);
    if (at === undefined) { first.set(turn, out.length); out.push(event); continue; }
    const kept = out[at]; const outcome = String(event.body.outcome ?? ''); const before = String(kept.body.outcome ?? '');
    const late = !!kept.body.late && !!event.body.late;
    out[at] = { ...kept, body: { ...kept.body, outcome: (PRECEDENCE[outcome] ?? 0) > (PRECEDENCE[before] ?? 0) ? outcome : before, ...(late ? { late: true } : {}) } };
    if (!late) delete out[at].body.late;
  }
  return out;
}

// The status bar's delivery summary for the session's own receipt.
export function statusLine(receipt: Receipt | null): { text: string; link: 'sent' | 'prepared' | null } {
  if (!receipt) return { text: '', link: null };
  const size = kilobytes(packetBytes(receipt.packet)); const notes = receipt.items.length;
  if (receipt.state === 'submitted') return { text: notes ? shell.agentGot(notes, size) : shell.agentGotNone, link: 'sent' };
  if (receipt.state === 'uncertain') return { text: shell.deliveryUncertain(notes, size), link: 'prepared' };
  if (receipt.state === 'failed') return { text: shell.notSent, link: null };
  return { text: '', link: null };
}

// Lines and files this session changed. Files already modified when it
// started ("before") are left out of all three numbers; new untracked files count.
export function diffSummary(changes: Changes | null): { additions: number; deletions: number; files: number } | null {
  if (!changes?.available) return null;
  const own = changes.files.filter(file => !file.preexisting);
  return { additions: own.reduce((sum, file) => sum + (file.additions ?? 0), 0), deletions: own.reduce((sum, file) => sum + (file.deletions ?? 0), 0), files: own.length };
}

// Only Claude reports its commands, edits and prompts (hooks).
// Claude always reports its activity; Codex and Cursor only when this launch's hooks are registered.
export const activityVisible = (session: Session) => session.provider === 'claude' || !!session.observes;
