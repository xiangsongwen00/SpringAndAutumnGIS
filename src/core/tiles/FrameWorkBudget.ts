/** Shared soft budget for indivisible background tasks within one browser RAF.
 * Every consumer uses the same RAF timestamp, independent of callback order.
 * One task may overrun; subsequent tasks then wait for the next frame.
 */
export class FrameWorkBudget {
  private frameTimestamp = -1;
  private usedMs = 0;
  constructor(readonly limitMs = 4) {}
  beginFrame(timestamp: number): void {
    if (timestamp === this.frameTimestamp) return;
    this.frameTimestamp = timestamp; this.usedMs = 0;
  }
  get canStart(): boolean { return this.usedMs < Math.max(.1, this.limitMs); }
  get spentMs(): number { return this.usedMs; }
  spend(milliseconds: number): void { this.usedMs += Math.max(0, milliseconds); }
}
