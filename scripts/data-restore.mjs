// Restore Journal data from a backup made in the app (manual, local).
//   node scripts/data-restore.mjs <backup.sqlite> [data directory]
// Refuses while a runtime holds the data directory. The current database is
// kept beside the restored one; nothing is deleted.
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function defaultDataDir() {
  if (process.env.JOURNAL_DATA_DIR) return resolve(process.env.JOURNAL_DATA_DIR);
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'journal-desktop');
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'journal-desktop');
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'journal-desktop');
}

export function restore(backup, dataDir = defaultDataDir(), { alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } } } = {}) {
  backup = resolve(backup);
  if (!existsSync(backup)) throw new Error(`No backup at ${backup}`);
  const lock = join(dataDir, 'runtime.lock');
  if (existsSync(lock)) { const owner = JSON.parse(readFileSync(lock, 'utf8')); if (alive(owner.pid)) throw new Error('Quit Journal and stop its runtime (choose "Stop sessions and quit") before restoring'); }
  const check = new DatabaseSync(backup, { readOnly: true });
  try { const result = check.prepare('PRAGMA integrity_check').get().integrity_check; if (result !== 'ok') throw new Error(`Backup failed its integrity check: ${result}`); }
  finally { check.close(); }
  const target = join(dataDir, 'journal.sqlite'); const kept = `${target}.before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(target + suffix)) renameSync(target + suffix, kept + suffix);
  copyFileSync(backup, target);
  return { restored: target, previous: existsSync(kept) ? kept : null };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try { console.log(JSON.stringify(restore(process.argv[2], process.argv[3] ? resolve(process.argv[3]) : undefined), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
