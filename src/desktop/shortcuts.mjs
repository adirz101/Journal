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
// label: shown in tooltips and <kbd>. aria: the same keys in the format of the
// aria-keyshortcuts attribute (modifiers Alt, Control, Meta, Shift, then the key).
const digit = n => `Digit${n}`;
const MAC = [
  { id: 'new-session', meta: true, key: 'n', label: '⌘N', aria: 'Meta+N' },
  { id: 'open-project', meta: true, key: 'o', label: '⌘O', aria: 'Meta+O' },
  { id: 'add-note', meta: true, shift: true, key: 'k', label: '⇧⌘K', aria: 'Meta+Shift+K' },
  { id: 'focus-terminal', meta: true, key: 'e', label: '⌘E', aria: 'Meta+E' },
  { id: 'toggle-inspector', meta: true, key: 'i', label: '⌘I', aria: 'Meta+I' },
  ...[1, 2, 3, 4].map(n => ({ id: `slot-${n}`, meta: true, code: digit(n), label: `⌘${n}`, aria: `Meta+${n}` })),
  { id: 'next-needs-you', meta: true, key: 'j', label: '⌘J', aria: 'Meta+J' },
  ...['session', 'files', 'memory'].map((tab, i) => ({ id: `tab-${tab}`, meta: true, alt: true, code: digit(i + 1), label: `⌥⌘${i + 1}`, aria: `Alt+Meta+${i + 1}` })),
];
const OTHER = [
  { id: 'new-session', control: true, shift: true, key: 'n', label: 'Ctrl+Shift+N', aria: 'Control+Shift+N' },
  { id: 'add-note', control: true, shift: true, key: 'k', label: 'Ctrl+Shift+K', aria: 'Control+Shift+K' },
  { id: 'focus-terminal', control: true, shift: true, key: 'e', label: 'Ctrl+Shift+E', aria: 'Control+Shift+E' },
  // Ctrl+Shift+I opens developer tools in development builds.
  { id: 'toggle-inspector', control: true, shift: true, key: 'b', label: 'Ctrl+Shift+B', aria: 'Control+Shift+B' },
  ...[1, 2, 3, 4].map(n => ({ id: `slot-${n}`, alt: true, code: digit(n), label: `Alt+${n}`, aria: `Alt+${n}` })),
  // Ctrl+J without Shift is a newline in shells and stays with the terminal.
  { id: 'next-needs-you', control: true, shift: true, key: 'j', label: 'Ctrl+Shift+J', aria: 'Control+Shift+J' },
  ...['session', 'files', 'memory'].map((tab, i) => ({ id: `tab-${tab}`, alt: true, shift: true, code: digit(i + 1), label: `Alt+Shift+${i + 1}`, aria: `Alt+Shift+${i + 1}` })),
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
    if (row.code ? input.code === row.code : pressed === row.key) return row.id;
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
export function shortcutKeys(platform) {
  const keys = Object.fromEntries(shortcutRows(platform).map(row => [row.id, { label: row.label, aria: row.aria }]));
  return platform === 'darwin' ? keys : { ...keys, 'open-project': { label: 'Ctrl+O', aria: 'Control+O' } };
}

export const COMMAND_IDS = [...new Set([...MAC, ...OTHER].map(row => row.id))];

// False for held-key repeats: claim the key, but do not send the command again.
export function shouldDispatch(input) {
  return input?.type === 'keyDown' && !input.isComposing && !input.isAutoRepeat;
}
