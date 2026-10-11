/** One active message: queued payloads are not cloned until needed. Cancellation
 * removes queued work immediately; indivisible active worker work finishes off
 * the main thread and its stale result is discarded. No worker respawn storms.
 */
export declare class SerialWorkerClient {
    readonly maxQueued: number;
    private worker;
    private active;
    private readonly queue;
    private nextId;
    private disposed;
    private lastQueueMs;
    private lastRoundTripMs;
    private lastPostMs;
    private priorityDispatches;
    constructor(factory: () => Worker, maxQueued?: number);
    get available(): boolean;
    get pending(): number;
    get stats(): {
        pending: number;
        queueMs: number;
        roundTripMs: number;
        postMs: number;
    };
    request<T>(message: object | (() => object), signal?: AbortSignal, transfer?: Transferable[], priority?: () => number): Promise<T>;
    dispose(): void;
    private pump;
    private fail;
}
//# sourceMappingURL=SerialWorkerClient.d.ts.map