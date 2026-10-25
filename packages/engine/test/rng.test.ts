import { describe, expect, it } from 'vitest';
import { createRng, randomAt, rngAt, timeKey } from '../src';

describe('seeded randomness', () => {
  it('randomAt is a pure function of seed and keys', () => {
    expect(randomAt(1, 'node', 5)).toBe(randomAt(1, 'node', 5));
    expect(randomAt(1, 'node', 5)).not.toBe(randomAt(2, 'node', 5));
    expect(randomAt(1, 'node', 5)).not.toBe(randomAt(1, 'other', 5));
    expect(randomAt(1, 'node', timeKey(1))).not.toBe(randomAt(1, 'node', timeKey(1 + 2 ** 32 / 1e6)));
  });

  it('is roughly uniform in [0, 1)', () => {
    const values = Array.from({ length: 10000 }, (_, i) => randomAt(42, 'n', i));
    expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
    const mean = values.reduce((a, b) => a + b) / values.length;
    expect(Math.abs(mean - 0.5)).toBeLessThan(0.02);
  });

  it('createRng repeats for a seed', () => {
    const a = createRng(9), b = createRng(9);
    const seqA = Array.from({ length: 5 }, () => a.next()), seqB = Array.from({ length: 5 }, () => b.next());
    expect(seqA).toEqual(seqB);
    expect(new Set(seqA).size).toBe(5);
  });

  it('handles non-finite keys', () => {
    expect(Number.isFinite(randomAt(1, NaN, Infinity))).toBe(true);
  });
});

describe('rngAt', () => {
  const draw = (rng: { next(): number }, n = 8) => Array.from({ length: n }, () => rng.next());
  it('gives the same stream for the same seed and keys, and another for any other key', () => {
    const a = draw(rngAt(7, 'verb', 'impulse', 0));
    expect(draw(rngAt(7, 'verb', 'impulse', 0))).toEqual(a);
    for (const other of [rngAt(8, 'verb', 'impulse', 0), rngAt(7, 'verb-2', 'impulse', 0), rngAt(7, 'verb', 'impulse', 1), rngAt(7, 'verb', 'impulse')]) expect(draw(other)).not.toEqual(a);
    for (const v of draw(rngAt(1, 'x'), 1000)) expect(v >= 0 && v < 1).toBe(true);
  });
});
