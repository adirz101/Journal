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
const digit = n => `Digit${n}`;
const MAC = [
  { id: 'new-session', meta: true, key: 'n', label: '⌘N' },
  { id: 'open-project', meta: true, key: 'o', label: '⌘O' },
  { id: 'add-note', meta: true, shift: true, key: 'k', label: '⇧⌘K' },
  { id: 'focus-terminal', meta: true, key: 'e', label: '⌘E' },
  { id: 'toggle-inspector', meta: true, key: 'i', label: '⌘I' },
  ...[1, 2, 3, 4].map(n => ({ id: `slot-${n}`, meta: true, code: digit(n), label: `⌘${n}` })),
  ...['session', 'files', 'memory'].map((tab, i) => ({ id: `tab-${tab}`, meta: true, alt: true, code: digit(i + 1), label: `⌥⌘${i + 1}` })),
];
const OTHER = [
  { id: 'new-session', control: true, shift: true, key: 'n', label: 'Ctrl+Shift+N' },
  { id: 'add-note', control: true, shift: true, key: 'k', label: 'Ctrl+Shift+K' },
  { id: 'focus-terminal', control: true, shift: true, key: 'e', label: 'Ctrl+Shift+E' },
  // Ctrl+Shift+I opens developer tools in development builds.
  { id: 'toggle-inspector', control: true, shift: true, key: 'b', label: 'Ctrl+Shift+B' },
  ...[1, 2, 3, 4].map(n => ({ id: `slot-${n}`, alt: true, code: digit(n), label: `Alt+${n}` })),
  ...['session', 'files', 'memory'].map((tab, i) => ({ id: `tab-${tab}`, alt: true, shift: true, code: digit(i + 1), label: `Alt+Shift+${i + 1}` })),
];
const rows = platform => platform === 'darwin' ? MAC : OTHER;

// The letter a key event means: its character on the active layout when that
// is a Latin letter (so Dvorak ⌘N is the key labelled N), otherwise its
// physical position (so ⌘N still works with a Cyrillic layout active).
function letter(input) {
  const key = typeof input.key === 'string' ? input.key.toLowerCase() : '';
  if (/^[a-z]$/.test(key)) return key;
  return /^Key[A-Z]$/.test(input.code ?? '') ? input.code.slice(3).toLowerCase() : null;
}

// input: Electron's before-input-event Input. Returns a command id or null.
export function matchShortcut(input, platform) {
  if (input?.type !== 'keyDown' || input.isComposing) return null;
  const pressed = letter(input);
  for (const row of rows(platform)) {
    if (!!row.meta !== !!input.meta || !!row.control !== !!input.control || !!row.alt !== !!input.alt || !!row.shift !== !!input.shift) continue;
    if (row.code ? input.code === row.code : pressed === row.key) return row.id;
  }
  return null;
}

// Labels for tooltips and menus, by command id. On Windows and Linux, Ctrl+O is
// not routed (the CLI owns it while the terminal has focus); the renderer
// handles it when focus is elsewhere in the window.
export function shortcutLabels(platform) {
  const labels = Object.fromEntries(rows(platform).map(row => [row.id, row.label]));
  return platform === 'darwin' ? labels : { ...labels, 'open-project': 'Ctrl+O' };
}

export const COMMAND_IDS = [...new Set([...MAC, ...OTHER].map(row => row.id))];
