/** Shared soft budget for indivisible background tasks within one browser RAF.
 * Every consumer uses the same RAF timestamp, independent of callback order.
 * One task may overrun; subsequent tasks then wait for the next frame.
 */
export declare class FrameWorkBudget {
    readonly limitMs: number;
    private frameTimestamp;
    private usedMs;
    constructor(limitMs?: number);
    beginFrame(timestamp: number): void;
    get canStart(): boolean;
    get spentMs(): number;
    spend(milliseconds: number): void;
}
//# sourceMappingURL=FrameWorkBudget.d.ts.map