import { test } from 'node:test';
import assert from 'node:assert/strict';
const { SlotPool, admission, fairQueue } = await import('../src/runtime/capacity.mjs').catch(() => ({}));
const { parseVmStat, estimateFootprint, reclaimEligible } = await import('../src/runtime/resources.mjs').catch(() => ({}));

test('ordinary and worker launches reserve the same cap and a released lease cannot be reused', () => {
  const pool = new SlotPool(4); const leases = Array.from({ length: 4 }, (_, i) => pool.reserve(`session-${i}`));
  assert.ok(leases.every(Boolean)); assert.equal(pool.reserve('fifth'), null);
  assert.equal(new Set(leases.map(lease => lease.slot)).size, 4);
  pool.release(leases[1]); const replacement = pool.reserve('replacement');
  assert.equal(replacement.slot, 2);
  assert.throws(() => pool.consume(leases[1]), { code: 'RESERVATION_EXPIRED' });
  assert.equal(pool.consume(replacement), 2);
  const reduced = new SlotPool(2, () => [3, 4]); assert.equal(reduced.reserve('new'), null, 'lowering the cap never reuses empty low slots while higher occupied slots still consume capacity');
});
test('resource estimates include overhead and reclamation refuses each missing condition independently', () => {
  assert.equal(parseVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 10.\nPages inactive: 20.\nPages speculative: 5.'), 35 * 16384);
  assert.equal(parseVmStat('not a measurement'), null);
  assert.equal(estimateFootprint([{ provider: 'claude', mode: 'build', rssBytes: 1e9 }, { provider: 'claude', mode: 'build', rssBytes: 2e9 }], 'claude', 'build').source, 'measured');
  const conditions = { enabled: true, capacityOnly: true, settled: true, captured: true, inboxEmpty: true, noApproval: true, descendantsEnded: true, idleLongEnough: true, exactResume: true, safePressure: true };
  assert.equal(reclaimEligible(conditions), true);
  for (const key of Object.keys(conditions)) assert.equal(reclaimEligible({ ...conditions, [key]: false }), false, key);
});

test('admission explains static and measured resource gates without claiming unknown signals are measured', () => {
  assert.equal(admission({ live: 4, reserved: 0, cap: 4 }).reasons[0], 'GLOBAL_CAP');
  assert.equal(admission({ live: 2, reserved: 1, cap: 4 }).verdict, 'allow');
  assert.equal(admission({ live: 2, reserved: 0, cap: 4, paused: true }).reasons[0], 'RUN_PAUSED');
  assert.equal(admission({ live: 2, reserved: 0, cap: 4, adaptive: true, sample: { availableBytes: 2e9, totalBytes: 16e9, pressure: 'normal', freeDiskBytes: 8e9, load: 1, cores: 8 }, estimate: 1.2e9 }).reasons[0], 'MEMORY');
  assert.equal(admission({ live: 1, reserved: 0, cap: 4, adaptive: true, sample: { availableBytes: 12e9, totalBytes: 16e9, pressure: 'critical', freeDiskBytes: 8e9, load: 1, cores: 8 } }).reasons[0], 'MEMORY_PRESSURE');
  const unknown = admission({ live: 1, reserved: 0, cap: 4, adaptive: true, sample: {} });
  assert.equal(unknown.verdict, 'hold'); assert.ok(unknown.reasons.includes('RESOURCE_UNKNOWN'));
});

test('the durable queue takes turns across runs, then priority and age within a run', () => {
  const item = (id, runId, priority, queuedAt) => ({ id, runId, priority, admission: { queuedAt } });
  const queued = [item('a-low', 'a', 0, '01'), item('b-first', 'b', 0, '02'), item('a-high', 'a', 1, '03'), item('b-last', 'b', 0, '04')];
  assert.deepEqual(fairQueue(queued, 'a').map(row => row.id), ['b-first', 'a-high', 'b-last', 'a-low']);
});
