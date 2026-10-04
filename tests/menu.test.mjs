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
  assert.deepEqual(win.map(item => item.role ?? item.label), ['File', 'editMenu', 'viewMenu', 'windowMenu', 'help']);
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
  for (const platform of ['darwin', 'win32', 'linux']) {
    const template = menuTemplate({ ...options, platform });
    assert.ok(!template.some(item => item.role === 'viewMenu'), platform);
    const view = template.find(item => item.label === 'View');
    assert.deepEqual(view.submenu.filter(item => item.role).map(item => item.role), ['resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen'], platform);
  }
  assert.ok(menuTemplate({ ...options, platform: 'win32', packaged: false }).some(item => item.role === 'viewMenu'), 'Development builds keep the default View menu');
  for (const platform of ['darwin', 'win32']) {
    const view = menuTemplate({ ...options, platform, devTools: true }).find(item => item.label === 'View');
    assert.equal(view.submenu.at(-1).role, 'toggleDevTools', platform);
    assert.ok(!view.submenu.some(item => item.role === 'reload'), platform);
  }
});

test('Settings… sits in the app menu on macOS and in File on Windows and Linux', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    let opened = 0;
    const template = menuTemplate({ name: 'Journal', checkForUpdates() {}, openUrl() {}, openSettings: () => opened++, platform });
    const settings = find(template, 'settings');
    assert.equal(settings.label, 'Settings…', platform);
    assert.equal(settings.accelerator, 'CmdOrCtrl+,', platform);
    assert.equal(settings.registerAccelerator, false, `${platform}: the shortcut router owns the key`);
    settings.click(); assert.equal(opened, 1, platform);
    const parent = template.find(item => item.submenu?.includes(settings));
    if (platform === 'darwin') {
      assert.equal(parent, template[0], 'macOS: the app menu');
      const items = parent.submenu.map(item => item.role ?? item.label ?? item.type);
      assert.deepEqual(items.slice(0, 4), ['about', 'Check for Updates…', 'Settings…', 'separator']);
      assert.equal(template[1].role, 'fileMenu');
    } else {
      assert.equal(parent.label, 'File', platform);
      assert.deepEqual(parent.submenu.map(item => item.id ?? item.role ?? item.type), ['settings', 'separator', 'quit'], platform);
    }
  }
});

test('no notification checkboxes remain in the menu', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const template = menuTemplate({ name: 'Journal', checkForUpdates() {}, openUrl() {}, platform });
    assert.equal(find(template, 'notify-approval'), undefined, platform); assert.equal(find(template, 'notify-command'), undefined, platform);
    assert.ok(!template.flatMap(item => item.submenu ?? []).some(item => item.type === 'checkbox'), platform);
  }
  // The Window menu is the standard one again.
  assert.equal(menuTemplate({ name: 'Journal', checkForUpdates() {}, openUrl() {}, platform: 'win32' })[3].submenu, undefined);
});
