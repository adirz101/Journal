import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editingKey } from '../src/ui/terminalKeys.ts';

const key = (key, mods = {}) => ({ type: 'keydown', key, metaKey: false, altKey: false, ctrlKey: false, shiftKey: false, ...mods });

test('macOS editing keys map to line-editing codes; nothing else is touched', () => {
  assert.equal(editingKey(key('Backspace', { metaKey: true }), true), '\x15');
  assert.equal(editingKey(key('ArrowLeft', { metaKey: true }), true), '\x01');
  assert.equal(editingKey(key('ArrowRight', { metaKey: true }), true), '\x05');
  assert.equal(editingKey(key('Backspace', { altKey: true }), true), '\x17');
  assert.equal(editingKey(key('ArrowLeft', { altKey: true }), true), '\x1bb');
  assert.equal(editingKey(key('ArrowRight', { altKey: true }), true), '\x1bf');
  // Not macOS, other keys, other modifiers, key up and IME composition: xterm's own behaviour.
  assert.equal(editingKey(key('Backspace', { metaKey: true }), false), null);
  for (const event of [key('v', { metaKey: true }), key('c', { metaKey: true }), key('Backspace'), key('ArrowLeft'),
    key('Backspace', { metaKey: true, shiftKey: true }), key('Backspace', { metaKey: true, altKey: true }), key('Backspace', { ctrlKey: true, metaKey: true }),
    { ...key('Backspace', { metaKey: true }), type: 'keyup' }, { ...key('Backspace', { altKey: true }), isComposing: true }]) {
    assert.equal(editingKey(event, true), null, JSON.stringify(event));
  }
});
