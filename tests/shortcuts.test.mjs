import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMMAND_IDS, matchShortcut, shortcutLabels, shortcutRows, shouldDispatch } from '../src/desktop/shortcuts.mjs';

// Electron Input objects as before-input-event delivers them.
const key = (spec, extra = {}) => {
  const parts = spec.split('+'); const name = parts.pop();
  const code = /^\d$/.test(name) ? `Digit${name}` : /^[A-Za-z]$/.test(name) ? `Key${name.toUpperCase()}` : { Enter: 'Enter', '\\': 'Backslash', ',': 'Comma' }[name];
  return { type: 'keyDown', key: name, code, meta: parts.includes('Meta'), control: parts.includes('Control'), alt: parts.includes('Alt'), shift: parts.includes('Shift'), isComposing: false, ...extra };
};

const ROUTED = {
  darwin: [['Meta+N', 'new-session'], ['Meta+O', 'open-project'], ['Meta+Shift+K', 'add-note'], ['Meta+E', 'focus-terminal'], ['Meta+I', 'toggle-inspector'],
    ['Meta+1', 'slot-1'], ['Meta+4', 'slot-4'], ['Meta+Alt+1', 'tab-session'], ['Meta+Alt+2', 'tab-files'], ['Meta+Alt+3', 'tab-memory']],
  win32: [['Control+Shift+N', 'new-session'], ['Control+Shift+K', 'add-note'], ['Control+Shift+E', 'focus-terminal'], ['Control+Shift+B', 'toggle-inspector'],
    ['Alt+1', 'slot-1'], ['Alt+4', 'slot-4'], ['Alt+Shift+1', 'tab-session'], ['Alt+Shift+2', 'tab-files'], ['Alt+Shift+3', 'tab-memory']],
};
ROUTED.linux = ROUTED.win32;

// Keys the terminal and its CLI own: never intercepted.
const TERMINAL = {
  darwin: ['Control+C', 'Control+D', 'Control+Z', 'Control+L', 'Control+R', 'Control+O', 'Control+A', 'Control+E', 'Control+K', 'Control+U', 'Control+W', 'Control+1', 'Alt+1', 'Alt+B', 'Meta+C', 'Meta+V', 'Meta+Q', 'Meta+W', 'Meta+R', 'Meta+5', 'Meta+K', 'Meta+P', 'Meta+Enter'],
  win32: ['Control+C', 'Control+D', 'Control+Z', 'Control+L', 'Control+R', 'Control+O', 'Control+N', 'Control+P', 'Control+K', 'Control+W', 'Control+E', 'Control+B', 'Control+A', 'Control+U',
    'Control+1', 'Control+Enter', 'Alt+B', 'Alt+F', 'Alt+5', 'Control+Alt+2', 'Control+Shift+C', 'Control+Shift+V', 'Control+Shift+P', 'Control+Shift+T', 'Control+Shift+W', 'Control+Shift+F', 'Control+Shift+X', 'Control+Shift+Z', 'Control+Shift+A', 'Meta+1', 'Meta+N'],
};
TERMINAL.linux = TERMINAL.win32;

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`${platform}: app shortcuts are routed`, () => {
    for (const [spec, id] of ROUTED[platform]) assert.equal(matchShortcut(key(spec), platform), id, spec);
  });
  test(`${platform}: terminal keys pass through`, () => {
    for (const spec of TERMINAL[platform]) assert.equal(matchShortcut(key(spec), platform), null, spec);
  });
}

test('only key presses outside an input method composition count', () => {
  assert.equal(matchShortcut(key('Meta+N', { type: 'keyUp' }), 'darwin'), null);
  assert.equal(matchShortcut(key('Meta+N', { isComposing: true }), 'darwin'), null);
  assert.equal(matchShortcut(null, 'darwin'), null);
});

test('letters follow the layout; digits and non-Latin layouts follow the physical key', () => {
  // Dvorak: the key labelled N sits where QWERTY has L.
  assert.equal(matchShortcut({ ...key('Meta+N'), code: 'KeyL' }, 'darwin'), 'new-session');
  // Russian layout: ⌘ plus the physical N key types "т".
  assert.equal(matchShortcut({ ...key('Meta+N'), key: 'т' }, 'darwin'), 'new-session');
  // Shift changes key ("N", "|", "!"); macOS Option changes it too ("¡").
  assert.equal(matchShortcut({ ...key('Alt+Shift+1'), key: '!' }, 'linux'), 'tab-session');
  assert.equal(matchShortcut({ ...key('Meta+Alt+1'), key: '¡' }, 'darwin'), 'tab-session');
  // AZERTY: Alt plus the physical 1 key types "&".
  assert.equal(matchShortcut({ ...key('Alt+1'), key: '&' }, 'win32'), 'slot-1');
});

test('every routed command has a label, and the renderer knows every id', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const labels = shortcutLabels(platform);
    assert.deepEqual(Object.keys(labels).sort(), [...COMMAND_IDS].sort(), platform);
  }
  assert.equal(shortcutLabels('win32')['open-project'], 'Ctrl+O');
  const types = readFileSync(new URL('../src/ui/types.ts', import.meta.url), 'utf8');
  const union = types.match(/export type CommandId = ([^;]+);/)[1].match(/'[^']+'/g).map(id => id.slice(1, -1));
  assert.deepEqual(union.sort(), [...COMMAND_IDS].sort());
});

test('punctuation is never mistaken for a letter by its physical position', () => {
  // Dvorak: the key labelled "." sits where QWERTY has E.
  assert.equal(matchShortcut({ ...key('Meta+E'), key: '.', code: 'KeyE' }, 'darwin'), null);
  assert.equal(matchShortcut({ ...key('Control+Shift+E'), key: '>', code: 'KeyE' }, 'linux'), null);
  // Non-Latin layouts still fall back to the physical key.
  assert.equal(matchShortcut({ ...key('Meta+E'), key: 'у' }, 'darwin'), 'focus-terminal');
});

test('auto-repeat is still claimed but not dispatched', () => {
  const repeat = key('Meta+N', { isAutoRepeat: true });
  assert.equal(matchShortcut(repeat, 'darwin'), 'new-session');
  assert.equal(shouldDispatch(repeat), false);
  assert.equal(shouldDispatch(key('Meta+N')), true);
  assert.equal(shouldDispatch(null), false);
});

test('no two rows on a platform share a key combination', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const seen = shortcutRows(platform).map(r => [!!r.meta, !!r.control, !!r.alt, !!r.shift, r.code ?? r.key].join());
    assert.equal(new Set(seen).size, seen.length, platform);
  }
});
