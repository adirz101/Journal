// Timing and disk cost of the prototype on two repositories: a local clone of this repository,
// and a synthetic one with many files. Prints a table; nothing is kept.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { EnvironmentManager } from '../src/environments.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=b', '-c', 'user.email=b@b', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).trim();
const ms = start => Number(process.hrtime.bigint() - start) / 1e6;
const time = fn => { const start = process.hrtime.bigint(); const value = fn(); return [value, ms(start)]; };
const du = path => Number(execFileSync('du', ['-sk', path], { encoding: 'utf8' }).split(/\s+/)[0]) * 1024;

async function bench(name, setup) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'jenv-bench-')));
  try {
    const repo = setup(root); git(repo, 'checkout', '-q', '-B', 'work');
    const files = Number(git(repo, 'ls-files').split('\n').length);
    const m = new EnvironmentManager({ dataRoot: join(root, 'data'), repos: { p: repo }, probe: async () => true });
    const createTimes = []; const envs = [];
    for (let i = 0; i < 3; i++) { const start = process.hrtime.bigint(); envs.push(await m.createEnvironment({ projectId: 'p', logicalBranch: 'work', task: `w${i}` })); createTimes.push(ms(start)); }
    const tracked = git(repo, 'ls-files').split('\n').filter(f => /\.(?:m?js|ts|tsx|md|txt)$/.test(f));
    envs.forEach((env, i) => { for (let k = 0; k < 20; k++) { const file = tracked[(i * 37 + k * 11) % tracked.length]; writeFileSync(join(env.details.path, file), `changed by ${i} ${k}\n`); } writeFileSync(join(env.details.path, `NEW-${i}.md`), 'new\n'); });
    const [, snapshot] = time(() => m.markCompleted(envs[0].id)); envs.slice(1).forEach(e => m.markCompleted(e.id));
    const [, snapshotAgain] = time(() => m.snapshotEnvironment(envs[0].id));
    const [preview, previewTime] = time(() => m.previewApply(envs[0].id));
    const [, applyTime] = time(() => m.applyEnvironment(envs[0].id));
    const [second, preview2] = time(() => m.previewApply(envs[1].id));
    const disk = du(envs[1].details.path); const repoDisk = du(join(repo, '.git'));
    const [, cleanup] = time(() => { m.markEnvironmentAbandoned(envs[2].id); return m.cleanupEnvironment(envs[2].id); });
    return { name, files, create: createTimes.map(t => t.toFixed(0)).join(' / '), snapshot: snapshot.toFixed(0), snapshotAgain: snapshotAgain.toFixed(0), preview: previewTime.toFixed(0), apply: applyTime.toFixed(0),
      preview2: `${preview2.toFixed(0)} (${second.clean ? 'clean' : `${second.conflicts.length} conflicts`})`, cleanup: cleanup.toFixed(0), envDiskMB: (disk / 1048576).toFixed(1), gitDirMB: (repoDisk / 1048576).toFixed(1), changed: preview.changes.length };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const rows = [];
rows.push(await bench('Journal repository (local clone)', root => { const repo = join(root, 'repo'); git(root, 'clone', '-q', '--no-hardlinks', resolve(import.meta.dirname, '../../..'), repo); return repo; }));
rows.push(await bench('Synthetic, 10,000 files', root => {
  const repo = join(root, 'repo'); mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main');
  for (let d = 0; d < 100; d++) { mkdirSync(join(repo, `dir${d}`)); for (let i = 0; i < 100; i++) writeFileSync(join(repo, `dir${d}`, `file${i}.txt`), `${d}-${i}\n`.repeat(20)); }
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init'); return repo;
}));
console.table(rows);
