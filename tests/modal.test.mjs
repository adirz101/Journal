import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { modalCounter, trackModalDialog } from '../src/ui/modal.ts';
import { keyLetter } from '../src/ui/keys.ts';
import { matchShortcut } from '../src/desktop/shortcuts.mjs';

const ui = new URL('../src/ui/', import.meta.url);
const sources = readdirSync(ui, { recursive: true }).filter(name => /\.tsx?$/.test(name)).map(name => [name, readFileSync(new URL(name, ui), 'utf8')]);

test('every dialog component opens through useModalDialog, so main knows a dialog is open', () => {
  const dialogs = sources.filter(([name, text]) => name.endsWith('.tsx') && text.includes('<dialog'));
  assert.ok(dialogs.length >= 6, 'dialog components found');
  for (const [name, text] of dialogs) assert.equal(text.match(/useModalDialog\(/g)?.length ?? 0, text.match(/<dialog/g).length, `${name}: one useModalDialog( per <dialog`);
  // Only the hook (through trackModalDialog in modal.ts) opens a modal dialog.
  for (const [name, text] of sources) if (name !== 'modal.ts') assert.doesNotMatch(text, /showModal\(/, name);
});

test('the modal counter reports only the first opening and the last closing', () => {
  const reports = []; const modals = modalCounter(open => reports.push(open));
  modals.opened(); modals.opened(); modals.closed();
  assert.deepEqual(reports, [true]);
  modals.closed(); modals.closed(); // an extra close never goes negative
  assert.deepEqual(reports, [true, false]);
  modals.opened();
  assert.deepEqual(reports, [true, false, true]);
});

test('a dialog that closes while still mounted counts down once', () => {
  const fakeDialog = () => Object.assign(new EventTarget(), { open: false, showModal() { this.open = true; } });
  const reports = []; const modals = modalCounter(open => reports.push(open));
  const first = fakeDialog(); const second = fakeDialog();
  const untrackFirst = trackModalDialog(first, modals); const untrackSecond = trackModalDialog(second, modals);
  assert.ok(first.open && second.open);
  assert.deepEqual(reports, [true]);
  // Escape closes the first dialog natively before its component unmounts.
  first.open = false; first.dispatchEvent(new Event('close'));
  first.dispatchEvent(new Event('close'));
  untrackFirst(); // the unmount after the close does not count down again
  assert.deepEqual(reports, [true], 'the second dialog is still open');
  untrackSecond();
  assert.deepEqual(reports, [true, false]);
  // A close event after unmount is ignored too.
  second.dispatchEvent(new Event('close'));
  trackModalDialog(fakeDialog(), modals);
  assert.deepEqual(reports, [true, false, true]);
});

test('the renderer reads letters by the same rule as the shortcut router', () => {
  const cases = [['o', 'KeyO'], ['O', 'KeyO'], ['o', 'KeyS'], ['щ', 'KeyO'], ['ο', 'KeyO'], ['r', 'KeyO'], ['.', 'KeyO'], ['>', 'KeyO'], ['щ', 'Digit1'], ['', 'KeyO'], ['Dead', 'KeyO']];
  for (const [key, code] of cases) {
    const routed = matchShortcut({ type: 'keyDown', key, code, meta: true, control: false, alt: false, shift: false, isComposing: false }, 'darwin') === 'open-project';
    assert.equal(keyLetter(key, code) === 'o', routed, `${key} ${code}`);
  }
});
