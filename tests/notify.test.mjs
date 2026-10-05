import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createNotifier, PREFERENCE_DEFAULTS, readPreferences, writePreferences, APP_USER_MODEL_ID, systemSurface } from '../src/desktop/notify.mjs';

class FakeNotification {
  static instances = [];
  constructor(options) { this.options = options; this.shown = false; this.closed = false; this.handlers = {}; FakeNotification.instances.push(this); }
  show() { this.shown = true; }
  close() { this.closed = true; }
  on(name, fn) { this.handlers[name] = fn; return this; }
}

const flush = () => new Promise(resolve => setImmediate(resolve));

function setup({ focused = false, prefs = {}, titleFor, supported = true } = {}) {
  const instances = [];
  const Notification = class extends FakeNotification { constructor(options) { super(options); instances.push(this); } };
  const clicks = []; const badges = []; const state = { focused, prefs: { ...PREFERENCE_DEFAULTS, ...prefs } };
  const notifier = createNotifier({
    Notification, isSupported: () => supported, isFocused: () => state.focused, onClick: id => clicks.push(id),
    setBadge: count => badges.push(count), preferences: () => state.prefs, ...(titleFor ? { titleFor } : {}),
  });
  let version = 0;
  const session = (fields = {}) => ({ id: 's1', provider: 'claude', title: 'Fix the parser', status: 'running', pending: null, version: ++version, ...fields });
  const shown = () => instances.filter(n => n.shown);
  return { notifier, instances, shown, clicks, badges, state, session };
}

test('one notification per waiting episode', async () => {
  const f = setup();
  f.notifier.update(f.session());
  f.notifier.update(f.session({ status: 'waiting' }));
  f.notifier.update(f.session({ status: 'waiting' }));
  f.notifier.update(f.session({ status: 'waiting' }));
  await flush();
  assert.equal(f.shown().length, 1);
  assert.equal(f.shown()[0].options.title, 'Claude needs approval');
  assert.equal(f.shown()[0].options.body, 'Fix the parser');
  assert.equal(f.shown()[0].options.silent, false);
  f.notifier.update(f.session());
  f.notifier.update(f.session({ status: 'waiting' }));
  await flush();
  assert.equal(f.shown().length, 2);
});

test('none when the window is focused at entry, and none later in that episode', async () => {
  const f = setup({ focused: true });
  f.notifier.update(f.session({ status: 'waiting' }));
  await flush();
  f.state.focused = false;
  f.notifier.update(f.session({ status: 'waiting' }));
  await flush();
  assert.equal(f.instances.length, 0);
  // A new episode after leaving waiting notifies again.
  f.notifier.update(f.session());
  f.notifier.update(f.session({ status: 'waiting' }));
  await flush();
  assert.equal(f.shown().length, 1);
});

test('none for Codex or Cursor waiting', async () => {
  const f = setup();
  f.notifier.update(f.session({ id: 'c1', provider: 'codex', status: 'waiting' }));
  f.notifier.update(f.session({ id: 'c2', provider: 'cursor', status: 'waiting' }));
  await flush();
  assert.equal(f.instances.length, 0);
});

test('none when notifications are off or unsupported', async () => {
  const off = setup({ prefs: { notifications: false } });
  off.notifier.update(off.session({ status: 'waiting' }));
  await flush();
  assert.equal(off.instances.length, 0);
  const unsupported = setup({ supported: false });
  unsupported.notifier.update(unsupported.session({ status: 'waiting' }));
  await flush();
  assert.equal(unsupported.instances.length, 0);
});

test('command hidden by default, shown when allowed', async () => {
  const command = `npm run deploy -- ${'x'.repeat(200)}`;
  const hidden = setup();
  hidden.notifier.update(hidden.session({ status: 'waiting', pending: { tool: 'Bash', command, path: null, at: '2026-10-04T00:00:00Z' } }));
  await flush();
  assert.equal(hidden.shown()[0].options.body, 'Fix the parser');
  assert.ok(!hidden.shown()[0].options.body.includes('npm'));

  const shown = setup({ prefs: { notificationCommand: true } });
  shown.notifier.update(shown.session({ status: 'waiting', pending: { tool: 'Bash', command, path: null, at: '2026-10-04T00:00:00Z' } }));
  await flush();
  const [title, detail] = shown.shown()[0].options.body.split('\n');
  assert.equal(title, 'Fix the parser');
  assert.equal(detail.length, 120);
  assert.ok(detail.startsWith('npm run deploy -- xxx'));
  assert.ok(detail.endsWith('…'));

  const path = setup({ prefs: { notificationCommand: true } });
  path.notifier.update(path.session({ status: 'waiting', pending: { tool: 'Edit', command: null, path: 'src/a.mjs', at: '2026-10-04T00:00:00Z' } }));
  await flush();
  assert.equal(path.shown()[0].options.body, 'Fix the parser\nsrc/a.mjs');

  const none = setup({ prefs: { notificationCommand: true } });
  none.notifier.update(none.session({ status: 'waiting', pending: { tool: 'Bash', command: null, path: null, at: '2026-10-04T00:00:00Z' } }));
  await flush();
  assert.equal(none.shown()[0].options.body, 'Fix the parser');
});

test('the command preference applies to an episode that starts with it off', async () => {
  const f = setup({ prefs: { notificationCommand: false } });
  f.notifier.update(f.session({ status: 'waiting', pending: { tool: 'Bash', command: 'rm -rf build', path: null, at: 'x' } }));
  await flush();
  assert.ok(!f.shown()[0].options.body.includes('rm -rf'));
});

test('leaving waiting closes the open notification', async () => {
  const f = setup();
  f.notifier.update(f.session({ status: 'waiting' }));
  await flush();
  assert.equal(f.shown()[0].closed, false);
  f.notifier.update(f.session({ status: 'running' }));
  assert.equal(f.shown()[0].closed, true);
});

test('an episode that ends before the title resolves never shows', async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const f = setup({ titleFor: () => pending });
  f.notifier.update(f.session({ status: 'waiting' }));
  f.notifier.update(f.session({ status: 'running' }));
  release('Named');
  await flush(); await flush();
  assert.equal(f.shown().length, 0);
});

test('click calls onClick with the session id', async () => {
  const f = setup();
  f.notifier.update(f.session({ id: 'abc', status: 'waiting' }));
  await flush();
  f.shown()[0].handlers.click();
  assert.deepEqual(f.clicks, ['abc']);
});

test('older versions are ignored', async () => {
  const f = setup();
  f.notifier.update({ id: 's1', provider: 'claude', title: 'T', status: 'waiting', version: 5 });
  await flush();
  f.notifier.update({ id: 's1', provider: 'claude', title: 'T', status: 'running', version: 4 });
  await flush();
  assert.equal(f.shown().length, 1);
  assert.equal(f.shown()[0].closed, false);
  assert.deepEqual(f.badges, [1]);
});

test('seed sets the badge and never notifies', async () => {
  const f = setup();
  f.notifier.seed([
    { id: 'a', provider: 'claude', status: 'waiting', title: 'A', version: 1 },
    { id: 'b', provider: 'claude', status: 'waiting', title: 'B', version: 1 },
    { id: 'c', provider: 'codex', status: 'orphaned', title: 'C', version: 1 },
    { id: 'd', provider: 'claude', status: 'running', title: 'D', version: 1 },
  ]);
  await flush();
  assert.equal(f.instances.length, 0);
  assert.deepEqual(f.badges, [3]);
  // A seeded waiting session's episode is spent: a newer waiting does not notify.
  f.notifier.update({ id: 'a', provider: 'claude', status: 'waiting', title: 'A', version: 2 });
  await flush();
  assert.equal(f.instances.length, 0);
});

test('seed keeps the newest copy of a session and drops sessions no longer listed', async () => {
  const f = setup();
  f.notifier.update({ id: 'a', provider: 'claude', status: 'waiting', title: 'A', version: 3 });
  await flush();
  assert.deepEqual(f.badges, [1]);
  // The store copy (older) and the runtime copy (newer) both arrive in a seed.
  f.notifier.seed([{ id: 'a', provider: 'claude', status: 'waiting', title: 'A', version: 2 }, { id: 'a', provider: 'claude', status: 'running', title: 'A', version: 4 }]);
  assert.deepEqual(f.badges, [1, 0]);
  assert.equal(f.shown()[0].closed, true, 'The episode ended while disconnected');
  f.notifier.update({ id: 'a', provider: 'claude', status: 'waiting', title: 'A', version: 5 });
  f.notifier.seed([]);
  assert.deepEqual(f.badges, [1, 0, 1, 0]);
});

test('badge counts Claude waiting and orphaned only', () => {
  const f = setup();
  f.notifier.update({ id: 'a', provider: 'claude', status: 'failed', title: 'A', version: 1 });
  f.notifier.update({ id: 'b', provider: 'claude', status: 'exited', survivors: [{ pid: 1 }], title: 'B', version: 1 });
  f.notifier.update({ id: 'c', provider: 'codex', status: 'waiting', title: 'C', version: 1 });
  assert.deepEqual(f.badges, [], 'setBadge is called only on a change');
  f.notifier.update({ id: 'd', provider: 'claude', status: 'waiting', title: 'D', version: 1 });
  f.notifier.update({ id: 'e', provider: 'cursor', status: 'orphaned', title: 'E', version: 1 });
  f.notifier.update({ id: 'd', provider: 'claude', status: 'waiting', title: 'D', version: 2 });
  assert.deepEqual(f.badges, [1, 2]);
  f.notifier.update({ id: 'e', provider: 'cursor', status: 'orphaned', title: 'E', version: 2, removed: true });
  f.notifier.update({ id: 'd', provider: 'claude', status: 'running', title: 'D', version: 3 });
  assert.deepEqual(f.badges, [1, 2, 1, 0]);
});

test('titleFor supplies the display name; rejection falls back to session.title', async () => {
  const named = setup({ titleFor: async () => 'Renamed session' });
  named.notifier.update(named.session({ status: 'waiting' }));
  await flush();
  assert.equal(named.shown()[0].options.body, 'Renamed session');
  const failing = setup({ titleFor: () => Promise.reject(new Error('store closed')) });
  failing.notifier.update(failing.session({ status: 'waiting' }));
  await flush(); await flush();
  assert.equal(failing.shown()[0].options.body, 'Fix the parser');
  const throwing = setup({ titleFor: () => { throw new Error('sync'); } });
  throwing.notifier.update(throwing.session({ status: 'waiting' }));
  await flush(); await flush();
  assert.equal(throwing.shown()[0].options.body, 'Fix the parser');
});

test('the session title in the body is redacted (a task can contain a credential)', async () => {
  const named = setup({ titleFor: async () => 'Deploy with API_KEY=abcd1234efgh5678' });
  named.notifier.update(named.session({ status: 'waiting' }));
  await flush();
  assert.equal(named.shown()[0].options.body, 'Deploy with API_KEY=[redacted]');
  const fallback = setup({ titleFor: async () => null, prefs: { notificationCommand: true } });
  fallback.notifier.update(fallback.session({ status: 'waiting', title: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789', pending: { command: 'ls' } }));
  await flush();
  assert.doesNotMatch(fallback.shown()[0].options.body, /ghp_abcdefghij/);
  assert.match(fallback.shown()[0].options.body, /\nls$/);
});

test('dispose closes every open notification', async () => {
  const f = setup();
  f.notifier.update(f.session({ id: 'a', status: 'waiting' }));
  f.notifier.update(f.session({ id: 'b', status: 'waiting' }));
  await flush();
  assert.equal(f.shown().length, 2);
  f.notifier.dispose();
  assert.ok(f.shown().every(n => n.closed));
  f.notifier.update(f.session({ id: 'c', status: 'waiting' }));
  await flush();
  assert.equal(f.shown().length, 2, 'A disposed notifier shows nothing');
});

test('a notification that throws on show never breaks status handling', async () => {
  const badges = [];
  const notifier = createNotifier({ Notification: class { constructor() { throw new Error('no notification server'); } }, isFocused: () => false, onClick() {}, setBadge: count => badges.push(count), preferences: () => PREFERENCE_DEFAULTS });
  notifier.update({ id: 'a', provider: 'claude', status: 'waiting', title: 'A', version: 1 });
  await flush();
  assert.deepEqual(badges, [1]);
});

test('preferences: defaults, booleans only, unknown keys ignored, private file', t => {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const dir = mkdtempSync(resolve('.cache/tmp', 'prefs-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'preferences.json');
  assert.deepEqual(PREFERENCE_DEFAULTS, { notifications: true, notificationCommand: false });
  assert.deepEqual(readPreferences(file), PREFERENCE_DEFAULTS, 'A missing file gives the defaults');
  writeFileSync(file, '{not json'); assert.deepEqual(readPreferences(file), PREFERENCE_DEFAULTS);
  writeFileSync(file, JSON.stringify({ notifications: 'no', notificationCommand: 1, other: true })); assert.deepEqual(readPreferences(file), PREFERENCE_DEFAULTS);
  writeFileSync(file, '[]'); assert.deepEqual(readPreferences(file), PREFERENCE_DEFAULTS);
  assert.deepEqual(writePreferences(file, { notificationCommand: true }), { notifications: true, notificationCommand: true });
  assert.deepEqual(writePreferences(file, { notifications: false }), { notifications: false, notificationCommand: true });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { notifications: false, notificationCommand: true }, 'Only the two preferences are stored');
  assert.throws(() => writePreferences(file, { notifications: 'yes' }), /Invalid preference/);
  assert.throws(() => writePreferences(file, { history: true }), /Invalid preference/);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('the Windows AppUserModelId equals the packaged appId', () => {
  assert.equal(APP_USER_MODEL_ID, 'io.github.adirz101.journal');
});

// I1: headless test runs never reach the OS notification, badge or taskbar.
function surface({ headless, hooks = {} }) {
  const calls = { constructed: 0, badge: [], flash: [] };
  const Real = class { constructor(options) { calls.constructed++; this.options = options; } static isSupported() { return true; } };
  const s = systemSurface({ headless, hook: name => headless && typeof hooks[name] === 'function' ? hooks[name] : null, Notification: Real,
    setBadgeCount: count => calls.badge.push(count), flashFrame: count => calls.flash.push(count), isFocused: () => false });
  return { s, calls };
}

test('headless without test hooks: notifications unsupported, the real constructor refused, badge and flash do nothing', () => {
  const { s, calls } = surface({ headless: true });
  assert.equal(s.isSupported(), false);
  assert.throws(() => new s.Notification({ title: 'x' }), /Headless runs never create a real notification/);
  s.setBadge(2);
  assert.deepEqual(calls, { constructed: 0, badge: [], flash: [] });
  assert.equal(s.isFocused(), false);
});

test('headless with test hooks: the stand-ins receive every call', () => {
  const made = []; const badges = [];
  const hooks = { __journalNotification: class { constructor(options) { made.push(options); } }, __journalBadge: count => badges.push(count), __journalFocused: () => true };
  const { s, calls } = surface({ headless: true, hooks });
  assert.equal(s.isSupported(), true);
  new s.Notification({ title: 'a' });
  s.setBadge(1);
  assert.equal(s.isFocused(), true);
  assert.deepEqual([made, badges, calls], [[{ title: 'a' }], [1], { constructed: 0, badge: [], flash: [] }]);
});

test('a normal run uses the real notification, badge and flash; hooks are ignored', () => {
  const { s, calls } = surface({ headless: false, hooks: { __journalNotification: class {}, __journalBadge: () => { throw new Error('unused'); } } });
  assert.equal(s.isSupported(), true);
  new s.Notification({ title: 'b' });
  s.setBadge(3);
  assert.deepEqual(calls, { constructed: 1, badge: [3], flash: [3] });
});
