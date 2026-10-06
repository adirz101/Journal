import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers.mjs';
import { allocateBlock, parseExcludedRanges } from '../src/ports.mjs';

// Prototype 6: ports, temp and log folders, variables, and processes per environment.
const WORKER = fileURLToPath(new URL('../fixtures/worker.mjs', import.meta.url));
const range = base => ({ start: base, end: base + 200, size: 10 });

test('port blocks: unique per environment, stable in the record, busy ports skipped, Windows exclusions parsed', async t => {
  const busy = net.createServer(); await new Promise(r => busy.listen({ port: 47205, host: '127.0.0.1' }, r)); t.after(() => busy.close());
  const f = fixture(t, { probe: undefined, range: range(47200) }); const m = f.manager();
  const a = await m.createEnvironment({ projectId: 'p1', logicalBranch: 'feature/auth' });
  const b = await m.createEnvironment({ projectId: 'p1', logicalBranch: 'feature/auth' });
  assert.equal(a.ports.includes(47205), false, 'the block with a busy port is skipped');
  assert.deepEqual([a.ports.length, b.ports.length], [10, 10]);
  assert.equal(a.ports.filter(p => b.ports.includes(p)).length, 0, 'no shared ports');
  assert.deepEqual(f.manager().getEnvironment(a.id).ports, a.ports, 'stable: read back from the record');
  const netsh = `\r\nProtocol tcp Port Exclusion Ranges\r\n\r\nStart Port    End Port\r\n----------    --------\r\n      5357        5357\r\n     49709       49808\r\n     50000       50059     *\r\n\r\n* - Administered port exclusions.\r\n`;
  assert.deepEqual(parseExcludedRanges(netsh), [[5357, 5357], [49709, 49808], [50000, 50059]]);
  const block = await allocateBlock([], { range: { start: 49700, end: 49900, size: 10 }, excluded: parseExcludedRanges(netsh), probe: async () => true });
  assert.equal(block.start, 49810, 'blocks overlapping an excluded range are skipped');
});

test('two fixture workers run at once: own ports, own folders, own temp; neither sees the other', async t => {
  const f = fixture(t, { probe: undefined, range: range(47600) }); const m = f.manager();
  const a = await m.createEnvironment({ projectId: 'p1', logicalBranch: 'feature/auth', sessionId: 'A' });
  const b = await m.createEnvironment({ projectId: 'p1', logicalBranch: 'feature/auth', sessionId: 'B' });
  const children = [a, b].map(env => m.spawnWorker(env.id, process.execPath, [WORKER]));
  t.after(() => { for (const child of children) try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch {} });
  const reports = await Promise.all([a, b].map(env => waitFor(() => { try { const line = readFileSync(join(env.details.logDir, 'worker.log'), 'utf8').trim().split('\n')[0]; return line ? JSON.parse(line) : null; } catch { return null; } })));
  assert.deepEqual(reports.map(r => r.error ?? null), [null, null], 'both bound their first port');
  assert.deepEqual(reports.map(r => r.port), [a.ports[0], b.ports[0]]);
  assert.notEqual(reports[0].port, reports[1].port);
  assert.deepEqual(reports.map(r => [r.base, r.branch]), [[a.base, 'feature/auth'], [b.base, 'feature/auth']]);
  assert.deepEqual(reports.map(r => r.cwd), [a.details.path, b.details.path].map(p => require_real(p)));
  assert.ok(existsSync(join(a.details.path, `worker-${a.id}.txt`)) && !existsSync(join(a.details.path, `worker-${b.id}.txt`)));
  assert.ok(existsSync(join(b.details.path, `worker-${b.id}.txt`)) && !existsSync(join(b.details.path, `worker-${a.id}.txt`)));
  assert.match(readFileSync(join(a.details.tmpDir, 'scratch.txt'), 'utf8'), new RegExp(a.id)); assert.match(readFileSync(join(b.details.tmpDir, 'scratch.txt'), 'utf8'), new RegExp(b.id));
  // Each answers on its own port with its own identity.
  assert.deepEqual(await Promise.all([a, b].map(env => ask(env.ports[0]))), [a.id, b.id]);
  // The record knows which process belongs to which environment; stopping one never touches the other.
  assert.deepEqual([m.record(a.id).processes[0].pid, m.record(b.id).processes[0].pid], children.map(c => c.pid));
  process.kill(process.platform === 'win32' ? children[0].pid : -children[0].pid, 'SIGKILL');
  await new Promise(r => children[0].once('exit', r));
  assert.equal(await ask(b.ports[0]), b.id, 'worker B still runs');
  assert.deepEqual(m.reconcile().map(r => r.slice(1)), [['running', 'ready']], 'reconcile notices only A is gone');
  assert.equal(m.getEnvironment(b.id).state, 'running');
  const vars = m.environmentVariables(a.id);
  assert.deepEqual(Object.keys(vars).sort(), ['JOURNAL_ENV_BASE', 'JOURNAL_ENV_ID', 'JOURNAL_ENV_LOG_DIR', 'JOURNAL_LOGICAL_BRANCH', 'JOURNAL_PORT', 'JOURNAL_PORTS', 'JOURNAL_PORT_COUNT', 'TEMP', 'TMP', 'TMPDIR']);
});

function require_real(path) { return require_realpath(path); }
import { realpathSync } from 'node:fs';
const require_realpath = path => realpathSync(path);
async function waitFor(check, timeout = 10000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = check(); if (value) return value; await new Promise(r => setTimeout(r, 50)); } throw new Error('timed out'); }
function ask(port) { return new Promise((resolve, reject) => { const socket = net.connect({ port, host: '127.0.0.1' }); let data = ''; socket.on('data', d => { data += d; }); socket.on('end', () => resolve(data.trim())); socket.on('error', reject); }); }
