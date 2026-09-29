import {
  TileStateMachine,
  tileContentId,
  type TileContentKey
} from './TileStateMachine';

export type RequestTask<T> = (signal: AbortSignal) => Promise<T>;

export type RequestScheduleOptions<T> = Readonly<{
  priority?: number;
  origin?: string;
  byteSize?: number | ((value: T) => number);
  dispose?: (value: T) => void;
}>;

export type RequestLease<T> = Readonly<{
  key: TileContentKey;
  promise: Promise<T>;
  release: () => void;
}>;

export type RequestSchedulerOptions = Readonly<{
  maxConcurrent?: number;
  maxConcurrentPerOrigin?: number;
  maxCacheBytes?: number;
  stateMachine?: TileStateMachine;
}>;

export type RequestSchedulerStats = Readonly<{
  queued: number;
  active: number;
  cached: number;
  cacheBytes: number;
}>;

type ScheduledJob<T> = {
  key: TileContentKey;
  id: string;
  task: RequestTask<T>;
  options: RequestScheduleOptions<T>;
  priority: number;
  origin: string;
  controller: AbortController;
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  started: boolean;
};

type CachedValue<T> = {
  value: T;
  byteSize: number;
  dispose?: (value: T) => void;
};

/** Shared priority queue with request deduplication, cancellation and byte-budgeted LRU. */
export class RequestScheduler<T = unknown> {
  readonly stateMachine: TileStateMachine;
  private readonly maxConcurrent: number;
  private readonly maxConcurrentPerOrigin: number;
  private readonly maxCacheBytes: number;
  private readonly jobs = new Map<string, ScheduledJob<T>>();
  private readonly cache = new Map<string, CachedValue<T>>();
  private readonly activeByOrigin = new Map<string, number>();
  private active = 0;
  private accessFrame = 0;

  constructor(options: RequestSchedulerOptions = {}) {
    this.maxConcurrent = positiveInteger(options.maxConcurrent ?? 12, 'maxConcurrent');
    this.maxConcurrentPerOrigin = positiveInteger(
      options.maxConcurrentPerOrigin ?? 6,
      'maxConcurrentPerOrigin'
    );
    this.maxCacheBytes = nonNegative(options.maxCacheBytes ?? 192 * 1024 * 1024, 'maxCacheBytes');
    this.stateMachine = options.stateMachine ?? new TileStateMachine();
  }

  get stats(): RequestSchedulerStats {
    let cacheBytes = 0;
    for (const entry of this.cache.values()) cacheBytes += entry.byteSize;
    return {
      queued: [...this.jobs.values()].filter((job) => !job.started).length,
      active: this.active,
      cached: this.cache.size,
      cacheBytes
    };
  }

  schedule(
    key: TileContentKey,
    task: RequestTask<T>,
    options: RequestScheduleOptions<T> = {}
  ): RequestLease<T> {
    const id = tileContentId(key);
    this.accessFrame += 1;
    this.stateMachine.retain(key);
    this.stateMachine.touch(key, this.accessFrame);
    const cached = this.cache.get(id);
    if (cached) return this.lease(key, Promise.resolve(cached.value));

    const existing = this.jobs.get(id);
    if (existing) {
      existing.priority = Math.min(existing.priority, options.priority ?? 0);
      return this.lease(key, existing.promise);
    }

    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    // A released fire-and-forget lease must not cause an unhandled rejection.
    void promise.catch(() => undefined);
    const job: ScheduledJob<T> = {
      key: Object.freeze({ ...key }),
      id,
      task,
      options,
      priority: options.priority ?? 0,
      origin: options.origin ?? 'default',
      controller: new AbortController(),
      promise,
      resolve,
      reject,
      started: false
    };
    this.jobs.set(id, job);
    this.stateMachine.transition(key, 'queued', { priority: job.priority });
    this.pump();
    return this.lease(key, promise);
  }

  reprioritize(key: TileContentKey, priority: number): boolean {
    const job = this.jobs.get(tileContentId(key));
    if (!job || job.started) return false;
    job.priority = priority;
    this.stateMachine.ensure(key, { priority });
    this.pump();
    return true;
  }

  clear(force = false): void {
    for (const job of this.jobs.values()) {
      const record = this.stateMachine.get(job.key);
      if (!force && (record?.references ?? 0) > 0) continue;
      this.cancelJob(job, 'Scheduler cleared');
    }
    for (const [id, cached] of this.cache) {
      const record = this.stateMachine.values().find((candidate) => candidate.id === id);
      if (!force && (record?.references ?? 0) > 0) continue;
      cached.dispose?.(cached.value);
      this.cache.delete(id);
      if (record?.state === 'ready') this.stateMachine.transition(record.key, 'expired');
      if (record) this.stateMachine.remove(record.key, force);
    }
  }

  private lease(key: TileContentKey, promise: Promise<T>): RequestLease<T> {
    let released = false;
    return {
      key,
      promise,
      release: () => {
        if (released) return;
        released = true;
        const record = this.stateMachine.release(key);
        if ((record?.references ?? 0) > 0) return;
        const job = this.jobs.get(tileContentId(key));
        if (job) this.cancelJob(job, 'No consumers remain');
        this.evict();
      }
    };
  }

  private pump(): void {
    while (this.active < this.maxConcurrent) {
      let next: ScheduledJob<T> | undefined;
      for (const job of this.jobs.values()) {
        if (job.started) continue;
        if ((this.activeByOrigin.get(job.origin) ?? 0) >= this.maxConcurrentPerOrigin) continue;
        if (!next || job.priority < next.priority) next = job;
      }
      if (!next) return;
      this.start(next);
    }
  }

  private start(job: ScheduledJob<T>): void {
    job.started = true;
    this.active += 1;
    this.activeByOrigin.set(job.origin, (this.activeByOrigin.get(job.origin) ?? 0) + 1);
    this.stateMachine.transition(job.key, 'loading', { priority: job.priority });
    void job.task(job.controller.signal).then(
      (value) => this.complete(job, value),
      (error: unknown) => this.fail(job, error)
    );
  }

  private complete(job: ScheduledJob<T>, value: T): void {
    this.finishActive(job);
    if (this.jobs.get(job.id) !== job || job.controller.signal.aborted) {
      job.options.dispose?.(value);
      this.pump();
      return;
    }
    const configuredSize = job.options.byteSize;
    const byteSize = nonNegative(
      typeof configuredSize === 'function' ? configuredSize(value) : configuredSize ?? 0,
      'byteSize'
    );
    this.jobs.delete(job.id);
    this.cache.set(job.id, { value, byteSize, dispose: job.options.dispose });
    this.accessFrame += 1;
    this.stateMachine.transition(job.key, 'ready', {
      byteSize,
      lastAccessFrame: this.accessFrame
    });
    job.resolve(value);
    this.evict();
    this.pump();
  }

  private fail(job: ScheduledJob<T>, error: unknown): void {
    this.finishActive(job);
    if (this.jobs.get(job.id) !== job) {
      this.pump();
      return;
    }
    this.jobs.delete(job.id);
    const aborted = job.controller.signal.aborted;
    this.stateMachine.transition(job.key, aborted ? 'cancelled' : 'failed', {
      error: aborted ? null : sanitizeError(error)
    });
    job.reject(error);
    this.pump();
  }

  private cancelJob(job: ScheduledJob<T>, reason: string): void {
    if (this.jobs.get(job.id) !== job) return;
    this.jobs.delete(job.id);
    job.controller.abort(reason);
    const record = this.stateMachine.get(job.key);
    if (record && record.state !== 'cancelled') {
      this.stateMachine.transition(job.key, 'cancelled');
    }
    job.reject(createAbortError(reason));
    if (!job.started) this.pump();
  }

  private finishActive(job: ScheduledJob<T>): void {
    if (!job.started) return;
    job.started = false;
    this.active = Math.max(0, this.active - 1);
    const originActive = Math.max(0, (this.activeByOrigin.get(job.origin) ?? 1) - 1);
    if (originActive === 0) this.activeByOrigin.delete(job.origin);
    else this.activeByOrigin.set(job.origin, originActive);
  }

  private evict(): void {
    let bytes = this.stats.cacheBytes;
    if (bytes <= this.maxCacheBytes) return;
    const candidates = this.stateMachine.values()
      .filter((record) => record.state === 'ready' && record.references === 0 && this.cache.has(record.id))
      .sort((left, right) => left.lastAccessFrame - right.lastAccessFrame);
    for (const record of candidates) {
      if (bytes <= this.maxCacheBytes) break;
      const cached = this.cache.get(record.id);
      if (!cached) continue;
      cached.dispose?.(cached.value);
      this.cache.delete(record.id);
      bytes -= cached.byteSize;
      this.stateMachine.transition(record.key, 'expired');
      this.stateMachine.remove(record.key);
    }
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function nonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be non-negative.`);
  return value;
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? 'Request failed');
  return message.replace(/([?&](?:key|token|access_token)=)[^&\s]+/gi, '$1***');
}

function createAbortError(message: string): Error {
  if (typeof DOMException !== 'undefined') return new DOMException(message, 'AbortError');
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}
