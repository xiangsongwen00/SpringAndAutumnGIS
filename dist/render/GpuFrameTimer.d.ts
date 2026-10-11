/** Asynchronous scene GPU timing. Never calls finish/readPixels or waits. */
export declare class GpuFrameTimer {
    private readonly gl;
    private readonly extension;
    private readonly pending;
    private active;
    private sequence;
    valueMs: number | null;
    constructor(gl: WebGL2RenderingContext);
    begin(): void;
    end(): void;
    reset(): void;
}
//# sourceMappingURL=GpuFrameTimer.d.ts.map