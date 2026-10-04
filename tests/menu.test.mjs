import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOutcome, menuTemplate, PROJECT_URL } from '../src/desktop/menu.mjs';

const find = (items, id) => items.flatMap(item => [item, ...(item.submenu ?? [])]).find(item => item.id === id);

test('Check for Updates… sits in the app menu on macOS and in Help on Windows', () => {
  const calls = []; const opened = [];
  const options = { name: 'Journal', checkForUpdates: () => calls.push('check'), openUrl: url => opened.push(url) };
  const mac = menuTemplate({ ...options, platform: 'darwin' });
  assert.equal(mac[0].label, 'Journal'); assert.deepEqual(mac[0].submenu.slice(0, 2).map(item => item.role ?? item.label), ['about', 'Check for Updates…']);
  assert.deepEqual(mac[0].submenu.filter(item => item.role).map(item => item.role), ['about', 'services', 'hide', 'hideOthers', 'unhide', 'quit'], 'The standard app menu stays');
  assert.deepEqual(mac.slice(1, 5).map(item => item.role), ['fileMenu', 'editMenu', 'viewMenu', 'windowMenu']);
  const win = menuTemplate({ ...options, platform: 'win32' });
  assert.deepEqual(win.map(item => item.role), ['fileMenu', 'editMenu', 'viewMenu', 'windowMenu', 'help']);
  assert.equal(win[4].submenu[0].label, 'Check for Updates…');
  find(mac, 'check-for-updates').click(); find(win, 'check-for-updates').click(); assert.deepEqual(calls, ['check', 'check']);
  win[4].submenu.at(-2).click(); win[4].submenu.at(-1).click(); assert.deepEqual(opened, [PROJECT_URL, `${PROJECT_URL}/releases`]);
});

test('menu check results', () => {
  const base = { current: '0.2.0-alpha.3', version: null, message: null };
  assert.match(checkOutcome({ ...base, status: 'none' }).message, /up to date/);
  assert.match(checkOutcome({ ...base, status: 'off' }).message, /installed builds only/);
  assert.deepEqual([checkOutcome({ ...base, status: 'ready', version: '0.2.0-alpha.4' }).kind, checkOutcome({ ...base, status: 'ready', version: '0.2.0-alpha.4' }).message], ['ready', 'Journal 0.2.0-alpha.4 is ready to install.']);
  assert.equal(checkOutcome({ ...base, status: 'downloading' }).message, 'A new version of Journal is available.');
  assert.equal(checkOutcome({ ...base, status: 'available', version: '0.2.0-alpha.4' }).kind, 'available');
  assert.deepEqual(checkOutcome({ ...base, status: 'error', message: 'offline' }), { kind: 'error', message: 'Could not check for updates.', detail: 'offline' });
  assert.equal(checkOutcome({ ...base, status: 'checking' }), null);
});

test('released builds have no Reload or developer tools in the View menu', () => {
  const options = { name: 'Journal', checkForUpdates() {}, openUrl() {}, packaged: true };
  for (const platform of ['darwin', 'win32']) {
    const template = menuTemplate({ ...options, platform });
    assert.ok(!template.some(item => item.role === 'viewMenu'), platform);
    const view = template.find(item => item.label === 'View');
    assert.deepEqual(view.submenu.filter(item => item.role).map(item => item.role), ['resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen'], platform);
  }
});
