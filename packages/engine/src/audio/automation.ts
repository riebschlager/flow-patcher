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

/** How far before a run's start a ParamAutomation keeps the points it scheduled, in seconds. A re-run starts
 *  at the clock or later, and the clock is never more than a lookahead (1.25 s while hidden) behind a run. */
export const AUTOMATION_MEMORY = 4;

/** A param that follows a modulated value on the automation grid (`paramAutomation`). */
export interface ParamAutomation {
  /** Follows `value(t)` on the grid in [t0, t1), replacing what was scheduled from t0 on. */
  follow(t0: number, t1: number, value: (t: number) => number): void;
}

/**
 * Follows a modulated value on `target` (ADR 0031): each `follow(t0, t1, value)`
 * withdraws what was scheduled from t0 on, then ramps linearly to each grid
 * point's value, ending there. Non-finite values are skipped: the ramp goes on
 * to the next point.
 *
 * It remembers the points it scheduled, so a re-run (a rewind or swap calling
 * it again for a stretch already covered) whose t0 falls inside a scheduled ramp
 * keeps that ramp whole: it cancels only after the ramp's end point, and the new
 * values start at the grid point after it. Cancelling at t0 would give the ramp
 * being played a new end, and the param would step by the change times the share
 * of the ramp already played (#103). So the first new ramp spans one grid step
 * (slopes stay bounded), the change shows 1/60 to 2/60 s after t0, and a render
 * already past t0 but not past the kept point sees no change. With an unchanged
 * value the kept point is the one the re-run would schedule, so a re-run leaves
 * the param's course as it was, and the course after forward runs depends only
 * on the grid points covered, not on window splits.
 */
export function paramAutomation(target: AudioParamLike, rate = AUTOMATION_RATE): ParamAutomation {
  // What is scheduled on target, in time order; times are distinct.
  let points: { time: number; value: number }[] = [];
  return {
    follow(t0, t1, value) {
      if (!Number.isFinite(t0)) return;
      let at = points.length;
      while (at > 0 && points[at - 1]!.time >= t0) at--;
      // The end of the ramp t0 falls in, if one is scheduled: kept, with what comes before it.
      const kept = points[at];
      if (kept) {
        at++;
        // Cancels only what follows it; nothing at all if nothing does.
        if (at < points.length) target.cancelScheduledValues(points[at]!.time);
      } else target.cancelScheduledValues(t0);
      points.length = at;
      const from = kept ? kept.time : -Infinity;
      for (const t of automationTimes(t0, t1, rate)) {
        if (!(t > from)) continue;
        const v = value(t);
        if (!Number.isFinite(v)) continue;
        target.linearRampToValueAtTime(v, t);
        points.push({ time: t, value: v });
      }
      // Forget points no re-run can reach, keeping the one a ramp after them starts from.
      let old = 0;
      while (old + 1 < points.length && points[old + 1]!.time < t0 - AUTOMATION_MEMORY) old++;
      if (old > 0) points = points.slice(old);
    },
  };
}

/** A param's knob edits made in place, one ramp after another (`editRamp`). */
export interface EditRamp {
  /** Ramps linearly to `value` over the ramp's duration, starting at audio-clock `time`. Times must not go
   *  backwards: one before the previous edit's is taken as that edit's time. */
  set(value: number, time: number): void;
  /** Where the edits put the param at `time`. */
  valueAt(time: number): number;
}

/**
 * Knob edits made in place on `target`, which holds `initial` (ADR 0031). Each
 * edit withdraws what was scheduled from its time on, holds the value the param
 * has then and ramps linearly to the new one over `duration`. An edit that lands
 * while the previous ramp is still running continues that ramp to the point it
 * has reached, then turns towards the new value, so a quick second edit never steps.
 */
export function editRamp(target: AudioParamLike, initial: number, duration = EDIT_RAMP): EditRamp {
  const span = Math.max(0, duration);
  let ramp = { from: initial, to: initial, start: -Infinity };
  const valueAt = (time: number): number => {
    if (!(time > ramp.start)) return ramp.from;
    if (!(time < ramp.start + span)) return ramp.to;
    return ramp.from + ((ramp.to - ramp.from) * (time - ramp.start)) / span;
  };
  return {
    valueAt,
    set(value, time) {
      if (!Number.isFinite(value) || !Number.isFinite(time)) return;
      time = Math.max(time, ramp.start);
      const from = valueAt(time);
      // Up to and including the previous ramp's end: the cancel below takes that end event too.
      const running = time > ramp.start && time <= ramp.start + span;
      target.cancelScheduledValues(time);
      // Mid-ramp: the cancel took the ramp's end, so ramp on to where it had got; else hold from here.
      if (running) target.linearRampToValueAtTime(from, time);
      else target.setValueAtTime(from, time);
      target.linearRampToValueAtTime(value, time + span);
      ramp = { from, to: value, start: time };
    },
  };
}
