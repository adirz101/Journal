// Restore Journal data from a backup made in the app (manual, local).
//   node scripts/data-restore.mjs <backup.sqlite> [data directory]
// Refuses while a runtime holds the data directory. The current database is
// kept beside the restored one; nothing is deleted.
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, lstatSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPPORTED_VERSION = 8; // keep in step with the store migrations

export function defaultDataDir() {
  if (process.env.JOURNAL_DATA_DIR) return resolve(process.env.JOURNAL_DATA_DIR);
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'journal-desktop');
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'journal-desktop');
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'journal-desktop');
}

export function restore(backup, dataDir = defaultDataDir(), { alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }, force = false } = {}) {
  backup = resolve(backup);
  if (!existsSync(backup)) throw new Error(`No backup at ${backup}`);
  const lock = join(dataDir, 'runtime.lock');
  if (existsSync(lock)) { const owner = JSON.parse(readFileSync(lock, 'utf8')); if (alive(owner.pid)) throw new Error('Quit Journal and stop its runtime (choose "Stop sessions and quit") before restoring'); }
  // Electron's single-instance lock exists while the app is open.
  // SingletonLock is a dangling symlink on macOS/Linux (lstat, not exists); Windows uses 'lockfile'.
  const appLock = ['SingletonLock', 'lockfile'].some(name => lstatSync(join(dataDir, name), { throwIfNoEntry: false }));
  if (!force && appLock) throw new Error('Journal appears to be open. Quit it first (or pass --force if it crashed and left a stale lock)');
  const check = new DatabaseSync(backup, { readOnly: true });
  try {
    const result = check.prepare('PRAGMA integrity_check').get().integrity_check; if (result !== 'ok') throw new Error(`Backup failed its integrity check: ${result}`);
    const tables = new Set(check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    if (!['projects', 'memories', 'revisions', 'receipts', 'sessions'].every(name => tables.has(name))) throw new Error('This file is not a Journal backup');
    const version = check.prepare('PRAGMA user_version').get().user_version;
    if (version > SUPPORTED_VERSION) throw new Error(`This backup is from a newer Journal (schema ${version}); update Journal before restoring it`);
  }
  finally { check.close(); }
  const target = join(dataDir, 'journal.sqlite'); const kept = `${target}.before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(target + suffix)) renameSync(target + suffix, kept + suffix);
  copyFileSync(backup, target);
  return { restored: target, previous: existsSync(kept) ? kept : null };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter(arg => arg !== '--force');
  try { console.log(JSON.stringify(restore(args[0], args[1] ? resolve(args[1]) : undefined, { force: process.argv.includes('--force') }), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
