import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CHECK_INTERVAL_MS, FIRST_CHECK_MS, RELEASES_URL, Updater, updateMode } from '../src/desktop/updater.mjs';

// A stand-in for electron-updater's autoUpdater: records calls, emits on demand.
class FakeAutoUpdater extends EventEmitter {
  constructor() { super(); this.checks = 0; this.installs = []; this.fail = null; }
  async checkForUpdates() { this.checks++; if (this.fail) throw this.fail; this.emit('checking-for-update'); }
  quitAndInstall(...args) { this.installs.push(args); }
}
const fakeTimers = () => {
  const timers = { pending: [], setTimeout: (fn, ms) => { const t = { fn, ms, kind: 'timeout' }; timers.pending.push(t); return t; }, setInterval: (fn, ms) => { const t = { fn, ms, kind: 'interval' }; timers.pending.push(t); return t; } };
  timers.clearTimeout = timers.clearInterval = t => { timers.pending = timers.pending.filter(item => item !== t); };
  return timers;
};
const make = (options = {}) => {
  const autoUpdater = new FakeAutoUpdater(); const sent = []; const timers = fakeTimers();
  const updater = new Updater({ autoUpdater, mode: 'auto', version: '0.2.0-alpha.2', send: event => sent.push(event), timers, ...options });
  return { autoUpdater, sent, timers, updater };
};

test('update modes: packaged macOS and installed Windows update; portable notifies; the rest is off', () => {
  assert.equal(updateMode({ packaged: true, platform: 'darwin', env: {} }), 'auto');
  assert.equal(updateMode({ packaged: true, platform: 'win32', env: {} }), 'auto');
  assert.equal(updateMode({ packaged: true, platform: 'win32', env: { PORTABLE_EXECUTABLE_DIR: 'C:\\x' } }), 'notify');
  assert.equal(updateMode({ packaged: true, platform: 'linux', env: {} }), 'off');
  assert.equal(updateMode({ packaged: false, platform: 'darwin', env: {} }), 'off', 'Development builds never update');
  assert.equal(updateMode({ packaged: true, platform: 'darwin', env: { JOURNAL_HEADLESS: '1' } }), 'off', 'Tests never reach GitHub');
  assert.equal(updateMode({ packaged: true, platform: 'darwin', env: { JOURNAL_DISABLE_UPDATES: '1' } }), 'off');
});

test('configures electron-updater: download in the background, never install on quit, never downgrade', () => {
  const { autoUpdater, updater } = make(); updater.start();
  assert.equal(autoUpdater.autoDownload, true); assert.equal(autoUpdater.autoInstallOnAppQuit, false);
  assert.equal(autoUpdater.allowPrerelease, true, 'An alpha follows newer alphas');
  // A channel would make the GitHub provider match only tags of that name (an alpha would find nothing) and allow downgrades.
  assert.equal(autoUpdater.channel, undefined); assert.equal(autoUpdater.allowDowngrade, false);
  const stable = make({ version: '1.0.0' }); stable.updater.start(); assert.equal(stable.autoUpdater.allowPrerelease, false, 'A release ignores prereleases');
  const portable = make({ mode: 'notify' }); portable.updater.start(); assert.equal(portable.autoUpdater.autoDownload, false);
});

test('events become window states', async () => {
  const { autoUpdater, sent, updater } = make(); updater.start();
  assert.equal(updater.state.status, 'idle');
  await updater.check(); assert.equal(updater.state.status, 'checking'); assert.equal(autoUpdater.checks, 1);
  autoUpdater.emit('update-available', { version: '0.2.0-alpha.3' }); assert.deepEqual([updater.state.status, updater.state.version, updater.state.percent], ['downloading', '0.2.0-alpha.3', 0]);
  autoUpdater.emit('download-progress', { percent: 42.6 }); assert.equal(updater.state.percent, 43);
  autoUpdater.emit('download-progress', { percent: 140 }); assert.equal(updater.state.percent, 100);
  autoUpdater.emit('update-downloaded', { version: '0.2.0-alpha.3' }); assert.equal(updater.state.status, 'ready'); assert.ok(updater.ready());
  assert.deepEqual(sent.at(-1), { type: 'update', state: updater.state });
  const none = make(); none.updater.start(); none.autoUpdater.emit('update-not-available', {}); assert.equal(none.updater.state.status, 'none');
});

test('the portable build only reports a new version', () => {
  const { autoUpdater, updater } = make({ mode: 'notify' }); updater.start();
  autoUpdater.emit('update-available', { version: '0.2.0-alpha.3' });
  assert.equal(updater.state.status, 'available'); assert.equal(updater.ready(), false);
  assert.equal(updater.releaseUrl(), `${RELEASES_URL}/tag/v0.2.0-alpha.3`);
  assert.throws(() => updater.install(), /No downloaded update/);
});

test('release links and errors are sanitized', async () => {
  const { autoUpdater, updater } = make(); updater.start();
  autoUpdater.emit('update-available', { version: '1.0.0/../../evil' }); assert.equal(updater.state.version, null); assert.equal(updater.releaseUrl(), RELEASES_URL);
  autoUpdater.emit('error', new Error('HttpError: 404 https://github.com/x/y/releases/download/latest-mac.yml\n    at stack trace'));
  assert.equal(updater.state.status, 'error'); assert.equal(updater.state.message, 'HttpError: 404');
  autoUpdater.fail = new Error('net::ERR_INTERNET_DISCONNECTED'); await updater.check();
  assert.equal(updater.state.status, 'error'); assert.equal(updater.state.message, 'net::ERR_INTERNET_DISCONNECTED');
  autoUpdater.emit('error', new Error("ENOENT: no such file, open '/Users/someone/Library/Caches/journal-desktop-updater/x.zip'"));
  assert.equal(updater.state.message, "ENOENT: no such file, open '…'", 'No local paths');
});

test('one check at a time, and a downloaded update is kept', async () => {
  const { autoUpdater, updater } = make(); updater.start();
  await updater.check(); await updater.check(); assert.equal(autoUpdater.checks, 1, 'Still checking');
  autoUpdater.emit('update-available', { version: '0.2.0-alpha.3' }); await updater.check(); assert.equal(autoUpdater.checks, 1, 'Downloading');
  autoUpdater.emit('update-downloaded', { version: '0.2.0-alpha.3' }); await updater.check(); assert.equal(autoUpdater.checks, 1, 'Ready');
  const off = make({ mode: 'off', autoUpdater: null }); off.updater.start(); await off.updater.check(); assert.equal(off.updater.state.status, 'off');
});

test('installs only a downloaded update, and only when asked', () => {
  const { autoUpdater, updater } = make(); updater.start();
  assert.throws(() => updater.install(), /No downloaded update/); assert.equal(autoUpdater.installs.length, 0);
  autoUpdater.emit('update-downloaded', { version: '0.2.0-alpha.3' }); updater.install();
  assert.deepEqual(autoUpdater.installs, [[false, true]], 'Installer as usual, then relaunch');
});

test('install progress is shared with the window and cleared by a failure', () => {
  const errors = []; const { autoUpdater, sent, updater } = make({ onError: error => errors.push(error.message) }); updater.start();
  autoUpdater.emit('update-downloaded', { version: '0.2.0-alpha.3' });
  updater.setInstalling(true); assert.equal(sent.at(-1).state.installing, true);
  updater.setInstalling(false); assert.equal(updater.state.installing, false);
  updater.setInstalling(true); autoUpdater.emit('error', new Error('Squirrel: code signature did not pass validation'));
  assert.equal(updater.state.installing, false); assert.equal(updater.state.status, 'error'); assert.deepEqual(errors, ['Squirrel: code signature did not pass validation']);
});

test('automatic checks: shortly after launch, then periodically, and can be switched off', () => {
  const { autoUpdater, timers, updater } = make(); updater.start();
  assert.deepEqual(timers.pending.map(t => [t.kind, t.ms]), [['timeout', FIRST_CHECK_MS], ['interval', CHECK_INTERVAL_MS]]);
  timers.pending[0].fn(); assert.equal(autoUpdater.checks, 1);
  updater.setAutomatic(false); assert.equal(timers.pending.length, 0); assert.equal(updater.state.automatic, false);
  updater.setAutomatic(true); assert.equal(timers.pending.length, 2);
  updater.stop(); assert.equal(timers.pending.length, 0);
  const manual = make({ enabled: false }); manual.updater.start(); assert.equal(manual.timers.pending.length, 0, 'Off: no timers, manual checks still work');
  const off = make({ mode: 'off', autoUpdater: null }); off.updater.start(); assert.equal(off.timers.pending.length, 0);
});
