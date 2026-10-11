import { TileStateMachine, type TileContentKey } from './TileStateMachine';
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
/** Shared priority queue with request deduplication, cancellation and byte-budgeted LRU. */
export declare class RequestScheduler<T = unknown> {
    readonly stateMachine: TileStateMachine;
    private readonly maxConcurrent;
    private readonly maxConcurrentPerOrigin;
    private readonly maxCacheBytes;
    private readonly jobs;
    private readonly cache;
    private readonly activeByOrigin;
    private active;
    private accessFrame;
    constructor(options?: RequestSchedulerOptions);
    get stats(): RequestSchedulerStats;
    schedule(key: TileContentKey, task: RequestTask<T>, options?: RequestScheduleOptions<T>): RequestLease<T>;
    reprioritize(key: TileContentKey, priority: number): boolean;
    clear(force?: boolean): void;
    private lease;
    private pump;
    private start;
    private complete;
    private fail;
    private cancelJob;
    private finishActive;
    private evict;
}
//# sourceMappingURL=RequestScheduler.d.ts.map