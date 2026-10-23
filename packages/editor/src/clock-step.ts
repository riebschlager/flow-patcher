// How far the audio clock jumps in one step, measured rather than taken from baseLatency
// (ADR 0028): Linux Chromium reports a 10 ms baseLatency while currentTime moves in ~2.9 ms
// steps. Once a frame, while the clock runs, currentTime is read in a tight loop for up to
// STEP_SLICE_MS; the first change seen is one step. The immediate offset covers the largest.

/** Longest busy read per animation frame, in ms (ADR 0016 allows ~4 ms of main-thread work). *(tune)* */
export const STEP_SLICE_MS = 1;
/** Steps seen before the measurement replaces the fallback and sampling stops. Until then the
 *  fallback holds, so the offset never shrinks and then grows back: macOS mixes 2.67 and 5.33 ms
 *  steps, and the first few can all be short. *(tune)* */
export const STEPS_SAMPLED = 32;

export class ClockStep {
  private largest = 0;
  private seen = 0;

  /**
   * @param read the audio clock (currentTime), in seconds
   * @param now a wall clock in ms (performance.now)
   * @param fallback the step to use until STEPS_SAMPLED have been seen (baseLatency)
   */
  constructor(
    private readonly read: () => number,
    private readonly now: () => number,
    private readonly fallback: () => number,
  ) {}

  /** True once the measurement is in use. It is final: sampling has stopped. */
  get known(): boolean {
    return this.seen >= STEPS_SAMPLED;
  }

  /** The largest step, in seconds: measured once known, the fallback before that. */
  value(): number {
    return this.known ? this.largest : this.fallback();
  }

  /** Called once a frame while the clock runs: reads it until it steps, for at most STEP_SLICE_MS. */
  sample(): void {
    if (this.known) return;
    const end = this.now() + STEP_SLICE_MS;
    const last = this.read();
    while (this.now() < end) {
      const time = this.read();
      if (time === last) continue;
      if (time > last) {
        this.largest = Math.max(this.largest, time - last);
        this.seen++;
      }
      return;
    }
  }
}
