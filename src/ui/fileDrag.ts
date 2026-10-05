// Dragging files onto a session's terminal (a Files tab row, or a file from Finder or File Explorer).
// The Files tab marks its drags with this type; the terminal accepts it and OS files.
export const JOURNAL_FILE = 'application/x-journal-file';
export interface JournalFileDrag { rootKey: string; path: string }

export const isFileDrag = (types: readonly string[] | DOMStringList | undefined) =>
  !!types && (Array.from(types as ArrayLike<string>).includes(JOURNAL_FILE) || Array.from(types as ArrayLike<string>).includes('Files'));

export function readJournalFile(data: string): JournalFileDrag | null {
  try { const value = JSON.parse(data); return typeof value?.rootKey === 'string' && typeof value?.path === 'string' && value.path ? { rootKey: value.rootKey, path: value.path } : null; }
  catch { return null; }
}

// What a dropped set of references becomes at the cursor: separated by spaces, then one space,
// never a newline (a drop never submits).
export const insertion = (texts: string[]) => texts.length ? `${texts.join(' ')} ` : '';
