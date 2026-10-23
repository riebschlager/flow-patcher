import { describe, expect, it } from 'vitest';
import type { NodeWiring, SignalSource } from '@flow-patcher/engine';
import { math, thresholdChange } from '../src';
import { applyOp, MATH_CONSTANT_LIMIT, MATH_OPS } from '../src/math';
import { context, queryTiled } from './helpers';

/** Math's Out as a Signal source, wired like the runtime wires it. */
function out(params: Record<string, unknown> = {}, signals: NodeWiring['signals'] = {}, mods?: NodeWiring['mods']): SignalSource {
  const ctx = context(math, { params, signals, mods });
  return (t, channel) => math.signal!(ctx, 'out', t, channel);
}

const constant = (v: number): SignalSource => () => v;
/** Channel c reads c + 1, so channels stay apart. */
const perChannel: SignalSource = (_t, channel) => channel + 1;
const ramp: SignalSource = (t) => t;

describe('math', () => {
  it('is A + B + Constant by default, so a lone A passes through', () => {
    expect(out({}, { a: [ramp] })(0.25, 0)).toBe(0.25);
    expect(out({}, { a: [constant(2)], b: [constant(3)] })(0, 0)).toBe(5);
    expect(out({ constant: 1.5 }, { a: [constant(2)] })(0, 0)).toBe(3.5);
  });

  it('applies each operation to A and B + Constant', () => {
    const at = (op: string, a: number, b: number, k = 0) => out({ op, constant: k }, { a: [constant(a)], b: [constant(b)] })(0, 0);
    expect(at('subtract', 5, 2)).toBe(3);
    expect(at('multiply', 3, 2, 2)).toBe(12);
    expect(at('divide', 9, 2, 1)).toBe(3);
    expect(at('min', 4, 1, 1)).toBe(2);
    expect(at('max', -4, -1)).toBe(-1);
    expect(at('modulo', 7.5, 2)).toBe(1.5);
    // Floored modulo: the result takes B's sign, so a negative A still wraps into [0, B).
    expect(at('modulo', -0.5, 2)).toBe(1.5);
    expect(at('modulo', 0.5, -2)).toBe(-1.5);
  });

  it('takes Constant up to ±20000, so A + 440 and A × 1000 work', () => {
    expect(MATH_CONSTANT_LIMIT).toBe(20_000);
    expect(out({ constant: 440 }, { a: [constant(0.5)] })(0, 0)).toBe(440.5);
    expect(out({ op: 'multiply', constant: 1000 }, { a: [ramp] })(0.25, 0)).toBe(250);
    expect(out({ constant: -20_000 }, { a: [constant(0)] })(0, 0)).toBe(-20_000);
  });

  it('raises A to the power B + Constant, per channel', () => {
    expect(out({ op: 'power', constant: 2 }, { a: [constant(3)] })(0, 0)).toBe(9);
    expect(out({ op: 'power', constant: 0.5 }, { a: [constant(16)] })(0, 0)).toBe(4);
    expect(out({ op: 'power', constant: -1 }, { a: [constant(4)] })(0, 0)).toBe(0.25);
    // B on each channel: 2^1, 2^2, 2^3.
    const f = out({ op: 'power' }, { a: [constant(2)], b: [perChannel] });
    expect([0, 1, 2].map((c) => f(0, c))).toEqual([2, 4, 8]);
    expect(applyOp('power', -8, 3)).toBe(-512);
    expect(applyOp('power', 5, 0)).toBe(1);
  });

  it('gives 0 for a power with no finite real result', () => {
    // A negative base to a fractional exponent is NaN; 0 to a negative power is Infinity; overflow too.
    expect(applyOp('power', -8, 1 / 3)).toBe(0);
    expect(out({ op: 'power', constant: 0.5 }, { a: [constant(-4)] })(0, 0)).toBe(0);
    expect(applyOp('power', 0, -1)).toBe(0);
    expect(applyOp('power', 10, 400)).toBe(0);
  });

  it('gives |A + B + Constant| for abs, so a lone A is folded positive', () => {
    expect(out({ op: 'abs' }, { a: [constant(-3)] })(0, 0)).toBe(3);
    expect(out({ op: 'abs' }, { a: [constant(-3)], b: [constant(1)] })(0, 0)).toBe(2);
    // |ramp − 0.5| folds a ramp into a V.
    const fold = out({ op: 'abs', constant: -0.5 }, { a: [ramp] });
    expect([0, 0.25, 0.5, 1].map((t) => fold(t, 0))).toEqual([0.5, 0.25, 0, 0.5]);
    const f = out({ op: 'abs' }, { a: [(_t, c) => -c] });
    expect([0, 1, 3].map((c) => f(0, c))).toEqual([0, 1, 3]);
    expect(applyOp('abs', -Number.MAX_VALUE, -Number.MAX_VALUE)).toBe(0);
  });

  it('scales and wraps a ramp with Constant alone', () => {
    const scaled = out({ op: 'multiply', constant: 12 }, { a: [ramp] });
    expect([0, 0.5, 1].map((t) => scaled(t, 0))).toEqual([0, 6, 12]);
    const wrapped = out({ op: 'modulo', constant: 1 }, { a: [ramp] });
    expect([0.25, 1.25, 3.75].map((t) => wrapped(t, 0))).toEqual([0.25, 0.25, 0.75]);
  });

  it('sums several cables into an input, as every Signal input does', () => {
    expect(out({ op: 'multiply' }, { a: [constant(1), constant(2)], b: [constant(2), constant(2)] })(0, 0)).toBe(12);
  });

  it('keeps channels apart: each reads A and B on its own channel', () => {
    const f = out({ op: 'multiply' }, { a: [perChannel], b: [perChannel] });
    expect([0, 1, 2, 7].map((c) => f(0, c))).toEqual([1, 4, 9, 64]);
  });

  it('adds a cable into Constant scaled by its depth, clamped to the knob range', () => {
    expect(out({ constant: 1 }, { a: [constant(1)] }, { constant: [{ depth: 2, signal: perChannel }] })(0, 1)).toBe(6);
    expect(out({}, {}, { constant: [{ depth: 1, signal: constant(1e6) }] })(0, 0)).toBe(MATH_CONSTANT_LIMIT);
  });

  it('gives 0 for division or modulo by zero and for non-finite results, never NaN', () => {
    for (const op of ['divide', 'modulo']) expect(out({ op }, { a: [constant(3)] })(0, 0)).toBe(0);
    expect(out({ op: 'multiply' }, { a: [constant(1e300)], b: [constant(1e300)] })(0, 0)).toBe(0);
    expect(out({ op: 'add' }, { a: [constant(Number.MAX_VALUE)], b: [constant(Number.MAX_VALUE)] })(0, 0)).toBe(0);
    for (const op of MATH_OPS) {
      for (const [a, b] of [[NaN, 1], [1, NaN], [Infinity, -Infinity], [0, 0]]) expect(Number.isFinite(applyOp(op, a!, b!)), `${op}(${a}, ${b})`).toBe(true);
    }
  });

  it('treats non-finite cables as 0, unconnected inputs as 0, and odd times or ports as 0', () => {
    expect(out({ op: 'add' }, { a: [constant(NaN), constant(2)], b: [constant(Infinity)] })(0, 0)).toBe(2);
    expect(out({ op: 'max' })(0, 0)).toBe(0);
    const f = out({}, { a: [constant(3)] });
    expect(f(NaN, 0)).toBe(0);
    expect(f(Infinity, 0)).toBe(0);
    expect(f(-5, 0)).toBe(3);
    const ctx = context(math, { signals: { a: [constant(3)] } });
    expect(math.signal!(ctx, 'nope', 0, 0)).toBe(0);
  });

  it('clamps an out-of-range Constant and falls back to Add for an unknown operation', () => {
    expect(out({ op: 'wobble', constant: 1e9 }, { a: [constant(1)] })(0, 0)).toBe(1 + MATH_CONSTANT_LIMIT);
    expect(out({ constant: -1e9 }, { a: [constant(1)] })(0, 0)).toBe(1 - MATH_CONSTANT_LIMIT);
    expect(out({ op: 'divide', constant: NaN }, { a: [constant(1)] })(0, 0)).toBe(0);
  });

  it('is stateless: it has no query, and reading Out leaves state empty', () => {
    expect(math.query).toBeUndefined();
    const state = {};
    const ctx = context(math, { state, signals: { a: [(t: number, c: number) => t + c] } });
    const reads = [0.25, 0.5, 0.25, 0.75].map((t) => math.signal!(ctx, 'out', t, 1));
    expect(reads[0]).toBe(reads[2]);
    expect(state).toEqual({});
  });

  it('gives a reader the same events whatever the windowing', () => {
    // Threshold on (sin on A) × (1 + channel on B): channel 1 crosses 0.5 more often than channel 0.
    const sine: SignalSource = (t) => Math.sin(2 * Math.PI * 1.3 * t);
    const source = out({ op: 'multiply' }, { a: [sine], b: [perChannel] });
    const run = (step: number) =>
      queryTiled(thresholdChange, 'out', 4, step, { state: {}, params: { channels: 2, direction: 'both' }, signals: { in: [source] } }).map((e) => [e.time, e.channel, e.value]);
    const whole = run(4);
    expect(whole.length).toBeGreaterThan(8);
    expect(new Set(whole.map((e) => e[1]))).toEqual(new Set([0, 1]));
    expect(run(0.025)).toEqual(whole);
    expect(run(0.1)).toEqual(whole);
  });
});
