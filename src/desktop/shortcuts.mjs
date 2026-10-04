// App shortcuts (design decision D8). The main process matches them in
// before-input-event, so they work while the terminal has focus, and sends
// {type: 'command', id} to the renderer. Any key not listed here reaches the
// page and the terminal untouched.
//
// macOS uses ⌘, which terminals do not receive. Windows and Linux use
// Ctrl+Shift, or Alt+digit for slots: the CLIs own Ctrl+letter (Ctrl+C, Ctrl+R,
// Ctrl+O…) and Alt+letter (word movement). Ctrl+Alt is avoided because it is
// AltGr on many European layouts.
//
// Add a row only together with the renderer code that handles its id: a row
// without a handler would swallow a key and do nothing.
//
// code: a physical key; codes and chars: other physical keys and characters that
// also match (the modifiers must still match exactly).
// label: shown in tooltips and <kbd>. aria: the same keys in the format of the
// aria-keyshortcuts attribute (modifiers Alt, Control, Meta, Shift, then the key).
// alias: a second key for the same id; it is matched but never labelled, so
// tooltips, menus and aria-keyshortcuts show the primary row.
const digit = n => `Digit${n}`;
const MAC = [
  // Phase 8: ⇧⌘P is an alias of ⌘K (it comes first and is marked, so labels show ⌘K).
  // ⌘K differs from the add-note row ⇧⌘K by Shift, which matchShortcut compares.
  { id: 'command-palette', meta: true, shift: true, key: 'p', label: '⇧⌘P', aria: 'Meta+Shift+P', alias: true },
  { id: 'command-palette', meta: true, key: 'k', label: '⌘K', aria: 'Meta+K' },
  { id: 'open-file', meta: true, key: 'p', label: '⌘P', aria: 'Meta+P' },
  { id: 'new-session', meta: true, key: 'n', label: '⌘N', aria: 'Meta+N' },
  { id: 'open-project', meta: true, key: 'o', label: '⌘O', aria: 'Meta+O' },
  { id: 'add-note', meta: true, shift: true, key: 'k', label: '⇧⌘K', aria: 'Meta+Shift+K' },
  { id: 'focus-terminal', meta: true, key: 'e', label: '⌘E', aria: 'Meta+E' },
  { id: 'toggle-inspector', meta: true, key: 'i', label: '⌘I', aria: 'Meta+I' },
  // Matched by the character too: ISO and other layouts put \ on another key.
  // (On a Mac ISO keyboard IntlBackslash is the § key, so it is not listed.)
  { id: 'toggle-sidebar', meta: true, code: 'Backslash', chars: ['\\'], label: '⌘\\', aria: 'Meta+\\' },
  ...[1, 2, 3, 4].map(n => ({ id: `slot-${n}`, meta: true, code: digit(n), label: `⌘${n}`, aria: `Meta+${n}` })),
  { id: 'next-needs-you', meta: true, key: 'j', label: '⌘J', aria: 'Meta+J' },
  ...['session', 'files', 'memory'].map((tab, i) => ({ id: `tab-${tab}`, meta: true, alt: true, code: digit(i + 1), label: `⌥⌘${i + 1}`, aria: `Alt+Meta+${i + 1}` })),
  // Punctuation matches its physical key: letter() never matches it.
  { id: 'settings', meta: true, code: 'Comma', label: '⌘,', aria: 'Meta+,' },
];
const OTHER = [
  // Phase 8: Ctrl+K is kill-line and Ctrl+P is shell history; both stay with the terminal.
  { id: 'command-palette', control: true, shift: true, key: 'p', label: 'Ctrl+Shift+P', aria: 'Control+Shift+P' },
  { id: 'open-file', control: true, shift: true, key: 'o', label: 'Ctrl+Shift+O', aria: 'Control+Shift+O' },
  { id: 'new-session', control: true, shift: true, key: 'n', label: 'Ctrl+Shift+N', aria: 'Control+Shift+N' },
  { id: 'add-note', control: true, shift: true, key: 'k', label: 'Ctrl+Shift+K', aria: 'Control+Shift+K' },
  { id: 'focus-terminal', control: true, shift: true, key: 'e', label: 'Ctrl+Shift+E', aria: 'Control+Shift+E' },
  // Ctrl+Shift+I opens developer tools in development builds.
  { id: 'toggle-inspector', control: true, shift: true, key: 'b', label: 'Ctrl+Shift+B', aria: 'Control+Shift+B' },
  // Ctrl+\ without Shift sends SIGQUIT and stays with the terminal.
  // UK and other ISO keyboards report the \ key beside left Shift as IntlBackslash.
  { id: 'toggle-sidebar', control: true, shift: true, code: 'Backslash', codes: ['IntlBackslash'], chars: ['\\', '|'], label: 'Ctrl+Shift+\\', aria: 'Control+Shift+\\' },
  ...[1, 2, 3, 4].map(n => ({ id: `slot-${n}`, alt: true, code: digit(n), label: `Alt+${n}`, aria: `Alt+${n}` })),
  // Ctrl+J without Shift is a newline in shells and stays with the terminal.
  { id: 'next-needs-you', control: true, shift: true, key: 'j', label: 'Ctrl+Shift+J', aria: 'Control+Shift+J' },
  ...['session', 'files', 'memory'].map((tab, i) => ({ id: `tab-${tab}`, alt: true, shift: true, code: digit(i + 1), label: `Alt+Shift+${i + 1}`, aria: `Alt+Shift+${i + 1}` })),
  { id: 'settings', control: true, code: 'Comma', label: 'Ctrl+,', aria: 'Control+,' },
];
export const shortcutRows = platform => platform === 'darwin' ? MAC : OTHER;

// The letter a key event means: its character on the active layout when that
// is a Latin letter (so Dvorak ⌘N is the key labelled N). Only when the layout
// produces no printable ASCII character at all (Cyrillic, Greek…) does the
// physical position decide, so ⌘N still works there. A printable ASCII
// non-letter ("." or ">" where QWERTY has E) is never a letter: Dvorak ⌘. must
// not trigger ⌘E.
// Digit rows always use the physical key position, so Programmer Dvorak (which
// shows 7 on Digit1) triggers the same slot as QWERTY, as in VS Code.
function letter(input) {
  const key = typeof input.key === 'string' ? input.key : '';
  if (/^[A-Za-z]$/.test(key)) return key.toLowerCase();
  if (/^[\x20-\x7e]$/.test(key)) return null;
  return /^Key[A-Z]$/.test(input.code ?? '') ? input.code.slice(3).toLowerCase() : null;
}

// input: Electron's before-input-event Input. Returns a command id or null.
// Auto-repeat keydowns are matched too, so the router still calls
// preventDefault (otherwise Alt+1 would leak ESC-1 to the terminal); it should
// send the command only when shouldDispatch(input) is true.
export function matchShortcut(input, platform) {
  if (input?.type !== 'keyDown' || input.isComposing) return null;
  const pressed = letter(input);
  for (const row of shortcutRows(platform)) {
    if (!!row.meta !== !!input.meta || !!row.control !== !!input.control || !!row.alt !== !!input.alt || !!row.shift !== !!input.shift) continue;
    if (row.code ? input.code === row.code || row.codes?.includes(input.code) || row.chars?.includes(input.key) : pressed === row.key) return row.id;
  }
  return null;
}

// Labels for tooltips and menus, by command id. On Windows and Linux, Ctrl+O is
// not routed (the CLI owns it while the terminal has focus); the renderer
// handles it when focus is elsewhere in the window.
export function shortcutLabels(platform) {
  return Object.fromEntries(Object.entries(shortcutKeys(platform)).map(([id, keys]) => [id, keys.label]));
}

// { label, aria } by command id: what the renderer receives as bootstrap.shortcuts.
// Alias rows are skipped: an id is always labelled by its primary keys.
export function shortcutKeys(platform) {
  const keys = Object.fromEntries(shortcutRows(platform).filter(row => !row.alias).map(row => [row.id, { label: row.label, aria: row.aria }]));
  return platform === 'darwin' ? keys : { ...keys, 'open-project': { label: 'Ctrl+O', aria: 'Control+O' } };
}

export const COMMAND_IDS = [...new Set([...MAC, ...OTHER].map(row => row.id))];

// False for held-key repeats: claim the key, but do not send the command again.
export function shouldDispatch(input) {
  return input?.type === 'keyDown' && !input.isComposing && !input.isAutoRepeat;
}
