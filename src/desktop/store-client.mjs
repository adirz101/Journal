import { Worker } from 'node:worker_threads';

// Filesystem validation and synchronous SQLite/Git run off the PTY/UI thread.
// No renderer can select worker methods; this proxy is private to main.
export class StoreClient {
  constructor(path) {
    this.pending = new Map(); this.sequence = 0; this.failure = null; this.closed = false;
    this.worker = new Worker(new URL('../core/store-worker.mjs', import.meta.url), { workerData: { path } });
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.worker.on('message', message => {
      if (message.ready) { this.readyResolve(); return; }
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id); if (pending.method === 'close' && !message.error) this.closed = true;
      message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.value);
    });
    const failed = error => {
      this.failure = error; this.readyReject(error);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
    this.worker.on('error', failed);
    this.worker.on('exit', code => { if (code !== 0 || this.pending.size) failed(new Error('Storage worker stopped unexpectedly')); });
    for (const method of ['openProject', 'listProjects', 'project', 'proposeMemory', 'getMemory', 'memoryHistory', 'listMemories', 'listMemoryPage', 'liveSessions', 'activeSessions', 'archiveSession', 'appendEvent', 'listEvents', 'checkoutBaseline', 'sessionChanges', 'sessionFileDiff', 'proposeStatusUpdate', 'setMemoryStatus', 'prepareContext', 'getReceipt', 'latestNativeReceipt', 'listReceipts', 'updateReceiptState', 'saveSession', 'getSession', 'listSessions', 'recoverSessions', 'close']) {
      this[method] = (...args) => this.call(method, args);
    }
  }
  async call(method, args) {
    await this.ready;
    if (this.closed) { if (method === 'close') return; throw new Error('Storage is closed'); }
    if (this.failure) throw this.failure;
    if (this.pending.size >= 128) throw new Error('Storage is busy; try again shortly');
    const id = ++this.sequence;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject, method }); this.worker.postMessage({ id, method, args }); });
  }
}
