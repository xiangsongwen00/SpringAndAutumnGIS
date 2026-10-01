type Task = { id: number; message: () => object; transfer: Transferable[];
  resolve: (value: unknown) => void; reject: (reason: unknown) => void;
  signal?: AbortSignal; abort: () => void; cancelled: boolean; queuedAt: number; startedAt: number };

/** One active message: queued payloads are not cloned until needed. Cancellation
 * removes queued work immediately; indivisible active worker work finishes off
 * the main thread and its stale result is discarded. No worker respawn storms.
 */
export class SerialWorkerClient {
  private worker: Worker | null = null;
  private active: Task | null = null;
  private readonly queue: Task[] = [];
  private nextId = 0;
  private disposed = false;
  private lastQueueMs = 0;
  private lastRoundTripMs = 0;
  private lastPostMs = 0;
  constructor(factory: () => Worker, readonly maxQueued = 32) {
    if (typeof Worker === 'undefined') return;
    try { this.worker = factory(); } catch { return; }
    this.worker.onmessage = ({ data }: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
      const task = this.active;
      if (!task || task.id !== data.id) return;
      this.active = null;
      this.lastRoundTripMs = performance.now() - task.startedAt;
      task.signal?.removeEventListener('abort', task.abort);
      if (!task.cancelled) {
        if (data.error) task.reject(new Error(data.error)); else task.resolve(data.result);
      }
      this.pump();
    };
    this.worker.onerror = (event) => this.fail(new Error(event.message || 'Worker failed'));
    this.worker.onmessageerror = () => this.fail(new Error('Worker response could not be decoded'));
  }
  get available(): boolean { return this.worker !== null && !this.disposed; }
  get pending(): number { return this.queue.length + (this.active ? 1 : 0); }
  get stats() { return { pending: this.pending, queueMs: this.lastQueueMs, roundTripMs: this.lastRoundTripMs, postMs: this.lastPostMs }; }
  request<T>(message: object | (() => object), signal?: AbortSignal, transfer: Transferable[] = []): Promise<T> {
    if (!this.available) return Promise.reject(new Error('Worker unavailable or disposed'));
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.pending >= this.maxQueued) return Promise.reject(new Error('Worker queue capacity exceeded'));
    return new Promise<T>((resolve, reject) => {
      const task: Task = { id: ++this.nextId, message: typeof message === 'function' ? message as () => object : () => message,
        transfer, resolve: value => resolve(value as T), reject, signal, cancelled: false,
        queuedAt: performance.now(), startedAt: 0, abort: () => {
          task.cancelled = true;
          const index = this.queue.indexOf(task);
          if (index >= 0) this.queue.splice(index, 1);
          signal?.removeEventListener('abort', task.abort);
          reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        } };
      signal?.addEventListener('abort', task.abort, { once: true });
      this.queue.push(task); this.pump();
    });
  }
  dispose(): void { this.disposed = true; this.fail(new Error('Worker client disposed')); }
  private pump(): void {
    if (this.active || !this.worker) return;
    const task = this.queue.shift(); if (!task) return;
    this.active = task;
    task.startedAt = performance.now(); this.lastQueueMs = task.startedAt - task.queuedAt;
    try {
      this.worker.postMessage({ ...task.message(), id: task.id }, task.transfer);
      this.lastPostMs = performance.now() - task.startedAt;
    }
    catch (error) {
      this.active = null; task.signal?.removeEventListener('abort', task.abort);
      task.reject(error); this.pump();
    }
  }
  private fail(error: Error): void {
    this.worker?.terminate(); this.worker = null;
    const tasks = this.active ? [this.active, ...this.queue] : [...this.queue];
    this.active = null; this.queue.length = 0;
    for (const task of tasks) { task.signal?.removeEventListener('abort', task.abort); if (!task.cancelled) task.reject(error); }
  }
}
