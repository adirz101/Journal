// Updates from GitHub Releases through electron-updater (the updater made for
// electron-builder). Journal only decides when to check, reports progress to
// the window, and installs when the user asks: it never restarts on its own.
// Drafts are invisible to the updater, so nothing reaches users before a
// maintainer publishes a release.

export const FIRST_CHECK_MS = 30_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const RELEASES_URL = 'https://github.com/adirz101/Journal/releases';
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

// auto: download in the background and install on request (macOS app, Windows
// installer). notify: say a version exists and link to it (the portable EXE
// cannot replace itself). off: development builds, tests, or switched off.
export function updateMode({ packaged, platform, env }) {
  if (!packaged || env.JOURNAL_DISABLE_UPDATES === '1' || env.JOURNAL_HEADLESS === '1') return 'off';
  if (platform === 'win32' && env.PORTABLE_EXECUTABLE_DIR) return 'notify';
  if (platform === 'darwin' || platform === 'win32') return 'auto';
  return 'off';
}

// Short, single-line messages: errors can carry URLs, paths or stack traces.
const brief = error => String(error?.message ?? error ?? 'Update failed').split('\n')[0].replace(/https?:\/\/\S+/g, '').replace(/(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[^\s'"]*/gi, '…').slice(0, 160).trim() || 'Update failed';

export class Updater {
  constructor({ autoUpdater, mode, version, send = () => {}, timers = { setTimeout, clearTimeout, setInterval, clearInterval }, enabled = true, onError = null }) {
    this.autoUpdater = autoUpdater; this.mode = mode; this.version = version; this.send = send; this.timers = timers;
    this.enabled = enabled; this.onError = onError; this.timer = null; this.interval = null;
    this.state = { status: mode === 'off' ? 'off' : 'idle', mode, current: version, version: null, percent: null, message: null, automatic: enabled, installing: false };
  }
  set(patch) { this.state = { ...this.state, ...patch }; this.send({ type: 'update', state: this.state }); return this.state; }
  start() {
    if (this.mode === 'off') return this.state;
    const updater = this.autoUpdater;
    updater.autoDownload = this.mode === 'auto';
    updater.autoInstallOnAppQuit = false; // installs only when the user chooses to
    // Alphas update to newer alphas and to releases; a release ignores prereleases.
    // No explicit channel: setting one would also allow downgrades and, for a
    // prerelease, match only tags of that channel name. The provider derives
    // "alpha" from the version, looks for alpha*.yml and falls back to the one
    // feed Journal publishes (latest*.yml).
    updater.allowPrerelease = this.version.includes('-');
    updater.allowDowngrade = false;
    updater.logger = null;
    updater.on('checking-for-update', () => this.set({ status: 'checking', message: null }));
    updater.on('update-not-available', () => this.set({ status: 'none', version: null, percent: null }));
    updater.on('update-available', info => this.set({ status: this.mode === 'auto' ? 'downloading' : 'available', version: VERSION.test(info?.version ?? '') ? info.version : null, percent: this.mode === 'auto' ? 0 : null }));
    updater.on('download-progress', progress => this.set({ status: 'downloading', percent: Math.max(0, Math.min(100, Math.round(progress?.percent ?? 0))) }));
    updater.on('update-downloaded', info => this.set({ status: 'ready', version: VERSION.test(info?.version ?? '') ? info.version : this.state.version, percent: 100 }));
    updater.on('error', error => { this.set({ status: 'error', message: brief(error), installing: false }); this.onError?.(error); });
    this.schedule();
    return this.state;
  }
  schedule() {
    this.timers.clearTimeout(this.timer); this.timers.clearInterval(this.interval); this.timer = this.interval = null;
    if (this.mode === 'off' || !this.enabled) return;
    this.timer = this.timers.setTimeout(() => void this.check(), FIRST_CHECK_MS);
    this.interval = this.timers.setInterval(() => void this.check(), CHECK_INTERVAL_MS);
  }
  setAutomatic(enabled) { this.enabled = !!enabled; this.schedule(); return this.set({ automatic: this.enabled }); }
  // One check at a time; a downloaded update is kept until it is installed.
  async check() {
    if (this.mode === 'off' || ['checking', 'downloading', 'ready'].includes(this.state.status)) return this.state;
    try { await this.autoUpdater.checkForUpdates(); } catch (error) { this.set({ status: 'error', message: brief(error) }); }
    return this.state;
  }
  // Shown while Journal shuts down for an install; cleared if the quit is cancelled.
  setInstalling(installing) { return this.set({ installing: !!installing }); }
  ready() { return this.mode === 'auto' && this.state.status === 'ready'; }
  // Called once Journal has shut down: starts the installer and quits (Windows),
  // or hands over to Squirrel.Mac, which quits and relaunches. Failures are
  // reported through the error event.
  install() {
    if (!this.ready()) throw new Error('No downloaded update is ready to install');
    this.autoUpdater.quitAndInstall(false, true); // installer UI as usual, relaunch afterwards
  }
  releaseUrl() { return this.state.version && VERSION.test(this.state.version) ? `${RELEASES_URL}/tag/v${this.state.version}` : RELEASES_URL; }
  stop() { this.timers.clearTimeout(this.timer); this.timers.clearInterval(this.interval); }
}
