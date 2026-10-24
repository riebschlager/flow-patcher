import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '@flow-patcher/engine';
import { stroke } from '../src';
import { ev, expectClaim, expectPassThrough, expectWindowIndependent, merge, run, stroke as line } from './recognizers';

/** Slow: 0.004 per 20 ms (0.2 units/s); fast: 0.03 per 16 ms (1.9 units/s). */
const slow = line(1, 0.1, [0.2, 0.5], [0.28, 0.5], 20, 0.02);
const fast = line(2, 0.1, [0.2, 0.2], [0.68, 0.2], 16, 0.016);

describe('stroke', () => {
  it('takes In and gives Pass, its phase split, Silk, Rush and End', () => {
    expect(stroke.ports.map((p) => `${p.direction} ${p.name}`)).toEqual(['in in', 'out pass', 'out passDown', 'out passMove', 'out passUp', 'out passCancel', 'out silk', 'out rush', 'out end']);
  });

  it('claims once the path passes Minimum length, at that move (Flow: path > 0.012 is a ribbon)', () => {
    const out = expectWindowIndependent(stroke, slow);
    // The third move takes the path to 0.012.
    expectClaim(out, slow, { claimed: [1], time: slow[3]!.time });
    expect(out.silk?.[0]).toMatchObject({ time: slow[3]!.time, channel: 1, length: expect.closeTo(0.012, 12) });
    expect(out.silk).toHaveLength(18);
    expect(out.rush).toBeUndefined();
  });

  it('sorts moves into Silk and Rush by the stroke\'s speed (Flow: energy over 0.58 is a rush)', () => {
    const out = run(stroke, fast);
    // Flow's smoothed speed climbs 40% a step toward 1.875: the first steps are still silk.
    expect(out.silk?.length).toBeGreaterThan(0);
    expect(out.rush?.length).toBeGreaterThan(10);
    expect(out.rush![0]!.time).toBeGreaterThan(out.silk!.at(-1)!.time);
    expect(out.rush!.every((e) => (e.speed as number) >= 0.87)).toBe(true);
    expect(out.silk!.every((e) => (e.speed as number) < 0.87)).toBe(true);
  });

  it('sums the stroke up at its up: length, curvature, average speed and kind', () => {
    const out = run(stroke, merge(slow, fast));
    // The fast stroke ends first.
    const [b, a] = out.end!;
    expect(a).toMatchObject({ channel: 1, length: expect.closeTo(0.08, 12), curvature: 0, speed: expect.closeTo(0.2, 9), duration: expect.closeTo(0.4, 12), kind: 'silk' });
    expect(b).toMatchObject({ channel: 2, length: expect.closeTo(0.48, 12), curvature: 0, kind: 'rush' });
    expect(b!.speed).toBeCloseTo(0.48 / 0.256, 9);
    // A right-angle bend: π/2 of turning over the path.
    const bend = [ev(0, 3, 'down', 0.2, 0.2), ev(0.1, 3, 'move', 0.3, 0.2), ev(0.2, 3, 'move', 0.3, 0.3), ev(0.2, 3, 'up', 0.3, 0.3)];
    expect(run(stroke, bend).end![0]!.curvature).toBeCloseTo(Math.PI / 2 / 0.2, 9);
  });

  it('leaves taps to Pass and ends a cancelled stroke without End, with channels independent', () => {
    const tap = [ev(0.12, 3, 'down', 0.5, 0.8), ev(0.15, 3, 'move', 0.505, 0.8), ev(0.2, 3, 'up', 0.505, 0.8)];
    const cancelled = line(4, 0.1, [0.9, 0.1], [0.9, 0.3], 5, 0.02, 'cancel');
    const events = merge(slow, tap, cancelled);
    const out = expectWindowIndependent(stroke, events);
    expectClaim(out, events, { claimed: [1], time: slow[3]!.time, free: [3] });
    expectClaim(out, events, { claimed: [4], time: cancelled[1]!.time });
    expect(out.end?.map((e) => e.channel)).toEqual([1]);
  });

  it('follows its knobs', () => {
    expect(run(stroke, fast, { params: { split: 4 } }).rush).toBeUndefined();
    expect(run(stroke, slow, { params: { split: 0.1 } }).silk).toBeUndefined();
    expectPassThrough(run(stroke, slow, { params: { minLength: 0.5 } }), slow);
  });

  it('with Claim off, classifies and passes everything', () => {
    const out = run(stroke, slow, { params: { claim: false } });
    expectPassThrough(out, slow);
    expect(out.silk).toHaveLength(18);
    expect(out.end).toHaveLength(1);
  });

  it('gives defined results for weird input', () => {
    const weird: EngineEvent[] = [{ time: 0, channel: 9 }, ev(0, 1, 'down', Number.NaN, 0.5), ev(0.1, 1, 'move', 0.5, Number.NaN), ev(0.1, 1, 'up', 0.5, 0.5)];
    const out = run(stroke, weird);
    expect(out.end).toEqual([expect.objectContaining({ length: 0.5, duration: 0.1, kind: 'rush' })]);
    expect(run(stroke, [ev(0, 1, 'down', 0.5, 0.5), ev(0, 1, 'move', 0.6, 0.5), ev(0, 1, 'up', 0.6, 0.5)]).end![0]!.speed).toBe(0);
    expect(run(stroke, [])).toEqual({});
  });
});
