import { describe, expect, it } from 'vitest';
import { transportBeat, type EngineEvent } from '@flow-patcher/engine';
import { clock } from '../src';
import { context, query, type ContextOptions } from './helpers';

/** One Clock instance: shared state across windows, params changeable per window (a new plan). */
function instance(options: ContextOptions = {}) {
  const state: Record<string, unknown> = {};
  let params = options.params ?? {};
  const read = () => context(clock, { ...options, params, state });
  return {
    state,
    set(next: Record<string, unknown>) {
      params = next;
    },
    query(t0: number, t1: number): EngineEvent[] {
      return query(clock, t0, t1, { ...options, params, state }).tick!;
    },
    /** Windows of `step` over [from, to). */
    tiled(from: number, to: number, step: number): EngineEvent[] {
      const out: EngineEvent[] = [];
      for (let t = from; t < to - 1e-9; t += step) out.push(...this.query(t, Math.min(to, t + step)));
      return out;
    },
    beat: (t: number) => clock.value!(read(), 'transport', t) as number,
    phase: (t: number, channel = 0) => clock.signal!(read(), 'phase', t, channel),
  };
}

type Clock = ReturnType<typeof instance>;

/** Runs [0, end) in windows of `step`, reading Phase and Transport inside each window after its query, as readers do. */
function run(make: () => Clock, end: number, step: number, plan: (t0: number, c: Clock) => void = () => {}) {
  const c = make();
  const ticks: EngineEvent[] = [];
  const phase: number[] = [], beat: number[] = [];
  const dt = 0.005;
  let next = 0;
  const count = Math.ceil(end / step - 1e-9);
  for (let i = 0; i < count; i++) {
    const t0 = i * step, t1 = Math.min(end, (i + 1) * step);
    plan(t0, c);
    ticks.push(...c.query(t0, t1));
    for (; next * dt < t1 - 1e-12; next++) {
      phase.push(c.phase(next * dt));
      beat.push(c.beat(next * dt));
    }
  }
  return { ticks, phase, beat, dt };
}

/** Phase only moves forward by a small amount, or wraps from near 1 to near 0. */
function expectContinuousPhase(phase: number[], maxStep: number) {
  for (let i = 1; i < phase.length; i++) {
    const d = phase[i]! - phase[i - 1]!;
    const forward = d >= -1e-9 ? d : d + 1;
    expect(forward).toBeGreaterThanOrEqual(-1e-9);
    expect(forward).toBeLessThanOrEqual(maxStep);
  }
}

/** Beats rise steadily and never by more than the fastest tempo allows. */
function expectSteadyBeats(beat: number[], maxStep: number) {
  for (let i = 1; i < beat.length; i++) {
    const d = beat[i]! - beat[i - 1]!;
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThanOrEqual(maxStep);
  }
}

/** Tick indices count 0, 1, 2, … with no repeats or gaps, and times rise. */
function expectConsecutive(ticks: EngineEvent[]) {
  expect(ticks.map((e) => e.index)).toEqual(ticks.map((_, i) => i));
  for (let i = 1; i < ticks.length; i++) expect(ticks[i]!.time).toBeGreaterThan(ticks[i - 1]!.time);
}

describe('clock', () => {
  it('ticks on the division grid, each carrying its step index', () => {
    const tick = instance({ params: { bpm: 120, division: '1/4' } }).query(0, 2);
    expect(tick.map((e) => e.time)).toEqual([0, 0.5, 1, 1.5]);
    expect(tick.map((e) => e.index)).toEqual([0, 1, 2, 3]);
    expect(tick.every((e) => e.channel === 0)).toBe(true);
  });

  it('uses half-open windows', () => {
    const c = instance({ params: { bpm: 120 } });
    expect(c.query(0, 0.5).map((e) => e.time)).toEqual([0]);
    expect(c.query(0.5, 1).map((e) => e.time)).toEqual([0.5]);
    expect(c.query(1, 1)).toEqual([]);
  });

  it('scales the tempo by Rate and the step by Division', () => {
    expect(instance({ params: { bpm: 120, rate: 2 } }).query(0, 1).map((e) => e.time)).toEqual([0, 0.25, 0.5, 0.75]);
    expect(instance({ params: { bpm: 120, rate: 0.5 } }).query(0, 2).map((e) => e.time)).toEqual([0, 1]);
    expect(instance({ params: { bpm: 60, division: '1/1' } }).query(0, 9).map((e) => e.time)).toEqual([0, 4, 8]);
    const triplets = instance({ params: { bpm: 60, division: '1/8T' } }).query(0, 1).map((e) => e.time);
    triplets.forEach((t, i) => expect(t).toBeCloseTo(i / 3, 12));
    expect(triplets).toHaveLength(3);
  });

  it('delays odd ticks by Swing, while Phase stays the even ramp', () => {
    // 1/8 at 120 bpm: 0.25 s steps; swing 0.5 moves odd ticks half a step late.
    const c = instance({ params: { bpm: 120, division: '1/8', swing: 0.5 } });
    const tick = c.query(0, 1);
    expect(tick.map((e) => e.time)).toEqual([0, 0.375, 0.5, 0.875]);
    expect(tick.map((e) => e.index)).toEqual([0, 1, 2, 3]);
    expect(c.phase(0.125)).toBeCloseTo(0.5, 12);
    expect(c.phase(0.375)).toBeCloseTo(0.5, 12);
    expect(c.beat(0.375)).toBeCloseTo(0.75, 12);
  });

  it('outputs the beat on Transport and the step ramp on Phase, on every channel', () => {
    const c = instance({ params: { bpm: 90, division: '1/8' } });
    c.query(0, 4);
    // 90 bpm: 1.5 beats per second; 1/8 steps are half a beat.
    expect(c.beat(2)).toBeCloseTo(3, 12);
    expect(c.beat(2.1)).toBeCloseTo(3.15, 12);
    expect(c.phase(2.1)).toBeCloseTo(0.3, 9);
    expect(c.phase(2.1, 3)).toBe(c.phase(2.1, 0));
  });

  it('gives identical ticks, Phase and Transport however time is split into windows', () => {
    const sets = [
      { bpm: 120, division: '1/16' },
      { bpm: 97.3, division: '1/8T', swing: 0.3 },
      { bpm: 300, division: '1/32', rate: 4 },
      { bpm: 20, division: '1/2', rate: 0.25, swing: 0.75 },
    ];
    for (const params of sets) {
      const whole = run(() => instance({ params }), 10, 10);
      for (const step of [0.025, 0.1, 0.0173]) {
        const tiled = run(() => instance({ params }), 10, step);
        expect(tiled.ticks).toEqual(whole.ticks);
        expect(tiled.phase).toEqual(whole.phase);
        expect(tiled.beat).toEqual(whole.beat);
      }
    }
  });

  describe('gate check Transport (Clock half)', () => {
    it('keeps Phase continuous and the beat count whole across a tempo change from a new plan', () => {
      // 120 bpm, then 90 bpm from the window at 1.125 s (beat 2.25), then rate 2 from 2.5 s.
      // Window sizes are exact in binary, so every windowing starts a window at both changes.
      const plan = (t0: number, c: Clock) => {
        if (t0 === 1.125) c.set({ bpm: 90, division: '1/4' });
        if (t0 === 2.5) c.set({ bpm: 90, rate: 2, division: '1/4' });
      };
      const r = run(() => instance({ params: { bpm: 120, division: '1/4' } }), 5, 1 / 64, plan);
      expectConsecutive(r.ticks);
      // At 1/4 a tick is a beat: each lands on a whole beat, with its index as the beat count.
      const c = instance({ params: { bpm: 120, division: '1/4' } });
      for (let i = 0; i < 5 * 64; i++) {
        plan(i / 64, c);
        for (const e of c.query(i / 64, (i + 1) / 64)) expect(c.beat(e.time)).toBeCloseTo(e.index as number, 9);
      }
      expect(r.ticks.slice(0, 3).map((e) => e.time)).toEqual([0, 0.5, 1]);
      // 2.25 beats at 1.125 s, then 1.5 beats/s: beat 3 at 1.125 + 0.75 / 1.5.
      expect(r.ticks[3]!.time).toBeCloseTo(1.625, 12);
      // Beat 2 at 120 bpm is 0.01 s per 0.005 s sample; the fastest here is 3 beats/s.
      expectSteadyBeats(r.beat, 3 * r.dt + 1e-9);
      expectContinuousPhase(r.phase, 3 * r.dt + 1e-9);
      // Coarser windows that also start at both changes agree.
      for (const step of [1 / 32, 0.125]) {
        const coarse = run(() => instance({ params: { bpm: 120, division: '1/4' } }), 5, step, plan);
        expect(coarse.ticks).toEqual(r.ticks);
        expect(coarse.phase).toEqual(r.phase);
        expect(coarse.beat).toEqual(r.beat);
      }
    });

    it('keeps Phase continuous across a division change mid-beat', () => {
      const c = instance({ params: { bpm: 120, division: '1/4' } });
      const before = c.query(0, 1.1);
      const phaseBefore = c.phase(1.1 - 1e-6);
      c.set({ bpm: 120, division: '1/16' });
      const after = c.query(1.1, 2);
      expect(c.phase(1.1)).toBeCloseTo(phaseBefore, 4);
      expectConsecutive([...before, ...after]);
      // At beat 2.2 the step is 0.2 through; the next 1/16 tick is 0.8 of a sixteenth (0.2 beats) later.
      expect(after.map((e) => e.time * 2)).toEqual([2.4, 2.65, 2.9, 3.15, 3.4, 3.65, 3.9].map((b) => expect.closeTo(b, 9)));
    });

    it('samples a modulated tempo at each tick, the same in any windowing', () => {
      // bpm 120 ± 80 from a slow wave on the Tempo param.
      const mods = { bpm: [{ depth: 80, signal: (t: number) => Math.sin(t * 1.3) }] };
      const make = () => instance({ params: { bpm: 120, division: '1/16' }, mods });
      const whole = run(make, 10, 10);
      expectConsecutive(whole.ticks);
      for (const step of [0.025, 0.1, 0.0173]) {
        const tiled = run(make, 10, step);
        expect(tiled.ticks).toEqual(whole.ticks);
        expect(tiled.phase).toEqual(whole.phase);
        expect(tiled.beat).toEqual(whole.beat);
      }
      // 200 bpm at most: 3.34 beats/s, 13.4 sixteenths/s.
      expectSteadyBeats(whole.beat, (200 / 60) * whole.dt + 1e-9);
      expectContinuousPhase(whole.phase, (200 / 60) * 4 * whole.dt + 1e-9);
      // The tempo changed: gaps between ticks vary.
      const gaps = whole.ticks.slice(1).map((e, i) => e.time - whole.ticks[i]!.time);
      expect(Math.max(...gaps) - Math.min(...gaps)).toBeGreaterThan(0.02);
    });

    it('does not re-anchor every window under modulation, only when the knobs change', () => {
      const mods = { bpm: [{ depth: 50, signal: (t: number) => Math.sin(t * 2) }] };
      const c = instance({ params: { bpm: 120, division: '1/4' }, mods });
      for (let i = 0; i < 120; i++) c.query(i * 0.025, (i + 1) * 0.025);
      const anchors = (c.state.transport as { anchors: unknown[] }).anchors.length;
      // One anchor per tick at most (6 quarter ticks in 3 s at up to 170 bpm is ~9), not one per window (120).
      expect(anchors).toBeLessThan(12);
    });
  });

  it('reads 0 before the first query, and a reader with no cable stays at beat 0', () => {
    const c = instance({ params: { bpm: 120 } });
    expect(c.beat(1)).toBe(0);
    expect(c.phase(1)).toBe(0);
    const unwired = context(clock);
    expect(transportBeat(unwired, 'transport', 3)).toBe(0);
    c.query(0, 2);
    const wired = context(clock, { values: { transport: (t) => c.beat(t) } });
    expect(transportBeat(wired, 'transport', 1.5)).toBeCloseTo(3, 12);
  });

  it('falls back to defaults or clamps on bad params and modulation', () => {
    expect(instance({ params: { bpm: NaN, division: 'nope', rate: NaN, swing: NaN } }).query(0, 1).map((e) => e.time)).toEqual([0, 0.5]);
    // Out of range: bpm 300 max, rate 4 max, swing clamped below 1.
    const fast = instance({ params: { bpm: 1e6, rate: 100, swing: 5, division: '1/4' } }).query(0, 0.1);
    expect(fast.map((e) => e.time)).toEqual([0, 0.0875]);
    const wild = { bpm: [{ depth: 1, signal: () => NaN }], rate: [{ depth: 1e9, signal: () => -1 }], swing: [{ depth: 1, signal: () => Infinity }] };
    const c = instance({ params: { bpm: 120 }, mods: wild });
    const tick = c.query(0, 2);
    expectConsecutive(tick);
    expect(Number.isFinite(c.beat(1))).toBe(true);
    expect(c.query(5, 4)).toEqual([]);
  });
});
