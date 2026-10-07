import { test } from 'node:test';
import assert from 'node:assert/strict';
const { SlotPool, admission, fairQueue, CapacityManager } = await import('../src/runtime/capacity.mjs').catch(() => ({}));
const { parseVmStat, estimateFootprint } = await import('../src/runtime/resources.mjs').catch(() => ({}));

test('launch reservations stay unique and a released lease cannot be reused', () => {
  const pool = new SlotPool(); const leases = Array.from({ length: 7 }, (_, i) => pool.reserve(`session-${i}`));
  assert.ok(leases.every(Boolean)); assert.equal(new Set(leases.map(lease => lease.slot)).size, 7);
  pool.release(leases[1]); const replacement = pool.reserve('replacement');
  assert.equal(replacement.slot, 2);
  assert.throws(() => pool.consume(leases[1]), { code: 'RESERVATION_EXPIRED' });
  assert.equal(pool.consume(replacement), 2);
});
test('resource estimates disclose measured samples separately from fallback estimates', () => {
  assert.equal(parseVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 10.\nPages inactive: 20.\nPages speculative: 5.'), 35 * 16384);
  assert.equal(parseVmStat('not a measurement'), null);
  assert.equal(estimateFootprint([{ provider: 'claude', mode: 'build', rssBytes: 1e9 }, { provider: 'claude', mode: 'build', rssBytes: 2e9 }], 'claude', 'build').source, 'measured');

});

test('resource warnings and legacy ceilings cannot prevent launch; pause ports and backoff still hold', () => {
  for (const sample of [{}, { pressure: 'warning' }, { pressure: 'critical', availableBytes: 1, freeDiskBytes: 1, load: 100, cores: 1 }]) {
    const decision = admission({ live: 8, runLive: 6, adaptive: true, sample });
    assert.equal(decision.verdict, 'allow');
    assert.deepEqual(decision.reasons, []);
    assert.ok(decision.warnings.length);
  }
  assert.deepEqual(admission({ live: 2, reserved: 1, cap: 3 }).reasons, []);
  assert.deepEqual(admission({ runLive: 2, runCap: 2 }).reasons, []);
  assert.deepEqual(admission({ paused: true, portsAvailable: false, backoffUntil: 200, at: 100 }).reasons, ['RUN_PAUSED', 'BACKOFF', 'NO_PORTS']);
});

function scheduler({ count = 6, sample = async () => ({ pressure: 'warning' }), afterLaunch = () => {} } = {}) {
  const attempts = Array.from({ length: count }, (_, i) => ({ id: String(i), runId: i % 2 ? 'b' : 'a', provider: 'claude', mode: 'build', state: 'queued', admission: { queuedAt: String(i) } }));
  const runs = ['a', 'b'].map(id => ({ id, state: 'active', paused: false, policy: { caps: { maxConcurrentWorkers: null }, idleReclamation: false }, attempts: attempts.filter(row => row.runId === id) }));
  const live = []; const launches = []; const samples = [];
  const terminals = { liveEntries: () => live, slots: new SlotPool(() => live.map(row => row.session.slot)) };
  const store = {
    queuedAttempts: async () => attempts.filter(row => row.state === 'queued'),
    getRun: async id => runs.find(run => run.id === id),
    activeRuns: async () => runs,
    capacitySamples: async () => [{ nextLaunchAt: Date.now() + 10000, runId: 'b' }],
    recordCapacitySample: async item => samples.push(item),
    queueAttempt: async (id, decision) => Object.assign(attempts.find(row => row.id === id), { admission: decision }),
    admitAttempt: async (id, intent) => Object.assign(attempts.find(row => row.id === id), { state: 'starting', ...intent }),
    failAttemptLaunch: async (id, failure) => Object.assign(attempts.find(row => row.id === id), { state: 'failed', failure }),
  };
  const manager = new CapacityManager({ store, terminals, sample, adaptive: true, launch: async (attempt, lease) => {
    assert.equal(terminals.slots.validate(lease), lease.slot);
    launches.push(attempt.id); live.push({ session: { slot: lease.slot } }); attempt.state = 'working'; attempt.presence = 'live';
    await afterLaunch(manager, runs, launches);
  } });
  return { manager, runs, live, launches, terminals, attempts, samples };
}

test('automatic admission drains more than four requests fairly without legacy pacing', async () => {
  const f = scheduler();
  await f.manager.reevaluate();
  assert.deepEqual(f.launches, ['0', '1', '2', '3', '4', '5']);
  assert.equal(f.terminals.slots.leases.size, 0);
  assert.equal(f.manager.limits.maxLiveSessions, null);
  assert.equal((await f.manager.coordinatorDecision('new')).verdict, 'allow');
  await f.manager.close();
});

test('a telemetry failure cannot prevent a coordinator or worker from launching', async () => {
  const f = scheduler({ count: 1, sample: async () => { throw new Error('probe unavailable'); } });
  assert.equal((await f.manager.coordinatorDecision('new')).verdict, 'allow');
  await f.manager.reevaluate();
  assert.equal(f.launches.length, 1);
  await f.manager.close();
});

test('the drain rechecks pause but ignores legacy worker caps and never reclaims idle sessions', async () => {
  const f = scheduler({ afterLaunch: (_manager, runs, launches) => {
    if (launches.length === 1) { runs[0].paused = true; runs[1].policy.caps.maxConcurrentWorkers = 1; runs[1].policy.idleReclamation = true; }
  } });
  await f.manager.reevaluate();
  assert.deepEqual(f.launches, ['0', '1', '3', '5']);
  assert.ok(f.attempts.some(row => row.admission.reasons?.includes('RUN_PAUSED')));
  assert.equal((await f.manager.coordinatorDecision('new')).verdict, 'allow');
  await f.manager.close();
});

test('closing during a launch prevents the remaining snapshot from starting', async () => {
  const f = scheduler({ afterLaunch: manager => { manager.closed = true; } });
  await f.manager.reevaluate(); assert.equal(f.launches.length, 1);
});

test('the durable queue takes turns across runs, then priority and age within a run', () => {
  const item = (id, runId, priority, queuedAt) => ({ id, runId, priority, admission: { queuedAt } });
  const queued = [item('a-low', 'a', 0, '01'), item('b-first', 'b', 0, '02'), item('a-high', 'a', 1, '03'), item('b-last', 'b', 0, '04')];
  assert.deepEqual(fairQueue(queued, 'a').map(row => row.id), ['b-first', 'a-high', 'b-last', 'a-low']);
});

test('a cancelled request is re-read before its turn and never starts from a stale queue snapshot', async () => {
  const f = scheduler({ afterLaunch: (_manager, runs, launches) => { if (launches.length === 1) runs[1].attempts[0].state = 'cancelled'; } });
  await f.manager.reevaluate();
  assert.deepEqual(f.launches, ['0', '2', '3', '4', '5']);
  assert.equal(f.terminals.slots.leases.size, 0);
  await f.manager.close();
});

test('a failed launch releases its reservation and does not strand other requested work', async () => {
  const f = scheduler({ count: 2 });
  const launch = f.manager.launch;
  f.manager.launch = async (attempt, lease) => {
    if (attempt.id === '0') throw Object.assign(new Error('No free ports'), { code: 'NO_PORTS', noProcess: true });
    return launch(attempt, lease);
  };
  await f.manager.reevaluate();
  assert.equal(f.attempts[0].failure.code, 'NO_PORTS');
  assert.equal(f.attempts[0].failure.noProcess, true);
  assert.deepEqual(f.launches, ['1']);
  assert.equal(f.terminals.slots.leases.size, 0);
  await f.manager.close();
});

test('status bursts coalesce while new requests drain and footprint probes stay bounded', async () => {
  let release; const blocked = new Promise(resolve => { release = resolve; });
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const f = scheduler({ count: 1, afterLaunch: async () => { entered(); await blocked; } });
  let ticks = 0; let probes = 0; let now = 100;
  f.manager.clock = () => now; f.manager.beforeDrain = async () => { ticks++; };
  f.manager.footprints = async () => { probes++; return []; };
  const first = f.manager.reevaluate(); await started;
  const next = { ...f.attempts[0], id: 'new', state: 'queued' };
  f.attempts.push(next); f.runs[0].attempts.push(next);
  const burst = Array.from({ length: 100 }, () => f.manager.reevaluate());
  release(); await Promise.all([first, ...burst]);
  assert.deepEqual(f.launches, ['0', 'new']); assert.equal(ticks, 2); assert.equal(probes, 1);
  now += 5000; await f.manager.reevaluate(); assert.equal(probes, 2);
  await f.manager.close();
});

test('close waits for the active launch and cancels a coalesced rerun', async () => {
  let release; const blocked = new Promise(resolve => { release = resolve; });
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const f = scheduler({ afterLaunch: async () => { entered(); await blocked; } });
  let ticks = 0; f.manager.beforeDrain = async () => { ticks++; };
  const pending = f.manager.reevaluate(); await started; void f.manager.reevaluate();
  let closed = false; const closing = f.manager.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  release(); await Promise.all([pending, closing]);
  assert.equal(closed, true); assert.equal(ticks, 1); assert.equal(f.launches.length, 1);
});
