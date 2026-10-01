import { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme } from 'electron';
import { spawn } from 'node-pty';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { StoreClient } from './store-client.mjs';
import { TerminalManager } from '../core/terminal.mjs';
import { detectAgents } from '../core/agents.mjs';
import { text } from '../core/validation.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
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
let window; let store; let terminals; let observers; let observerTimer;
const devUrl = process.env.JOURNAL_DEV_URL;
if (devUrl && !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(devUrl)) throw new Error('Development URL must be local');

const quote = value => process.platform === 'win32' ? `"${value.replaceAll('"', '\\"')}"` : `'${value.replaceAll("'", "'\\''")}'`;

function makeSettings(session, project) {
  // Only this invocation receives Journal observers. Existing user/project hooks remain native.
  const directory = resolve(app.getPath('userData'), 'observers'); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = resolve(directory, `${session.id}.json`); const token = randomBytes(24).toString('hex');
  // Electron binary in Node mode avoids adding a system Node requirement to hooks.
  const command = process.platform === 'win32'
    ? `set ELECTRON_RUN_AS_NODE=1&& ${quote(process.execPath)} ${quote(resolve(here, 'hook.mjs'))} ${quote(target)} ${quote(token)}`
    : `ELECTRON_RUN_AS_NODE=1 ${quote(process.execPath)} ${quote(resolve(here, 'hook.mjs'))} ${quote(target)} ${quote(token)}`;
  const hooks = Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop'].map(event => [event, [{ hooks: [{ type: 'command', command, timeout: 3 }] }]]));
  const settingsFile = resolve(directory, `${session.id}.settings.json`);
  writeFileSync(settingsFile, JSON.stringify({ hooks }), { mode: 0o600 });
  observers.set(session.id, { token, target, projectRoot: project.root, last: '' });
  return settingsFile;
}

function send(event) {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('journal:event', event);
}

function pollObserver() {
  if (!terminals.active) return;
  const id = terminals.active.session.id; const observer = observers.get(id); if (!observer) return;
  try {
    const raw = readFileSync(observer.target, 'utf8'); if (raw === observer.last || raw.length > 2048) return;
    observer.last = raw; const data = JSON.parse(raw);
    if (data.id !== id || data.token !== observer.token || realpathSync(data.cwd) !== observer.projectRoot) return;
    const status = data.event === 'PermissionRequest' ? 'waiting' : data.event === 'Stop' ? 'running' : 'running';
    terminals.observe(id, data.nativeId, status);
  } catch { /* Hooks are best-effort, never a native permission bypass. */ }
}

function validSender(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return false;
  const url = event.senderFrame.url;
  return devUrl ? url === devUrl : url === pathToFileURL(resolve(root, 'dist/index.html')).href;
}

function createWindow() {
  window = new BrowserWindow({ title: 'Journal', icon: displayIcon, width: 1440, height: 920, minWidth: 900, minHeight: 640, backgroundColor: '#101216',
    webPreferences: { preload: resolve(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('did-start-loading', () => terminals.detach());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.on('closed', () => { window = null; });
  if (devUrl) window.loadURL(devUrl); else window.loadFile(resolve(root, 'dist/index.html'));
}

// Do not top-level-await readiness: Electron waits for its entry module to finish
// evaluating before emitting ready (and automation loaders also defer that event).
app.whenReady().then(async () => {
if (process.platform === 'darwin') app.dock.setIcon(displayIcon);
const dataDir = app.getPath('userData'); mkdirSync(dataDir, { recursive: true, mode: 0o700 });
store = new StoreClient(resolve(dataDir, 'journal.sqlite'));
await store.ready; await store.recoverSessions(); observers = new Map();
terminals = new TerminalManager({ store, spawn, makeSettings }); terminals.on('event', send);
observerTimer = setInterval(pollObserver, 400); observerTimer.unref();
const agents = detectAgents();
const actions = {
  setAppearance: ({ appearance }) => {
    if (appearance !== 'light' && appearance !== 'dark') throw new Error('Invalid appearance');
    nativeTheme.themeSource = appearance;
    window?.setBackgroundColor(appearance === 'light' ? '#fafbfe' : '#101216');
  },
  bootstrap: async () => ({ projects: await store.listProjects(), agents, activeSession: terminals.active?.session ?? null, platform: process.platform }),
  openProject: async () => {
    const result = await dialog.showOpenDialog(window, { title: 'Open a Git project', properties: ['openDirectory'] });
    return result.canceled ? null : store.openProject(result.filePaths[0]);
  },
  project: async ({ projectId }) => ({ project: await store.project(projectId), memories: await store.listMemories(projectId), sessions: await store.listSessions(projectId), receipts: await store.listReceipts(projectId) }),
  proposeMemory: ({ projectId, input }) => store.proposeMemory(projectId, input),
  setMemoryStatus: ({ id, status }) => store.setMemoryStatus(id, status),
  proposeStatusUpdate: ({ projectId, scope }) => store.proposeStatusUpdate(projectId, scope),
  memoryHistory: ({ id }) => store.memoryHistory(id),
  prepareContext: ({ projectId, task }) => store.prepareContext(projectId, task),
  getReceipt: ({ id }) => store.getReceipt(id),
  start: input => terminals.start(input),
  attach: ({ id }) => terminals.attach(id),
  write: ({ id, data }) => terminals.write(id, data),
  resize: ({ id, cols, rows }) => terminals.resize(id, cols, rows),
  interrupt: ({ id }) => terminals.interrupt(id),
  stop: ({ id }) => terminals.stop(id),
  acknowledge: ({ id, sequence }) => terminals.acknowledge(id, sequence),
  confirmNativeId: ({ id, nativeId }) => terminals.confirmNativeId(id, nativeId),
};
ipcMain.handle('journal:request', async (event, action, input = {}) => {
  try {
    if (!validSender(event)) throw new Error('Untrusted desktop caller');
    if (!Object.hasOwn(actions, action) || !input || typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).length > 100000) throw new Error('Invalid desktop request');
    return { ok: true, value: await actions[action](input) };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Operation failed' }; }
});
createWindow();
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
app.on('activate', () => { if (!window) createWindow(); });
app.on('window-all-closed', () => app.quit());
let closing = false; let closed = false;
app.on('before-quit', event => {
  if (closed) return; event.preventDefault(); if (closing) return; closing = true;
  clearInterval(observerTimer);
  terminals.dispose().catch(() => {}).then(() => store.close()).catch(() => {}).finally(() => { closed = true; app.quit(); });
});
}).catch(error => {
  console.error('Journal startup failed:', error.message);
  app.quit();
});
