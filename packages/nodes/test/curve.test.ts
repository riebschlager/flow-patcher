import { describe, expect, it } from 'vitest';
import type { NodeWiring, SignalSource } from '@flow-patcher/engine';
import { curve, thresholdChange } from '../src';
import { CURVE_AMOUNT_MAX, CURVE_AMOUNT_MIN, CURVE_SHAPES, shape } from '../src/curve';
import { context, queryTiled } from './helpers';

/** Curve's Out as a Signal source, wired like the runtime wires it. */
function out(params: Record<string, unknown> = {}, signals: NodeWiring['signals'] = {}, mods?: NodeWiring['mods']): SignalSource {
  const ctx = context(curve, { params, signals, mods });
  return (t, channel) => curve.signal!(ctx, 'out', t, channel);
}

const constant = (v: number): SignalSource => () => v;
/** Channel c reads c / 4, so channels stay apart inside 0–1. */
const perChannel: SignalSource = (_t, channel) => channel / 4;
const ramp: SignalSource = (t) => t;
const sample = (f: SignalSource, ts: number[], channel = 0) => ts.map((t) => f(t, channel));
const grid = Array.from({ length: 21 }, (_, i) => i / 20);

describe('curve', () => {
  it('passes a 0–1 Signal through with the defaults and clamps the rest into 0–1', () => {
    expect(sample(out({}, { in: [ramp] }), [-1, 0, 0.25, 1, 3])).toEqual([0, 0, 0.25, 1, 1]);
  });

  it('is a straight line at Amount 1 for every shape', () => {
    for (const s of CURVE_SHAPES) {
      const f = out({ shape: s, amount: 1 }, { in: [ramp] });
      for (const t of grid) expect(f(t, 0), `${s} ${t}`).toBeCloseTo(t, 12);
    }
  });

  it('keeps 0 at 0 and 1 at 1, stays in 0–1 and never falls, for every shape and amount', () => {
    for (const s of CURVE_SHAPES) {
      for (const amount of [CURVE_AMOUNT_MIN, 0.3, 1, 2, 7, CURVE_AMOUNT_MAX]) {
        const ys = grid.map((x) => shape(s, x, amount));
        expect(ys[0], `${s} ${amount}`).toBeCloseTo(0, 12);
        expect(ys[20], `${s} ${amount}`).toBeCloseTo(1, 12);
        for (let i = 1; i < ys.length; i++) expect(ys[i]! >= ys[i - 1]!, `${s} ${amount} at ${grid[i]}`).toBe(true);
        for (const y of ys) expect(y >= 0 && y <= 1).toBe(true);
      }
    }
  });

  it('power: x^amount, slow start above 1 and fast start below', () => {
    const f = out({ shape: 'power', amount: 2 }, { in: [ramp] });
    expect(sample(f, [0.5, 0.25])).toEqual([0.25, 0.0625]);
    expect(out({ shape: 'power', amount: 0.5 }, { in: [ramp] })(0.25, 0)).toBe(0.5);
  });

  it('exponential: lo · (hi / lo)^x once a linear map follows, so equal steps are equal ratios', () => {
    // Flow's Paint cutoff: 650 · 24^u. Curve with amount 24, then 650 + (15600 − 650) · Out.
    const f = out({ shape: 'exponential', amount: 24 }, { in: [ramp] });
    for (const u of [0, 0.25, 0.5, 0.75, 1]) expect(650 + (650 * 24 - 650) * f(u, 0)).toBeCloseTo(650 * 24 ** u, 6);
    // Below 1 it bends the other way.
    expect(out({ shape: 'exponential', amount: 0.1 }, { in: [ramp] })(0.5, 0)).toBeGreaterThan(0.5);
    expect(f(0.5, 0)).toBeLessThan(0.5);
  });

  it('s-curve: eases in and out, symmetric about the middle', () => {
    const f = out({ shape: 's-curve', amount: 2 }, { in: [ramp] });
    expect(sample(f, [0.25, 0.5, 0.75])).toEqual([0.125, 0.5, 0.875]);
    const g = out({ shape: 's-curve', amount: 0.5 }, { in: [ramp] });
    expect(g(0.125, 0)).toBeCloseTo(0.25, 12);
    expect(g(0.875, 0)).toBeCloseTo(0.75, 12);
  });

  it('keeps channels apart: each shapes In on its own channel', () => {
    const f = out({ shape: 'power', amount: 2 }, { in: [perChannel] });
    expect([0, 1, 2, 3, 4, 7].map((c) => f(0, c))).toEqual([0, 0.0625, 0.25, 0.5625, 1, 1]);
  });

  it('sums several cables into In', () => {
    expect(out({ amount: 2 }, { in: [constant(0.25), constant(0.25)] })(0, 0)).toBe(0.25);
  });

  it('adds cables into Amount per channel, clamped to the knob range', () => {
    // Amount 1 + c: channel 0 linear, channel 1 squared, channel 2 cubed.
    const f = out({ amount: 1 }, { in: [constant(0.5)] }, { amount: [{ depth: 4, signal: perChannel }] });
    expect([0, 1, 2].map((c) => f(0, c))).toEqual([0.5, 0.25, 0.125]);
    expect(out({}, { in: [constant(0.5)] }, { amount: [{ depth: 1, signal: constant(1e9) }] })(0, 0)).toBe(0.5 ** CURVE_AMOUNT_MAX);
    expect(out({}, { in: [constant(0.5)] }, { amount: [{ depth: 1, signal: constant(-1e9) }] })(0, 0)).toBe(0.5 ** CURVE_AMOUNT_MIN);
  });

  it('treats non-finite cables as 0, an unconnected In as 0, and odd times or ports as 0', () => {
    const s = { shape: 's-curve', amount: 3 };
    expect(out(s, { in: [constant(NaN)] })(0, 0)).toBe(0);
    expect(out(s, { in: [constant(Infinity), constant(1)] })(0, 0)).toBe(1);
    expect(out(s)(0, 0)).toBe(0);
    const f = out(s, { in: [constant(1)] });
    expect(f(NaN, 0)).toBe(0);
    expect(f(Infinity, 0)).toBe(0);
    expect(f(-5, 0)).toBe(1);
    const ctx = context(curve, { signals: { in: [constant(1)] } });
    expect(curve.signal!(ctx, 'nope', 0, 0)).toBe(0);
  });

  it('never returns a non-finite number or leaves 0–1', () => {
    for (const s of CURVE_SHAPES) {
      for (const [x, a] of [[NaN, 2], [0.5, NaN], [0.5, Infinity], [0.5, 0], [0.5, -3], [1e308, 1e308], [-1e308, 1e-300], [0.5, 1 + 1e-12]] as const) {
        const v = shape(s, x, a);
        expect(Number.isFinite(v) && v >= 0 && v <= 1, `${s} ${x} ${a}`).toBe(true);
      }
    }
    expect(shape('power', 0.5, 0)).toBe(0);
  });

  it('falls back to the defaults for mistyped params and clamps out-of-range ones', () => {
    expect(out({ shape: 'wobble', amount: 2 }, { in: [constant(0.5)] })(0, 0)).toBe(0.25);
    expect(out({ shape: 3, amount: NaN }, { in: [constant(0.3)] })(0, 0)).toBe(0.3);
    expect(out({ amount: 1e9 }, { in: [constant(0.5)] })(0, 0)).toBe(0.5 ** CURVE_AMOUNT_MAX);
  });

  it('is stateless: it has no query, and reading Out leaves state empty', () => {
    expect(curve.query).toBeUndefined();
    const state = {};
    const ctx = context(curve, { state, signals: { in: [(t: number, c: number) => t + c] } });
    const reads = [0.25, 0.5, 0.25, 0.75].map((t) => curve.signal!(ctx, 'out', t, 1));
    expect(reads[0]).toBe(reads[2]);
    expect(state).toEqual({});
  });

  it('gives a reader the same events whatever the windowing', () => {
    // A 0–1 sine bent per channel (amount 1 + 3c), read by Threshold at 0.5: channels cross at different times.
    const sine: SignalSource = (t) => 0.5 + 0.5 * Math.sin(2 * Math.PI * 1.3 * t);
    const ctx = context(curve, { params: { shape: 's-curve', amount: 1 }, signals: { in: [sine] }, mods: { amount: [{ depth: 3, signal: (_t, c) => c }] } });
    const source: SignalSource = (t, channel) => curve.signal!(ctx, 'out', t, channel);
    const tctx = { params: { channels: 2, direction: 'both', level: 0.7 }, signals: { in: [source] } };
    const run = (step: number) => queryTiled(thresholdChange, 'out', 4, step, { state: {}, ...tctx }).map((e) => [e.time, e.channel, e.value]);
    const whole = run(4);
    expect(whole.length).toBeGreaterThan(8);
    expect(new Set(whole.map((e) => e[1]))).toEqual(new Set([0, 1]));
    expect(whole.filter((e) => e[1] === 0)).not.toEqual(whole.filter((e) => e[1] === 1).map((e) => [e[0], 0, e[2]]));
    expect(run(0.025)).toEqual(whole);
    expect(run(0.1)).toEqual(whole);
  });
});
