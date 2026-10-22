import { describe, expect, it } from 'vitest';
import { compareEvents, type EngineEvent } from '@flow-patcher/engine';
import { clock, euclidean } from '../src';
import { ACCENT, euclideanAt, euclideanPattern, rotatePattern, SOFT } from '../src/euclidean';
import { query, queryTiled, ticks } from './helpers';

const hitSteps = (pattern: number[]) => pattern.flatMap((v, i) => (v > 0 ? [i] : []));

describe('euclideanPattern and rotatePattern (from Flow checks/rhythm.test.mjs)', () => {
  it('has 16 steps, exactly `hits` hits, velocities in 0–1, and rotating by 16 is a no-op', () => {
    for (let hits = 0; hits <= 16; hits++) {
      for (let rotation = 0; rotation < 16; rotation++) {
        const pattern = euclideanPattern(hits, 16, rotation);
        expect(pattern).toHaveLength(16);
        expect(pattern.filter(Boolean)).toHaveLength(hits);
        expect(pattern.every((v) => v >= 0 && v <= 1)).toBe(true);
        expect(rotatePattern(pattern, 16)).toEqual(pattern);
      }
    }
  });

  it('holds the same for every step count', () => {
    for (let steps = 1; steps <= 32; steps++) {
      for (let hits = 0; hits <= steps; hits++) {
        const pattern = euclideanPattern(hits, steps, 0);
        expect(pattern).toHaveLength(steps);
        expect(pattern.filter(Boolean)).toHaveLength(hits);
        if (hits > 0) expect(pattern[0]).toBeGreaterThan(0);
        expect(rotatePattern(pattern, steps)).toEqual(pattern);
      }
    }
  });

  it('spreads hits evenly', () => {
    expect(hitSteps(euclideanPattern(4, 16))).toEqual([0, 4, 8, 12]);
    expect(hitSteps(euclideanPattern(3, 8))).toEqual([0, 3, 6]);
    expect(hitSteps(euclideanPattern(5, 8))).toEqual([0, 2, 4, 5, 7]);
    // Gaps between hits differ by at most one step.
    for (let steps = 2; steps <= 24; steps++) {
      for (let hits = 1; hits <= steps; hits++) {
        const at = hitSteps(euclideanPattern(hits, steps));
        const gaps = at.map((s, i) => (at[(i + 1) % at.length]! - s + steps) % steps || steps);
        expect(Math.max(...gaps) - Math.min(...gaps), `${hits}/${steps}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('accents hits on every fourth step of the unrotated pattern', () => {
    expect(euclideanPattern(8, 16).filter(Boolean)).toEqual([ACCENT, SOFT, ACCENT, SOFT, ACCENT, SOFT, ACCENT, SOFT]);
  });

  it('rotates later, and wraps negative and large offsets', () => {
    expect(rotatePattern([1, 0, 0, 0])).toEqual([0, 1, 0, 0]);
    expect(rotatePattern([1, 0, 0, 0], -1)).toEqual([0, 0, 0, 1]);
    expect(rotatePattern([1, 0, 0, 0], 9)).toEqual([0, 1, 0, 0]);
    expect(euclideanPattern(3, 8, -1)).toEqual(rotatePattern(euclideanPattern(3, 8), 7));
    expect(rotatePattern([], 3)).toEqual([]);
    expect(rotatePattern([1, 0], NaN)).toEqual([1, 0]);
  });

  it('gives defined results for odd knobs', () => {
    expect(euclideanPattern(20, 8)).toEqual(euclideanPattern(8, 8));
    expect(euclideanPattern(-3, 8).filter(Boolean)).toHaveLength(0);
    expect(euclideanPattern(NaN, 8)).toEqual(Array(8).fill(0));
    expect(euclideanPattern(4, 0)).toEqual([]);
    expect(euclideanPattern(4, NaN)).toEqual([]);
    expect(euclideanPattern(4, -5)).toEqual([]);
    expect(euclideanPattern(4, 16, NaN)).toEqual(euclideanPattern(4, 16, 0));
    expect(euclideanPattern(2.6, 7.6)).toEqual(euclideanPattern(3, 8));
    expect(euclideanPattern(4, 1000)).toHaveLength(64);
  });

  it('euclideanAt matches the built pattern at every index, including negative ones', () => {
    for (const [hits, steps, rotation] of [[4, 16, 0], [3, 8, 2], [5, 13, -3], [7, 12, 30], [0, 5, 1], [9, 9, 4]] as const) {
      const pattern = euclideanPattern(hits, steps, rotation);
      for (let index = -40; index < 40; index++) expect(euclideanAt(index, hits, steps, rotation)).toBe(pattern[((index % steps) + steps) % steps]);
    }
    expect(euclideanAt(NaN, 4, 16, 0)).toBe(0);
    expect(euclideanAt(0, 4, 0, 0)).toBe(0);
  });
});

describe('euclidean node', () => {
  const steps = (n: number, channel = 0, dt = 0.125) => Array.from({ length: n }, (_, i): EngineEvent => ({ time: i * dt, channel, index: i }));

  it('fires on the ticks whose step index is a hit, with the hit velocity', () => {
    const out = query(euclidean, 0, 4, { params: { hits: 3, steps: 8, rotate: 1 }, inputs: { tick: steps(32) } }).hit!;
    expect(out.map((e) => e.index)).toEqual([1, 4, 7, 9, 12, 15, 17, 20, 23, 25, 28, 31]);
    expect(out[0]).toEqual({ time: 0.125, channel: 0, index: 1, velocity: ACCENT });
    expect(out[1]!.velocity).toBe(SOFT);
  });

  it('uses the tick index, not how many ticks it has seen', () => {
    // Ticks starting mid-pattern (after a seek or rewind) land where their index says.
    const late = steps(32).slice(5);
    const out = query(euclidean, 0, 4, { params: { hits: 4, steps: 16 }, inputs: { tick: late } }).hit!;
    expect(out.map((e) => e.index)).toEqual([8, 12, 16, 20, 24, 28]);
  });

  it('is independent of windowing, fed by a real Clock', () => {
    const tick = query(clock, 0, 10, { params: { bpm: 133, division: '1/16', swing: 0.3 } }).tick!;
    expect(tick.length).toBeGreaterThan(80);
    const options = { params: { hits: 5, steps: 13, rotate: 2 } };
    const whole = query(euclidean, 0, 10, { ...options, inputs: { tick } }).hit!;
    expect(whole.length).toBeGreaterThan(20);
    const inputsFor = (t0: number, t1: number) => ({ tick: tick.filter((e) => e.time >= t0 && e.time < t1) });
    expect(queryTiled(euclidean, 'hit', 10, 0.025, { ...options, inputsFor })).toEqual(whole);
    expect(queryTiled(euclidean, 'hit', 10, 0.1, { ...options, inputsFor })).toEqual(whole);
  });

  it('decides each channel from its own index and its own modulated knobs', () => {
    const both = [...steps(16, 0), ...steps(16, 1).map((e) => ({ ...e, index: (e.index as number) + 2 }))].sort(compareEvents);
    // Channel 1 gets 4 more hits than channel 0 (4 → 8 of 16).
    const mods = { hits: [{ depth: 4, signal: (_t: number, channel: number) => channel }] };
    const out = query(euclidean, 0, 2, { params: { hits: 4, steps: 16 }, inputs: { tick: both }, mods }).hit!;
    expect(out.filter((e) => e.channel === 0).map((e) => e.index)).toEqual([0, 4, 8, 12]);
    expect(out.filter((e) => e.channel === 1).map((e) => e.index)).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
  });

  it('reads modulated steps and rotate at each tick\'s time, rounded and clamped', () => {
    const mods = {
      steps: [{ depth: 1, signal: (t: number) => (t < 1 ? 0 : -12) }],
      rotate: [{ depth: 1, signal: () => 0.6 }],
    };
    // 16 steps, rotate 1 before 1 s; 4 steps after.
    const out = query(euclidean, 0, 2, { params: { hits: 1, steps: 16 }, inputs: { tick: steps(16) }, mods }).hit!;
    expect(out.map((e) => e.index)).toEqual([1, 9, 13]);
    const huge = { steps: [{ depth: 1e300, signal: () => -1e300 }] };
    expect(query(euclidean, 0, 2, { params: { hits: 1, steps: 4 }, inputs: { tick: steps(16) }, mods: huge }).hit!.map((e) => e.index)).toEqual([0, 4, 8, 12]);
  });

  it('handles odd input without throwing', () => {
    // Out-of-range and non-finite knobs resolve to the spec's range and defaults.
    expect(query(euclidean, 0, 2, { params: { hits: 99, steps: 4 }, inputs: { tick: steps(8) } }).hit).toHaveLength(8);
    expect(query(euclidean, 0, 2, { params: { hits: NaN, steps: 0, rotate: -1000 }, inputs: { tick: steps(16) } }).hit!.length).toBeGreaterThan(0);
    expect(query(euclidean, 0, 2, { params: { hits: 0 }, inputs: { tick: steps(16) } }).hit).toEqual([]);
    expect(query(euclidean, 0, 2, { params: { rotate: -3 }, inputs: { tick: steps(16) } }).hit!.map((e) => e.index)).toEqual([1, 5, 9, 13]);
    // Ticks without a numeric index are dropped; negative and fractional indices wrap and round.
    const odd: EngineEvent[] = [
      { time: 0, channel: 0 },
      { time: 0.1, channel: 0, index: 'x' },
      { time: 0.2, channel: 0, index: NaN },
      { time: 0.3, channel: 0, index: -4 },
      { time: 0.4, channel: 0, index: 3.6 },
      { time: 0.5, channel: 0, index: Infinity },
    ];
    expect(query(euclidean, 0, 1, { inputs: { tick: odd } }).hit!.map((e) => e.time)).toEqual([0.3, 0.4]);
    expect(query(euclidean, 0, 1, { inputs: {} }).hit).toEqual([]);
    expect(query(euclidean, 0, 1, { inputs: { tick: ticks([]) } }).hit).toEqual([]);
  });
});
