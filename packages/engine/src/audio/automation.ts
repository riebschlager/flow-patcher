// Helpers for audio nodes that follow modulated params (`AudioInstance.automate`)
// and take knob edits in place (`AudioInstance.update`), ADR 0031. Signals are
// sampled at about 60 Hz on an absolute grid and interpolated for audio
// (design.md, Core concepts), so what a param is given doesn't depend on how
// time was split into windows or chunks.
//
// Linear ramps, not setTargetAtTime: node-web-audio-api 2.2.0 (headless runs)
// evaluates a setTargetAtTime curve before its start time while it is the next
// event, so a param jumps to huge values until it starts (ADR 0031).
import type { AudioParamLike } from './types';

/** Points per second on the automation grid: Signals are sampled at t = k / AUTOMATION_RATE. */
export const AUTOMATION_RATE = 60;
/** How long a knob edit made in place ramps, in seconds. *(tune)* */
export const EDIT_RAMP = 0.02;

/**
 * The grid times k / rate in [t0, t1), in order. A point belongs to exactly
 * one of two adjacent intervals [a, b) and [b, c), so splitting an interval
 * splits its points and never adds or loses one.
 */
export function automationTimes(t0: number, t1: number, rate = AUTOMATION_RATE): number[] {
  if (!(t1 > t0) || !Number.isFinite(t0) || !Number.isFinite(t1) || !(rate > 0)) return [];
  // Start near ceil(t0 · rate) and settle by comparing k / rate itself, the value every caller compares.
  let k = Math.ceil(t0 * rate);
  while ((k - 1) / rate >= t0) k--;
  while (k / rate < t0) k++;
  const times: number[] = [];
  for (; k / rate < t1; k++) times.push(k / rate);
  return times;
}

/**
 * Follows `value(t)` on the grid in [t0, t1): withdraws what was scheduled on
 * `target` from t0 on, then a linear ramp to each grid point's value, ending
 * there. The timeline after a run of calls depends only on the grid points
 * covered, so calling it again for a stretch already covered (a rewind or
 * swap re-run) gives what one call would have. Non-finite values are skipped:
 * the ramp goes on to the next point.
 */
export function automateParam(target: AudioParamLike, t0: number, t1: number, value: (t: number) => number, rate = AUTOMATION_RATE): void {
  if (!Number.isFinite(t0)) return;
  target.cancelScheduledValues(t0);
  for (const t of automationTimes(t0, t1, rate)) {
    const v = value(t);
    if (Number.isFinite(v)) target.linearRampToValueAtTime(v, t);
  }
}

/**
 * A knob edit made in place: withdraws what was scheduled on `target` from
 * `time` on, holds `from` (the value it had) until `time` and ramps linearly to
 * `to` over `duration`. An earlier edit's ramp still running at `time` is cut
 * there, so keep edits on one param at least `duration` apart (swap times are
 * window boundaries, normally a wake interval apart).
 */
export function rampParam(target: AudioParamLike, from: number, to: number, time: number, duration = EDIT_RAMP): void {
  if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(time)) return;
  target.cancelScheduledValues(time);
  target.setValueAtTime(from, time);
  target.linearRampToValueAtTime(to, time + Math.max(0, duration));
}
