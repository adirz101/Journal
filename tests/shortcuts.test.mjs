import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMMAND_IDS, matchShortcut, shortcutKeys, shortcutLabels, shortcutRows, shouldDispatch } from '../src/desktop/shortcuts.mjs';

// Electron Input objects as before-input-event delivers them.
const key = (spec, extra = {}) => {
  const parts = spec.split('+'); const name = parts.pop();
  const code = /^\d$/.test(name) ? `Digit${name}` : /^[A-Za-z]$/.test(name) ? `Key${name.toUpperCase()}` : { Enter: 'Enter', '\\': 'Backslash', ',': 'Comma' }[name];
  return { type: 'keyDown', key: name, code, meta: parts.includes('Meta'), control: parts.includes('Control'), alt: parts.includes('Alt'), shift: parts.includes('Shift'), isComposing: false, ...extra };
};

const ROUTED = {
  darwin: [['Meta+N', 'new-session'], ['Meta+O', 'open-project'], ['Meta+Shift+K', 'add-note'], ['Meta+E', 'focus-terminal'], ['Meta+I', 'toggle-inspector'], ['Meta+\\', 'toggle-sidebar'],
    ['Meta+1', 'slot-1'], ['Meta+4', 'slot-4'], ['Meta+J', 'next-needs-you'], ['Meta+Alt+1', 'tab-session'], ['Meta+Alt+2', 'tab-files'], ['Meta+Alt+3', 'tab-memory'], ['Meta+,', 'settings']],
  win32: [['Control+Shift+N', 'new-session'], ['Control+Shift+K', 'add-note'], ['Control+Shift+E', 'focus-terminal'], ['Control+Shift+B', 'toggle-inspector'], ['Control+Shift+\\', 'toggle-sidebar'],
    ['Alt+1', 'slot-1'], ['Alt+4', 'slot-4'], ['Control+Shift+J', 'next-needs-you'], ['Alt+Shift+1', 'tab-session'], ['Alt+Shift+2', 'tab-files'], ['Alt+Shift+3', 'tab-memory'], ['Control+,', 'settings']],
};
ROUTED.linux = ROUTED.win32;

// Keys the terminal and its CLI own: never intercepted. (Phase 8 moved Meta+K and
// Meta+P on macOS and Control+Shift+P elsewhere to the palette; see the Phase 8 tests.)
const TERMINAL = {
  darwin: ['Control+C', 'Control+D', 'Control+Z', 'Control+L', 'Control+R', 'Control+O', 'Control+A', 'Control+E', 'Control+K', 'Control+U', 'Control+W', 'Control+1', 'Alt+1', 'Alt+B', 'Meta+C', 'Meta+V', 'Meta+Q', 'Meta+W', 'Meta+R', 'Meta+5', 'Meta+Enter', 'Meta+Shift+J', 'Control+J', 'Meta+Shift+,', 'Control+,', 'Control+\\', 'Meta+Shift+\\'],
  win32: ['Control+C', 'Control+D', 'Control+Z', 'Control+L', 'Control+R', 'Control+O', 'Control+N', 'Control+P', 'Control+K', 'Control+W', 'Control+E', 'Control+B', 'Control+A', 'Control+U',
    'Control+1', 'Control+Enter', 'Control+J', 'Alt+J', 'Alt+B', 'Alt+F', 'Alt+5', 'Control+Alt+2', 'Control+Shift+C', 'Control+Shift+V', 'Control+Shift+T', 'Control+Shift+W', 'Control+Shift+F', 'Control+Shift+X', 'Control+Shift+Z', 'Control+Shift+A', 'Meta+1', 'Meta+N', 'Control+Shift+,', 'Meta+,', 'Control+\\', 'Meta+\\'],
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

test('the backslash shortcut works on ISO keyboards and Ctrl+\\ stays with the terminal', () => {
  // UK ISO: the \\ key beside left Shift reports IntlBackslash; the key where US has \\ types #.
  for (const platform of ['win32', 'linux']) {
    assert.equal(matchShortcut({ ...key('Control+Shift+\\'), code: 'IntlBackslash', key: '|' }, platform), 'toggle-sidebar', platform);
    assert.equal(matchShortcut({ ...key('Control+Shift+\\'), code: 'IntlBackslash', key: '\\' }, platform), 'toggle-sidebar', platform);
    // Another layout that puts \\ on some other key is matched by its character.
    assert.equal(matchShortcut({ ...key('Control+Shift+\\'), code: 'Quote', key: '|' }, platform), 'toggle-sidebar', platform);
    // Without Shift it is SIGQUIT for the terminal, whichever key produces it.
    assert.equal(matchShortcut({ ...key('Control+\\'), code: 'IntlBackslash' }, platform), null, platform);
    assert.equal(matchShortcut({ ...key('Control+\\'), code: 'Quote' }, platform), null, platform);
  }
  assert.equal(matchShortcut({ ...key('Meta+\\'), code: 'Backquote' }, 'darwin'), 'toggle-sidebar');
  assert.equal(matchShortcut({ ...key('Control+\\'), code: 'Backquote' }, 'darwin'), null);
  assert.equal(matchShortcut({ ...key('Meta+\\'), code: 'IntlBackslash', key: '§' }, 'darwin'), null, 'the Mac ISO § key');
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

test('aria-keyshortcuts strings name the same keys as each row', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    for (const row of shortcutRows(platform)) {
      const modifiers = [row.alt && 'Alt', row.control && 'Control', row.meta && 'Meta', row.shift && 'Shift'].filter(Boolean);
      const name = row.code ? ({ Comma: ',', Backslash: '\\' }[row.code] ?? row.code.replace(/^Digit/, '')) : row.key.toUpperCase();
      assert.equal(row.aria, [...modifiers, name].join('+'), `${platform} ${row.id}`);
    }
    const keys = shortcutKeys(platform);
    assert.deepEqual(Object.keys(keys).sort(), [...COMMAND_IDS].sort(), platform);
    for (const [id, value] of Object.entries(keys)) assert.equal(value.label, shortcutLabels(platform)[id]);
  }
  assert.deepEqual(shortcutKeys('darwin')['open-project'], { label: '⌘O', aria: 'Meta+O' });
  assert.deepEqual(shortcutKeys('linux')['open-project'], { label: 'Ctrl+O', aria: 'Control+O' });
  assert.deepEqual(shortcutKeys('win32')['new-session'], { label: 'Ctrl+Shift+N', aria: 'Control+Shift+N' });
  assert.equal(shortcutKeys('darwin')['tab-files'].aria, 'Alt+Meta+2');
});

// Phase 8: the command palette and open-file (master plan section 2.1).
test('⌘K and ⇧⌘P open the palette; ⌘P opens a file on macOS', () => {
  assert.equal(matchShortcut(key('Meta+K'), 'darwin'), 'command-palette');
  assert.equal(matchShortcut(key('Meta+Shift+P'), 'darwin'), 'command-palette');
  assert.equal(matchShortcut(key('Meta+P'), 'darwin'), 'open-file');
  // Ctrl+K and Ctrl+P stay with the terminal on macOS too.
  for (const spec of ['Control+K', 'Control+P', 'Control+Shift+P', 'Control+Shift+O']) assert.equal(matchShortcut(key(spec), 'darwin'), null, spec);
});

test('Ctrl+Shift+P and Ctrl+Shift+O on Windows and Linux; Ctrl+K and Ctrl+P stay with the terminal', () => {
  for (const platform of ['win32', 'linux']) {
    assert.equal(matchShortcut(key('Control+Shift+P'), platform), 'command-palette', platform);
    assert.equal(matchShortcut(key('Control+Shift+O'), platform), 'open-file', platform);
    for (const spec of ['Control+K', 'Control+P', 'Control+O', 'Meta+K', 'Meta+P', 'Alt+P']) assert.equal(matchShortcut(key(spec), platform), null, `${platform} ${spec}`);
  }
});

test('an alias row never replaces the label', () => {
  assert.deepEqual(shortcutKeys('darwin')['command-palette'], { label: '⌘K', aria: 'Meta+K' });
  assert.equal(shortcutLabels('darwin')['command-palette'], '⌘K');
  assert.deepEqual(shortcutKeys('darwin')['open-file'], { label: '⌘P', aria: 'Meta+P' });
  for (const platform of ['win32', 'linux']) {
    assert.deepEqual(shortcutKeys(platform)['command-palette'], { label: 'Ctrl+Shift+P', aria: 'Control+Shift+P' }, platform);
    assert.deepEqual(shortcutKeys(platform)['open-file'], { label: 'Ctrl+Shift+O', aria: 'Control+Shift+O' }, platform);
  }
  // Only the macOS ⇧⌘P row is an alias, and it names an id that also has a primary row.
  const aliases = ['darwin', 'win32', 'linux'].flatMap(platform => shortcutRows(platform).filter(row => row.alias).map(row => [platform, row.id, row.aria]));
  assert.deepEqual(aliases, [['darwin', 'command-palette', 'Meta+Shift+P']]);
});

test('⇧⌘K stays add-note', () => {
  assert.equal(matchShortcut(key('Meta+Shift+K'), 'darwin'), 'add-note');
  assert.equal(matchShortcut(key('Meta+K'), 'darwin'), 'command-palette');
  for (const platform of ['win32', 'linux']) assert.equal(matchShortcut(key('Control+Shift+K'), platform), 'add-note', platform);
});
