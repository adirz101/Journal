// macOS text-editing keys in the terminal. xterm.js sends nothing for ⌘ combinations, and the
// native CLIs (Claude Code, Codex, Cursor) read standard line-editing control codes, as they get
// them from macOS terminals set up for natural text editing. Pure, so it can be tested directly.
// Only these keys are handled; everything else keeps xterm's own behaviour. Journal's own
// shortcuts (⌘K, ⌘N, ⌘1–4 …) are routed by the main process before the page sees them.
export interface KeyLike { type: string; key: string; metaKey: boolean; altKey: boolean; ctrlKey: boolean; shiftKey: boolean; isComposing?: boolean }

const MAC_KEYS: Record<string, string> = {
  'Meta+Backspace': '\x15',  // delete to the start of the line (Ctrl+U)
  'Meta+ArrowLeft': '\x01',  // start of the line (Ctrl+A)
  'Meta+ArrowRight': '\x05', // end of the line (Ctrl+E)
  'Alt+Backspace': '\x17',   // delete the previous word (Ctrl+W)
  'Alt+ArrowLeft': '\x1bb',  // back one word (Esc b)
  'Alt+ArrowRight': '\x1bf', // forward one word (Esc f)
};

export function editingKey(event: KeyLike, mac: boolean): string | null {
  if (!mac || event.type !== 'keydown' || event.isComposing || event.ctrlKey || event.shiftKey) return null;
  if (event.metaKey === event.altKey) return null; // exactly one of ⌘ and ⌥
  return MAC_KEYS[`${event.metaKey ? 'Meta' : 'Alt'}+${event.key}`] ?? null;
}
