const { contextBridge, ipcRenderer } = require('electron');
const allowed = new Set(['bootstrap', 'openProject', 'project', 'checkout', 'projects', 'renameProject', 'setProjectPinned', 'projectDetails', 'addProjectFolder', 'removeProjectFolder', 'removeProject', 'memoryPage', 'workspaces', 'planWorkspace', 'createWorkspace', 'importWorkspace', 'workspaceRemovalBlockers', 'removeWorkspace', 'forgetWorkspace', 'proposeMemory', 'setMemoryStatus', 'setPinned', 'storageInfo', 'backupData', 'exportBrain', 'importBrain', 'proposals', 'acceptProposal', 'dismissProposal', 'markIncorrect', 'proposePromotion', 'getMemory', 'proposeStatusUpdate', 'memoryHistory', 'prepareContext', 'getReceipt', 'sessions', 'getSession', 'sessionEvents', 'sessionChanges', 'sessionFileDiff', 'openPath', 'archiveSession', 'unarchiveSession', 'renameSession', 'setSessionPinned', 'removeSession', 'revealProject', 'copyProjectPath', 'revealSession', 'copySessionPath', 'copySessionNativeId', 'contextMenu', 'fileRoots', 'listDirectory', 'fileStatus', 'previewFile', 'fileDiff', 'revealFile', 'copyFilePath', 'openInEditor', 'watchRoot', 'unwatchRoot', 'referenceInSession', 'describeReference', 'providerStatus', 'installCursor', 'cursorLogin', 'processInput', 'processResize', 'processStop', 'processSnapshot', 'updateStatus', 'checkForUpdates', 'setAutomaticUpdates', 'openUpdateRelease', 'installUpdate', 'start', 'attach', 'detach', 'write', 'resize', 'interrupt', 'stop', 'terminateSurvivors', 'terminateOrphan', 'acknowledge', 'confirmNativeId', 'setAppearance', 'setModalOpen']);
for (const action of ['memoryOrigins', 'deliveryCounts', 'memoryChecks']) allowed.add(action);
contextBridge.exposeInMainWorld('journal', {
  request: async (action, input = {}) => {
    if (!allowed.has(action)) throw new Error('Unknown desktop action');
    const result = await ipcRenderer.invoke('journal:request', action, input);
    if (!result.ok) throw Object.assign(new Error(result.error), result.code ? { code: result.code } : {});
    return result.value;
  },
  onEvent: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('journal:event', listener);
    return () => ipcRenderer.removeListener('journal:event', listener);
  },
});
