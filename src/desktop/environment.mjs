import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve, sep as pathSep } from 'node:path';

// Apps opened from Finder get a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin),
// so CLIs installed by Homebrew, npm, the Claude/Cursor installers or a Node
// version manager would not be found. Journal appends the usual install
// folders that exist, after whatever PATH it already has (which wins). It never
// runs shell startup files to discover PATH.
const semverDesc = (a, b) => b.replace(/^v/, '').split('.').map(Number).reduce((r, n, i) => r || n - (Number(a.replace(/^v/, '').split('.')[i]) || 0), 0);

export function guiPathEntries({ platform = process.platform, home = homedir(), exists = existsSync, list = readdirSync } = {}) {
  if (platform !== 'darwin') return [];
  // nvm: the version its default alias names, else the newest installed.
  const nvmDefault = () => { try { const alias = readFileSync(join(home, '.nvm', 'alias', 'default'), 'utf8').trim().replace(/^v?/, 'v'); return exists(join(home, '.nvm', 'versions', 'node', alias, 'bin')) ? [join(home, '.nvm', 'versions', 'node', alias, 'bin')] : []; } catch { return []; } };
  const latest = (dir, suffix) => { try { const versions = list(dir).filter(name => /^v?\d+(\.\d+)*$/.test(name)).sort(semverDesc); return versions.length ? [join(dir, versions[0], suffix)] : []; } catch { return []; } };
  return [
    join(home, '.local', 'bin'), join(home, '.claude', 'local'),
    '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin',
    join(home, '.npm-global', 'bin'), join(home, '.bun', 'bin'), join(home, '.volta', 'bin'), join(home, 'Library', 'pnpm'),
    join(home, '.yarn', 'bin'), join(home, '.cargo', 'bin'), join(home, '.asdf', 'shims'), join(home, '.local', 'share', 'mise', 'shims'),
    join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
    ...nvmDefault(), ...latest(join(home, '.nvm', 'versions', 'node'), 'bin'),
  ].filter(dir => { try { return exists(dir); } catch { return false; } });
}

export function withGuiPath(env, options = {}) {
  const current = (env.PATH ?? '').split(delimiter).filter(Boolean);
  const added = guiPathEntries(options).filter(dir => !current.includes(dir));
  const unique = [...new Set(added)];
  return unique.length ? { ...env, PATH: [...current, ...unique].join(delimiter) } : env;
}

// Journal's data folder: per user, the same for the installed app, the portable
// build and development (appData/journal-desktop, for example
// ~/Library/Application Support/journal-desktop or %APPDATA%\journal-desktop),
// never next to the executable. JOURNAL_DATA_DIR overrides it (tests, smoke runs).
export const dataDirectory = (env, appData) => env.JOURNAL_DATA_DIR ? resolve(env.JOURNAL_DATA_DIR) : resolve(appData, 'journal-desktop');

// Files a separate Node-mode process executes must come from the unpacked copy
// when Journal runs from app.asar (only the first, still-packed occurrence changes).
export const unpackedPath = (path, sep = pathSep) => path.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
