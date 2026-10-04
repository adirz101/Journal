// The pure parts of the "Check needed" scan (useMemoryChecks). tests/note-card.test.mjs
// runs them; the hook keeps the timing, the queue and the React state.
import type { Memory } from './types';

// A window focus within this long after the last finished scan does not start another.
export const FOCUS_QUIET_MS = 5000;

// The visible page's notes that already need a check and that the scan counts: notes of
// this project (a page of the previous project can still be on screen after a switch)
// whose status is current (active or candidate). History also lists forgotten
// (archived) and rejected notes, which the scan never counts.
export function seedStale(seed: readonly Pick<Memory, 'id' | 'projectId' | 'status' | 'validation'>[], projectId: string | null): string[] {
  if (!projectId) return [];
  return seed.filter(note => note.projectId === projectId && (note.status === 'active' || note.status === 'candidate') && note.validation === 'stale').map(note => note.id);
}

// A focus starts a scan unless one is running or the last one finished under FOCUS_QUIET_MS
// ago (a focus storm, or the focus that comes with restoring a window that already rescans).
export function focusStartsScan(lastFinishedAt: number | null | undefined, now: number, scanning: boolean): boolean {
  if (scanning) return false;
  return lastFinishedAt === null || lastFinishedAt === undefined || now - lastFinishedAt >= FOCUS_QUIET_MS;
}

// What the count shows. While a scan runs: the last finished result plus the visible
// page's own notes (no partial results, so the count does not flicker). Once it
// finishes: its result alone. Before any result: the visible page's notes.
export function shownStale(last: ReadonlySet<string> | null, seeded: readonly string[], scanning: boolean): Set<string> {
  if (last && !scanning) return new Set(last);
  return new Set([...(last ?? []), ...seeded]);
}

// A finished scan's result. A scan that covered every current note is exact; one that
// stopped at the cap (or failed) adds the visible page's notes it may not have reached.
export function finishedStale(found: Iterable<string>, seeded: readonly string[], complete: boolean): Set<string> {
  return new Set([...found, ...(complete ? [] : seeded)]);
}
