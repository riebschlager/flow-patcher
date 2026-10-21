import { getCtx } from './audio';
import { LivePatch } from './live-graph';
import { OUTPUT_CEILING, outputLevel, readOutput } from './nodes/output';
import { Scheduler } from './scheduler';
import { recordLongFrame, stats } from './stats';

// One live patch and scheduler per page. They live outside React, and outside App.tsx so a hot
// reload of the UI doesn't start a second scheduler.
export const live = new LivePatch();
export const scheduler = new Scheduler(live);

let framing = false;

/**
 * The frame loop: each animation frame hands the visual nodes the audio-clock interval since the last one,
 * so events scheduled ahead land in the frame where their sound starts. The clock is shifted back by the
 * output latency, so that's when the sound is heard, not when it's rendered. Started with the first node, like the scheduler.
 */
export function startFrames() {
  if (framing) return;
  framing = true;
  let last: { audio: number; wall: number } | null = null;
  const tick = (wall: number) => {
    requestAnimationFrame(tick); // first, so a node that throws can't stop the loop
    const ctx = getCtx();
    stats.outputLatencyMs = (ctx.outputLatency || ctx.baseLatency) * 1000;
    const audio = ctx.currentTime - stats.outputLatencyMs / 1000;
    // dt as Flow's tick computes it; the solver clamps it again.
    const dt = last ? Math.min(0.033, (wall - last.wall) / 1000) || 0.016 : 0.016;
    const t0 = last?.audio ?? audio;
    last = { audio, wall };
    try {
      live.frame(t0, audio, dt);
    } catch (e) {
      console.error('[spike] frame', e);
    }
  };
  requestAnimationFrame(tick);
}

// The peak meter's poll. Its analysers hold ~0.7 s, so a 200 ms poll sees every sample (a hidden tab's 1 s throttle won't).
// Peaks are polled, so a guard hit counts 200 ms polls with clipping in the last ~0.7 s, not clipped samples.
setInterval(() => {
  const { peak, preGuard } = readOutput();
  stats.peak = peak;
  stats.peakMax = Math.max(stats.peakMax, peak);
  stats.preGuard = preGuard;
  stats.preGuardMax = Math.max(stats.preGuardMax, preGuard);
  if (preGuard > OUTPUT_CEILING) stats.guardHits++;
  if (peak > OUTPUT_CEILING) console.warn('[spike] peak above the ceiling', peak);
}, 200);

// What blocks the main thread: Chrome's long animation frames name the scripts that ran in them.
// Browsers without the API (Safari, Firefox) report 0 long frames.
type LongFrameScript = { duration: number; invoker?: string; sourceFunctionName?: string; sourceURL?: string };
try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as (PerformanceEntry & { scripts?: LongFrameScript[] })[]) {
      const top = entry.scripts?.length ? entry.scripts.reduce((a, b) => (b.duration > a.duration ? b : a)) : undefined;
      const where = top ? `${top.invoker ?? '?'} ${top.sourceFunctionName || ''} ${top.sourceURL?.split('/').pop()?.split('?')[0] ?? ''} ${top.duration.toFixed(0)} ms`.replace(/\s+/g, ' ').trim() : 'no attributed script';
      recordLongFrame(entry.duration, where);
      console.log(`[spike] long frame ${entry.duration.toFixed(0)} ms: ${where}`);
    }
  }).observe({ type: 'long-animation-frame', buffered: false });
} catch { /* not supported */ }

// Debug hooks for Playwright and the console: sound level and peak, gate counters, and the immediate path.
(window as unknown as { spike: unknown }).spike = {
  level: outputLevel,
  /** Sample peaks at the speakers and before the guard, now and the highest since load (or the last reset), against Flow's ceiling. */
  peak: () => ({
    now: stats.peak, max: stats.peakMax, ceiling: OUTPUT_CEILING,
    preGuard: stats.preGuard, preGuardMax: stats.preGuardMax, guardHits: stats.guardHits,
  }),
  resetPeak: () => { stats.peakMax = 0; stats.preGuardMax = 0; stats.guardHits = 0; },
  stats,
  push: (node: string, port: string, fields: Record<string, unknown> = {}) => live.push(node, port, fields),
};
