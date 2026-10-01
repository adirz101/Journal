import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, sep } from 'node:path';

// Per-launch Claude observer hooks. Each session gets its own settings file and
// an append-only, size-bounded events file; existing user/project hooks stay
// native. Observations are hints for status and activity, never approvals.
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure'];
const quote = (value, platform) => platform === 'win32' ? `"${value.replaceAll('"', '\\"')}"` : `'${value.replaceAll("'", "'\\''")}'`;

export class Observers {
  constructor({ dataDir, hookScript, execPath, platform = process.platform, ingest }) {
    this.dir = join(dataDir, 'observers'); this.hookScript = hookScript; this.execPath = execPath; this.platform = platform; this.ingest = ingest;
    this.sessions = new Map();
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }
  settings(session, project) {
    const target = join(this.dir, `${session.id}.events.jsonl`); const token = randomBytes(24).toString('hex');
    const runner = `${quote(this.execPath, this.platform)} ${quote(this.hookScript, this.platform)} ${quote(target, this.platform)} ${quote(token, this.platform)}`;
    // Electron binary in Node mode avoids adding a system Node requirement to hooks.
    const command = this.platform === 'win32' ? `set ELECTRON_RUN_AS_NODE=1&& ${runner}` : `ELECTRON_RUN_AS_NODE=1 ${runner}`;
    const hooks = Object.fromEntries(HOOK_EVENTS.map(event => [event, [{ hooks: [{ type: 'command', command, timeout: 3 }] }]]));
    const settingsFile = join(this.dir, `${session.id}.settings.json`);
    writeFileSync(settingsFile, JSON.stringify({ hooks }), { mode: 0o600 });
    let root = project.root; try { root = realpathSync(project.root); } catch { /* keep recorded root */ }
    this.sessions.set(session.id, { token, target, settingsFile, root, offset: 0, partial: '' });
    return settingsFile;
  }
  poll() {
    for (const [id, observer] of this.sessions) {
      if (!existsSync(observer.target)) continue;
      let fd;
      try {
        fd = openSync(observer.target, 'r'); const size = fstatSync(fd).size;
        if (size <= observer.offset) continue;
        const buffer = Buffer.alloc(Math.min(size - observer.offset, 256 * 1024));
        const count = readSync(fd, buffer, 0, buffer.length, observer.offset); observer.offset += count;
        const lines = (observer.partial + buffer.subarray(0, count).toString('utf8')).split('\n'); observer.partial = lines.pop().slice(-8192);
        for (const line of lines) this.accept(id, observer, line);
      } catch { /* Observation failures never affect the native agent. */ }
      finally { if (fd !== undefined) closeSync(fd); }
    }
  }
  accept(id, observer, line) {
    let data; try { data = JSON.parse(line); } catch { return; }
    if (data.id !== id || data.token !== observer.token || typeof data.cwd !== 'string') return;
    let cwd; try { cwd = realpathSync(data.cwd); } catch { return; }
    if (cwd !== observer.root && !cwd.startsWith(observer.root + sep)) return;
    this.ingest(id, data);
  }
  release(id) {
    const observer = this.sessions.get(id); if (!observer) return;
    this.poll(); this.sessions.delete(id);
    rmSync(observer.target, { force: true }); rmSync(observer.settingsFile, { force: true });
  }
}
