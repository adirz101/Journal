// The first-note moment (Phase 7, board 12): once per install, never for an install that
// already had remembered notes. Without storage it never plays: a "first" moment that
// could repeat would be false. Every storage access is guarded.
export const FIRST_NOTE_KEY = 'journal-first-note-seen';
export type NoteStore = Pick<Storage, 'getItem' | 'setItem'>;
const defaultStore = (): NoteStore | null => { try { return globalThis.localStorage ?? null; } catch { return null; } };

// Called once at bootstrap: an install that already has notes (an upgrade) is marked seen silently.
export function settleFirstNote(hasNotes: boolean, store: NoteStore | null = defaultStore()) {
  if (!hasNotes || !store) return;
  try { store.setItem(FIRST_NOTE_KEY, '1'); } catch { /* claimFirstNote stays false without storage */ }
}

// After a note is remembered: true only the first time for this install, and never when
// the install had notes at start. The key is set either way.
export function claimFirstNote(hasNotesAtStart: boolean, store: NoteStore | null = defaultStore()): boolean {
  if (!store) return false;
  try {
    const seen = store.getItem(FIRST_NOTE_KEY) === '1';
    store.setItem(FIRST_NOTE_KEY, '1');
    return !seen && !hasNotesAtStart;
  } catch { return false; }
}
