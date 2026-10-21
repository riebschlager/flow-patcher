import { describe, expect, it } from 'vitest';
import { makeNote } from '../src';
import { query, ticks } from './helpers';

describe('make-note', () => {
  it('turns each trigger into a note, keeping time, channel and fields', () => {
    const { note } = query(makeNote, 0, 1, { params: { pitch: 67, velocity: 0.5, length: 0.1 }, inputs: { trigger: ticks([0, 0.5], 3) } });
    expect(note).toEqual([
      { time: 0, channel: 3, index: 0, pitch: 67, velocity: 0.5, duration: 0.1 },
      { time: 0.5, channel: 3, index: 1, pitch: 67, velocity: 0.5, duration: 0.1 },
    ]);
  });

  it('clamps params into range', () => {
    const [n] = query(makeNote, 0, 1, { params: { pitch: 500, velocity: -1, length: 0 }, inputs: { trigger: ticks([0]) } }).note!;
    expect(n).toMatchObject({ pitch: 127, velocity: 0, duration: 0.01 });
  });

  it('emits nothing without triggers', () => {
    expect(query(makeNote, 0, 1).note).toEqual([]);
  });
});
