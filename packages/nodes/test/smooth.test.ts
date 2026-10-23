import { describe, expect, it } from 'vitest';
import type { NodeWiring, SignalSource } from '@flow-patcher/engine';
import { smooth, thresholdChange } from '../src';
import { blend, MAX_GRID_POINTS, SMOOTH_RATE, SMOOTH_RETAIN, SMOOTH_TIME_MAX } from '../src/smooth';
import { context, query, queryTiled } from './helpers';

interface Setup {
  params?: Record<string, unknown>;
  signals?: NodeWiring['signals'];
  mods?: NodeWiring['mods'];
}

/**
 * Runs Smooth over [0, end) in windows of `step`, as the runtime does: each window
 * queries it, then reads Out at the given times that fall inside the window.
 * Returns the reads, in order, per channel.
 */
function run({ params = {}, signals = {}, mods }: Setup, end: number, step: number, times: number[], channels = [0]): number[][] {
  const ctx = context(smooth, { params, signals, mods });
  const reads: number[][] = channels.map(() => []);
  const count = Math.ceil(end / step - 1e-9);
  for (let w = 0; w < count; w++) {
    const t0 = w * step, t1 = Math.min(end, (w + 1) * step);
    smooth.query!({ ...ctx, inputs: {}, pushed: {}, t0, t1 });
    for (const t of times) {
      if (t < t0 || t >= t1) continue;
      channels.forEach((c, i) => reads[i]!.push(smooth.signal!(ctx, 'out', t, c)));
    }
  }
  return reads;
}

const constant = (v: number): SignalSource => () => v;
/** 0 before 0.5 s, then 1. */
const stepUp: SignalSource = (t) => (t < 0.5 ? 0 : 1);
/** 1 before 0.5 s, then 0. */
const stepDown: SignalSource = (t) => (t < 0.5 ? 1 : 0);
/** 0 → 4 over 4 s. */
const ramp4: SignalSource = (t) => t;
const readTimes = Array.from({ length: 200 }, (_, i) => i * 0.01 + 0.0037);

describe('smooth', () => {
  it('eases toward a step with the time constant: 63% after one τ, 95% after three', () => {
    const [out] = run({ params: { rise: 0.1, fall: 0.1 }, signals: { in: [stepUp] } }, 1, 0.1, [0.4, 0.4979, 0.6, 0.8]);
    expect(out!.slice(0, 2)).toEqual([0, 0]);
    expect(out![2]).toBeCloseTo(1 - Math.exp(-1), 1);
    expect(out![3]).toBeCloseTo(1 - Math.exp(-3), 2);
  });

  it('is the continuous exponential from the grid step the jump lands in, between grid points too', () => {
    // The grid step ending at 0.5 s sees In at 1, so the ease starts one step (2 ms) before the jump.
    const onset = 0.5 - 1 / SMOOTH_RATE;
    const times = [0.5, 0.5137, 0.6, 0.6011, 0.73333];
    const [out] = run({ params: { rise: 0.05 }, signals: { in: [stepUp] } }, 1, 0.025, times);
    times.forEach((t, i) => expect(out![i]).toBeCloseTo(1 - Math.exp(-(t - onset) / 0.05), 9));
  });

  it('uses Rise going up and Fall going down', () => {
    const up = run({ params: { rise: 0.05, fall: 1 }, signals: { in: [stepUp] } }, 1, 0.1, [0.65])[0]![0]!;
    const down = run({ params: { rise: 0.05, fall: 1 }, signals: { in: [stepDown] } }, 1, 0.1, [0.65])[0]![0]!;
    expect(up).toBeCloseTo(1 - Math.exp(-0.152 / 0.05), 9);
    expect(down).toBeCloseTo(Math.exp(-0.152), 9);
  });

  it('follows In without lag at 0, and starts at In rather than easing up from 0', () => {
    const wave: SignalSource = (t) => Math.sin(7 * t) * 3;
    const [out] = run({ params: { rise: 0, fall: 0 }, signals: { in: [wave] } }, 2, 0.1, readTimes);
    readTimes.slice(0, out!.length).forEach((t, i) => expect(out![i]).toBe(wave(t, 0)));
    expect(run({ params: { rise: 5, fall: 5 }, signals: { in: [constant(0.7)] } }, 1, 0.1, [0, 0.5])[0]).toEqual([0.7, 0.7]);
    // Rise 0, Fall slow: an envelope follower that jumps up and decays.
    const [env] = run({ params: { rise: 0, fall: 0.5 }, signals: { in: [stepDown] } }, 1, 0.1, [0.25, 0.75]);
    expect(env![0]).toBe(1);
    expect(env![1]).toBeCloseTo(Math.exp(-0.252 / 0.5), 9);
  });

  it('keeps channels apart, and passes channels beyond Channels through', () => {
    // Channel c steps up at 0.2 + 0.2c; three watched channels, channel 5 unwatched.
    const staggered: SignalSource = (t, c) => (t < 0.2 + 0.2 * c ? 0 : 2);
    const [c0, c1, c2, c5] = run({ params: { rise: 0.1, channels: 3 }, signals: { in: [staggered] } }, 1, 0.1, [0.3, 0.5], [0, 1, 2, 5]);
    expect(c0![0]).toBeCloseTo(2 * (1 - Math.exp(-1.02)), 9);
    expect(c1![0]).toBe(0);
    expect(c1![1]).toBeCloseTo(2 * (1 - Math.exp(-1.02)), 9);
    expect(c2![1]).toBe(0);
    expect(c5).toEqual([0, 0]);
    expect(run({ signals: { in: [staggered] } }, 2, 0.1, [1.5], [5])[0]).toEqual([2]);
  });

  it('sums several cables into In', () => {
    expect(run({ signals: { in: [constant(0.25), constant(0.5)] } }, 1, 0.1, [0.5])[0]).toEqual([0.75]);
  });

  it('adds cables into Rise per channel', () => {
    // Rise 0.05 + 0.05c: channel 1 lags twice as long as channel 0.
    const [c0, c1] = run({ params: { rise: 0.05, channels: 2 }, signals: { in: [stepUp] }, mods: { rise: [{ depth: 0.05, signal: (_t, c) => c }] } }, 1, 0.1, [0.6], [0, 1]);
    expect(c0![0]).toBeCloseTo(1 - Math.exp(-0.102 / 0.05), 9);
    expect(c1![0]).toBeCloseTo(1 - Math.exp(-0.102 / 0.1), 9);
  });

  it('gives the same Out whatever the windowing, at 25 ms, 100 ms and in one call', () => {
    const wave: SignalSource = (t, c) => (Math.sin(2 * Math.PI * (1.3 + c) * t) > 0 ? 1 : -1) + 0.1 * Math.sin(17 * t);
    const setup = { params: { rise: 0.03, fall: 0.2, channels: 2 }, signals: { in: [wave] } };
    const whole = run(setup, 2, 2, readTimes, [0, 1]);
    expect(run(setup, 2, 0.025, readTimes, [0, 1])).toEqual(whole);
    expect(run(setup, 2, 0.1, readTimes, [0, 1])).toEqual(whole);
    expect(run(setup, 2, 0.0013, readTimes, [0, 1])).toEqual(whole);
    expect(whole[0]).not.toEqual(whole[1]);
  });

  it('gives a reader the same events whatever the windowing', () => {
    // A square wave smoothed per channel (rise 0.05 + 0.1c), read by Threshold at 0.7: channels cross at different times.
    const square: SignalSource = (t) => (Math.sin(2 * Math.PI * 1.3 * t) > 0 ? 1 : 0);
    const reader = (step: number) => {
      const ctx = context(smooth, { params: { rise: 0.05, fall: 0.2, channels: 2 }, signals: { in: [square] }, mods: { rise: [{ depth: 0.1, signal: (_t, c) => c }] } });
      const source: SignalSource = (t, channel) => smooth.signal!(ctx, 'out', t, channel);
      const tctx = context(thresholdChange, { params: { channels: 2, direction: 'both', level: 0.7 }, signals: { in: [source] } });
      const out: (number | unknown)[][] = [];
      const count = Math.ceil(4 / step - 1e-9);
      for (let w = 0; w < count; w++) {
        const t0 = w * step, t1 = Math.min(4, (w + 1) * step);
        smooth.query!({ ...ctx, inputs: {}, pushed: {}, t0, t1 });
        for (const e of thresholdChange.query!({ ...tctx, inputs: {}, pushed: {}, t0, t1 }).out ?? []) out.push([e.time, e.channel, e.value]);
      }
      return out;
    };
    const whole = reader(4);
    expect(whole.length).toBeGreaterThan(8);
    expect(new Set(whole.map((e) => e[1]))).toEqual(new Set([0, 1]));
    // Channel 1 lags more, so it crosses later.
    const firstOf = (c: number) => whole.find((e) => e[1] === c)![0] as number;
    expect(firstOf(1)).toBeGreaterThan(firstOf(0));
    expect(reader(0.025)).toEqual(whole);
    expect(reader(0.1)).toEqual(whole);
  });

  it('replays exactly from a snapshot, as a rewind does', () => {
    const wave: SignalSource = (t) => Math.sin(5 * t) + (t > 0.43 ? 0.5 : 0);
    const ctx = context(smooth, { params: { rise: 0.08, fall: 0.3 }, signals: { in: [wave] } });
    const window = (t0: number, t1: number) => smooth.query!({ ...ctx, inputs: {}, pushed: {}, t0, t1 });
    const read = () => [0.4, 0.43, 0.47, 0.499].map((t) => smooth.signal!(ctx, 'out', t, 0));
    for (let t = 0; t < 0.4; t += 0.1) window(t, t + 0.1);
    const snapshot = structuredClone(ctx.state);
    window(0.4, 0.5);
    const first = read();
    window(0.5, 0.6);
    // Restore and re-run the window, as the engine does when a live event lands inside it.
    for (const key of Object.keys(ctx.state)) delete ctx.state[key];
    Object.assign(ctx.state, structuredClone(snapshot));
    window(0.4, 0.5);
    expect(read()).toEqual(first);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it('replays exactly from a snapshot when the rewind splits the window differently', () => {
    const wave: SignalSource = (t) => Math.sin(5 * t) + (t > 0.43 ? 0.5 : 0) + (t > 0.47 ? -1 : 0);
    const ctx = context(smooth, { params: { rise: 0.08, fall: 0.3 }, signals: { in: [wave] } });
    const window = (t0: number, t1: number) => smooth.query!({ ...ctx, inputs: {}, pushed: {}, t0, t1 });
    const times = [0.2, 0.33, 0.4, 0.4237, 0.43, 0.4499, 0.47, 0.499];
    const read = () => times.map((t) => smooth.signal!(ctx, 'out', t, 0));
    for (let t = 0; t < 0.4; t += 0.1) window(t, t + 0.1);
    const snapshot = structuredClone(ctx.state);
    window(0.4, 0.5);
    const first = read();
    window(0.5, 0.6);
    // A live event at 0.45 s: restore the 0.4 s snapshot and re-run as two windows.
    for (const key of Object.keys(ctx.state)) delete ctx.state[key];
    Object.assign(ctx.state, structuredClone(snapshot));
    window(0.4, 0.45);
    window(0.45, 0.5);
    expect(read()).toEqual(first);
    // The reads aren't all one held value.
    expect(new Set(first).size).toBe(times.length);
  });

  it('reads behind the chunk from its history, inside it from the grid, and past it by finishing the step', () => {
    // In steps 0 → 1 at 0.3 s and 1 → 3 at 0.62 s; Rise 0.1. The ease starts one grid step before each jump.
    const twoSteps: SignalSource = (t) => (t < 0.3 ? 0 : t < 0.62 ? 1 : 3);
    const ctx = context(smooth, { params: { rise: 0.1 }, signals: { in: [twoSteps] } });
    for (let w = 0; w < 6; w++) smooth.query!({ ...ctx, inputs: {}, pushed: {}, t0: w / 10, t1: (w + 1) / 10 });
    const onset = 0.3 - 1 / SMOOTH_RATE;
    const eased = (t: number) => 1 - Math.exp(-(t - onset) / 0.1);
    const read = (t: number) => smooth.signal!(ctx, 'out', t, 0);
    // Behind the chunk [0.5, 0.6), as frame() reads: the smoothed value there, between grid points too.
    for (const t of [0.2, 0.3537, 0.4037, 0.4991]) expect(read(t), `t = ${t}`).toBeCloseTo(t < onset ? 0 : eased(t), 9);
    // Inside the chunk: the grid value plus the partial step.
    expect(read(0.5537)).toBeCloseTo(eased(0.5537), 9);
    // 50 ms past the chunk: one step of 52 ms from the last grid point (0.598 s) toward In there, 3.
    const lastGrid = eased(0.598);
    const ahead = lastGrid + (3 - lastGrid) * (1 - Math.exp(-0.052 / 0.1));
    expect(read(0.65)).toBeCloseTo(ahead, 9);
    expect(read(0.65)).not.toBe(3);
  });

  it('keeps reads behind the chunk smooth, not a staircase at the window rate', () => {
    // A slow glide read 1 s behind each 100 ms window, as a hidden tab's frame() does.
    const ramp: SignalSource = (t) => t;
    const setup = { params: { rise: 0.5, fall: 0.5 }, signals: { in: [ramp] } };
    const ctx = context(smooth, setup);
    const behind: number[] = [];
    for (let w = 0; w < 40; w++) {
      smooth.query!({ ...ctx, inputs: {}, pushed: {}, t0: w * 0.1, t1: (w + 1) * 0.1 });
      if (w >= 15) for (let i = 0; i < 10; i++) behind.push(smooth.signal!(ctx, 'out', w * 0.1 - 1 + i * 0.01 + 0.0037, 0));
    }
    // The same times read while their window is current.
    const times = Array.from({ length: 250 }, (_, i) => 0.5 + i * 0.01 + 0.0037);
    const [current] = run(setup, 4, 0.1, times);
    expect(behind).toHaveLength(250);
    behind.forEach((v, i) => expect(v, `t = ${times[i]}`).toBeCloseTo(current![i]!, 12));
  });

  it('keeps a bounded history in state: Retain plus one chunk', () => {
    const state = {};
    for (let t = 0; t < 10; t += 0.1) query(smooth, t, t + 0.1, { state, params: { channels: 8 }, signals: { in: [constant(1)] } });
    const track = (state as { track: Record<number, { k0: number; v: number[] }> }).track;
    expect(Object.keys(track)).toHaveLength(8);
    for (const row of Object.values(track)) {
      expect(row.v.length).toBeLessThanOrEqual((SMOOTH_RETAIN + 0.1) * SMOOTH_RATE + 2);
      expect(row.v.length).toBeGreaterThanOrEqual(SMOOTH_RETAIN * SMOOTH_RATE);
    }
    // Lowering Channels drops the others.
    query(smooth, 10, 10.1, { state, params: { channels: 2 }, signals: { in: [constant(1)] } });
    expect(Object.keys((state as { track: object }).track)).toEqual(['0', '1']);
  });

  it('holds the oldest kept value for reads behind the history', () => {
    const ctx = context(smooth, { params: { rise: 0.1 }, signals: { in: [ramp4] } });
    for (let w = 0; w < 50; w++) smooth.query!({ ...ctx, inputs: {}, pushed: {}, t0: w * 0.1, t1: (w + 1) * 0.1 });
    const track = ctx.state.track as Record<number, { k0: number; v: number[] }>;
    const oldest = track[0]!.v[0]!;
    expect(track[0]!.k0).toBe(4.9 * SMOOTH_RATE - SMOOTH_RETAIN * SMOOTH_RATE);
    expect(oldest).toBeGreaterThan(2);
    expect(smooth.signal!(ctx, 'out', 1, 0)).toBe(oldest);
    expect(smooth.signal!(ctx, 'out', -3, 0)).toBe(oldest);
  });

  it('starts again from In after a gap in the windows', () => {
    const ctx = context(smooth, { params: { rise: 1, fall: 1 }, signals: { in: [(t) => (t < 1 ? 0 : 5)] } });
    smooth.query!({ ...ctx, inputs: {}, pushed: {}, t0: 0, t1: 0.5 });
    smooth.query!({ ...ctx, inputs: {}, pushed: {}, t0: 2, t1: 2.1 });
    expect(smooth.signal!(ctx, 'out', 2.05, 0)).toBe(5);
    // A huge window is a gap too: it jumps to In at its last grid point.
    smooth.query!({ ...ctx, inputs: {}, pushed: {}, t0: 3, t1: 3 + (MAX_GRID_POINTS + 10) / SMOOTH_RATE });
    expect(smooth.signal!(ctx, 'out', 3 + (MAX_GRID_POINTS + 9.5) / SMOOTH_RATE, 0)).toBe(5);
  });

  it('carries over windows narrower than a grid step', () => {
    const setup = { params: { rise: 0.02 }, signals: { in: [stepUp] } };
    expect(run(setup, 1, 0.0007, [0.51, 0.53])).toEqual(run(setup, 1, 1, [0.51, 0.53]));
  });

  it('treats non-finite cables as 0, an unconnected In as 0, and odd times, windows or ports as defined values', () => {
    expect(run({ signals: { in: [constant(NaN)] } }, 1, 0.1, [0.5])[0]).toEqual([0]);
    expect(run({ signals: { in: [constant(Infinity), constant(2)] } }, 1, 0.1, [0.5])[0]).toEqual([2]);
    expect(run({}, 1, 0.1, [0.5])[0]).toEqual([0]);
    const ctx = context(smooth, { signals: { in: [constant(1)] } });
    expect(smooth.signal!(ctx, 'out', 0.5, 0)).toBe(1);
    for (const [t0, t1] of [[NaN, 1], [0, NaN], [1, 0], [0, Infinity], [-Infinity, 0], [2 ** 60, 2 ** 60 + 1]]) {
      expect(smooth.query!({ ...ctx, inputs: {}, pushed: {}, t0: t0!, t1: t1! })).toEqual({});
    }
    smooth.query!({ ...ctx, inputs: {}, pushed: {}, t0: -1, t1: -0.9 });
    expect(smooth.signal!(ctx, 'out', NaN, 0)).toBe(0);
    expect(smooth.signal!(ctx, 'out', Infinity, 0)).toBe(0);
    expect(smooth.signal!(ctx, 'nope', -0.95, 0)).toBe(0);
    // Reads before the history hold its first value; reads after finish the step from its last.
    expect(smooth.signal!(ctx, 'out', -5, 0)).toBe(1);
    expect(smooth.signal!(ctx, 'out', 3, 0)).toBe(1);
    expect(smooth.signal!(ctx, 'out', 0, -1)).toBe(1);
  });

  it('never overflows or returns a non-finite number on huge input', () => {
    const flip: SignalSource = (t) => (Math.floor(t * 10) % 2 ? 1e308 : -1e308);
    const [out] = run({ params: { rise: 0.01, fall: 0.01 }, signals: { in: [flip] } }, 1, 0.1, readTimes);
    for (const v of out!) expect(Number.isFinite(v)).toBe(true);
  });

  it('clamps out-of-range and mistyped params', () => {
    const at = (params: Record<string, unknown>) => run({ params, signals: { in: [stepUp] } }, 1, 0.1, [0.6])[0]![0]!;
    expect(at({ rise: -3 })).toBe(1);
    expect(at({ rise: 1e9 })).toBeCloseTo(at({ rise: SMOOTH_TIME_MAX }), 12);
    expect(at({ rise: NaN })).toBe(at({}));
    expect(at({ rise: 'fast' })).toBe(at({}));
    expect(run({ params: { channels: 99 }, signals: { in: [constant(1)] } }, 0.1, 0.1, [0.05], [7])[0]).toEqual([1]);
  });

  it('blend: 1 − e^(−dt/τ), 1 at τ ≤ 0 or NaN, 0 for no time', () => {
    expect(blend(0.1, 0.1)).toBeCloseTo(1 - Math.exp(-1), 12);
    expect(blend(1, 0)).toBe(1);
    expect(blend(1, NaN)).toBe(1);
    expect(blend(0, 1)).toBe(0);
    expect(blend(-1, 1)).toBe(0);
    expect(blend(1e300, 1e-300)).toBe(1);
  });

  it('emits no events', () => {
    expect(queryTiled(smooth, 'out', 1, 0.1, { signals: { in: [stepUp] } })).toEqual([]);
  });
});
