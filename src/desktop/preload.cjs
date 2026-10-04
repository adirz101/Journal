const { contextBridge, ipcRenderer, webUtils } = require('electron');
const allowed = new Set(['bootstrap', 'openProject', 'project', 'checkout', 'projects', 'renameProject', 'setProjectPinned', 'projectDetails', 'addProjectFolder', 'removeProjectFolder', 'removeProject', 'memoryPage', 'workspaces', 'planWorkspace', 'createWorkspace', 'importWorkspace', 'workspaceRemovalBlockers', 'removeWorkspace', 'forgetWorkspace', 'proposeMemory', 'setMemoryStatus', 'setPinned', 'storageInfo', 'backupData', 'exportBrain', 'importBrain', 'proposals', 'acceptProposal', 'dismissProposal', 'markIncorrect', 'proposePromotion', 'getMemory', 'proposeStatusUpdate', 'memoryHistory', 'prepareContext', 'getReceipt', 'sessions', 'getSession', 'sessionEvents', 'sessionChanges', 'sessionFileDiff', 'openPath', 'archiveSession', 'unarchiveSession', 'renameSession', 'setSessionPinned', 'removeSession', 'revealProject', 'copyProjectPath', 'revealSession', 'copySessionPath', 'copySessionNativeId', 'contextMenu', 'fileRoots', 'listDirectory', 'fileStatus', 'previewFile', 'fileDiff', 'revealFile', 'copyFilePath', 'openInEditor', 'watchRoot', 'unwatchRoot', 'referenceInSession', 'describeReference', 'providerStatus', 'providerInstall', 'providerLogin', 'processInput', 'processResize', 'processStop', 'processSnapshot', 'updateStatus', 'checkForUpdates', 'setAutomaticUpdates', 'openUpdateRelease', 'installUpdate', 'start', 'attach', 'detach', 'write', 'resize', 'interrupt', 'stop', 'terminateSurvivors', 'terminateOrphan', 'acknowledge', 'confirmNativeId', 'setAppearance', 'setModalOpen']);
for (const action of ['memoryOrigins', 'deliveryCounts', 'memoryChecks', 'previewSelection', 'preferences', 'setPreference']) allowed.add(action);
for (const action of ['sessionSummary', 'staleNotes', 'rememberProposals', 'reaffirmMemory']) allowed.add(action);
for (const action of ['openProjectPath', 'firstRunDrafts', 'rememberDraft', 'skipOrientation']) allowed.add(action);
allowed.add('openInstallPage');
// contextBridge copies only the message of an Error thrown across it, so the
// renderer's api() uses settle(), which returns the error code as plain data.
const settle = async (action, input = {}) => {
  if (!allowed.has(action)) return { ok: false, error: 'Unknown desktop action' };
  const result = await ipcRenderer.invoke('journal:request', action, input);
  if (result.ok) return { ok: true, value: result.value };
  return { ok: false, error: String(result.error), ...(typeof result.code === 'string' ? { code: result.code.slice(0, 40) } : {}) };
};
contextBridge.exposeInMainWorld('journal', {
  request: async (action, input = {}) => {
    const result = await settle(action, input);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  },
  settle,
  onEvent: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('journal:event', listener);
    return () => ipcRenderer.removeListener('journal:event', listener);
  },
  // Electron removed File.path; '' for a file that did not come from the OS (a synthetic drop).
  pathForFile: file => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
});
