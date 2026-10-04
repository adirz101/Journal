// Desktop notifications and the Dock/taskbar badge. Pure: Electron's
// Notification, focus and badge calls are injected, so tests drive it directly.
//
// Privacy: a notification names the session only, with credentials in its
// name redacted (a title can come from the task text). The pending command or path
// (already redacted by the runtime) is added only when the user turned on
// "Show Commands in Notifications". Nothing here is persisted except the two
// preferences, written by writePreferences.
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { redact } from '../core/validation.mjs';

// Windows attributes toasts to this ID. It must equal `appId` in
// electron-builder.config.cjs (tests/release.test.mjs keeps them equal).
export const APP_USER_MODEL_ID = 'io.github.adirz101.journal';

export const PREFERENCE_DEFAULTS = Object.freeze({ notifications: true, notificationCommand: false });
const PREFERENCE_KEYS = Object.keys(PREFERENCE_DEFAULTS);
const DETAIL_MAX = 120;

// Unknown keys and non-boolean values are ignored, so a damaged file can only
// fall back to the defaults.
export function readPreferences(file) {
  let stored = {};
  try { stored = JSON.parse(readFileSync(file, 'utf8')); } catch { /* missing or unreadable: defaults */ }
  const valid = stored && typeof stored === 'object' && !Array.isArray(stored)
    ? Object.fromEntries(PREFERENCE_KEYS.filter(key => typeof stored[key] === 'boolean').map(key => [key, stored[key]])) : {};
  return { ...PREFERENCE_DEFAULTS, ...valid };
}

export function writePreferences(file, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid preference');
  for (const [key, value] of Object.entries(patch)) if (!PREFERENCE_KEYS.includes(key) || typeof value !== 'boolean') throw new Error('Invalid preference');
  const next = { ...readPreferences(file), ...patch };
  writeFileSync(file, JSON.stringify(next), { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* the data folder is private already */ }
  return next;
}

const truncate = value => value.length > DETAIL_MAX ? `${value.slice(0, DETAIL_MAX - 1)}…` : value;
const claudeWaiting = session => session.provider === 'claude' && session.status === 'waiting';
// The badge means "a live agent is blocked or unaccounted for": Claude waiting
// for approval, or a process still running outside Journal. Failed and
// survivor sessions stay in the app's "needs you" list but not on the badge,
// which would otherwise never clear.
const counts = session => !session.removed && (claudeWaiting(session) || session.status === 'orphaned');

export function createNotifier({ Notification, isSupported = () => true, isFocused, onClick, setBadge, titleFor = session => session.title, preferences }) {
  const sessions = new Map();   // id -> latest session seen
  const episodes = new Map();   // id -> { notification } while a Claude session is waiting
  let badge = 0; let disposed = false;

  const updateBadge = () => {
    let count = 0; for (const session of sessions.values()) if (counts(session)) count++;
    if (count === badge) return;
    badge = count;
    try { setBadge(count); } catch { /* The badge is a hint only. */ }
  };
  const endEpisode = id => {
    const episode = episodes.get(id); if (!episode) return;
    episodes.delete(id);
    try { episode.notification?.close(); } catch { /* already gone */ }
  };
  const show = async (session, episode) => {
    let title;
    try { title = await titleFor(session); } catch { title = null; }
    if (typeof title !== 'string' || !title) title = session.title ?? 'Claude session';
    title = redact(String(title), 200) || 'Claude session';
    // The episode may have ended (or the notifier closed) while the name was read.
    if (disposed || episodes.get(session.id) !== episode) return;
    const prefs = preferences();
    const detail = prefs.notificationCommand ? session.pending?.command ?? session.pending?.path ?? null : null;
    try {
      const notification = new Notification({ title: 'Claude needs approval', body: detail ? `${title}\n${truncate(String(detail))}` : title, silent: false });
      notification.on('click', () => onClick(session.id));
      // Held until the episode ends: Windows drops the click of a collected notification.
      episode.notification = notification;
      notification.show();
    } catch { /* No notification server (for example a bare Linux session). */ }
  };
  // A Claude session entering waiting starts an episode. It notifies only if
  // the window is unfocused at that moment; either way the episode is spent.
  const enter = (session, { notify }) => {
    const episode = { notification: null }; episodes.set(session.id, episode);
    if (!notify || disposed) return;
    const prefs = preferences();
    if (!prefs.notifications || isFocused() || !isSupported()) return;
    void show(session, episode).catch(() => {});
  };
  const apply = (session, { notify }) => {
    sessions.set(session.id, session);
    const waiting = claudeWaiting(session) && !session.removed;
    if (waiting && !episodes.has(session.id)) enter(session, { notify });
    else if (!waiting && episodes.has(session.id)) endEpisode(session.id);
  };
  const newer = (session, held) => !held || (session.version ?? 0) >= (held.version ?? 0);

  return {
    seed(list) {
      const latest = new Map();
      for (const session of list ?? []) {
        if (!session?.id) continue;
        const held = latest.get(session.id) ?? sessions.get(session.id);
        latest.set(session.id, newer(session, held) ? session : held);
      }
      for (const id of [...sessions.keys()]) if (!latest.has(id)) { sessions.delete(id); endEpisode(id); }
      for (const session of latest.values()) apply(session, { notify: false });
      updateBadge();
    },
    update(session) {
      if (!session?.id || !newer(session, sessions.get(session.id))) return;
      apply(session, { notify: true });
      updateBadge();
    },
    dispose() {
      disposed = true;
      for (const id of [...episodes.keys()]) endEpisode(id);
    },
  };
}

// The OS side of the notifier. Headless test runs (JOURNAL_HEADLESS=1) never
// reach the OS: a test's stand-ins (__journalNotification, __journalBadge,
// __journalFocused, read through `hook`) receive the calls, and without them
// notifications are unsupported, the real constructor refuses, and the badge
// and taskbar flash do nothing. `hook` returns null outside headless runs.
export function systemSurface({ headless, hook, Notification, setBadgeCount, flashFrame, isFocused }) {
  return {
    // Constructing through a plain function lets a test install its stand-in after launch.
    Notification: function JournalNotification(options) {
      const Stand = hook('__journalNotification'); if (Stand) return new Stand(options);
      if (headless) throw new Error('Headless runs never create a real notification');
      return new Notification(options);
    },
    isSupported: () => !!hook('__journalNotification') || (!headless && Notification.isSupported()),
    isFocused: () => { const focused = hook('__journalFocused'); return focused ? !!focused() : isFocused(); },
    setBadge: count => {
      const badge = hook('__journalBadge'); if (badge) { badge(count); return; }
      if (headless) return;
      setBadgeCount(count); flashFrame(count);
    },
  };
}
