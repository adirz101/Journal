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
  return merged.sort((a, b) => a.at.localeCompare(b.at));
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
export const activityVisible = (session: Session) => session.provider === 'claude';
