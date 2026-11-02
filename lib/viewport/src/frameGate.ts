/**
 * Decides whether the viewport's animation loop draws a frame.
 *
 * Frames are drawn on demand: a tick renders only when a frame was requested
 * since the last one (the scene or camera changed, input arrived) or while
 * something holds continuous rendering. Redrawing an unchanged scene every
 * frame costs little on a GPU, but under software WebGL (headless browsers,
 * machines without GPU acceleration) it takes most of the CPU and starves the
 * kernel worker of the time it needs for rebuilds.
 */
export class FrameGate {
  // The first tick always draws.
  private requested = true;
  private holds = 0;

  /** Draw on the next tick. */
  request(): void {
    this.requested = true;
  }

  /**
   * Draw on every tick until the returned function is called. Holds stack;
   * releasing one requests a final frame so whatever the holder removed
   * disappears. Releasing twice is a no-op.
   */
  hold(): () => void {
    this.holds++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.holds--;
      this.request();
    };
  }

  /** True when this tick should draw. Consumes the pending request. */
  take(): boolean {
    if (!this.requested && this.holds === 0) return false;
    this.requested = false;
    return true;
  }
}
