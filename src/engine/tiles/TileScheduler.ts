export type ScheduledTileRequest<T> = {
  key: string;
  priority?: number;
  load: () => Promise<T>;
};

type QueueItem<T> = Required<Pick<ScheduledTileRequest<T>, 'key' | 'load'>> & {
  priority: number;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

export class TileScheduler {
  private readonly _maxConcurrent: number;
  private _inflight = 0;
  private readonly _queuedKeys = new Set<string>();
  private readonly _queue: QueueItem<unknown>[] = [];

  constructor(maxConcurrent = 8) {
    this._maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
  }

  get queuedCount(): number {
    return this._queue.length;
  }

  get inflightCount(): number {
    return this._inflight;
  }

  schedule<T>(request: ScheduledTileRequest<T>): Promise<T> {
    if (this._queuedKeys.has(request.key)) {
      return Promise.reject(new Error(`Tile request already queued: ${request.key}`));
    }

    return new Promise<T>((resolve, reject) => {
      this._queuedKeys.add(request.key);
      this._queue.push({
        key: request.key,
        priority: request.priority ?? 0,
        load: request.load,
        resolve: resolve as (value: unknown) => void,
        reject
      });
      this.process();
    });
  }

  clear(): void {
    const pending = this._queue.splice(0);
    this._queuedKeys.clear();
    for (const item of pending) {
      item.reject(new Error('Tile request was cleared.'));
    }
  }

  private process(): void {
    while (this._inflight < this._maxConcurrent && this._queue.length > 0) {
      const index = this.pickBestIndex();
      const item = this._queue.splice(index, 1)[0];
      if (!item) return;

      this._queuedKeys.delete(item.key);
      this._inflight += 1;
      item
        .load()
        .then(item.resolve, item.reject)
        .finally(() => {
          this._inflight = Math.max(0, this._inflight - 1);
          this.process();
        });
    }
  }

  private pickBestIndex(): number {
    let bestIndex = 0;
    let bestPriority = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this._queue.length; i += 1) {
      const item = this._queue[i];
      if (!item) continue;
      if (item.priority < bestPriority) {
        bestPriority = item.priority;
        bestIndex = i;
      }
    }
    return bestIndex;
  }
}
