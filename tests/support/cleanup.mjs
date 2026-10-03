import { rmSync } from 'node:fs';

// Temporary test folders are removed when the test process exits, after every
// store, worker and child has closed. node:test runs `after` hooks in the order
// they were added, so a fixture's cleanup would otherwise run before a test's
// own `store.close()`; Windows refuses to delete files that are still open.
const pending = new Set();
// Only Windows defers: elsewhere deleting at once still surfaces leaked handles.
export function removeLater(path) { if (process.platform === 'win32') pending.add(path); else rmSync(path, { recursive: true, force: true }); }
process.on('exit', () => {
  for (const path of pending) { try { rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* leave it for the OS */ } }
});
