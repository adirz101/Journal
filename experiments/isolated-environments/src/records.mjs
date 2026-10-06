import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, closeSync, unlinkSync, fsyncSync } from 'node:fs';
import { dirname, join } from 'node:path';

// The durable record of environments: one JSON file, replaced atomically (write a temporary file,
// fsync, rename). Every state change is written before the side effect it announces ("intent
// first"), so a crash leaves a record that reconcile() can finish or roll back. The real
// implementation would use Journal's SQLite store; the shape is what matters here.
export class Records {
  constructor(file) { this.file = file; mkdirSync(dirname(file), { recursive: true }); }
  load() { try { return JSON.parse(readFileSync(this.file, 'utf8')); } catch { return { version: 1, environments: {}, ports: {} }; } }
  update(change) {
    const data = this.load(); const result = change(data);
    const temp = `${this.file}.${process.pid}.tmp`;
    const fd = openSync(temp, 'w', 0o600); try { writeFileSync(fd, `${JSON.stringify(data, null, 1)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, this.file);
    return result;
  }
}

// One Apply at a time per logical branch: an exclusive lock file holding the owner's pid. A lock
// whose owner process is gone (a crash) is stale and taken over.
export function acquireLock(dir, name, { pid = process.pid, alive = defaultAlive } = {}) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try { const fd = openSync(file, 'wx', 0o600); writeFileSync(fd, String(pid)); closeSync(fd); return { file, release: () => { try { unlinkSync(file); } catch { /* gone */ } } }; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = Number(readFileSync(file, 'utf8')) || 0;
      if (owner && alive(owner)) return null;
      try { unlinkSync(file); } catch { /* raced */ }
    }
  }
  return null;
}
export function defaultAlive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } }
export const lockExists = (dir, name) => existsSync(join(dir, `${name}.lock`));
