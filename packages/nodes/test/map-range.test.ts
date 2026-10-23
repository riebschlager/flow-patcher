import { describe, expect, it } from 'vitest';
import type { NodeWiring, SignalSource } from '@flow-patcher/engine';
import { mapRange, thresholdChange } from '../src';
import { MAP_RANGE_LIMIT, rescale } from '../src/map-range';
import { context, query, queryTiled } from './helpers';

/** Map Range's Out as a Signal source, wired like the runtime wires it. */
function out(params: Record<string, unknown> = {}, signals: NodeWiring['signals'] = {}, mods?: NodeWiring['mods']): SignalSource {
  const ctx = context(mapRange, { params, signals, mods });
  return (t, channel) => mapRange.signal!(ctx, 'out', t, channel);
}

const constant = (v: number): SignalSource => () => v;
/** Channel c reads c / 4, so channels stay apart inside 0–1. */
const perChannel: SignalSource = (_t, channel) => channel / 4;
const ramp: SignalSource = (t) => t;
const sample = (f: SignalSource, ts: number[], channel = 0) => ts.map((t) => f(t, channel));

describe('map-range', () => {
  it('passes a 0–1 Signal through with the defaults and clamps the rest into 0–1', () => {
    expect(sample(out({}, { in: [ramp] }), [-1, 0, 0.25, 1, 3])).toEqual([0, 0, 0.25, 1, 1]);
  });

  it('maps pointer-style 0–1 onto a pitch range', () => {
    const pitch = out({ outMin: 48, outMax: 72 }, { in: [ramp] });
    expect(sample(pitch, [0, 0.5, 1])).toEqual([48, 60, 72]);
  });

  it('maps any input range linearly onto any output range', () => {
    const f = out({ inMin: 2, inMax: 4, outMin: 200, outMax: 2000 }, { in: [ramp] });
    expect(sample(f, [2, 3, 4])).toEqual([200, 1100, 2000]);
  });

  it('clamps to the output range, or extends the line when Clamp is off', () => {
    const params = { outMin: 10, outMax: 20 };
    expect(sample(out(params, { in: [ramp] }), [-1, 2])).toEqual([10, 20]);
    expect(sample(out({ ...params, clamp: false }, { in: [ramp] }), [-1, 2])).toEqual([0, 30]);
  });

  it('inverts when either range is reversed, and still clamps between the output bounds', () => {
    const down = out({ outMin: 1, outMax: 0 }, { in: [ramp] });
    expect(sample(down, [-1, 0, 0.25, 1, 2])).toEqual([1, 1, 0.75, 0, 0]);
    const flipped = out({ inMin: 1, inMax: 0, outMin: 0, outMax: 10 }, { in: [ramp] });
    expect(sample(flipped, [0, 0.25, 1, 5])).toEqual([10, 7.5, 0, 0]);
  });

  it('keeps channels apart: each maps In on its own channel', () => {
    const f = out({ outMin: 100, outMax: 500 }, { in: [perChannel] });
    expect([0, 1, 2, 3, 4, 7].map((c) => f(0, c))).toEqual([100, 200, 300, 400, 500, 500]);
  });

  it('sums several cables into In', () => {
    expect(out({ outMax: 10 }, { in: [constant(0.25), constant(0.25)] })(0, 0)).toBe(5);
  });

  it('adds cables into the bounds per channel, clamped to the knob range', () => {
    // Out max 10 + 4 × (c / 4) = 10 + c; In 1 reads Out max.
    const f = out({ outMax: 10 }, { in: [constant(1)] }, { outMax: [{ depth: 4, signal: perChannel }] });
    expect([0, 1, 2].map((c) => f(0, c))).toEqual([10, 11, 12]);
    expect(out({ clamp: false }, { in: [constant(1)] }, { outMax: [{ depth: 1, signal: constant(1e9) }] })(0, 0)).toBe(MAP_RANGE_LIMIT);
  });

  it('gives Out min for an empty input range', () => {
    const f = out({ inMin: 0.5, inMax: 0.5, outMin: 3, outMax: 9 }, { in: [ramp] });
    expect(sample(f, [0, 0.5, 1])).toEqual([3, 3, 3]);
    expect(out({ inMin: 0.5, inMax: 0.5, outMin: 3, clamp: false }, { in: [ramp] })(1, 0)).toBe(3);
  });

  it('treats non-finite cables as 0, an unconnected In as 0, and odd times or ports as 0', () => {
    expect(out({ outMin: 5, outMax: 6 }, { in: [constant(NaN)] })(0, 0)).toBe(5);
    expect(out({ outMin: 5, outMax: 6 }, { in: [constant(Infinity), constant(1)] })(0, 0)).toBe(6);
    expect(out({ outMin: 5, outMax: 6 })(0, 0)).toBe(5);
    const f = out({ outMin: 5, outMax: 6 }, { in: [constant(1)] });
    expect(f(NaN, 0)).toBe(0);
    expect(f(Infinity, 0)).toBe(0);
    expect(f(-5, 0)).toBe(6);
    const ctx = context(mapRange, { signals: { in: [constant(1)] } });
    expect(mapRange.signal!(ctx, 'nope', 0, 0)).toBe(0);
  });

  it('never returns a non-finite number, even unclamped', () => {
    expect(rescale(1e308, 0, 1e-300, 0, 1, false)).toBe(0);
    const cases: [number, number, number, number, number][] = [[NaN, 0, 1, 0, 1], [0, NaN, 1, 0, 1], [0, 0, Infinity, 0, 1], [0, 0, 1, -Infinity, 1], [0, 0, 1, 0, NaN]];
    for (const args of cases) {
      for (const clamp of [true, false]) expect(Number.isFinite(rescale(...args, clamp)), `${args.join(', ')} ${clamp}`).toBe(true);
    }
    expect(out({ inMax: 1e-9, outMax: MAP_RANGE_LIMIT, clamp: false }, { in: [constant(1e300)] })(0, 0)).toBe(0);
  });

  it('falls back to the defaults for out-of-range or mistyped params', () => {
    expect(out({ outMax: 1e9 }, { in: [constant(1)] })(0, 0)).toBe(MAP_RANGE_LIMIT);
    expect(out({ outMax: NaN, clamp: 'yes' }, { in: [constant(2)] })(0, 0)).toBe(1);
  });

  it('is stateless: its query emits nothing and leaves state empty', () => {
    const state = {};
    expect(query(mapRange, 0, 1, { state })).toEqual({});
    expect(state).toEqual({});
  });

  it('gives a reader the same events whatever the windowing', () => {
    // A sine in −1…1 mapped onto 0…(1 + channel), read by Threshold at 0.5: channels cross at different times.
    const sine: SignalSource = (t) => Math.sin(2 * Math.PI * 1.3 * t);
    const ctx = context(mapRange, { params: { inMin: -1, outMax: 1 }, signals: { in: [sine] }, mods: { outMax: [{ depth: 1, signal: (_t, c) => c }] } });
    const source: SignalSource = (t, channel) => mapRange.signal!(ctx, 'out', t, channel);
    const run = (step: number) =>
      queryTiled(thresholdChange, 'out', 4, step, { state: {}, params: { channels: 2, direction: 'both' }, signals: { in: [source] } }).map((e) => [e.time, e.channel, e.value]);
    const whole = run(4);
    expect(whole.length).toBeGreaterThan(8);
    expect(new Set(whole.map((e) => e[1]))).toEqual(new Set([0, 1]));
    expect(whole.filter((e) => e[1] === 0)).not.toEqual(whole.filter((e) => e[1] === 1).map((e) => [e[0], 0, e[2]]));
    expect(run(0.025)).toEqual(whole);
    expect(run(0.1)).toEqual(whole);
  });
});
