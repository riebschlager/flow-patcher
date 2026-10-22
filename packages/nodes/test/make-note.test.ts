import { describe, expect, it } from 'vitest';
import { compareEvents } from '@flow-patcher/engine';
import { makeNote } from '../src';
import { query, queryTiled, ticks } from './helpers';

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

  it('reads modulated pitch, velocity and length at each trigger\'s time and channel', () => {
    const triggers = [...ticks([0, 0.25, 0.5, 0.75], 0), ...ticks([0, 0.25, 0.5, 0.75], 1)].sort(compareEvents);
    const mods = {
      // Channel 1 an octave up; channel 0 up a tone from 0.5 s.
      pitch: [{ depth: 1, signal: (t: number, channel: number) => (channel === 1 ? 12 : t >= 0.5 ? 2 : 0) }],
      velocity: [{ depth: 0.5, signal: (_t: number, channel: number) => channel }],
      length: [{ depth: 1, signal: () => 100 }],
    };
    const options = { params: { pitch: 60, velocity: 0.5, length: 0.25 }, inputs: { trigger: triggers }, mods };
    const note = query(makeNote, 0, 1, options).note!;
    const by = (channel: number) => note.filter((n) => n.channel === channel);
    expect(by(0).map((n) => n.pitch)).toEqual([60, 60, 62, 62]);
    expect(by(1).map((n) => n.pitch)).toEqual([72, 72, 72, 72]);
    expect(by(0).every((n) => n.velocity === 0.5) && by(1).every((n) => n.velocity === 1)).toBe(true);
    expect(note.every((n) => n.duration === 8)).toBe(true);
    const tiled = queryTiled(makeNote, 'note', 1, 0.1, { ...options, inputsFor: (t0, t1) => ({ trigger: triggers.filter((e) => e.time >= t0 && e.time < t1) }) });
    expect(tiled).toEqual(note);
  });

  it('sums cables into a param, rounds to its step and ignores non-finite cables', () => {
    const mods = { pitch: [{ depth: 1, signal: () => 0.3 }, { depth: 2, signal: () => 0.2 }, { depth: 1, signal: () => NaN }] };
    expect(query(makeNote, 0, 1, { params: { pitch: 60 }, inputs: { trigger: ticks([0]) }, mods }).note![0]!.pitch).toBe(61);
  });

  it('emits nothing without triggers', () => {
    expect(query(makeNote, 0, 1).note).toEqual([]);
  });
});
