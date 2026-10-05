import { shortcutKeys } from './shortcuts.mjs';

// The application menu: Electron's default menus (standard roles) plus
// "Check for Updates…" (app menu on macOS, Help elsewhere), "Settings…"
// (app menu on macOS, File elsewhere), and "Command Palette…" and "Open File…"
// (View). The shortcut router owns their keys (src/desktop/shortcuts.mjs), so
// each accelerator is shown but not registered, and a click sends the same
// command the key does.
export const PROJECT_URL = 'https://github.com/adirz101/Journal';

// An aria-keyshortcuts string ("Meta+Shift+P") as an Electron accelerator ("Cmd+Shift+P").
export const accelerator = aria => aria.split('+').map(part => ({ Meta: 'Cmd', Control: 'Ctrl' })[part] ?? part).join('+');

export function menuTemplate({ platform, name, checkForUpdates, openUrl, openSettings = () => {}, command = () => {}, packaged = false, devTools = false }) {
  const keys = shortcutKeys(platform);
  const routed = (id, label) => ({ id, label, accelerator: accelerator(keys[id].aria), registerAccelerator: false, click: () => command(id) });
  const find = [routed('command-palette', 'Command Palette…'), routed('open-file', 'Open File…'), { type: 'separator' }];
  // Released builds: zoom and full screen only. Reload would drop the renderer mid-session; DevTools is a developer affordance, not a security boundary (set JOURNAL_DEVTOOLS=1 for support).
  // Development builds keep the viewMenu role with its default items written out, since a role's submenu replaces its defaults.
  const view = packaged
    ? { label: 'View', submenu: [...find, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, ...(devTools ? [{ type: 'separator' }, { role: 'toggleDevTools' }] : [])] }
    : { role: 'viewMenu', submenu: [...find, { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] };
  const check = { id: 'check-for-updates', label: 'Check for Updates…', click: () => checkForUpdates() };
  const settings = { id: 'settings', label: 'Settings…', accelerator: 'CmdOrCtrl+,', registerAccelerator: false, click: () => openSettings() };
  const help = { role: 'help', submenu: [{ label: 'Journal on GitHub', click: () => openUrl(PROJECT_URL) }, { label: 'Releases', click: () => openUrl(`${PROJECT_URL}/releases`) }] };
  if (platform === 'darwin') {
    return [
      { label: name, submenu: [{ role: 'about' }, check, settings, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'fileMenu' }, { role: 'editMenu' }, view, { role: 'windowMenu' }, help,
    ];
  }
  // Electron's fileMenu role holds only Quit on Windows and Linux.
  return [{ label: 'File', submenu: [settings, { type: 'separator' }, { role: 'quit' }] }, { role: 'editMenu' }, view, { role: 'windowMenu' }, { ...help, submenu: [check, { type: 'separator' }, ...help.submenu] }];
}

// What to tell the user after a check they started from the menu. The sidebar
// already shows downloads and the restart button; dialogs cover the rest.
export function checkOutcome(state) {
  const next = state.version ? `Journal ${state.version}` : 'A new version of Journal';
  switch (state.status) {
    case 'off': return { kind: 'info', message: 'Updates are available in installed builds only.', detail: `This is a development build of Journal ${state.current}.` };
    case 'none': return { kind: 'info', message: 'Journal is up to date.', detail: `Version ${state.current} is the newest version available.` };
    case 'downloading': return { kind: 'info', message: `${next} is available.`, detail: 'It is downloading in the background. When it is ready, choose Restart to update at the bottom right of the window.' };
    case 'ready': return { kind: 'ready', message: `${next} is ready to install.`, detail: 'Restart Journal now to finish updating?' };
    case 'available': return { kind: 'available', message: `${next} is available.`, detail: 'This portable build cannot update itself. Download the new version from the release page.' };
    case 'error': return { kind: 'error', message: 'Could not check for updates.', detail: state.message ?? 'Unknown error' };
    default: return null; // still checking: the sidebar and the next result cover it
  }
}
