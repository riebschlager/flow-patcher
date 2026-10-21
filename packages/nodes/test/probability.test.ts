import { describe, expect, it } from 'vitest';
import { probability } from '../src';
import { query, queryTiled, ticks } from './helpers';

const times = Array.from({ length: 400 }, (_, i) => i * 0.025);

describe('probability', () => {
  it('passes everything at 1 and nothing at 0', () => {
    expect(query(probability, 0, 10, { params: { chance: 1 }, inputs: { in: ticks(times) } }).out).toHaveLength(400);
    expect(query(probability, 0, 10, { params: { chance: 0 }, inputs: { in: ticks(times) } }).out).toHaveLength(0);
  });

  it('passes about the chance', () => {
    const passed = query(probability, 0, 10, { params: { chance: 0.3 }, inputs: { in: ticks(times) } }).out!.length;
    expect(passed).toBeGreaterThan(80);
    expect(passed).toBeLessThan(160);
  });

  it('is independent of windowing and seeded per node', () => {
    const options = { params: { chance: 0.5 }, inputs: { in: ticks(times) } };
    const whole = query(probability, 0, 10, options).out;
    const tiled = queryTiled(probability, 'out', 10, 0.1, { ...options, inputsFor: (t0, t1) => ({ in: ticks(times).filter((e) => e.time >= t0 && e.time < t1) }) });
    expect(tiled).toEqual(whole);
    expect(query(probability, 0, 10, { ...options, nodeId: 'other' }).out).not.toEqual(whole);
    expect(query(probability, 0, 10, { ...options, seed: 2 }).out).not.toEqual(whole);
  });

  it('decides each channel separately', () => {
    const both = [...ticks(times, 0), ...ticks(times, 1)];
    const out = query(probability, 0, 10, { params: { chance: 0.5 }, inputs: { in: both } }).out!;
    const zero = out.filter((e) => e.channel === 0).map((e) => e.time), one = out.filter((e) => e.channel === 1).map((e) => e.time);
    expect(zero).not.toEqual(one);
  });
});
