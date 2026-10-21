import { getCtx } from './audio';
import type { LivePatch } from './live-graph';
import { stats } from './stats';

const WAKE = 0.025; // seconds between wakes
const LOOKAHEAD = 0.12; // seconds queried ahead of now
const HIDDEN_LOOKAHEAD = 1.25; // background tabs wake about once a second

/**
 * The one scheduler: every 25 ms it queries the patch for [horizon, now + lookahead).
 * Windows are contiguous, so each moment is queried exactly once. After a stall the missed
 * windows are skipped, never burst.
 */
export class Scheduler {
  private horizon: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private patch: LivePatch) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.wake(), WAKE * 1000);
    // Query the long hidden-tab window as the tab hides, before the browser throttles the next wake.
    document.addEventListener('visibilitychange', () => this.wake());
  }

  private wake() {
    const ctx = getCtx();
    if (ctx.state !== 'running') {
      this.horizon = null; // a suspended clock isn't a stall; start fresh when it resumes
      return;
    }
    const now = ctx.currentTime;
    if (this.horizon === null) this.horizon = now;
    if (this.horizon < now) {
      const missed = Math.ceil((now - this.horizon) / WAKE);
      stats.skipped += missed;
      if (performance.now() < stats.rewiringUntil) stats.rewireSkipped += missed;
      console.log(`[spike] stall: skipped ${missed} windows (${((now - this.horizon) * 1000).toFixed(0)} ms)`);
      this.horizon = now;
    }
    const t1 = now + (document.hidden ? HIDDEN_LOOKAHEAD : LOOKAHEAD);
    if (t1 <= this.horizon) return;
    this.patch.run(this.horizon, t1);
    this.horizon = t1;
    stats.windows++;
  }
}
