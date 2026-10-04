// When the composer asks for its context preview (decision D3). Pure, with
// injected timers: useContextPreview wraps it and tests/preview-scheduler.test.mjs
// drives it with mock timers.
//
// - Every input change takes a new ticket and restarts both timers.
// - After debounceMs, a selection preview (SQLite only). At most one is in
//   flight; a change meanwhile marks it dirty, and one request follows the reply.
// - After idleMs without a change, a full check (validates sources, stores
//   nothing). At most one is in flight. For the same ticket it wins over a
//   selection reply, whichever arrives last.
// - A reply is applied only while its ticket is the latest, so a late reply
//   never overwrites newer typing.
// - immediate (leave out, restore) asks for a selection preview now.
// - flush() runs the full check now and resolves with its result.
// - reset() (another project or workspace) drops every pending reply.
// - A request that has not answered after timeoutMs settles as an error, so a
//   stuck request never stops later previews or Inspect all.
export type PreviewKind = 'selection' | 'full';
export type PreviewOutcome<R> = { kind: PreviewKind; ticket: number; value: R; error?: undefined } | { kind: PreviewKind; ticket: number; error: string; value?: undefined };
export interface Timers { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(id: unknown): void }
export interface SchedulerOptions<I, S, F> {
  debounceMs: number; idleMs: number;
  timeoutMs?: number; timeoutMessage?: string;
  request(kind: PreviewKind, input: I): Promise<S | F>;
  onResult(outcome: PreviewOutcome<S | F>): void;
  timers?: Timers;
}
type Flight<R> = { ticket: number; promise: Promise<PreviewOutcome<R>> };

export class PreviewScheduler<I, S, F> {
  private ticket = 0; private input: I | undefined; private fullApplied = -1;
  private debounce: unknown = null; private idle: unknown = null;
  private flights: Record<PreviewKind, Flight<S | F> | null> = { selection: null, full: null };
  private dirty: Record<PreviewKind, boolean> = { selection: false, full: false };
  private readonly timers: Timers;
  constructor(private readonly options: SchedulerOptions<I, S, F>) {
    this.timers = options.timers ?? { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: id => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>) };
  }
  get latest() { return this.ticket; }

  update(input: I, { immediate = false } = {}) {
    this.ticket++; this.input = input;
    this.clear();
    if (immediate) this.send('selection');
    else this.debounce = this.timers.setTimeout(() => { this.debounce = null; this.send('selection'); }, this.options.debounceMs);
    this.idle = this.timers.setTimeout(() => { this.idle = null; this.send('full'); }, this.options.idleMs);
  }

  // The full check for the current input, now; null when there is no input (before the
  // first update, or after a reset or dispose).
  flush(): Promise<PreviewOutcome<S | F> | null> {
    if (this.idle !== null) { this.timers.clearTimeout(this.idle); this.idle = null; }
    const flight = this.flights.full;
    if (flight && flight.ticket === this.ticket) return flight.promise;
    if (flight) return flight.promise.then(() => this.flush());
    return this.send('full') ?? Promise.resolve(null);
  }

  reset() { this.ticket++; this.input = undefined; this.clear(); this.flights = { selection: null, full: null }; this.dirty = { selection: false, full: false }; }
  dispose() { this.reset(); }

  private clear() {
    if (this.debounce !== null) { this.timers.clearTimeout(this.debounce); this.debounce = null; }
    if (this.idle !== null) { this.timers.clearTimeout(this.idle); this.idle = null; }
  }

  private send(kind: PreviewKind): Promise<PreviewOutcome<S | F>> | null {
    if (this.input === undefined) return null;
    if (this.flights[kind]) { this.dirty[kind] = true; return null; }
    const ticket = this.ticket; const input = this.input;
    let timer: unknown = null;
    const answer = Promise.resolve().then(() => this.options.request(kind, input));
    const limit = new Promise<never>((_, reject) => { timer = this.timers.setTimeout(() => reject(new Error(this.options.timeoutMessage ?? 'timed out')), this.options.timeoutMs ?? 20000); });
    const promise = Promise.race([answer, limit]).finally(() => this.timers.clearTimeout(timer))
      .then(value => ({ kind, ticket, value }) as PreviewOutcome<S | F>, (error: unknown) => ({ kind, ticket, error: error instanceof Error ? error.message : String(error) }) as PreviewOutcome<S | F>)
      .then(outcome => { this.settle(flight, outcome); return outcome; });
    const flight: Flight<S | F> = { ticket, promise };
    this.flights[kind] = flight;
    return promise;
  }

  private settle(flight: Flight<S | F>, outcome: PreviewOutcome<S | F>) {
    const { kind, ticket } = outcome;
    if (this.flights[kind] !== flight) return; // reset meanwhile: dropped
    this.flights[kind] = null;
    const current = ticket === this.ticket;
    if (current && !(kind === 'selection' && this.fullApplied === ticket)) {
      // A failed full check does not hide a later selection reply for the same input.
      if (kind === 'full' && outcome.error === undefined) this.fullApplied = ticket;
      this.options.onResult(outcome);
    }
    // A change arrived while this was in flight: one request for the latest input.
    if (this.dirty[kind]) { this.dirty[kind] = false; if (!current) this.send(kind); }
  }
}

export const createPreviewScheduler = <I, S, F>(options: SchedulerOptions<I, S, F>) => new PreviewScheduler(options);
