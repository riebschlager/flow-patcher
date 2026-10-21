import { LivePatch } from './live-graph';
import { OUTPUT_CEILING, outputLevel, readOutput } from './nodes/output';
import { Scheduler } from './scheduler';
import { stats } from './stats';

// One live patch and scheduler per page. They live outside React, and outside App.tsx so a hot
// reload of the UI doesn't start a second scheduler.
export const live = new LivePatch();
export const scheduler = new Scheduler(live);

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
