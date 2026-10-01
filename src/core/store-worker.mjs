import { parentPort, workerData } from 'node:worker_threads';
import { chmodSync } from 'node:fs';
import { JournalStore } from './store.mjs';
const store = new JournalStore(workerData.path);
if (workerData.path !== ':memory:' && process.platform !== 'win32') chmodSync(workerData.path, 0o600);
const methods = new Set(['openProject', 'listProjects', 'project', 'proposeMemory', 'getMemory', 'memoryHistory', 'listMemories', 'listMemoryPage', 'liveSessions', 'activeSessions', 'archiveSession', 'appendEvent', 'listEvents', 'checkoutBaseline', 'sessionChanges', 'sessionFileDiff', 'openableFile', 'proposeStatusUpdate', 'setMemoryStatus', 'prepareContext', 'getReceipt', 'latestNativeReceipt', 'listReceipts', 'updateReceiptState', 'saveSession', 'getSession', 'listSessions', 'recoverSessions', 'close']);
parentPort.postMessage({ ready: true });
parentPort.on('message', ({ id, method, args }) => {
  try {
    if (!methods.has(method)) throw new Error('Unknown storage operation');
    const value = store[method](...args);
    parentPort.postMessage({ id, value });
    if (method === 'close') parentPort.close();
  } catch (error) { parentPort.postMessage({ id, error: error.message }); }
});
