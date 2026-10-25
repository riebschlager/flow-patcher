// Log-scaled knobs in the inspector (ADR 0032): readout, typing, drag and keys by ratio, depth in octaves.
import { describe, expect, it } from 'vitest';
import type { NumberParamSpec } from '@flow-patcher/engine';
import { filter } from '@flow-patcher/nodes';
import { depthScale, formatDepth, formatParam, keyedDepth, keyedParam, parseParam, snapParam, turnBy } from '../src/param-format';

const cutoff = filter.params.find((p) => p.name === 'cutoff') as NumberParamSpec;
const time: NumberParamSpec = { name: 'time', kind: 'number', min: 0.001, max: 4, default: 0.25, unit: 's', scale: 'log' };
const q = filter.params.find((p) => p.name === 'q') as NumberParamSpec;

describe('log-scaled params in the inspector', () => {
  it('read in natural units with a prefix, three significant figures', () => {
    expect(formatParam(cutoff, 1200)).toBe('1.2 kHz');
    expect(formatParam(cutoff, 1234.5)).toBe('1.23 kHz');
    expect(formatParam(cutoff, 20000)).toBe('20 kHz');
    expect(formatParam(cutoff, 300)).toBe('300 Hz');
    expect(formatParam(cutoff, 42.37)).toBe('42.4 Hz');
    expect(formatParam(cutoff, 20)).toBe('20 Hz');
    expect(formatParam(time, 0.25)).toBe('250 ms');
    expect(formatParam(time, 1.5)).toBe('1.5 s');
    // Rounded before the prefix is picked: no "1000 Hz" or "1000 ms".
    expect(formatParam(cutoff, 999.7)).toBe('1 kHz');
    expect(formatParam(cutoff, 999.4)).toBe('999 Hz');
    expect(formatParam(cutoff, 19996)).toBe('20 kHz');
    expect(formatParam(time, 0.9996)).toBe('1 s');
    expect(formatParam(time, 0.9994)).toBe('999 ms');
    // Linear params read as before.
    expect(formatParam(q, 6)).toBe('6.00');
  });

  it('read typed numbers in Hz, with kHz and ms understood', () => {
    expect(parseParam(cutoff, '440')).toBe(440);
    expect(parseParam(cutoff, '440 Hz')).toBe(440);
    expect(parseParam(cutoff, '1.2k')).toBe(1200);
    expect(parseParam(cutoff, '1.2 kHz')).toBe(1200);
    expect(parseParam(time, '250 ms')).toBe(0.25);
    expect(parseParam(time, '2 s')).toBe(2);
    expect(parseParam(cutoff, 'loud')).toBeNaN();
    // Linear fields read the prefixes too: any Hz param takes "k", any seconds param "ms".
    const attack: NumberParamSpec = { name: 'attack', kind: 'number', min: 0, max: 2, default: 0.02, unit: 's' };
    const hz: NumberParamSpec = { name: 'rate', kind: 'number', min: 0, max: 20000, default: 440, unit: 'Hz' };
    expect(parseParam(attack, '250 ms')).toBe(0.25);
    expect(parseParam(attack, '0.5')).toBe(0.5);
    expect(parseParam(hz, '1.2k')).toBe(1200);
    expect(parseParam(q, '3')).toBe(3);
  });

  it('snap to three significant figures inside the range', () => {
    expect(snapParam(cutoff, 1234.5)).toBe(1230);
    expect(snapParam(cutoff, 42.37)).toBe(42.4);
    expect(snapParam(cutoff, 3)).toBe(20);
    expect(snapParam(cutoff, 1e9)).toBe(20000);
    expect(snapParam(cutoff, NaN)).toBe(20);
    expect(snapParam(time, 0.0012345)).toBe(0.00123);
  });

  it('turn by ratio: equal travel multiplies by the same factor anywhere on the knob', () => {
    // 20 Hz–20 kHz is ×1000: a tenth of the travel is ×1000^0.1, about ×2.
    const step = 1000 ** 0.1;
    expect(turnBy(cutoff, 100, 0.1)).toBe(snapParam(cutoff, 100 * step));
    expect(turnBy(cutoff, 5000, 0.1)).toBe(snapParam(cutoff, 5000 * step));
    expect(turnBy(cutoff, 5000, -0.1)).toBe(snapParam(cutoff, 5000 / step));
    expect(turnBy(cutoff, 300, 5)).toBe(20000);
    expect(turnBy(cutoff, 300, -5)).toBe(20);
    // A linear param turns by difference, as before.
    // 1 + 0.1 × 19.9, snapped to a thousandth of the range (0.0199), as a linear drag always was.
    expect(turnBy(q, 1, 0.1)).toBeCloseTo(2.985, 9);
  });

  it('step by ratio on keys: a hundredth of the travel, Shift a thousandth, Home and End the ends', () => {
    expect(keyedParam(cutoff, 'ArrowUp', false, 1000)).toBe(snapParam(cutoff, 1000 * 1000 ** 0.01));
    expect(keyedParam(cutoff, 'ArrowDown', true, 1000)).toBe(snapParam(cutoff, 1000 / 1000 ** 0.001));
    expect(keyedParam(cutoff, 'PageUp', false, 1000)).toBe(snapParam(cutoff, 1000 * 1000 ** 0.1));
    expect(keyedParam(cutoff, 'Home', false, 1000)).toBe(20);
    expect(keyedParam(cutoff, 'End', false, 1000)).toBe(20000);
    expect(keyedParam(cutoff, 'a', false, 1000)).toBeUndefined();
  });

  it('give cable depth in octaves: reach ±log2(max / min), snapped to hundredths', () => {
    expect(depthScale(cutoff)).toEqual({ range: Math.log2(1000), step: 0.01 });
    expect(formatDepth(cutoff, 3.17)).toBe('+3.17 oct');
    expect(formatDepth(cutoff, -1.5)).toBe('−1.50 oct');
    expect(formatDepth(cutoff, 1)).toBe('+1.00 oct');
    // Keys step in octaves, snapped once: 0.1 octave, Shift 0.01, Page keys ten times that, Home and End the reach.
    expect(keyedDepth(cutoff, 'ArrowDown', true, 3.17)).toBe(3.16);
    expect(keyedDepth(cutoff, 'ArrowUp', true, 3.17)).toBe(3.18);
    expect(keyedDepth(cutoff, 'ArrowUp', false, 3.17)).toBe(3.27);
    expect(keyedDepth(cutoff, 'ArrowLeft', false, 0.05)).toBe(-0.05);
    expect(keyedDepth(cutoff, 'PageUp', false, 3.17)).toBe(4.17);
    expect(keyedDepth(cutoff, 'PageDown', true, 3.17)).toBe(3.07);
    expect(keyedDepth(cutoff, 'End', false, 3.17)).toBe(Math.log2(1000));
    expect(keyedDepth(cutoff, 'Home', false, 3.17)).toBe(-Math.log2(1000));
    expect(keyedDepth(cutoff, 'ArrowUp', false, 9.9)).toBe(Math.log2(1000));
    expect(keyedDepth(cutoff, 'x', false, 3.17)).toBeUndefined();
    // Many Shift steps one way go a hundredth each, never stuck.
    let depth = 3.17;
    for (let i = 0; i < 50; i++) depth = keyedDepth(cutoff, 'ArrowDown', true, depth)!;
    expect(depth).toBe(2.67);
    // A linear param's depth keys over ±its range, as before.
    // A hundredth of the reach (0.398) from 3, snapped to a thousandth of it (0.0398): 85 × 0.0398.
    expect(keyedDepth(q, 'ArrowUp', false, 3)).toBe(3.383);
    // A linear param's depth is in its unit.
    expect(depthScale(q)).toEqual({ range: 19.9, step: undefined });
    expect(formatDepth(q, 3)).toBe('+3.00');
  });
});
