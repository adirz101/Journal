import { parentPort, workerData } from 'node:worker_threads';
import { chmodSync } from 'node:fs';
import { JournalStore } from './store.mjs';
import { STORE_METHODS } from './store-methods.mjs';
const store = new JournalStore(workerData.path);
if (workerData.path !== ':memory:' && process.platform !== 'win32') chmodSync(workerData.path, 0o600);
const methods = new Set(STORE_METHODS);
// SQLite reports a full disk tersely; say what it means for the user's work.
const friendly = error => /database or disk is full|SQLITE_FULL/i.test(error.message) ? 'Disk full: Journal could not save this change. Free disk space; running terminals are unaffected, and nothing already saved was lost.' : error.message;
parentPort.postMessage({ ready: true });
parentPort.on('message', ({ id, method, args }) => {
  try {
    if (!methods.has(method)) throw new Error('Unknown storage operation');
    // Some operations (backup) are asynchronous; results are posted when done.
    Promise.resolve(store[method](...args)).then(value => {
      parentPort.postMessage({ id, value });
      if (method === 'close') parentPort.close();
    }, error => parentPort.postMessage({ id, error: friendly(error) }));
  } catch (error) { parentPort.postMessage({ id, error: friendly(error) }); }
});
