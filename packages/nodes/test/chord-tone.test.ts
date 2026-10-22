import { describe, expect, it } from 'vitest';
import { compareEvents, type EngineEvent } from '@flow-patcher/engine';
import { chordTone, clock, progression } from '../src';
import { parseChord, pitchesForRange } from '../src/music';
import { context, query, queryTiled, ticks } from './helpers';

const pitches = (events: EngineEvent[] | undefined) => (events ?? []).map((e) => e.pitch);
/** A Position signal that is the same on every channel. */
const position = (f: (t: number) => number) => ({ position: [(t: number) => f(t)] });

describe('chord-tone node', () => {
  it('maps Position across the own chord and octave range, keeping the trigger\'s fields', () => {
    // Cmaj7 over one octave up: 48 52 55 59 60 64 67 71.
    const signals = position((t) => t);
    const note = query(chordTone, 0, 1, { inputs: { trigger: ticks([0, 0.2, 0.5, 0.99], 2) }, signals }).note!;
    expect(pitches(note)).toEqual([48, 52, 60, 71]);
    expect(note[0]).toEqual({ time: 0, channel: 2, index: 0, pitch: 48, velocity: 0.8, duration: 0.25 });
  });

  it('plays the lowest tone with no Position cable', () => {
    expect(pitches(query(chordTone, 0, 1, { params: { symbol: 'Am', down: 1 }, inputs: { trigger: ticks([0, 0.5]) } }).note)).toEqual([45, 45]);
  });

  it('reads the chord on its Chord cable at each trigger\'s time', () => {
    const values = { chord: (t: number) => (t < 0.5 ? { symbol: 'Dm', pitches: parseChord('Dm') } : 'G7') };
    const note = query(chordTone, 0, 1, { params: { symbol: 'C', up: 0 }, inputs: { trigger: ticks([0, 0.25, 0.5, 0.75]) }, values, signals: position(() => 1) }).note!;
    expect(pitches(note)).toEqual([57, 57, 65, 65]);
  });

  it('falls back to its own chord when the cable carries no chord, and drops triggers with no chord at all', () => {
    const values = { chord: (t: number) => (t < 0.5 ? undefined : 'nope') };
    const inputs = { trigger: ticks([0, 0.75]) };
    expect(pitches(query(chordTone, 0, 1, { params: { symbol: 'E' }, inputs, values }).note)).toEqual([52, 52]);
    expect(query(chordTone, 0, 1, { params: { symbol: 'H9' }, inputs, values }).note).toEqual([]);
    expect(query(chordTone, 0, 1, { params: { symbol: 'H9' }, inputs, values: { chord: () => 'F' } }).note!.map((e) => e.pitch)).toEqual([53, 53]);
  });

  it('reads Position and the octave range per channel, with modulation', () => {
    const triggers = [...ticks([0, 0.5], 0), ...ticks([0, 0.5], 1)].sort(compareEvents);
    const signals = { position: [(_t: number, channel: number) => (channel ? 1 : 0)] };
    // Channel 1 gets two more octaves down and up.
    const mods = { down: [{ depth: 2, signal: (_t: number, c: number) => c }], up: [{ depth: 2, signal: (_t: number, c: number) => c }] };
    const note = query(chordTone, 0, 1, { params: { symbol: 'C', down: 0, up: 0 }, inputs: { trigger: triggers }, signals, mods }).note!;
    expect(note.filter((e) => e.channel === 0).map((e) => e.pitch)).toEqual([48, 48]);
    expect(note.filter((e) => e.channel === 1).map((e) => e.pitch)).toEqual([79, 79]);
  });

  it('modulates velocity and length like Make Note', () => {
    const mods = { velocity: [{ depth: 1, signal: () => -0.3 }], length: [{ depth: 1, signal: () => 100 }] };
    const [n] = query(chordTone, 0, 1, { params: { velocity: 0.5 }, inputs: { trigger: ticks([0]) }, mods }).note!;
    expect(n).toMatchObject({ velocity: 0.2, duration: 8 });
  });

  it('handles odd input without throwing', () => {
    const inputs = { trigger: ticks([0, 0.5]) };
    // NaN position counts as 0 (the context zeroes non-finite cables); out-of-range position clamps.
    expect(pitches(query(chordTone, 0, 1, { inputs, signals: position(() => NaN) }).note)).toEqual([48, 48]);
    expect(pitches(query(chordTone, 0, 1, { inputs, signals: position(() => -5) }).note)).toEqual([48, 48]);
    expect(pitches(query(chordTone, 0, 1, { inputs, signals: position(() => 1e9) }).note)).toEqual([71, 71]);
    // Out-of-range and non-finite octaves resolve to the knob's range and defaults.
    expect(pitches(query(chordTone, 0, 1, { params: { down: 99, up: NaN }, inputs, signals: position(() => 0) }).note)).toEqual([12, 12]);
    // A chord whose pitches all fall outside MIDI gives no note.
    expect(query(chordTone, 0, 1, { params: { down: 0, up: 0 }, inputs, values: { chord: () => ({ pitches: [200, 300] }) } }).note).toEqual([]);
    expect(query(chordTone, 0, 1, { inputs: {} }).note).toEqual([]);
    expect(query(chordTone, 0, 1, { inputs: { trigger: [] } }).note).toEqual([]);
  });

  it('is independent of windowing, fed by a real Clock and Progression', () => {
    const clockCtx = context(clock, { params: { bpm: 150, division: '1/16' } });
    const tick = clock.query!({ ...clockCtx, inputs: {}, pushed: {}, t0: 0, t1: 10 }).tick!;
    const transport = (t: number) => clock.value!(clockCtx, 'transport', t);
    const progCtx = context(progression, { params: { chords: 'Dm9, G9, Cmaj9, Am9', beats: 2 }, values: { transport } });
    const values = { chord: (t: number) => progression.value!(progCtx, 'chord', t) };
    const options = { params: { down: 1, up: 1 }, values, signals: position((t) => (t * 0.37) % 1) };
    const whole = query(chordTone, 0, 10, { ...options, inputs: { trigger: tick } }).note!;
    expect(whole.length).toBe(tick.length);
    const inputsFor = (t0: number, t1: number) => ({ trigger: tick.filter((e) => e.time >= t0 && e.time < t1) });
    expect(queryTiled(chordTone, 'note', 10, 0.025, { ...options, inputsFor })).toEqual(whole);
    expect(queryTiled(chordTone, 'note', 10, 0.1, { ...options, inputsFor })).toEqual(whole);
    // Every note is a tone of the chord in force at its tick.
    for (const n of whole) {
      const chord = progression.value!(progCtx, 'chord', n.time) as { pitches: number[] };
      expect(pitchesForRange(chord.pitches, { down: 1, up: 1 })).toContain(n.pitch);
    }
  });
});
