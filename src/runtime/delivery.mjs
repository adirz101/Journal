// One lane per launch. The database stores intent before PTY writes; after any possible
// write, an error means uncertain, never an invitation to replay text or send another Enter.
export class DeliveryManager {
  constructor({ store, terminals, log = () => {} }) { Object.assign(this, { store, terminals, log }); this.lanes = new Map(); this.closed = false; }
  deliver(message) {
    if (this.closed) return Promise.resolve();
    const key = message.target?.launchId; if (!key) return Promise.resolve({ held: 'NO_LAUNCH' });
    const previous = this.lanes.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.send(message));
    this.lanes.set(key, pending);
    void pending.finally(() => { if (this.lanes.get(key) === pending) this.lanes.delete(key); }).catch(() => {});
    return pending;
  }
  async send(message) {
    if (this.closed) return;
    const boundary = this.terminals.qualifyBoundary(message.target.sessionId, 'delivery');
    if (!boundary.eligible) { await this.store.holdMessage?.(message.id, boundary.reason); return { held: boundary.reason }; }
    const reserved = await this.store.reserveMessage(message.id, { runId: message.runId, recipient: message.recipient, ...boundary });
    const deliveryId = reserved.delivery.id; let wrote = false;
    const valid = async () => {
      const allowed = await this.store.deliveryAllowed(message.id, deliveryId);
      return allowed && !this.closed && this.terminals.validateBoundary(boundary).eligible;
    };
    try {
      if (!await valid()) return await this.store.recordMessageDelivery(message.id, { deliveryId, state: 'queued', noWrite: true });
      // No await between the final boundary check and the write. Human input takes
      // ownership synchronously; the subsequent check observes it before Enter.
      const frame = `[Journal message ${message.id}; delivery ${deliveryId}; ${message.kind}]\n${message.text}\nAcknowledge with the journal tools. Ignore message IDs you already handled.`;
      wrote = true; this.terminals.stageAutomatic(boundary, frame);
      await this.store.recordMessageDelivery(message.id, { deliveryId, state: 'staged' });
      if (!await valid()) throw new Error('Delivery boundary changed after text was staged');
      this.terminals.submitAutomatic(boundary);
      return await this.store.recordMessageDelivery(message.id, { deliveryId, state: 'submitted' });
    } catch (error) {
      if (wrote) this.terminals.uncertainInput(boundary.sessionId);
      try { await this.store.recordMessageDelivery(message.id, { deliveryId, state: wrote ? 'uncertain' : 'queued', noWrite: !wrote, reason: error.message }); }
      catch (persistError) { this.log(`delivery ${deliveryId}: ${persistError.message}`); }
      return { uncertain: wrote, reason: error.message };
    }
  }
  async dispatch() {
    for (const run of await this.store.activeRuns()) {
      await this.store.makeRunDigest(run.id);
      const current = await this.store.getRun(run.id);
      for (const message of current.messages.filter(item => ['queued', 'held'].includes(item.state))) {
        if (current.paused) { await this.store.holdMessage(message.id, 'RUN_PAUSED'); continue; }
        try { await this.deliver(message); } catch (error) { await this.store.holdMessage(message.id, error.code ?? 'DELIVERY_UNKNOWN'); }
      }
    }
  }
  async close() { this.closed = true; await Promise.allSettled([...this.lanes.values()]); }
}
