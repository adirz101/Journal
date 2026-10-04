// What the session header, status bar and inspector derive from a session's
// records. Pure: tests/session-view.test.mjs checks it.
import type { Changes, Receipt, Session, TimelineEvent } from './types';
import { shell } from './copy';

export const packetBytes = (packet: string) => new TextEncoder().encode(packet).length;
const kilobytes = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

// Stored and live timeline events of one session, each once, oldest first.
// Live events carry no id; one that was also stored is recognised by its time, kind and body.
export function mergeEvents(stored: TimelineEvent[], live: TimelineEvent[], sessionId: string): TimelineEvent[] {
  const key = (event: TimelineEvent) => `${event.at}\u0000${event.kind}\u0000${JSON.stringify(event.body)}`;
  const ids = new Set<number>(); const keys = new Set<string>(); const merged: TimelineEvent[] = [];
  for (const event of [...stored, ...live]) {
    if (event.sessionId !== undefined && event.sessionId !== sessionId) continue;
    if (event.id !== undefined && ids.has(event.id)) continue;
    const k = key(event); if (keys.has(k)) continue;
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
