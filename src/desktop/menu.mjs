// The application menu: Electron's default menus (standard roles) plus
// "Check for Updates…", in the app menu on macOS and in Help elsewhere, and the
// two notification preferences (app menu on macOS, Window elsewhere) until the
// Settings dialog takes them over.
export const PROJECT_URL = 'https://github.com/adirz101/Journal';

export function menuTemplate({ platform, name, checkForUpdates, openUrl, packaged = false, devTools = false, preferences = null, setPreference = () => {} }) {
  // Released builds: zoom and full screen only. Reload would drop the renderer mid-session; DevTools is a developer affordance, not a security boundary (set JOURNAL_DEVTOOLS=1 for support).
  const view = packaged
    ? { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, ...(devTools ? [{ type: 'separator' }, { role: 'toggleDevTools' }] : [])] }
    : { role: 'viewMenu' };
  const check = { id: 'check-for-updates', label: 'Check for Updates…', click: () => checkForUpdates() };
  // Each click names the value it sets, so the result never depends on Electron toggling the item first.
  const notify = preferences ? [{ type: 'separator' },
    { id: 'notify-approval', type: 'checkbox', label: 'Notify When Claude Needs Approval', checked: preferences.notifications, click: () => setPreference('notifications', !preferences.notifications) },
    { id: 'notify-command', type: 'checkbox', label: 'Show Commands in Notifications', checked: preferences.notificationCommand, enabled: preferences.notifications, click: () => setPreference('notificationCommand', !preferences.notificationCommand) }] : [];
  const help = { role: 'help', submenu: [{ label: 'Journal on GitHub', click: () => openUrl(PROJECT_URL) }, { label: 'Releases', click: () => openUrl(`${PROJECT_URL}/releases`) }] };
  if (platform === 'darwin') {
    return [
      { label: name, submenu: [{ role: 'about' }, check, ...notify, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'fileMenu' }, { role: 'editMenu' }, view, { role: 'windowMenu' }, help,
    ];
  }
  const windowMenu = notify.length ? { role: 'windowMenu', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }, ...notify] } : { role: 'windowMenu' };
  return [{ role: 'fileMenu' }, { role: 'editMenu' }, view, windowMenu, { ...help, submenu: [check, { type: 'separator' }, ...help.submenu] }];
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
