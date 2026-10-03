import { execFile } from 'node:child_process';

// Working-tree status for the file explorer: one `git status --porcelain=v2 -z`
// call per refresh. Untracked and ignored directories come back collapsed
// ("dir/"), so dependency and build folders are never walked.

export const MAX_STATUS_ENTRIES = 5000;
// Higher wins when a folder summarises its descendants.
export const STATUS_PRIORITY = { conflict: 5, deleted: 4, modified: 3, renamed: 3, typechange: 3, added: 2, untracked: 2, submodule: 1, ignored: 0 };

function kindOf(xy) {
  const [x, y] = xy;
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'A') return 'added';
  if (x === 'R' || x === 'C') return 'renamed';
  if (x === 'T' || y === 'T') return 'typechange';
  return 'modified';
}

// Parses NUL-separated porcelain v2 records. Paths are relative to the
// repository root, with forward slashes.
export function parseStatusV2(output, limit = MAX_STATUS_ENTRIES) {
  const records = output.split('\0'); const entries = []; let truncated = false; let branch = null; let head = null;
  for (let i = 0; i < records.length; i++) {
    const record = records[i]; if (!record) continue;
    if (record.startsWith('# ')) {
      if (record.startsWith('# branch.head ')) { const value = record.slice(14); branch = value === '(detached)' ? null : value; }
      if (record.startsWith('# branch.oid ')) { const value = record.slice(13); head = value === '(initial)' ? null : value; }
      continue;
    }
    if (entries.length >= limit) { truncated = true; if (record[0] === '2') i++; continue; }
    const type = record[0];
    if (type === '?' || type === '!') {
      const path = record.slice(2); const directory = path.endsWith('/');
      entries.push({ path: directory ? path.slice(0, -1) : path, kind: type === '?' ? 'untracked' : 'ignored', directory, staged: false, unstaged: type === '?' });
      continue;
    }
    // "1 XY sub mH mI mW hH hI path", "2 XY sub mH mI mW hH hI Xscore path\0orig", "u XY sub m1 m2 m3 mW h1 h2 h3 path"
    const fields = type === '1' ? 8 : type === '2' ? 9 : type === 'u' ? 10 : -1;
    if (fields < 0) continue;
    const parts = record.split(' '); const xy = parts[1] ?? '..'; const sub = parts[2] ?? 'N...';
    const path = parts.slice(fields).join(' ');
    const entry = { path, kind: type === 'u' ? 'conflict' : kindOf(xy), directory: false, staged: type !== 'u' && xy[0] !== '.', unstaged: type !== 'u' && xy[1] !== '.' };
    if (sub[0] === 'S') { entry.submodule = true; if (entry.kind === 'modified') entry.kind = 'submodule'; }
    if (type === '2') entry.from = records[++i] ?? null;
    entries.push(entry);
  }
  return { branch, head, entries, truncated };
}

// Limits a repository-wide status to one folder of it and makes paths relative to that folder.
export function scopeStatus(status, prefix) {
  if (!prefix) return status;
  const entries = [];
  for (const entry of status.entries) {
    if (entry.path === prefix.slice(0, -1) && entry.directory) { entries.push({ ...entry, path: '', directory: true }); continue; }
    if (!entry.path.startsWith(prefix)) continue;
    entries.push({ ...entry, path: entry.path.slice(prefix.length), ...(entry.from ? { from: entry.from.startsWith(prefix) ? entry.from.slice(prefix.length) : `../${entry.from}` } : {}) });
  }
  return { ...status, entries };
}

// Folder summaries: the highest-priority kind of any changed descendant.
// Deletions and ignored entries do not mark their parents, as in common editors.
export function folderDecorations(entries) {
  const folders = {};
  for (const entry of entries) {
    if (entry.kind === 'ignored' || entry.kind === 'deleted') continue;
    const parts = entry.path.split('/');
    for (let depth = parts.length - 1; depth >= 1; depth--) {
      const folder = parts.slice(0, depth).join('/');
      const current = folders[folder];
      if (!current || STATUS_PRIORITY[entry.kind] > STATUS_PRIORITY[current]) folders[folder] = entry.kind;
    }
    if (entry.path) {
      const current = folders['']; if (!current || STATUS_PRIORITY[entry.kind] > STATUS_PRIORITY[current]) folders[''] = entry.kind;
    }
  }
  return folders;
}

export function gitStatus(gitRoot, { prefix = '', signal, timeout = 8000 } = {}) {
  const args = ['-C', gitRoot, '--no-optional-locks', 'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=normal', '--ignored=matching', ...(prefix ? ['--', prefix] : [])];
  return new Promise((resolve, reject) => {
    execFile('git', args, { encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true, signal,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' } }, (error, stdout) => {
      if (error) { reject(error.name === 'AbortError' ? error : new Error('Git status is unavailable for this folder')); return; }
      const status = scopeStatus(parseStatusV2(stdout), prefix);
      resolve({ ...status, folders: folderDecorations(status.entries) });
    });
  });
}
