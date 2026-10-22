import { describe, expect, it } from 'vitest';
import { compilePatch, presetFor, Runtime, type EngineEvent, type ParamValue, type Patch, type TextParamSpec } from '@flow-patcher/engine';
import { clock, nodeRegistry, progression } from '../src';
import { PROGRESSIONS, type Chord } from '../src/music';
import { chordAtBeat } from '../src/progression';
import { context, query, type ContextOptions } from './helpers';

/** A Clock instance queried by hand, for its Transport. */
function clockInstance(params: Record<string, unknown> = {}) {
  const ctx = context(clock, { params });
  return {
    query: (t0: number, t1: number) => clock.query!({ ...ctx, inputs: {}, t0, t1 }).tick ?? [],
    beat: (t: number) => clock.value!(ctx, 'transport', t) as number,
  };
}

/** Progression's chord at t, with the given wiring. */
const chordAt = (options: ContextOptions, t: number) => progression.value!(context(progression, options), 'chord', t) as Chord | undefined;
const symbolAt = (options: ContextOptions, t: number) => chordAt(options, t)?.symbol;

describe('chordAtBeat', () => {
  const chords: Chord[] = ['C', 'F', 'G'].map((symbol) => ({ symbol, pitches: [] }));
  const at = (beat: number, beats = 4) => chordAtBeat(chords, beat, beats)?.symbol;

  it('steps every `beats` beats and loops', () => {
    expect([0, 3.99, 4, 7.5, 8, 11.9, 12, 16, 100].map((b) => at(b))).toEqual(['C', 'C', 'F', 'F', 'G', 'G', 'C', 'F', 'F']);
    expect(at(2, 1)).toBe('G');
  });

  it('counts a beat a hair below a boundary as on it', () => {
    expect(at(4 - 1e-12)).toBe('F');
    expect(at(4 - 1e-6)).toBe('C');
  });

  it('holds the first chord before beat 0 and on bad input', () => {
    expect(at(-5)).toBe('C');
    expect(at(NaN)).toBe('C');
    expect(at(Infinity)).toBe('C');
    expect(at(5, 0)).toBe('C');
    expect(at(5, NaN)).toBe('C');
    expect(at(1e300, 1e-300)).toBe('C');
    expect(chordAtBeat([], 3, 4)).toBeUndefined();
  });
});

describe('progression node', () => {
  it('offers Flow\'s progressions as presets of its chord string, defaulting to Daydream', () => {
    const spec = progression.params.find((p) => p.name === 'chords') as TextParamSpec;
    expect(spec.presets).toBe(PROGRESSIONS);
    expect(presetFor(spec, spec.default)).toBe('Daydream');
    expect(presetFor(spec, 'Am, Dm')).toBe('Custom');
    expect(spec.check!('Am, H9')).toMatch(/"H9"/);
  });

  it('outputs the chord with its pitches', () => {
    const c = clockInstance({ bpm: 120 });
    c.query(0, 10);
    expect(chordAt({ params: { chords: 'Am, Dm7', beats: 2 }, values: { transport: c.beat } }, 1.2)).toEqual({ symbol: 'Dm7', pitches: [50, 53, 57, 60] });
  });

  it('changes chord on the beat of its Transport', () => {
    // 120 bpm: a beat every 0.5 s, so 2 beats per chord is a chord a second.
    const c = clockInstance({ bpm: 120 });
    c.query(0, 10);
    const options = { params: { chords: 'C, F, G, Am', beats: 2 }, values: { transport: c.beat } };
    expect([0, 0.99, 1, 2.5, 3, 4, 7.2].map((t) => symbolAt(options, t))).toEqual(['C', 'C', 'F', 'G', 'Am', 'C', 'Am']);
  });

  it('follows its own Transport, so two Clocks run two tempos', () => {
    const slow = clockInstance({ bpm: 60 }), fast = clockInstance({ bpm: 240 });
    slow.query(0, 4);
    fast.query(0, 4);
    const params = { chords: 'C, F', beats: 4 };
    expect(symbolAt({ params, values: { transport: slow.beat } }, 1.5)).toBe('C');
    expect(symbolAt({ params, values: { transport: fast.beat } }, 1.5)).toBe('F');
  });

  it('holds its first chord with no Transport cable, or one that carries no beat (ADR 0018)', () => {
    const params = { chords: 'Dm9, G9', beats: 1 };
    for (const t of [0, 1, 5, 1000]) expect(symbolAt({ params }, t)).toBe('Dm9');
    expect(symbolAt({ params, values: { transport: () => 'x' } }, 5)).toBe('Dm9');
    expect(symbolAt({ params, values: { transport: () => NaN } }, 5)).toBe('Dm9');
    expect(symbolAt({ params, values: { transport: () => -3 } }, 5)).toBe('Dm9');
  });

  it('skips unknown chords, and gives no chord when none is usable', () => {
    const transport = (t: number) => t;
    expect([0, 1, 2].map((t) => symbolAt({ params: { chords: 'C, nope, G', beats: 1 }, values: { transport } }, t))).toEqual(['C', 'G', 'C']);
    expect(chordAt({ params: { chords: 'nope' } }, 0)).toBeUndefined();
    expect(chordAt({ params: { chords: '' } }, 0)).toBeUndefined();
    expect(chordAt({ params: { chords: 42 } }, 0)?.symbol).toBe('Cmaj7');
    expect(progression.value!(context(progression), 'other', 0)).toBeUndefined();
  });

  it('reads a modulated beats-per-chord at the read time, rounded and clamped', () => {
    const transport = (t: number) => t;
    const mods = { beats: [{ depth: 1, signal: (t: number) => (t < 10 ? 0 : -100) }] };
    const options = { params: { chords: 'C, F, G', beats: 2.6 }, values: { transport }, mods };
    // 3 beats per chord before 10 s; 1 after.
    expect([2.9, 3, 9.5, 10, 11].map((t) => symbolAt(options, t))).toEqual(['C', 'F', 'C', 'F', 'G']);
  });

  it('emits no events', () => {
    expect(query(progression, 0, 10)).toEqual({});
  });

  // M1 gate check "Transport" (Progression half): the same chords in 25 ms windows and in one call.
  describe('gate: Transport', () => {
    const node = (id: string, type: string, params: Record<string, ParamValue> = {}) => ({ id, type, typeVersion: nodeRegistry.get(type)!.version, params, position: { x: 0, y: 0 } });
    const patch: Patch = {
      format: 'flowpatch',
      version: 1,
      seed: 3,
      nodes: [
        node('clock', 'clock', { bpm: 137, division: '1/8', swing: 0.2 }),
        node('prog', 'progression', { chords: PROGRESSIONS['Passing cloud'], beats: 3 }),
        node('tone', 'chord-tone', { down: 1, up: 2 }),
      ],
      cables: [
        { from: { node: 'clock', port: 'transport' }, to: { node: 'prog', port: 'transport' } },
        { from: { node: 'clock', port: 'tick' }, to: { node: 'tone', port: 'trigger' } },
        { from: { node: 'prog', port: 'chord' }, to: { node: 'tone', port: 'chord' } },
      ],
    };

    /** The chord Progression gives at every tick, read in the tick's own window as a downstream node would. */
    const chordsAtTicks = (step: number) => {
      const compiled = compilePatch(patch, nodeRegistry);
      if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
      const runtime = new Runtime(compiled.plan, { history: true });
      const log = [];
      const end = 20, windows = Math.ceil(end / step - 1e-9);
      for (let i = 0; i < windows; i++) log.push(...runtime.query(i * step, Math.min(end, (i + 1) * step)));
      return log.filter((e) => e.node === 'tone').map((e) => [e.time, e.pitch]);
    };

    it('gives the same chord tones over 20 s in 25 ms windows, 100 ms windows and one call', () => {
      const whole = chordsAtTicks(20);
      expect(whole.length).toBeGreaterThan(80);
      expect(chordsAtTicks(0.025)).toEqual(whole);
      expect(chordsAtTicks(0.1)).toEqual(whole);
    });

    it('reads the same chords at each tick from a Clock queried in 25 ms windows and in one call', () => {
      const tiled = clockInstance({ bpm: 137, division: '1/8', swing: 0.2 });
      const once = clockInstance({ bpm: 137, division: '1/8', swing: 0.2 });
      const ticks: EngineEvent[] = once.query(0, 20);
      const params = { chords: PROGRESSIONS['Passing cloud'], beats: 3 };
      const read = (beat: (t: number) => number, t: number) => symbolAt({ params, values: { transport: beat } }, t);
      const expected = ticks.map((e) => read(once.beat, e.time));
      // Each tiled window reads its own ticks right after the Clock ran it, as the runtime does.
      const got: (string | undefined)[] = [];
      for (let i = 0; i < 800; i++) {
        const t0 = i * 0.025, t1 = (i + 1) * 0.025;
        tiled.query(t0, t1);
        for (const e of ticks) if (e.time >= t0 && e.time < t1) got.push(read(tiled.beat, e.time));
      }
      expect(got).toEqual(expected);
      expect(new Set(expected)).toEqual(new Set(['Cmaj7', 'C#dim7', 'Dm7', 'G7']));
      // Changes land on whole multiples of 3 beats.
      const changes = ticks.filter((e, i) => i > 0 && expected[i] !== expected[i - 1]).map((e) => once.beat(e.time));
      expect(changes.length).toBeGreaterThan(10);
      for (const beat of changes) expect(beat / 3).toBeCloseTo(Math.round(beat / 3), 9);
    });
  });
});
