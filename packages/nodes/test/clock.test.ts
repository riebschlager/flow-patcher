import { describe, expect, it } from 'vitest';
import { clock } from '../src';
import { query, queryTiled } from './helpers';

describe('clock', () => {
  it('ticks on the division grid', () => {
    const { tick } = query(clock, 0, 2, { params: { bpm: 120, division: '1/4' } });
    expect(tick!.map((e) => e.time)).toEqual([0, 0.5, 1, 1.5]);
    expect(tick!.map((e) => e.index)).toEqual([0, 1, 2, 3]);
  });

  it('uses half-open windows', () => {
    expect(query(clock, 0.5, 1, { params: { bpm: 120 } }).tick!.map((e) => e.time)).toEqual([0.5]);
    expect(query(clock, 0.5, 0.5, { params: { bpm: 120 } }).tick).toEqual([]);
  });

  it('gives identical ticks however time is split into windows', () => {
    for (const params of [{ bpm: 120, division: '1/16' }, { bpm: 97.3, division: '1/8T' }, { bpm: 300, division: '1/32' }]) {
      const whole = query(clock, 0, 10, { params }).tick;
      expect(queryTiled(clock, 'tick', 10, 0.025, { params })).toEqual(whole);
      expect(queryTiled(clock, 'tick', 10, 0.1, { params })).toEqual(whole);
      expect(queryTiled(clock, 'tick', 10, 0.0173, { params })).toEqual(whole);
    }
  });

  it('falls back to defaults on bad params', () => {
    const { tick } = query(clock, 0, 1, { params: { bpm: NaN, division: 'nope' } });
    expect(tick!.map((e) => e.time)).toEqual([0, 0.5]);
  });
});
