import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { crashPageHtml, rendererGoneAction } from '../src/desktop/crash-page.mjs';

// Phase 9 part 2 review I1: a lost renderer must never lead to a tight loop of crash pages.
test('rendererGoneAction: a page only after a page had loaded; a dialog when a page cannot help', () => {
  // The usual crash: the app had loaded, then its renderer was lost.
  assert.equal(rendererGoneAction({ reason: 'crashed', loadedSinceLastGone: true }), 'page');
  assert.equal(rendererGoneAction({ reason: 'killed', loadedSinceLastGone: true }), 'page');
  assert.equal(rendererGoneAction({ reason: 'oom', loadedSinceLastGone: true }), 'page');
  assert.equal(rendererGoneAction({ reason: 'abnormal-exit', loadedSinceLastGone: true }), 'page');
  // No renderer can start: a page would need one.
  assert.equal(rendererGoneAction({ reason: 'launch-failed', loadedSinceLastGone: true }), 'dialog');
  assert.equal(rendererGoneAction({ reason: 'integrity-failure', loadedSinceLastGone: true }), 'dialog');
  // The crash page itself was lost, or lost again before any page loaded (sustained oom): no new page.
  assert.equal(rendererGoneAction({ reason: 'crashed', crashPageShowing: true, loadedSinceLastGone: true }), 'dialog');
  assert.equal(rendererGoneAction({ reason: 'oom', loadedSinceLastGone: false }), 'dialog');
  assert.equal(rendererGoneAction({ reason: 'crashed', crashPageShowing: true, loadedSinceLastGone: false }), 'dialog');
  // Nothing at all for a clean exit, a quit or a destroyed window.
  assert.equal(rendererGoneAction({ reason: 'clean-exit' }), 'ignore');
  assert.equal(rendererGoneAction({ reason: 'crashed', quitting: true }), 'ignore');
  assert.equal(rendererGoneAction({ reason: 'launch-failed', destroyed: true }), 'ignore');
});

test('a sequence of losses never loads the crash page twice without a finished load in between', () => {
  // Main's bookkeeping replayed: loadedSinceGone resets on every loss and is set by did-finish-load.
  let loaded = true; let showing = false; const pages = [];
  const gone = reason => { const action = rendererGoneAction({ reason, crashPageShowing: showing, loadedSinceLastGone: loaded }); loaded = false; if (action === 'page') showing = true; pages.push(action); };
  gone('crashed'); // the app crashed: the page loads
  gone('oom'); gone('oom'); gone('launch-failed'); // the page's renderer keeps failing
  assert.deepEqual(pages, ['page', 'dialog', 'dialog', 'dialog']);
});

test('main uses the helper and never loads the crash page outside it', () => {
  const main = readFileSync(new URL('../src/desktop/main.mjs', import.meta.url), 'utf8');
  assert.equal(main.match(/crashPageUrl\(/g)?.length, 1);
  assert.match(main, /if \(action === 'page'\) \{ crashShown = true; void window\.loadURL\(crashPageUrl\(appearance\)\)/);
  assert.match(main, /did-finish-load', \(\) => \{ loadedSinceGone = true; \}/);
  // Headless runs never show the native dialog.
  assert.match(main, /if \(headless && typeof hook !== 'function'\) return;/);
  // The sentence is the Reload button's description.
  assert.match(crashPageHtml('dark'), /<p id="crash-body">[^<]+<\/p>[\s\S]*aria-describedby="crash-body"/);
});
