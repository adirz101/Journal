// The letter a key event means, by the same rule as letter() in
// src/desktop/shortcuts.mjs (tests/modal.test.mjs compares them): the character
// on the active layout when it is a Latin letter; the physical key only when
// the layout produces no printable ASCII character (Cyrillic, Greek…).
export function keyLetter(key: string, code: string): string | null {
  if (/^[A-Za-z]$/.test(key)) return key.toLowerCase();
  if (/^[\x20-\x7e]$/.test(key)) return null;
  return /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase() : null;
}
