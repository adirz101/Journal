import { watch } from 'node:fs';
import { sep } from 'node:path';

// Watches the one root the explorer shows, recursively (FSEvents on macOS,
// ReadDirectoryChangesW on Windows). Changes are batched: the explorer gets the
// folders whose listings changed, and refreshes Git status once per batch.
// Git metadata and dependency folders never trigger work.

const QUIET = new Set(['.git', 'node_modules']);
const BATCH_MS = 150; const MAX_FOLDERS = 200;

export class RootWatcher {
  constructor(onChange) { this.onChange = onChange; this.current = null; }
  watch(key, path) {
    if (this.current?.key === key && this.current.path === path) return;
    this.close();
    const state = { key, path, folders: new Set(), overflow: false, timer: null, watcher: null };
    const flush = () => {
      state.timer = null; if (this.current !== state) return;
      const folders = [...state.folders]; const overflow = state.overflow || folders.length > MAX_FOLDERS;
      state.folders.clear(); state.overflow = false;
      this.onChange({ key, folders: overflow ? [] : folders, overflow });
    };
    const schedule = () => { if (!state.timer) state.timer = setTimeout(flush, BATCH_MS); };
    try {
      state.watcher = watch(path, { recursive: true }, (_event, filename) => {
        // No name (or a platform overflow) means "something changed": rescan.
        if (!filename) { state.overflow = true; schedule(); return; }
        const parts = String(filename).split(sep).join('/').split('/');
        if (parts.some(part => QUIET.has(part))) return;
        state.folders.add(parts.slice(0, -1).join('/'));
        schedule();
      });
      // A failed watcher stops; one final rescan keeps the tree honest.
      state.watcher.on('error', () => { if (this.current === state) { this.close(); this.onChange({ key, folders: [], overflow: true, stopped: true }); } });
    } catch { /* unwatchable folder: the explorer still refreshes on focus and on request */ }
    this.current = state;
  }
  close() {
    const state = this.current; this.current = null;
    if (!state) return;
    clearTimeout(state.timer); try { state.watcher?.close(); } catch { /* already closed */ }
  }
}
