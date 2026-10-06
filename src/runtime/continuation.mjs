import { randomBytes, randomUUID } from 'node:crypto';
import { refuse } from '../core/orchestration/model.mjs';

// A hook credential can request only this launch's pending addressed message. It is
// deliberately separate from both observation-file tokens and agent tool credentials.
export class ContinuationManager {
  constructor({ store, terminals, clock = Date.now }) { Object.assign(this, { store, terminals, clock }); this.grants = new Map(); this.pending = new Map(); }
  issue(binding) { const grant = { ...binding, id: randomUUID(), token: randomBytes(32).toString('hex'), disabled: false, turns: new Set(), count: 0 }; this.grants.set(grant.id, grant); return grant; }
  authenticate(id) { return this.grants.get(id) ?? null; }
  async request(id, input) {
    const grant = this.grants.get(id); if (!grant) refuse('UNAUTHORIZED', 'Unknown hook credential');
    if (this.pending.has(id)) return {}; // Parallel Stop hooks do not reserve two messages.
    const operation = this.deliver(grant, input); this.pending.set(id, operation);
    try { return await operation; } finally { this.pending.delete(id); }
  }
  async deliver(grant, input) {
    const deadline = this.clock() + 800;
    const entry = this.terminals.entry(grant.sessionId);
    if (!entry || entry.exited || entry.launchId !== grant.launchId) refuse('STALE_LAUNCH', 'This hook launch has ended');
    const adapter = this.terminals.adapter(entry.session.provider);
    const turnId = entry.lastStopInvocation?.id === input?.invocationId ? entry.lastStopInvocation.turnId : null;
    // No production adapter enables this until its exact provider/version/platform trial.
    if (grant.disabled || adapter?.continuation?.validated !== true || adapter.continuation.format !== 'claude-stop-block' || input?.event !== 'Stop' || turnId !== entry.currentTurn || !turnId || grant.turns.has(turnId) || grant.count >= 3) return {};
    const boundary = this.terminals.qualifyBoundary(grant.sessionId, 'delivery'); if (!boundary.eligible) return {};
    const run = await this.store.getRun(grant.runId); if (run.paused || run.state === 'finished') return {};
    const recipient = grant.role === 'coordinator' ? 'coordinator' : grant.attemptId;
    const message = run.messages.find(item => item.recipient === recipient && ['queued', 'held'].includes(item.state)); if (!message) return {};
    let reserved;
    try {
      reserved = await this.store.reserveMessage(message.id, { runId: run.id, recipient, ...boundary });
      if (this.clock() >= deadline || !await this.store.deliveryAllowed(message.id, reserved.delivery.id) || !this.terminals.validateBoundary(boundary).eligible) { await this.store.recordMessageDelivery(message.id, { deliveryId: reserved.delivery.id, state: 'queued', noWrite: true }); return {}; }
      const reason = `[Journal message ${message.id}; receipt ${reserved.delivery.id}]\n${message.text}\nDeduplicate this message ID and acknowledge receipt using Journal tools.`;
      const response = { decision: 'block', reason };
      grant.turns.add(turnId); grant.count++;
      // A response being returned is transport submission, never acknowledgment. A lost or
      // timed-out hook therefore becomes uncertain under the ordinary receipt deadline.
      await this.store.recordMessageDelivery(message.id, { deliveryId: reserved.delivery.id, state: 'submitted' });
      if (this.clock() >= deadline) { grant.disabled = true; await this.store.recordMessageDelivery(message.id, { deliveryId: reserved.delivery.id, state: 'uncertain', reason: 'Continuation response deadline expired' }); return {}; }
      return response;
    } catch (error) {
      grant.disabled = true;
      if (reserved) { try { await this.store.recordMessageDelivery(message.id, { deliveryId: reserved.delivery.id, state: 'uncertain', reason: 'Continuation transport is uncertain' }); } catch { /* retain the durable earlier phase for restart reconciliation */ } }
      return {};
    }
  }
}
