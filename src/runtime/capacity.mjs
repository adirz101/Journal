import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { estimateFootprint, reclaimEligible } from './resources.mjs';
import { descendants, sameIdentity } from '../core/process.mjs';

export class SlotPool {
  constructor(cap = 4, occupied = () => []) { this.cap = cap; this.occupied = occupied; this.leases = new Map(); }
  free() { const used = new Set([...this.occupied(), ...[...this.leases.values()].map(lease => lease.slot)]); if (used.size >= this.cap) return null; for (let slot = 1; slot <= this.cap; slot++) if (!used.has(slot)) return slot; return null; }
  reserve(owner) { const slot = this.free(); if (!slot) return null; const lease = Object.freeze({ id: randomUUID(), owner, slot }); this.leases.set(lease.id, lease); return lease; }
  validate(lease) { if (this.leases.get(lease?.id) !== lease) throw Object.assign(new Error('This launch reservation expired'), { code: 'RESERVATION_EXPIRED' }); return lease.slot; }
  consume(lease) { if (this.leases.get(lease?.id) !== lease) throw Object.assign(new Error('This launch reservation expired'), { code: 'RESERVATION_EXPIRED' }); this.leases.delete(lease.id); return lease.slot; }
  release(lease) { if (this.leases.get(lease?.id) === lease) this.leases.delete(lease.id); }
}

// Pure decisions keep estimates distinct from measurements. Unknown resource signals hold
// adaptive launches; ordinary manual launches continue to use the static cap.
export function admission({ live = 0, reserved = 0, cap = 4, runLive = 0, runCap = 3, paused = false, adaptive = false, sample = {}, estimate = 1.2e9, cooldownBytes = 0, backoffUntil = 0, at = Date.now(), portsAvailable = true }) {
  const reasons = [];
  if (paused) reasons.push('RUN_PAUSED');
  if (live + reserved >= cap) reasons.push('GLOBAL_CAP');
  if (runLive >= runCap) reasons.push('RUN_CAP');
  if (backoffUntil > at) reasons.push('BACKOFF');
  if (!portsAvailable) reasons.push('NO_PORTS');
  if (adaptive) {
    if (['warning', 'critical'].includes(sample.pressure)) reasons.push('MEMORY_PRESSURE');
    if (![sample.availableBytes, sample.totalBytes, sample.freeDiskBytes].every(Number.isFinite)) reasons.push('RESOURCE_UNKNOWN');
    else {
      if (sample.availableBytes - Math.max(2e9, sample.totalBytes * 0.15) - cooldownBytes < estimate) reasons.push('MEMORY');
      if (sample.freeDiskBytes < 5e9) reasons.push('DISK');
    }
    if (runLive > 0 && Number.isFinite(sample.load) && sample.cores > 0 && sample.load / sample.cores > 1.5) reasons.push('CPU');
  }
  return { verdict: reasons.length ? 'hold' : 'allow', reasons, estimate: adaptive ? { bytes: estimate, source: 'estimate' } : null, mode: adaptive ? 'adaptive' : 'static', unknown: adaptive ? ['pressure', 'load'].filter(key => sample[key] == null) : [] };
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
  constructor({ store, terminals, launch, dataDir = null, sample = async () => ({}), footprints = async () => [], adaptive = false, pacingMs = 10000, clock = Date.now, log = () => {} }) {
    Object.assign(this, { store, terminals, launch, sample, footprints, adaptive, pacingMs, clock, log });
    this.pending = Promise.resolve(); this.lastRun = null; this.nextLaunchAt = 0; this.closed = false;
    this.initialized = false; this.lastSample = {}; this.memoryHeld = new Set(); this.history = [];
    this.settingsFile = dataDir ? join(dataDir, 'capacity.json') : null; this.limits = { maxLiveSessions: 4, maxActiveRuns: 2 };
    if (this.settingsFile) { try { const saved = JSON.parse(readFileSync(this.settingsFile, 'utf8')); if (Number.isInteger(saved.maxLiveSessions) && saved.maxLiveSessions >= 1 && saved.maxLiveSessions <= 4 && Number.isInteger(saved.maxActiveRuns) && saved.maxActiveRuns >= 1 && saved.maxActiveRuns <= 4) this.limits = saved; } catch { /* safe defaults */ } }
    this.terminals.slots.cap = this.limits.maxLiveSessions;
  }
  reevaluate() {
    if (this.closed) return this.pending;
    this.pending = this.pending.then(() => this.tick()).catch(error => this.log(`admission failed: ${error.message}`));
    return this.pending;
  }
  async tick() {
    if (!this.initialized) {
      this.history = await this.store.capacitySamples?.() ?? [];
      const latest = this.history.filter(row => row.nextLaunchAt).at(-1);
      this.nextLaunchAt = latest?.nextLaunchAt ?? 0; this.lastRun = latest?.runId ?? null; this.initialized = true;
    }
    if (this.closed || this.clock() < this.nextLaunchAt) return;
    const requests = await this.store.queuedAttempts();
    const sample = this.adaptive ? await this.sample() : {};
    this.lastSample = sample;
    if (this.adaptive) {
      for (const footprint of await this.footprints(this.terminals.liveEntries())) { this.history.push(footprint); await this.store.recordCapacitySample?.(footprint); }
      this.history = this.history.slice(-300);
    }
    for (const attempt of fairQueue(requests, this.lastRun)) {
      const run = await this.store.getRun(attempt.runId);
      const estimate = estimateFootprint(this.history, attempt.provider, attempt.mode);
      const held = this.memoryHeld.has(attempt.id) || attempt.admission?.reasons?.includes('MEMORY');
      const cooldownBytes = this.history.filter(row => row.nextLaunchAt > this.clock()).reduce((sum, row) => sum + (row.estimateBytes ?? 0), 0);
      const decision = admission({ live: this.terminals.liveEntries().length, reserved: this.terminals.slots.leases.size, cap: this.terminals.slots.cap,
        runLive: run.attempts.filter(row => row.presence === 'live' || row.state === 'starting' || row.admission?.phase === 'resuming').length, runCap: run.policy.caps.maxConcurrentWorkers,
        paused: run.paused || run.state === 'finished', adaptive: this.adaptive, sample, estimate: estimate.bytes * (held ? 1.2 : 1), cooldownBytes, backoffUntil: attempt.admission?.backoffUntil ?? 0, at: this.clock() });
      if (this.adaptive) decision.estimate = estimate;
      if (decision.reasons.includes('MEMORY')) this.memoryHeld.add(attempt.id);
      if (decision.verdict !== 'allow') { await this.store.queueAttempt(attempt.id, decision); await this.reclaim(run, decision); continue; }
      this.memoryHeld.delete(attempt.id);
      const lease = this.terminals.slots.reserve(attempt.id); if (!lease) return;
      const launchId = randomUUID(); this.nextLaunchAt = this.clock() + this.pacingMs; this.lastRun = attempt.runId;
      try {
        const pacing = { at: this.clock(), nextLaunchAt: this.nextLaunchAt, runId: attempt.runId, estimateBytes: estimate.bytes };
        await this.store.recordCapacitySample?.(pacing); this.history.push(pacing);
        const admitted = await this.store.admitAttempt(attempt.id, { launchId, reservationId: lease.id, slot: lease.slot, admittedAt: new Date(this.clock()).toISOString() });
        await this.launch(admitted, lease);
      } catch (error) {
        await this.store.failAttemptLaunch(attempt.id, { launchId, code: error.code ?? 'LAUNCH_FAILED', message: error.message, noProcess: error.noProcess === true, at: this.clock() });
      } finally { this.terminals.slots.release(lease); }
      return; // At most one launch in a pacing window.
    }
  }
  async view(runId) { return { cap: this.terminals.slots.cap, limits: this.limits, live: this.terminals.liveEntries().length, reserved: this.terminals.slots.leases.size, mode: this.adaptive ? 'adaptive' : 'static', sample: this.lastSample, nextLaunchAt: this.nextLaunchAt, queued: (await this.store.queuedAttempts()).filter(row => !runId || row.runId === runId) }; }
  setLimits(patch) {
    const next = { ...this.limits, ...patch };
    if (!['maxLiveSessions', 'maxActiveRuns'].every(key => Number.isInteger(next[key]) && next[key] >= 1 && next[key] <= 4) || Object.keys(next).some(key => !['maxLiveSessions', 'maxActiveRuns'].includes(key))) throw Object.assign(new Error('Choose limits from one to four; higher limits require separate calibration'), { code: 'CALIBRATION_REQUIRED' });
    if (this.settingsFile) { writeFileSync(`${this.settingsFile}.tmp`, JSON.stringify(next), { mode: 0o600 }); renameSync(`${this.settingsFile}.tmp`, this.settingsFile); }
    this.limits = next; this.terminals.slots.cap = next.maxLiveSessions; void this.reevaluate(); return next;
  }
  async coordinatorDecision(runId) {
    const active = (await this.store.activeRuns()).filter(run => run.id !== runId && ['starting', 'active', 'idle', 'waiting_for_user'].includes(run.state));
    const sample = this.adaptive ? await this.sample() : {}; this.lastSample = sample;
    const decision = admission({ live: this.terminals.liveEntries().length, reserved: this.terminals.slots.leases.size, cap: this.terminals.slots.cap, adaptive: this.adaptive, sample });
    if (active.length >= this.limits.maxActiveRuns) { decision.verdict = 'hold'; decision.reasons.push('RUNS_CAP'); }
    return decision;
  }
  async reclaim(run, decision) {
    if (!run.policy.idleReclamation || run.paused) return;
    const capacityOnly = decision.reasons.length > 0 && decision.reasons.every(reason => ['GLOBAL_CAP', 'RUN_CAP', 'MEMORY', 'MEMORY_PRESSURE'].includes(reason));
    if (!capacityOnly || this.lastSample.pressure === 'critical') return;
    const table = await this.terminals.table();
    for (const attempt of run.attempts) {
      const entry = this.terminals.entry(attempt.currentSessionId); if (!entry || entry.exited) continue;
      const root = table?.find(row => row.pid === entry.session.pid);
      const conditions = { enabled: run.policy.idleReclamation, capacityOnly, settled: ['ready', 'integrated'].includes(attempt.state), captured: !!attempt.currentResultId,
        inboxEmpty: !run.messages.some(message => message.recipient === attempt.id && !['acknowledged', 'cancelled'].includes(message.state)),
        noApproval: !entry.session.pending && !run.approvals.some(approval => approval.attemptId === attempt.id && ['pending', 'approved'].includes(approval.state)),
        descendantsEnded: !!table && sameIdentity(root, entry.session.identity) && descendants(table, entry.session.pid).length === 0,
        idleLongEnough: entry.session.activity === 'idle' && this.clock() - (entry.activitySince ?? this.clock()) >= 20 * 60000 && entry.inputOwner === 'automation',
        exactResume: entry.session.nativeIdConfirmed === true && ['claude', 'codex', 'cursor'].includes(entry.session.provider), safePressure: this.lastSample.pressure === 'normal' };
      if (!reclaimEligible(conditions)) continue;
      // Persist intent before signalling, and recheck ownership immediately before Stop.
      await this.store.setAttemptState(attempt.id, attempt.state, { launchId: attempt.launchId, reclamation: { phase: 'stopping', at: this.clock(), sessionId: entry.session.id } });
      if (entry.session.activity !== 'idle' || entry.session.pending || entry.inputOwner !== 'automation') return;
      await this.terminals.stop(entry.session.id); return;
    }
  }
  async close() { this.closed = true; await this.pending; }
}
