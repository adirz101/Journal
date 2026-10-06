// The surviving runtime owns environment lifecycle. All sync/reconcile operations share
// a lane, including asynchronous StoreClient calls, so shutdown can drain before closing SQLite.
export class EnvironmentSync {
  constructor({ store, emit = () => {}, log = () => {} }) {
    this.store = store; this.emit = emit; this.log = log; this.pending = Promise.resolve(); this.closed = false;
  }
  enqueue(work) {
    if (this.closed) return this.pending;
    this.pending = this.pending.then(work).catch(error => this.log(`environment sync failed: ${error.message}`));
    return this.pending;
  }
  follow(session) {
    if (!session?.environmentId) return this.pending;
    const captured = { ...session };
    return this.enqueue(async () => {
      const environment = await this.store.syncEnvironment?.(captured);
      if (environment) this.emit({ type: 'environment', environment });
    });
  }
  reconcile() {
    return this.enqueue(async () => {
      const report = await this.store.reconcileEnvironments?.();
      if (report?.length) this.emit({ type: 'environment', reconciled: report.length });
    });
  }
  async close() { this.closed = true; await this.pending; }
}
