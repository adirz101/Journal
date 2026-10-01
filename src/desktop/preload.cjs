const { contextBridge, ipcRenderer } = require('electron');
const allowed = new Set(['bootstrap', 'openProject', 'project', 'memoryPage', 'workspaces', 'planWorkspace', 'createWorkspace', 'importWorkspace', 'workspaceRemovalBlockers', 'removeWorkspace', 'forgetWorkspace', 'proposeMemory', 'setMemoryStatus', 'proposeStatusUpdate', 'memoryHistory', 'prepareContext', 'getReceipt', 'sessions', 'getSession', 'sessionEvents', 'sessionChanges', 'sessionFileDiff', 'openPath', 'archiveSession', 'start', 'attach', 'detach', 'write', 'resize', 'interrupt', 'stop', 'terminateSurvivors', 'terminateOrphan', 'acknowledge', 'confirmNativeId', 'setAppearance']);
contextBridge.exposeInMainWorld('journal', {
  request: async (action, input = {}) => {
    if (!allowed.has(action)) throw new Error('Unknown desktop action');
    const result = await ipcRenderer.invoke('journal:request', action, input);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  },
  onEvent: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('journal:event', listener);
    return () => ipcRenderer.removeListener('journal:event', listener);
  },
});
