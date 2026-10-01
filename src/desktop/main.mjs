import { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, shell } from 'electron';
import { spawn } from 'node:child_process';
import { resolve, dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync, openSync } from 'node:fs';
import { StoreClient } from './store-client.mjs';
import { RuntimeClient } from './runtime-client.mjs';
import { detectAgents } from '../core/agents.mjs';
import { relativePath, text } from '../core/validation.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
// Scripts executed by a separate Node-mode process must come from the unpacked
// copy when Journal runs from a packaged archive.
const unpacked = path => path.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
const appIcon = nativeImage.createFromPath(resolve(root, 'assets/branding/journal-app-icon.png'));
// Trim a small part of the supplied transparent padding for a fuller Dock icon.
// Preserve the rounded artwork and its remaining safety margin at every scale.
const iconSize = appIcon.getSize(); const iconInset = Math.round(Math.min(iconSize.width, iconSize.height) * 0.05);
const displayIcon = appIcon.crop({ x: iconInset, y: iconInset, width: iconSize.width - 2 * iconInset, height: iconSize.height - 2 * iconInset });
app.setName('Journal');
// Keep the existing store when the displayed product name changes.
const userData = process.env.JOURNAL_DATA_DIR
  ? resolve(process.env.JOURNAL_DATA_DIR)
  : resolve(app.getPath('appData'), 'journal-desktop');
mkdirSync(userData, { recursive: true, mode: 0o700 });
app.setPath('userData', userData);
if (!app.requestSingleInstanceLock()) app.quit();
let window; let store; let runtime; let runtimeState = 'connecting'; let runtimeWarning = null;
const devUrl = process.env.JOURNAL_DEV_URL;
if (devUrl && !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(devUrl)) throw new Error('Development URL must be local');
const LIVE = ['starting', 'running', 'waiting', 'stopping'];

function send(event) {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('journal:event', event);
}

function validSender(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return false;
  const url = event.senderFrame.url;
  return devUrl ? url === devUrl : url === pathToFileURL(resolve(root, 'dist/index.html')).href;
}

// The runtime is detached from this process so an app crash or window close
// does not end running agents. Its output goes to a bounded log, not a pipe.
function launchRuntime() {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  const log = openSync(join(userData, 'runtime-stderr.log'), 'a', 0o600);
  const child = spawn(process.execPath, [unpacked(resolve(here, '../runtime/runtime.mjs')), '--data', userData], { detached: true, stdio: ['ignore', 'ignore', log], env, windowsHide: true });
  child.unref(); return child.pid;
}

function createWindow() {
  window = new BrowserWindow({ title: 'Journal', icon: displayIcon, width: 1440, height: 920, minWidth: 900, minHeight: 640, backgroundColor: '#101216',
    webPreferences: { preload: resolve(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  // A reloading renderer re-attaches; until then the runtime keeps buffering.
  window.webContents.on('did-start-loading', () => { void runtime?.call('detach', {}).catch(() => {}); });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.on('closed', () => { window = null; });
  if (devUrl) window.loadURL(devUrl); else window.loadFile(resolve(root, 'dist/index.html'));
}

// Do not top-level-await readiness: Electron waits for its entry module to finish
// evaluating before emitting ready (and automation loaders also defer that event).
app.whenReady().then(async () => {
if (process.platform === 'darwin') app.dock.setIcon(displayIcon);
store = new StoreClient(resolve(userData, 'journal.sqlite'));
await store.ready;
runtime = new RuntimeClient({ dataDir: userData, launch: launchRuntime });
runtime.on('event', send);
runtime.on('warning', message => { runtimeWarning = message; send({ type: 'runtime', state: runtimeState, warning: message }); });
runtime.on('disconnected', () => { runtimeState = 'disconnected'; send({ type: 'runtime', state: 'disconnected' }); });
runtime.on('failed', message => { runtimeWarning = message; send({ type: 'runtime', state: 'disconnected', warning: message }); });
runtime.on('reconnected', () => { runtimeState = 'connected'; send({ type: 'runtime', state: 'connected', recovered: true }); });
const agents = detectAgents();
const actions = {
  setAppearance: ({ appearance }) => {
    if (appearance !== 'light' && appearance !== 'dark') throw new Error('Invalid appearance');
    nativeTheme.themeSource = appearance;
    window?.setBackgroundColor(appearance === 'light' ? '#fafbfe' : '#101216');
  },
  bootstrap: async () => ({ projects: await store.listProjects(), agents, platform: process.platform, runtime: { state: runtimeState, warning: runtimeWarning },
    live: runtimeState === 'connected' ? await runtime.call('list') : [], active: await store.activeSessions() }),
  openProject: async () => {
    const result = await dialog.showOpenDialog(window, { title: 'Open a Git project', properties: ['openDirectory'] });
    return result.canceled ? null : store.openProject(result.filePaths[0]);
  },
  project: async ({ projectId }) => ({ project: await store.project(projectId), sessions: await store.listSessions(projectId), receipts: await store.listReceipts(projectId) }),
  memoryPage: ({ projectId, offset, limit, filter, search }) => store.listMemoryPage(projectId, { offset, limit, filter, search }),
  proposeMemory: ({ projectId, input }) => store.proposeMemory(projectId, input),
  setMemoryStatus: ({ id, status }) => store.setMemoryStatus(id, status),
  proposeStatusUpdate: ({ projectId, scope }) => store.proposeStatusUpdate(projectId, scope),
  memoryHistory: ({ id }) => store.memoryHistory(id),
  prepareContext: ({ projectId, task }) => store.prepareContext(projectId, task),
  getReceipt: ({ id }) => store.getReceipt(id),
  sessions: async () => ({ live: await runtime.call('list'), active: await store.activeSessions() }),
  getSession: ({ id }) => store.getSession(id),
  sessionEvents: ({ id }) => store.listEvents(id, 500),
  sessionChanges: ({ id }) => store.sessionChanges(id),
  sessionFileDiff: ({ id, path }) => store.sessionFileDiff(id, path),
  // Opens a listed, regular, non-executable changed file with its default
  // application. Anything launchable is revealed in the file manager instead.
  openPath: async ({ id, path }) => {
    const file = await store.openableFile(text(id, 'session ID', 100), relativePath(path));
    if (!file.open) { shell.showItemInFolder(file.path); return { revealed: true }; }
    const error = await shell.openPath(file.path); if (error) throw new Error(error);
    return { revealed: false };
  },
  archiveSession: async ({ id }) => { await runtime.call('release', { id }).catch(() => {}); return store.archiveSession(id); },
  start: input => runtime.call('start', input),
  attach: ({ id }) => runtime.call('attach', { id }),
  detach: ({ id }) => runtime.call('detach', { id }),
  write: ({ id, data }) => runtime.call('write', { id, data }),
  resize: ({ id, cols, rows }) => runtime.call('resize', { id, cols, rows }),
  interrupt: ({ id }) => runtime.call('interrupt', { id }),
  stop: ({ id }) => runtime.call('stop', { id }),
  terminateSurvivors: ({ id }) => runtime.call('terminateSurvivors', { id }),
  terminateOrphan: ({ id }) => runtime.call('terminateOrphan', { id }),
  acknowledge: ({ id, sequence }) => { void runtime.call('acknowledge', { id, sequence }).catch(() => {}); },
  confirmNativeId: ({ id, nativeId }) => runtime.call('confirmNativeId', { id, nativeId }),
};
ipcMain.handle('journal:request', async (event, action, input = {}) => {
  try {
    if (!validSender(event)) throw new Error('Untrusted desktop caller');
    if (!Object.hasOwn(actions, action) || !input || typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).length > 100000) throw new Error('Invalid desktop request');
    return { ok: true, value: await actions[action](input) };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Operation failed' }; }
});
try { await runtime.connect(); runtimeState = 'connected'; }
catch (error) { runtimeState = 'disconnected'; console.error('Journal runtime unavailable:', error.message); void runtime.reconnect(); }
createWindow();
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
app.on('activate', () => { if (!window) createWindow(); });
app.on('window-all-closed', () => app.quit());
// Quit versus close: quitting asks what to do with running sessions. Stopping
// ends them gracefully; keeping them leaves the runtime running so the next
// launch rediscovers them. JOURNAL_QUIT_POLICY=stop|keep skips the prompt.
let closing = false; let closed = false;
app.on('before-quit', event => {
  if (closed) return; event.preventDefault(); if (closing) return; closing = true;
  (async () => {
    let live = [];
    try { live = (await runtime.call('list')).filter(session => LIVE.includes(session.status)); } catch { /* runtime unavailable */ }
    let policy = process.env.JOURNAL_QUIT_POLICY;
    if (live.length && policy !== 'stop' && policy !== 'keep') {
      const { response } = await dialog.showMessageBox({ type: 'question', buttons: ['Stop sessions and quit', 'Keep running in background', 'Cancel'], defaultId: 0, cancelId: 2,
        message: `${live.length} session${live.length === 1 ? ' is' : 's are'} still running.`,
        detail: 'Stopping ends the native CLIs gracefully. Keeping them running lets you reconnect when you reopen Journal.' });
      if (response === 2) { closing = false; if (!window) createWindow(); return; }
      policy = response === 0 ? 'stop' : 'keep';
    }
    await runtime.close({ shutdown: policy !== 'keep', stopSessions: true });
    await store.close().catch(() => {});
    closed = true; app.quit();
  })().catch(() => { closed = true; app.quit(); });
});
}).catch(error => {
  console.error('Journal startup failed:', error.message);
  app.quit();
});
