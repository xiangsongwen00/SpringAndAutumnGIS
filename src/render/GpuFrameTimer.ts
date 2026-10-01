type TimerExtension = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };

/** Asynchronous scene GPU timing. Never calls finish/readPixels or waits. */
export class GpuFrameTimer {
  private readonly extension: TimerExtension | null;
  private readonly pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  private sequence = 0;
  valueMs: number | null = null;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.extension = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExtension | null;
  }

  begin(): void {
    const ext = this.extension;
    if (!ext || this.gl.isContextLost()) return;
    if (this.gl.getParameter(ext.GPU_DISJOINT_EXT)) { this.reset(); return; }
    while (this.pending.length && this.gl.getQueryParameter(this.pending[0]!, this.gl.QUERY_RESULT_AVAILABLE)) {
      const query = this.pending.shift()!;
      this.valueMs = this.gl.getQueryParameter(query, this.gl.QUERY_RESULT) / 1e6;
      this.gl.deleteQuery(query);
    }
    if (++this.sequence % 4 !== 0 || this.pending.length >= 4) return;
    this.active = this.gl.createQuery();
    if (this.active) this.gl.beginQuery(ext.TIME_ELAPSED_EXT, this.active);
  }

  end(): void {
    if (!this.active || !this.extension) return;
    this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
    this.pending.push(this.active); this.active = null;
  }

  reset(): void {
    if (this.active) { this.end(); }
    for (const query of this.pending) this.gl.deleteQuery(query);
    this.pending.length = 0; this.valueMs = null;
  }
}
