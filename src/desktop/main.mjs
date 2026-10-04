import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, shell } from 'electron';
import { spawn } from 'node:child_process';
import { resolve, dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { StoreClient } from './store-client.mjs';
import { RuntimeClient } from './runtime-client.mjs';
import { buildId } from '../runtime/protocol.mjs';
import { detectAgents, detectCursor } from '../core/agents.mjs';
import { cursorAuth, findCursor, installCommand, installEnv } from '../core/cursor.mjs';
import { ProcessRunner } from './processes.mjs';
import { homedir } from 'node:os';
import { relativePath, text } from '../core/validation.mjs';
import { SESSION_USER_FIELDS, survivorScanPending } from '../core/sessions.mjs';
import { headDiff, listDirectory, locate, previewFile, treePath } from '../core/files.mjs';
import { gitStatus } from '../core/git-status.mjs';
import { formatReference, referenceEvent } from '../core/references.mjs';
import { isSensitivePath } from '../core/evidence.mjs';
import { launchTarget, resolveExecutable } from '../core/process.mjs';
import { RootWatcher } from './watch.mjs';
import { Updater, updateMode } from './updater.mjs';
import { checkOutcome, menuTemplate } from './menu.mjs';
import electronUpdater from 'electron-updater';
import { dataDirectory, unpackedPath, withGuiPath } from './environment.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
// Scripts executed by a separate Node-mode process must come from the unpacked
// copy when Journal runs from a packaged archive.
const unpacked = path => unpackedPath(path, sep);
const appIcon = nativeImage.createFromPath(resolve(root, 'assets/branding/journal-app-icon.png'));
// Trim a small part of the supplied transparent padding for a fuller Dock icon.
// Preserve the rounded artwork and its remaining safety margin at every scale.
const iconSize = appIcon.getSize(); const iconInset = Math.round(Math.min(iconSize.width, iconSize.height) * 0.05);
const displayIcon = appIcon.crop({ x: iconInset, y: iconInset, width: iconSize.width - 2 * iconInset, height: iconSize.height - 2 * iconInset });
app.setName('Journal');
// A packaged app opened from Finder has a minimal PATH; add the usual CLI
// install folders so Claude Code, Codex and Cursor are found (see environment.mjs).
if (app.isPackaged) { const next = withGuiPath(process.env).PATH; if (next) process.env.PATH = next; }
// Keep the existing store when the displayed product name changes.
const userData = dataDirectory(process.env, app.getPath('appData'));
mkdirSync(userData, { recursive: true, mode: 0o700 });
app.setPath('userData', userData);
if (!app.requestSingleInstanceLock()) app.quit();
let window; let store; let runtime; let updater; let updatePolicy = null; let closing = false; let closed = false; let runtimeState = 'connecting'; let runtimeWarning = null;
const devUrl = process.env.JOURNAL_DEV_URL;
// Automated tests run without visible windows or a Dock icon.
const headless = process.env.JOURNAL_HEADLESS === '1';
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
  // Report exit from the child handle: a killed, not yet reaped runtime still
  // answers kill(pid, 0), which must not block launching a replacement.
  let exited = false; child.once('exit', () => { exited = true; }); child.unref();
  return { pid: child.pid, alive: () => !exited };
}

function createWindow() {
  window = new BrowserWindow({ title: 'Journal', icon: displayIcon, width: 1440, height: 920, minWidth: 900, minHeight: 640, backgroundColor: '#101216',
    show: !headless,
    // Hidden test windows keep their size on small CI screens (macOS clamps to the display otherwise).
    enableLargerThanScreen: headless,
    // Hidden test windows must keep timers, visibility and frames running like a visible one.
    webPreferences: { preload: resolve(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: !headless } });
  // Test runs: macOS clamps a new window to the screen (CI runners have a 1024x768
  // virtual display) even with enableLargerThanScreen; resizing after creation keeps
  // the requested size, so tests see the same layout everywhere.
  if (headless) window.setSize(1440, 920);
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
// The packaged app keeps its bundle icon (masked by macOS); development builds show the artwork.
if (process.platform === 'darwin') { if (headless) app.dock.hide(); else if (!app.isPackaged) app.dock.setIcon(displayIcon); }
store = new StoreClient(resolve(userData, 'journal.sqlite'));
await store.ready;
runtime = new RuntimeClient({ dataDir: userData, launch: launchRuntime });
// The runtime's in-memory sessions carry status only: names, pins, archive and
// removal belong to the store, so its copies of those fields never reach the UI.
const fromRuntime = session => { const status = { ...session }; for (const field of SESSION_USER_FIELDS) delete status[field]; return status; };
runtime.on('event', event => send(event?.type === 'status' && event.session ? { ...event, session: fromRuntime(event.session) } : event));
// Explorer: one watched root, the status call per root shared while it runs,
// and an external editor found on PATH (or named by JOURNAL_EDITOR).
const watcher = new RootWatcher(change => send({ type: 'files', ...change }));
const statusCalls = new Map();
// Resolved roots are cached briefly so browsing does not run Git in the store
// worker for every request; any workspace or folder change clears the cache.
const rootCache = new Map();
const fileRoot = async (projectId, rootKey) => {
  const key = `${text(projectId, 'project ID', 100)}\u0000${text(rootKey, 'root', 100)}`; const cached = rootCache.get(key);
  if (cached && Date.now() - cached.at < 5000) return cached.root;
  const root = await store.fileRoot(projectId, rootKey); rootCache.set(key, { root, at: Date.now() }); return root;
};
const ROOT_CHANGES = new Set(['addProjectFolder', 'removeProjectFolder', 'removeProject', 'openProject', 'createWorkspace', 'importWorkspace', 'removeWorkspace', 'forgetWorkspace']);
const EDITORS = { code: line => file => ['--goto', `${file}:${line}`], cursor: line => file => ['--goto', `${file}:${line}`], zed: line => file => [`${file}:${line}`], subl: line => file => [`${file}:${line}`] };
let editor;
const findEditor = () => {
  if (editor !== undefined) return editor;
  const names = process.env.JOURNAL_EDITOR && Object.hasOwn(EDITORS, process.env.JOURNAL_EDITOR) ? [process.env.JOURNAL_EDITOR] : Object.keys(EDITORS);
  // Windows command shims would route the path through cmd.exe; those fall back to revealing.
  for (const name of names) { const path = resolveExecutable(name); if (path && !/\.(?:cmd|bat)$/i.test(path)) return (editor = { name, path }); }
  return (editor = null);
};
runtime.on('warning', message => { runtimeWarning = message; send({ type: 'runtime', state: runtimeState, warning: message }); });
runtime.on('disconnected', () => { runtimeState = 'disconnected'; send({ type: 'runtime', state: 'disconnected' }); });
runtime.on('failed', message => { runtimeWarning = message; send({ type: 'runtime', state: 'disconnected', warning: message }); });
runtime.on('reconnected', () => { runtimeState = 'connected'; send({ type: 'runtime', state: 'connected', recovered: true }); });
let agents = detectAgents();
// Cursor's sign-in state is checked off the startup path, again after install
// or sign-in, and on request. Only signed in / signed out is kept.
let cursorCheck = null;
const refreshCursor = async ({ fresh = false } = {}) => {
  // One check at a time. After an install or sign-in a running (older) check
  // is waited for and a new one started, so the result reflects the change.
  if (cursorCheck && !fresh) return cursorCheck;
  if (cursorCheck) await cursorCheck.catch(() => {});
  if (cursorCheck) return cursorCheck;
  const check = (async () => {
    const row = await detectCursor(process.env);
    const auth = row.available ? await cursorAuth(row.path, process.env) : 'unchecked';
    const next = { ...row, auth, state: row.available && auth === 'signed-out' ? 'login-required' : row.state };
    agents = agents.map(agent => agent.provider === 'cursor' ? next : agent);
    send({ type: 'providers', agents });
    return next;
  })();
  cursorCheck = check; void check.finally(() => { if (cursorCheck === check) cursorCheck = null; }).catch(() => {});
  return check;
};
void refreshCursor().catch(() => {});
const processes = new ProcessRunner(send, async (file, args, options) => (await import('node-pty')).spawn(file, args, options));
const runnable = env => { const next = { ...env }; delete next.ELECTRON_RUN_AS_NODE; return next; };
const actions = {
  setAppearance: ({ appearance }) => {
    if (appearance !== 'light' && appearance !== 'dark') throw new Error('Invalid appearance');
    nativeTheme.themeSource = appearance;
    window?.setBackgroundColor(appearance === 'light' ? '#fafbfe' : '#101216');
  },
  bootstrap: async () => ({ projects: await store.listProjects(), agents, platform: process.platform, runtime: { state: runtimeState, warning: runtimeWarning },
    live: runtimeState === 'connected' ? (await runtime.call('list')).map(fromRuntime) : [], active: await store.activeSessions() }),
  openProject: async () => {
    const result = await dialog.showOpenDialog(window, { title: 'Open a Git project', properties: ['openDirectory'] });
    return result.canceled ? null : store.openProject(result.filePaths[0]);
  },
  renameProject: ({ id, name }) => store.renameProject(id, name),
  setProjectPinned: ({ id, pinned }) => store.setProjectPinned(id, pinned),
  projectDetails: ({ id }) => store.projectDetails(id),
  addProjectFolder: async ({ id }) => {
    const result = await dialog.showOpenDialog(window, { title: 'Add a folder to this project', properties: ['openDirectory'] });
    return result.canceled ? null : store.addProjectRoot(id, result.filePaths[0]);
  },
  removeProjectFolder: async ({ id, rootId }) => {
    const details = await store.projectDetails(id); const root = details.roots.find(entry => entry.id === rootId);
    if (!root) throw new Error('Unknown folder');
    const { response } = await dialog.showMessageBox(window, { type: 'question', buttons: ['Remove folder from project', 'Cancel'], defaultId: 1, cancelId: 1,
      message: `Remove ${root.name} from ${details.project.name}?`,
      detail: `Your files will not be deleted. Journal stops using ${root.path} as part of this project.${root.knowledge ? ` ${root.knowledge} knowledge claim${root.knowledge === 1 ? '' : 's'} from this folder will be kept but excluded until you add the same folder again.` : ''}` });
    return response === 0 ? store.removeProjectRoot(id, rootId) : null;
  },
  // Removing never deletes files; the second option deletes Journal's own records for the project.
  removeProject: async ({ id }) => {
    const { project, counts } = await store.projectDetails(id);
    if (counts.liveSessions) throw new Error('Stop this project\'s running sessions first');
    const data = [`${counts.knowledge} knowledge claim${counts.knowledge === 1 ? '' : 's'}`, `${counts.sessions} session record${counts.sessions === 1 ? '' : 's'}`, `${counts.receipts} context receipt${counts.receipts === 1 ? '' : 's'}`, `${counts.events} timeline event${counts.events === 1 ? '' : 's'}`, `${counts.proposals} open proposal${counts.proposals === 1 ? '' : 's'}`].join(', ');
    const { response } = await dialog.showMessageBox(window, { type: 'warning', buttons: ['Remove from Journal', 'Remove and delete Journal data', 'Cancel'], defaultId: 2, cancelId: 2,
      message: `Remove ${project.name} from Journal?`,
      detail: `Your files will not be deleted. Nothing in ${project.root} or its Git repository is touched.\n\nRemove from Journal: hides the project. Its Journal data (${data}) is kept, and opening the folder again restores everything.\n\nRemove and delete Journal data: permanently deletes that Journal data from this computer. This cannot be undone.${counts.worktrees ? `\n\nThis project has ${counts.worktrees} Journal worktree${counts.worktrees === 1 ? '' : 's'}; remove ${counts.worktrees === 1 ? 'it' : 'them'} under Workspaces before deleting data.` : ''}` });
    if (response === 2) return null;
    return store.removeProject(id, { deleteData: response === 1 });
  },
  projects: () => store.listProjects(),
  // Cheap branch/HEAD read so the UI notices checkouts switched outside Journal.
  checkout: async ({ projectId }) => { const project = await store.project(projectId); return { branch: project.branch, head: project.head }; },
  project: async ({ projectId }) => ({ project: await store.project(projectId), sessions: await store.listSessions(projectId, true), receipts: await store.listReceipts(projectId) }),
  workspaces: ({ projectId }) => store.listWorkspaces(projectId),
  planWorkspace: ({ projectId, branch, base }) => store.planWorkspace(projectId, { branch, base }, join(userData, 'worktrees')),
  createWorkspace: ({ projectId, branch, base, baseCommit, planId }) => store.createWorkspace(projectId, { branch, base, baseCommit, planId }, join(userData, 'worktrees')),
  importWorkspace: ({ projectId, path }) => store.importWorkspace(projectId, path),
  workspaceRemovalBlockers: ({ id }) => store.workspaceRemovalBlockers(id),
  removeWorkspace: ({ id }) => store.removeWorkspace(id),
  forgetWorkspace: ({ id }) => store.forgetWorkspace(id),
  memoryPage: ({ projectId, offset, limit, filter, search }) => store.listMemoryPage(projectId, { offset, limit, filter, search }),
  proposeMemory: ({ projectId, input }) => store.proposeMemory(projectId, input),
  setMemoryStatus: ({ id, status }) => store.setMemoryStatus(id, status, { reason: status === 'archived' ? 'withdrawn' : null }),
  proposeStatusUpdate: ({ projectId, scope }) => store.proposeStatusUpdate(projectId, scope),
  memoryHistory: ({ id }) => store.memoryHistory(id),
  prepareContext: ({ projectId, task, workspaceId, disabled, references }) => store.prepareContext(projectId, task, { workspaceId: workspaceId ?? null, disabled: disabled ?? [], references: references ?? [], persist: false }),
  // ----- Explorer (read-only). Roots resolve from Journal's records; the
  // renderer only names a root key and a relative path. -----
  fileRoots: ({ projectId }) => store.fileRoots(text(projectId, 'project ID', 100)),
  listDirectory: async ({ projectId, rootKey, path }) => listDirectory((await fileRoot(projectId, rootKey)).path, path ?? ''),
  fileStatus: async ({ projectId, rootKey }) => {
    const root = await fileRoot(projectId, rootKey);
    if (!root.git) return { available: false, entries: [], folders: {}, truncated: false };
    const key = `${projectId}\u0000${rootKey}`;
    if (!statusCalls.has(key)) statusCalls.set(key, gitStatus(root.gitRoot, { prefix: root.prefix }).then(status => ({ available: true, ...status }), error => ({ available: false, reason: error.message, entries: [], folders: {}, truncated: false })).finally(() => statusCalls.delete(key)));
    return statusCalls.get(key);
  },
  previewFile: async ({ projectId, rootKey, path }) => previewFile((await fileRoot(projectId, rootKey)).path, path),
  fileDiff: async ({ projectId, rootKey, path }) => {
    const root = await fileRoot(projectId, rootKey);
    if (!root.git) throw new Error('This folder is not a Git repository');
    return headDiff(root.path, root.gitRoot, root.prefix, path);
  },
  revealFile: async ({ projectId, rootKey, path }) => { shell.showItemInFolder((await locate((await fileRoot(projectId, rootKey)).path, path)).full); },
  copyFilePath: async ({ projectId, rootKey, path, absolute }) => {
    const root = await fileRoot(projectId, rootKey); const rel = treePath(path, true);
    clipboard.writeText(absolute ? (await locate(root.path, rel)).full : rel || '.');
  },
  // An editor found on PATH, launched without a shell. Without one, passive
  // documents open with their default app and everything else is revealed.
  openInEditor: async ({ projectId, rootKey, path, line }) => {
    const root = await fileRoot(projectId, rootKey); const rel = treePath(path);
    const { full, stat } = await locate(root.path, rel);
    if (isSensitivePath(rel) || stat.isSymbolicLink()) { shell.showItemInFolder(full); return { opened: 'revealed' }; }
    const found = findEditor();
    if (found) {
      const target = launchTarget(found.path, EDITORS[found.name](Number.isInteger(line) && line > 0 ? line : 1)(full));
      spawn(target.file, target.args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => shell.showItemInFolder(full)).unref();
      return { opened: found.name };
    }
    const passive = /\.(?:md|markdown|txt|text|log|json|jsonc|ya?ml|toml|ini|cfg|conf|csv|tsv|diff|patch|png|jpe?g|gif|webp|bmp|pdf)$/i.test(rel);
    if (stat.isFile() && !(stat.mode & 0o111) && passive) { const error = await shell.openPath(full); if (!error) return { opened: 'default' }; }
    shell.showItemInFolder(full); return { opened: 'revealed' };
  },
  watchRoot: async ({ projectId, rootKey }) => { const root = await fileRoot(projectId, rootKey); watcher.watch(`${projectId}\u0000${rootKey}`, root.path); return { key: `${projectId}\u0000${rootKey}` }; },
  unwatchRoot: () => { watcher.close(); },
  // Types a reference into a running session's input (never submitted) when
  // the agent is known to be ready; otherwise copies it for the user to paste.
  referenceInSession: async ({ sessionId, projectId, rootKey, path, startLine, endLine }) => {
    const id = text(sessionId, 'session ID', 100);
    const reference = await store.referenceFor(id, { projectId, rootKey, path, startLine, endLine });
    const textValue = formatReference(reference.provider, { path: reference.display, kind: reference.kind, startLine: reference.startLine, endLine: reference.endLine });
    const record = { ...reference, text: textValue };
    let result;
    try { result = await runtime.call('paste', { id, text: textValue, reference: record }); }
    catch (error) { result = { inserted: false, reason: /Unknown|method/i.test(error.message) ? 'The running Journal runtime is from another build' : error.message }; }
    if (result.inserted) return { inserted: true, text: textValue };
    clipboard.writeText(textValue);
    const event = referenceEvent(record, 'copied');
    await store.appendEvent(id, 'reference', event).catch(() => {});
    send({ type: 'timeline', event: { sessionId: id, kind: 'reference', at: new Date().toISOString(), body: event } });
    return { inserted: false, copied: true, reason: result.reason, text: textValue };
  },
  // A reference chosen for the next task: validated and fingerprinted now,
  // recorded again in the receipt when the task starts.
  describeReference: async ({ projectId, rootKey, path, startLine, endLine, workspaceId }) => {
    return store.describeReference(text(projectId, 'project ID', 100), workspaceId ?? null, { rootKey, path, startLine, endLine });
  },
  setPinned: ({ id, pinned }) => store.setPinned(id, pinned),
  proposals: ({ projectId }) => store.listProposals(projectId, 'open'),
  storageInfo: () => store.storageInfo(),
  backupData: async () => {
    const result = await dialog.showSaveDialog(window, { title: 'Back up Journal data', defaultPath: `journal-backup-${new Date().toISOString().slice(0, 10)}.sqlite` });
    return result.canceled ? null : store.backup(result.filePath);
  },
  exportBrain: async ({ projectId }) => {
    const result = await dialog.showSaveDialog(window, { title: 'Export project knowledge', defaultPath: 'journal-knowledge.json', filters: [{ name: 'Journal knowledge', extensions: ['json'] }] });
    if (result.canceled) return null;
    const { json, markdown } = await store.exportBrain(projectId);
    writeFileSync(result.filePath, JSON.stringify(json, null, 2));
    // Never overwrite an unrelated Markdown file that the save dialog did not ask about.
    const mdPath = result.filePath.replace(/\.json$/i, '') + '.md'; const wroteMarkdown = !existsSync(mdPath);
    if (wroteMarkdown) writeFileSync(mdPath, markdown);
    return { path: result.filePath, memories: json.memories.length, markdown: wroteMarkdown ? mdPath : null };
  },
  importBrain: async ({ projectId }) => {
    const result = await dialog.showOpenDialog(window, { title: 'Import project knowledge', properties: ['openFile'], filters: [{ name: 'Journal knowledge', extensions: ['json'] }] });
    if (result.canceled) return null;
    if (statSync(result.filePaths[0]).size > 5 * 1024 * 1024) throw new Error('Import file is larger than 5 MiB');
    return store.importBrain(projectId, readFileSync(result.filePaths[0], 'utf8'));
  },
  acceptProposal: ({ id }) => store.acceptProposal(id),
  dismissProposal: ({ id }) => store.dismissProposal(id),
  markIncorrect: ({ id }) => store.setMemoryStatus(id, 'archived', { reason: 'incorrect' }),
  proposePromotion: ({ id }) => store.proposePromotion(id),
  getMemory: ({ id }) => store.getMemory(id),
  getReceipt: ({ id }) => store.getReceipt(id),
  sessions: async () => ({ live: (await runtime.call('list')).map(fromRuntime), active: await store.activeSessions() }),
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
  unarchiveSession: ({ id }) => store.unarchiveSession(id),
  renameSession: ({ id, name }) => store.renameSession(id, name),
  setSessionPinned: ({ id, pinned }) => store.setSessionPinned(id, pinned),
  // Never kills silently: a running session asks whether to stop it first or
  // keep it running and hide it. Files, worktrees and the native conversation
  // are never affected.
  removeSession: async ({ id }) => {
    const session = await store.getSession(id); const label = session.displayName || session.title;
    const running = LIVE.includes(session.status) || session.status === 'orphaned';
    const files = 'Your files, worktree and the native Claude/Codex conversation are not affected.';
    if (running) {
      const canStop = session.status !== 'orphaned';
      const { response } = await dialog.showMessageBox(window, { type: 'warning', buttons: canStop ? ['Stop and remove', 'Keep running and archive', 'Cancel'] : ['Keep running and archive', 'Cancel'], defaultId: canStop ? 2 : 1, cancelId: canStop ? 2 : 1,
        message: `"${label}" is still running.`, detail: `${canStop ? 'Stopping ends the agent gracefully, then removes the session from Journal. ' : 'Journal cannot stop an orphaned process from here; end it from the session first. '}Archiving leaves it running, marked archived in Active, and moves it out of Recent once it ends. ${files}` });
      const choice = canStop ? ['stop', 'archive', null][response] : ['archive', null][response];
      if (choice === 'archive') return store.archiveSession(id);
      if (choice !== 'stop') return null;
      await runtime.call('stop', { id });
      // Wait for the exit and the leftover-process scan, so nothing is recorded after removal.
      const settled = current => !LIVE.includes(current.status) && current.survivors !== null;
      for (let i = 0; i < 150 && !settled(await store.getSession(id)); i++) await new Promise(r => setTimeout(r, 100));
      const after = await store.getSession(id);
      if (LIVE.includes(after.status)) throw new Error('The session did not stop; it was not removed');
      if (survivorScanPending(after)) throw new Error('The agent stopped, but Journal is still checking for leftover child processes. The session was kept; try removing it again in a moment.');
      if (after.survivors?.length) throw new Error(`The agent stopped, but ${after.survivors.length} child process${after.survivors.length === 1 ? '' : 'es'} kept running. The session was kept so you can end them from its header.`);
    } else {
      const { response } = await dialog.showMessageBox(window, { type: 'warning', buttons: ['Remove from Journal', 'Remove and delete history', 'Cancel'], defaultId: 2, cancelId: 2, message: `Remove "${label}" from Journal?`,
        detail: `Remove from Journal hides it and deletes its timeline; its context receipts are kept so the native conversation can still be resumed exactly. Remove and delete history also deletes its receipts (refused if other sessions continue the same native conversation). ${files}` });
      if (response === 2) return null;
      if (response === 1) { await runtime.call('release', { id }).catch(() => {}); await store.purgeSession(id); return { id, removed: true }; }
    }
    await runtime.call('release', { id }).catch(() => {});
    return store.removeSession(id);
  },
  // Paths and IDs come from Journal's records, never from the renderer.
  revealProject: async ({ id }) => { const project = await store.storedProject(text(id, 'project ID', 100)); shell.showItemInFolder(project.root); },
  copyProjectPath: async ({ id }) => { clipboard.writeText((await store.storedProject(text(id, 'project ID', 100))).root); },
  revealSession: async ({ id }) => { const session = await store.getSession(id); if (session.cwd) shell.showItemInFolder(session.cwd); },
  copySessionPath: async ({ id }) => { const session = await store.getSession(id); if (session.cwd) clipboard.writeText(session.cwd); },
  copySessionNativeId: async ({ id }) => { const session = await store.getSession(id); if (!session.nativeId) throw new Error('No native session ID is known for this session'); clipboard.writeText(session.nativeId); },
  // A native context menu built from labels the renderer chose; returns only
  // the chosen item ID, and the renderer runs its existing action for it.
  contextMenu: ({ items, x, y }) => {
    if (!Array.isArray(items) || !items.length || items.length > 40) throw new Error('Invalid menu');
    const template = items.map(item => item?.separator ? { type: 'separator' } : { id: text(item?.id, 'menu item', 40), label: text(item?.label, 'menu label', 80), enabled: item.enabled !== false });
    if (headless && typeof globalThis.__journalMenuHook === 'function') {
      // Tests may only choose what a user could: an existing, enabled item.
      const choice = globalThis.__journalMenuHook(template) ?? null;
      if (choice !== null && !template.some(item => item.id === choice && item.enabled)) throw new Error(`Menu item ${choice} is missing or disabled`);
      return choice;
    }
    const position = Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 ? { x, y } : {};
    return new Promise(resolve => {
      let clicked = false;
      const menu = Menu.buildFromTemplate(template.map(item => item.type ? item : { ...item, click: () => { clicked = true; resolve(item.id); } }));
      // The close callback can precede the click; resolve empty only once no click is pending.
      menu.popup({ window, ...position, callback: () => setTimeout(() => { if (!clicked) resolve(null); }, 250) });
    });
  },
  start: input => {
    // A runtime from another build may not understand newer launch options;
    // never let it silently run in the wrong workspace or mode.
    if (runtime.info?.build && runtime.info.build !== buildId() && (input.workspaceId || input.research || input.plan || input.provider === 'cursor' || input.disabled?.length || input.references?.length)) throw new Error('Sessions are still running in a runtime from another Journal build. Stop them (quit with "Stop sessions") before using worktrees, research or plan mode, Cursor, leave-out or file references.');
    return runtime.call('start', input);
  },
  // ----- Cursor CLI: install and sign in run visibly, only after the user asks. -----
  providerStatus: ({ provider, fresh }) => { if (provider !== 'cursor') throw new Error('Only Cursor needs a status check'); return refreshCursor({ fresh: fresh === true }); },
  installCursor: async () => {
    const command = installCommand(process.platform, process.env);
    const { response } = await dialog.showMessageBox(window, { type: 'question', buttons: ['Install', 'Cancel'], defaultId: 1, cancelId: 1, message: 'Install Cursor CLI?',
      detail: `Journal will run Cursor's official installation command:\n\n${command.display}\n\nThis downloads and installs the Cursor Agent CLI on your computer from cursor.com.${process.platform === 'win32' ? ' The installer also adds its folder to your user PATH.' : ''} It runs as you, without administrator rights, in a window where you can watch its output. Journal will not receive or store your Cursor credentials.` });
    if (response !== 0) return null;
    // Automated tests substitute a local fixture installer; nothing else can.
    const run = headless && globalThis.__journalCursorInstall ? globalThis.__journalCursorInstall : command;
    return { ...(await processes.start('install', { file: run.file, args: run.args, env: installEnv(process.env), cwd: homedir() })), command: command.display };
  },
  cursorLogin: async () => {
    const found = await findCursor(process.env);
    if (!found.path) throw new Error('Install the Cursor CLI first');
    const target = launchTarget(found.path, ['login'], { env: process.env });
    return processes.start('login', { file: target.file, args: target.args, env: runnable(process.env), cwd: homedir() });
  },
  processInput: ({ id, data }) => processes.write(text(id, 'process', 40), data),
  processResize: ({ id, cols, rows }) => processes.resize(text(id, 'process', 40), cols, rows),
  processStop: ({ id }) => processes.stop(text(id, 'process', 40)),
  processSnapshot: ({ id }) => processes.snapshot(text(id, 'process', 40)),
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
  // ----- Updates -----
  updateStatus: () => updater.state,
  checkForUpdates: () => updater.check(),
  setAutomaticUpdates: ({ enabled }) => { writeFileSync(updatePrefs, JSON.stringify({ automatic: enabled === true })); return updater.setAutomatic(enabled === true); },
  openUpdateRelease: () => { void shell.openExternal(updater.releaseUrl()); },
  // Installing restarts Journal. Running agents are stopped or kept running first,
  // as when quitting; then Journal quits normally and the installer starts only
  // after the runtime and the database are closed (see before-quit). The Windows
  // installer ends every process started from the install folder, including the
  // runtime, so sessions cannot be kept there.
  installUpdate: async () => {
    if (!updater.ready()) throw new Error('No downloaded update is ready to install');
    let live = []; if (runtime.socket) { try { live = (await runtime.call('list')).filter(session => LIVE.includes(session.status)); } catch { /* runtime unavailable */ } }
    const canKeep = process.platform !== 'win32';
    let policy = canKeep && process.env.JOURNAL_QUIT_POLICY === 'keep' ? 'keep' : 'stop';
    if (live.length && !process.env.JOURNAL_QUIT_POLICY) {
      const buttons = canKeep ? ['Stop sessions and update', 'Keep them running and update', 'Cancel'] : ['Stop sessions and update', 'Cancel'];
      const { response } = await dialog.showMessageBox(window, { type: 'question', buttons, defaultId: 0, cancelId: buttons.length - 1,
        message: `Install Journal ${updater.state.version} and restart?`,
        detail: `${live.length} session${live.length === 1 ? ' is' : 's are'} still running. Stopping ends the native CLIs gracefully.${canKeep ? ' Keeping them running lets the updated Journal reconnect to them.' : ' The installer closes everything Journal started, so sessions cannot keep running during an update.'}` });
      if (response === buttons.length - 1) return { installing: false };
      policy = response === 0 ? 'stop' : 'keep';
    }
    updatePolicy = policy; updater.setInstalling(true); app.quit();
    return { installing: true };
  },
};
ipcMain.handle('journal:request', async (event, action, input = {}) => {
  try {
    if (!validSender(event)) throw new Error('Untrusted desktop caller');
    if (!Object.hasOwn(actions, action) || !input || typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).length > 100000) throw new Error('Invalid desktop request');
    if (ROOT_CHANGES.has(action)) rootCache.clear();
    try { return { ok: true, value: await actions[action](input) }; } finally { if (ROOT_CHANGES.has(action)) rootCache.clear(); }
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Operation failed' }; }
});
try { await runtime.connect(); runtimeState = 'connected'; }
catch (error) { runtimeState = 'disconnected'; console.error('Journal runtime unavailable:', error.message); void runtime.reconnect(); }
createWindow();
// Updates: packaged builds only. The automatic-check preference lives in the data folder.
const updatePrefs = join(userData, 'updates.json');
const automaticUpdates = (() => { try { return JSON.parse(readFileSync(updatePrefs, 'utf8')).automatic !== false; } catch { return true; } })();
const updates = updateMode({ packaged: app.isPackaged, platform: process.platform, env: process.env });
// A failed install after shutdown leaves nothing to return to: quit instead.
const installFailed = () => { if (updatePolicy && closed) app.exit(0); updatePolicy = null; };
updater = new Updater({ autoUpdater: updates === 'off' ? null : electronUpdater.autoUpdater, mode: updates, version: app.getVersion(), send, enabled: automaticUpdates, onError: installFailed });
updater.start();
// Check for Updates… (app menu on macOS, Help elsewhere): reports the result in a dialog.
async function checkForUpdatesFromMenu() {
  const outcome = checkOutcome(await updater.check()); if (!outcome) return;
  const buttons = outcome.kind === 'ready' ? ['Restart Now', 'Later'] : outcome.kind === 'available' ? ['Download', 'Later'] : ['OK'];
  const options = { type: outcome.kind === 'error' ? 'warning' : 'info', buttons, defaultId: 0, cancelId: buttons.length - 1, message: outcome.message, detail: outcome.detail };
  const { response } = window && !window.isDestroyed() ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
  if (response !== 0) return;
  if (outcome.kind === 'ready') await actions.installUpdate().catch(error => dialog.showErrorBox('Could not install the update', error.message));
  if (outcome.kind === 'available') actions.openUpdateRelease();
}
Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate({ platform: process.platform, name: app.name, packaged: app.isPackaged, checkForUpdates: () => void checkForUpdatesFromMenu().catch(() => {}), openUrl: url => void shell.openExternal(url) })));
// Release smoke checks of builds that cannot be driven by automation (the
// Windows portable EXE relaunches itself): report basic health, then quit.
// Packaged builds only; contains no project or user content.
if (app.isPackaged && process.env.JOURNAL_SMOKE_MARKER) {
  window.webContents.once('did-finish-load', () => setTimeout(() => {
    writeFileSync(process.env.JOURNAL_SMOKE_MARKER, JSON.stringify({ version: app.getVersion(), packaged: app.isPackaged, userData, runtime: runtimeState,
      exe: process.execPath, providers: agents.map(agent => ({ provider: agent.provider, state: agent.state ?? (agent.available ? 'ready' : 'missing') })) }));
    app.quit();
  }, 1500));
}
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
app.on('activate', () => { if (!window) createWindow(); });
app.on('window-all-closed', () => app.quit());
// Quit versus close: quitting asks what to do with running sessions. Stopping
// ends them gracefully; keeping them leaves the runtime running so the next
// launch rediscovers them. JOURNAL_QUIT_POLICY=stop|keep skips the prompt.
app.on('before-quit', event => {
  if (closed) return; event.preventDefault(); if (closing) return; closing = true;
  (async () => {
    let live = [];
    // Never start a runtime while quitting: only ask a connected one.
    if (runtime.socket) { try { live = (await runtime.call('list')).filter(session => LIVE.includes(session.status)); } catch { /* runtime unavailable */ } }
    // A half-finished Cursor install could leave a broken CLI behind: ask first.
    const running = processes.running();
    if (running.length && !headless) {
      const { response } = await dialog.showMessageBox({ type: 'warning', buttons: ['Stop it and quit', 'Cancel'], defaultId: 1, cancelId: 1,
        message: running.includes('install') ? 'The Cursor CLI installation is still running.' : 'Cursor sign-in is still running.',
        detail: running.includes('install') ? 'Quitting now stops the installer and may leave an incomplete installation. You can run the installer again afterwards.' : 'Quitting now cancels the sign-in.' });
      if (response === 1) { closing = false; if (updatePolicy) { updatePolicy = null; updater.setInstalling(false); } if (!window) createWindow(); return; }
    }
    // An update install already asked what to do with running sessions.
    let policy = updatePolicy ?? process.env.JOURNAL_QUIT_POLICY;
    if (live.length && policy !== 'stop' && policy !== 'keep') {
      const { response } = await dialog.showMessageBox({ type: 'question', buttons: ['Stop sessions and quit', 'Keep running in background', 'Cancel'], defaultId: 0, cancelId: 2,
        message: `${live.length} session${live.length === 1 ? ' is' : 's are'} still running.`,
        detail: 'Stopping ends the native CLIs gracefully. Keeping them running lets you reconnect when you reopen Journal.' });
      if (response === 2) { closing = false; if (!window) createWindow(); return; }
      policy = response === 0 ? 'stop' : 'keep';
    }
    processes.stopAll(); updater?.stop();
    await runtime.close({ shutdown: policy !== 'keep' && !!runtime.socket, stopSessions: true });
    await store.close().catch(() => {});
    closed = true;
    if (updatePolicy) {
      // Everything is closed: start the installer (it quits Journal and relaunches it).
      try { updater.install(); setTimeout(() => app.exit(0), 60_000).unref(); return; } catch { /* quit without updating */ }
    }
    app.quit();
  })().catch(() => { closed = true; app.quit(); });
});
}).catch(error => {
  console.error('Journal startup failed:', error.message);
  app.quit();
});
