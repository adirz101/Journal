import { randomUUID } from 'node:crypto';
import { estimateFootprint } from './resources.mjs';

// Slots are stable session identities, not a concurrency budget. Reserve before
// asynchronous work so simultaneous manual/coordinator/worker launches cannot collide.
export class SlotPool {
  constructor(occupied = () => []) { this.occupied = occupied; this.leases = new Map(); }
  free() { const used = new Set([...this.occupied(), ...[...this.leases.values()].map(lease => lease.slot)]); let slot = 1; while (used.has(slot)) slot++; return slot; }
  reserve(owner) { const slot = this.free(); const lease = Object.freeze({ id: randomUUID(), owner, slot }); this.leases.set(lease.id, lease); return lease; }
  validate(lease) { if (this.leases.get(lease?.id) !== lease) throw Object.assign(new Error('This launch reservation expired'), { code: 'RESERVATION_EXPIRED' }); return lease.slot; }
  consume(lease) { const slot = this.validate(lease); this.leases.delete(lease.id); return slot; }
  release(lease) { if (this.leases.get(lease?.id) === lease) this.leases.delete(lease.id); }
}

// Resource telemetry describes the machine; it does not grant or refuse launches.
// Legacy cap arguments are intentionally ignored, including on existing runs.
export function admission({ paused = false, adaptive = false, sample = {}, estimate = null, backoffUntil = 0, at = Date.now(), portsAvailable = true } = {}) {
  const reasons = [];
  if (paused) reasons.push('RUN_PAUSED');
  if (backoffUntil > at) reasons.push('BACKOFF');
  if (!portsAvailable) reasons.push('NO_PORTS');
  const unknown = adaptive ? ['availableBytes', 'totalBytes', 'freeDiskBytes', 'load'].filter(key => !Number.isFinite(sample[key])) : [];
  if (adaptive && !['normal', 'warning', 'critical'].includes(sample.pressure)) unknown.push('pressure');
  const warnings = [];
  if (adaptive && ['warning', 'critical'].includes(sample.pressure)) warnings.push('MEMORY_PRESSURE');
  if (unknown.length) warnings.push('RESOURCE_UNKNOWN');
  if (adaptive && Number.isFinite(estimate) && Number.isFinite(sample.availableBytes) && estimate > sample.availableBytes) warnings.push('MEMORY_ESTIMATE');
  return { verdict: reasons.length ? 'hold' : 'allow', reasons, warnings, estimate: adaptive && estimate != null ? { bytes: estimate, source: 'estimate' } : null, mode: 'on-demand', unknown };
}

export function fairQueue(attempts, lastRun = null) {
  const groups = new Map();
  for (const attempt of [...attempts].sort((a, b) => String(a.admission?.queuedAt ?? a.createdAt).localeCompare(String(b.admission?.queuedAt ?? b.createdAt)))) {
    if (!groups.has(attempt.runId)) groups.set(attempt.runId, []);
    groups.get(attempt.runId).push(attempt);
  }
  for (const group of groups.values()) group.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || String(a.admission?.queuedAt ?? a.createdAt).localeCompare(String(b.admission?.queuedAt ?? b.createdAt)));
  const runs = [...groups.keys()]; const start = runs.includes(lastRun) ? (runs.indexOf(lastRun) + 1) % runs.length : 0;
  const ordered = [...runs.slice(start), ...runs.slice(0, start)]; const result = [];
  while (ordered.some(id => groups.get(id).length)) for (const id of ordered) if (groups.get(id).length) result.push(groups.get(id).shift());
  return result;
}

export class CapacityManager {
  constructor({ store, terminals, launch, sample = async () => ({}), footprints = async () => [], adaptive = false, beforeDrain = async () => {}, clock = Date.now, log = () => {} }) {
    Object.assign(this, { store, terminals, launch, sample, footprints, adaptive, beforeDrain, clock, log });
    this.pending = Promise.resolve(); this.running = false; this.dirty = false; this.lastFootprintAt = -Infinity; this.lastRun = null; this.closed = false;
    this.initialized = false; this.lastSample = {}; this.history = [];
    // Older clients can read the same shape, but saved capacity.json limits are
    // no longer read or applied. The historical file is left intact.
    this.limits = { maxLiveSessions: null, maxActiveRuns: null };
  }
  reevaluate() {
    if (this.closed) return this.pending;
    this.dirty = true;
    if (this.running) return this.pending;
    this.running = true;
    this.pending = (async () => {
      // Status events during a drain request one fresh snapshot, not one queued
      // process-table scan per event. New work still gets its next turn promptly.
      try {
        while (this.dirty && !this.closed) {
          this.dirty = false;
          try { await this.tick(); } catch (error) { this.log(`admission failed: ${error.message}`); }
        }
      } finally { this.running = false; }
    })();
    return this.pending;
  }
  async readResources() {
    if (!this.adaptive) return {};
    try { this.lastSample = await this.sample() ?? {}; }
    catch { this.lastSample = { limitations: ['Resource measurements are unavailable. Launches remain available.'] }; }
    return this.lastSample;
  }
  async tick() {
    if (this.closed) return;
    if (!this.initialized) {
      this.history = await this.store.capacitySamples?.() ?? [];
      this.lastRun = this.history.filter(row => row.runId).at(-1)?.runId ?? null;
      this.initialized = true;
    }
    // Coordinators waiting from the previous tick get their turn before workers.
    await this.beforeDrain(() => !this.closed);
    if (this.closed) return;
    const requests = await this.store.queuedAttempts();
    const sample = await this.readResources();
    if (this.adaptive && this.clock() - this.lastFootprintAt >= 5000) {
      // Advisory history need not fork a process-table probe for every status.
      this.lastFootprintAt = this.clock();
      try {
        for (const footprint of await this.footprints(this.terminals.liveEntries())) { this.history.push(footprint); await this.store.recordCapacitySample?.(footprint); }
        this.history = this.history.slice(-300);
      } catch (error) { this.log(`resource measurements unavailable: ${error.message}`); }
    }
    // Drain only this finite snapshot, in run-round-robin order. Await each launch
    // to serialize worktree/PTY setup, without an artificial delay between starts.
    for (const queued of fairQueue(requests, this.lastRun)) {
      if (this.closed) return;
      const run = await this.store.getRun(queued.runId);
      const attempt = run.attempts.find(row => row.id === queued.id);
      if (!attempt || !['requested', 'queued'].includes(attempt.state) && attempt.admission?.phase !== 'resume_queued') continue;
      const estimate = estimateFootprint(this.history, attempt.provider, attempt.mode);
      const decision = admission({ paused: run.paused || run.state === 'finished', adaptive: this.adaptive, sample,
        estimate: estimate.bytes, backoffUntil: attempt.admission?.backoffUntil ?? 0, at: this.clock() });
      if (this.adaptive) decision.estimate = estimate;
      if (decision.verdict !== 'allow') { await this.store.queueAttempt(attempt.id, decision); continue; }
      if (this.closed) return;
      const lease = this.terminals.slots.reserve(attempt.id);
      const launchId = randomUUID(); this.lastRun = attempt.runId;
      try {
        await this.store.recordCapacitySample?.({ at: this.clock(), runId: attempt.runId });
        const admitted = await this.store.admitAttempt(attempt.id, { launchId, reservationId: lease.id, slot: lease.slot, admittedAt: new Date(this.clock()).toISOString() });
        await this.launch(admitted, lease);
      } catch (error) {
        await this.store.failAttemptLaunch(attempt.id, { launchId, code: error.code ?? 'LAUNCH_FAILED', message: error.message, noProcess: error.noProcess === true, at: this.clock() });
      } finally { this.terminals.slots.release(lease); }
    }
  }
  async view(runId) {
    const sample = await this.readResources();
    return { cap: null, limits: this.limits, live: this.terminals.liveEntries().length, reserved: this.terminals.slots.leases.size,
      mode: 'on-demand', sample, warnings: admission({ adaptive: this.adaptive, sample }).warnings, nextLaunchAt: 0,
      queued: (await this.store.queuedAttempts()).filter(row => !runId || row.runId === runId) };
  }
  setLimits() { throw Object.assign(new Error('Session limits have been removed. Update this window to use on-demand launches.'), { code: 'CAPACITY_LIMITS_REMOVED' }); }
  async coordinatorDecision(runId) {
    const run = await this.store.getRun(runId);
    return admission({ paused: run?.paused || run?.state === 'finished', adaptive: this.adaptive, sample: await this.readResources() });
  }
  async close() { this.closed = true; await this.pending; }
}
