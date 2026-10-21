import { getCtx } from './audio';
import type { LivePatch } from './live-graph';
import { recordStall, stats } from './stats';

const WAKE = 0.025; // seconds between wakes
const LOOKAHEAD = 0.12; // seconds queried ahead of now
const HIDDEN_LOOKAHEAD = 1.25; // background tabs wake about once a second
/** A wake up to this far past the horizon still queries the missed time and plays it late; only longer gaps are stalls that skip. */
const CATCH_UP = 0.1;

/** The missed stretch [from, to) while a late wake's run() is querying it, so sinks can play it late without bunching it. */
let catchingUp: { from: number; to: number } | null = null;

/**
 * Where a sink should play an event from a caught-up stretch: the whole stretch moves to start now, so its
 * events keep their spacing instead of all landing on currentTime at once. Null for any other event.
 */
export function caughtUpTime(t: number) {
  if (!catchingUp || t >= catchingUp.to) return null;
  stats.caughtUpEvents++;
  return getCtx().currentTime + (t - catchingUp.from);
}

/**
 * The one scheduler: every 25 ms it queries the patch for [horizon, now + lookahead).
 * Windows are contiguous, so each moment is queried exactly once. A wake that runs a little late
 * (by CATCH_UP or less) queries what it missed and those events play late, spaced as they were. After a longer stall the
 * missed windows are skipped, never burst.
 */
export class Scheduler {
  private horizon: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** performance.now() and currentTime at the last wake, to tell a blocked main thread from a jump in the audio clock. */
  private last: { wall: number; audio: number } | null = null;

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
    const wall = performance.now();
    const last = this.last;
    this.last = { wall, audio: now };
    if (this.horizon === null) this.horizon = now;
    const lateBy = now - this.horizon;
    if (lateBy > 0 && lateBy <= CATCH_UP) {
      stats.caughtUp++;
      stats.caughtUpMaxMs = Math.max(stats.caughtUpMaxMs, lateBy * 1000);
      catchingUp = { from: this.horizon, to: now };
    } else if (lateBy > 0) {
      const missed = Math.ceil((now - this.horizon) / WAKE);
      stats.skipped += missed;
      if (wall < stats.rewiringUntil) stats.rewireSkipped += missed;
      // A blocked main thread moves both clocks by the same long gap; an audio clock jump moves only currentTime.
      const gaps = last ? { wallMs: wall - last.wall, audioMs: (now - last.audio) * 1000 } : null;
      recordStall(missed, gaps);
      console.log(`[spike] stall: skipped ${missed} windows (${((now - this.horizon) * 1000).toFixed(0)} ms)${gaps ? `; since the last wake, wall clock ${gaps.wallMs.toFixed(0)} ms, audio clock ${gaps.audioMs.toFixed(0)} ms` : ''}`);
      this.horizon = now;
    }
    const t1 = now + (document.hidden ? HIDDEN_LOOKAHEAD : LOOKAHEAD);
    if (t1 <= this.horizon) return; // never while catching up: t1 is ahead of now
    try {
      this.patch.run(this.horizon, t1);
    } finally {
      catchingUp = null;
    }
    this.horizon = t1;
    stats.windows++;
  }
}
