import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fixture } from './helpers.mjs';

// Prototype 7, Windows-only cases. They need a real Windows machine or runner; on macOS and Linux
// they are skipped (the portable equivalents are in cleanup.test.mjs). Not yet run: see README.
const windows = process.platform === 'win32';

test('Windows: environment paths stay short (MAX_PATH headroom) and inside the data root', { skip: !windows }, async t => {
  const f = fixture(t); const m = f.manager();
  const env = await m.createEnvironment({ projectId: 'p1', logicalBranch: 'feature/auth' });
  assert.ok(env.details.path.startsWith(join(f.data, 'env')));
  assert.ok(env.details.path.length - f.data.length <= 25, `${env.details.path.length - f.data.length} characters below the data root`);
});

test('Windows: a directory junction inside an environment is removed as a link; its target survives', { skip: !windows }, async t => {
  const f = fixture(t); const m = f.manager();
  const target = join(f.root, 'store'); mkdirSync(join(target, 'pkg'), { recursive: true }); writeFileSync(join(target, 'pkg', 'index.js'), 'keep\n');
  const env = await m.createEnvironment({ projectId: 'p1', logicalBranch: 'feature/auth' });
  mkdirSync(join(env.details.path, 'node_modules')); symlinkSync(join(target, 'pkg'), join(env.details.path, 'node_modules', 'pkg'), 'junction');
  m.markEnvironmentAbandoned(env.id);
  assert.equal(m.cleanupEnvironment(env.id).state, 'removed');
  assert.equal(readFileSync(join(target, 'pkg', 'index.js'), 'utf8'), 'keep\n');
});

test('Windows: a file held open by another process gives cleanup_pending, never a forced removal; the retry succeeds', { skip: !windows }, async t => {
  const f = fixture(t); const m = f.manager();
  const env = await m.createEnvironment({ projectId: 'p1', logicalBranch: 'feature/auth' });
  const file = join(env.details.path, 'held.txt'); writeFileSync(file, 'held\n');
  m.markEnvironmentAbandoned(env.id);
  // FileShare None: no other process may read, write or delete it while the handle is open.
  const holder = spawn('powershell.exe', ['-NoProfile', '-Command', `$f=[System.IO.File]::Open('${file.replace(/'/g, "''")}','Open','Read','None'); Write-Output ready; Start-Sleep -Seconds 60; $f.Close()`], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => holder.kill());
  await new Promise(resolve => holder.stdout.once('data', resolve));
  const pending = m.cleanupEnvironment(env.id);
  assert.equal(pending.state, 'cleanup_pending');
  assert.ok(existsSync(file), 'nothing was deleted');
  holder.kill(); await new Promise(r => holder.once('exit', r));
  assert.equal(m.cleanupEnvironment(env.id).state, 'removed');
});
