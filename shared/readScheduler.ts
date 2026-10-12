/** Only in-flight GETs are shared. No response or credential is logged/persisted. */
export interface ReadMetric { event: string; accountId?: number; durationMs?: number; queueMs?: number; status?: number; attempt?: number }
type Job = { key: string; accountId: number; background: boolean; controller: AbortController; start: () => void };
type Flight<T> = { promise: Promise<T>; controller: AbortController; consumers: number };
export class ReadScheduler {
  private queue: Job[] = [];
  private active = 0;
  private background = 0;
  private accounts = new Map<number, number>();
  private flights = new Map<string, Flight<unknown>>();
  constructor(private metric: (value: ReadMetric) => void = () => {}, private limit = 6, private perAccount = 2, private timeoutMs = 30000) {}
  run<T>(key: string, accountId: number, task: (signal: AbortSignal) => Promise<T>, options: { signal?: AbortSignal; background?: boolean } = {}): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    let flight = this.flights.get(key) as Flight<T> | undefined;
    if (flight?.controller.signal.aborted) flight = undefined;
    if (flight) {
      this.metric({ event: 'read_merged', accountId });
      // Promote queued work when a foreground consumer needs it.
      if (!options.background) { const job = this.queue.find(job => job.key === key); if (job) job.background = false; this.drain(); }
    } else {
      const controller = new AbortController();
      const queuedAt = Date.now();
      let resolve!: (value: T) => void, reject!: (error: unknown) => void;
      const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
      flight = { promise, controller, consumers: 0 };
      this.flights.set(key, flight);
      const current = flight;
      const timer = setTimeout(() => controller.abort(new DOMException('Read deadline exceeded', 'TimeoutError')), this.timeoutMs);
      const job: Job = { key, accountId, background: !!options.background, controller, start: () => {
        const startedAt = Date.now();
        const isBackground = job.background;
        this.active++; if (isBackground) this.background++;
        this.accounts.set(accountId, (this.accounts.get(accountId) || 0) + 1);
        this.metric({ event: 'read_started', accountId, queueMs: startedAt - queuedAt });
        Promise.resolve().then(() => task(controller.signal)).then(resolve, reject).finally(() => {
          this.active--; if (isBackground) this.background--;
          const count = (this.accounts.get(accountId) || 1) - 1;
          if (count) this.accounts.set(accountId, count); else this.accounts.delete(accountId);
          this.metric({ event: 'read_finished', accountId, durationMs: Date.now() - startedAt });
          this.drain();
        });
      } };
      controller.signal.addEventListener('abort', () => {
        this.queue = this.queue.filter(item => item !== job);
        reject(controller.signal.reason);
        this.metric({ event: controller.signal.reason?.name === 'TimeoutError' ? 'read_timeout' : 'read_cancelled', accountId });
        this.drain();
      }, { once: true });
      // Do not evict a newer flight with the same key after cancellation.
      void promise.finally(() => { clearTimeout(timer); if (this.flights.get(key) === current) this.flights.delete(key); }).catch(() => {});
      this.queue.push(job); this.drain();
    }
    const current = flight;
    current.consumers++;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (error: unknown, value?: T, cancelled = false) => {
        if (settled) return; settled = true;
        options.signal?.removeEventListener('abort', cancel);
        current.consumers--;
        if (error) reject(error); else resolve(value as T);
        if (!current.consumers && cancelled && !current.controller.signal.aborted) current.controller.abort(error);
      };
      const cancel = () => finish(options.signal?.reason || new DOMException('Cancelled', 'AbortError'), undefined, true);
      options.signal?.addEventListener('abort', cancel, { once: true });
      current.promise.then(value => finish(null, value), error => finish(error));
    });
  }
  private drain() {
    while (this.active < this.limit) {
      this.queue.sort((a, b) => Number(a.background) - Number(b.background));
      const index = this.queue.findIndex(job => !job.controller.signal.aborted && (this.accounts.get(job.accountId) || 0) < this.perAccount && (!job.background || this.background < Math.min(2, this.limit)));
      if (index < 0) break;
      this.queue.splice(index, 1)[0].start();
    }
  }
}
