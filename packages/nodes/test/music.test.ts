// Flow's checks/progressions.test.mjs and checks/octaves.test.mjs, ported.
import { describe, expect, it } from 'vitest';
import {
  chordError,
  chordFromValue,
  chordSymbols,
  INSTRUMENT_GROUPS,
  INSTRUMENT_KEYS,
  INSTRUMENTS,
  instrumentFile,
  instrumentFor,
  normalizeOctaveRange,
  parseChord,
  parseProgression,
  pitchesForRange,
  pitchForPosition,
  progressionError,
  PROGRESSIONS,
  softEnvelope,
} from '../src/music';

const chord = (symbol: string) => {
  const pitches = parseChord(symbol);
  if (!pitches) throw new Error(`not a chord: ${symbol}`);
  return pitches;
};

describe('parseChord (from Flow checks/progressions.test.mjs)', () => {
  it('gives exact extended-chord pitches', () => {
    expect(parseChord('Cmaj9')).toEqual([48, 52, 55, 59, 62]);
    expect(parseChord('Dm9')).toEqual([50, 53, 57, 60, 64]);
    expect(parseChord('G9')).toEqual([55, 59, 62, 65, 69]);
    expect(parseChord('Fm6')).toEqual([53, 56, 60, 62]);
    expect(parseChord('C6')).toEqual([48, 52, 55, 57]);
    expect(parseChord('C')).toEqual([48, 52, 55]);
    expect(parseChord('Cadd9')).toEqual([48, 52, 55, 62]);
  });

  it('gives diminished, suspended and degree-sign shapes', () => {
    const shapes: Record<string, number[]> = { Cdim: [48, 51, 54], Cdim7: [48, 51, 54, 57], Csus2: [48, 50, 55], Csus4: [48, 53, 55], Csus: [48, 53, 55], 'C°': [48, 51, 54], 'C°7': [48, 51, 54, 57] };
    for (const [symbol, notes] of Object.entries(shapes)) expect(parseChord(symbol), symbol).toEqual(notes);
  });

  it('treats enharmonics alike and wraps the root into 48–59', () => {
    expect(parseChord('Bbmaj9')).toEqual(parseChord('A#maj9'));
    for (const quality of ['dim', 'dim7', 'sus2', 'sus4']) expect(parseChord(`F#${quality}`)).toEqual(parseChord(`Gb${quality}`));
    // Cb is B, so its root wraps up to 59 rather than below C.
    expect(parseChord('Cb7')).toEqual([59, 63, 66, 69]);
    expect(parseChord('  Am7 ')).toEqual(parseChord('Am7'));
  });

  it('rejects malformed chords with null (Flow threw)', () => {
    for (const bad of ['Cmaj99', 'Cm69', 'Cdim9', 'G9junk', 'H9', 'F6/9', '', 'c', 'Cmaj']) expect(parseChord(bad), bad).toBeNull();
    expect(chordError('H9')).toMatch(/isn't a chord/);
    expect(chordError('Am7')).toBeNull();
  });
});

describe('progressions (from Flow checks/progressions.test.mjs)', () => {
  it('has all fifteen of Flow\'s presets, four chords each', () => {
    expect(Object.keys(PROGRESSIONS)).toHaveLength(15);
    expect(PROGRESSIONS.Daydream).toBe('Cmaj7, Am7, Fmaj7, G');
    for (const [name, text] of Object.entries(PROGRESSIONS)) {
      expect(progressionError(text), name).toBeNull();
      expect(chordSymbols(text), name).toHaveLength(4);
    }
  });

  it('gives every preset chord a full canvas range of valid MIDI pitches on its own pitch classes', () => {
    for (const text of Object.values(PROGRESSIONS)) {
      for (const { symbol, pitches } of parseProgression(text)) {
        const classes = new Set(pitches.map((n) => n % 12));
        const range = pitchesForRange(pitches, { down: 3, up: 3 });
        expect(range.every((p) => p >= 0 && p <= 127 && classes.has(p % 12)), symbol).toBe(true);
      }
    }
  });

  it('splits chord strings on commas, spaces, bars and arrows, and skips unknown symbols', () => {
    expect(chordSymbols('Cmaj7, Am7 | Fmaj7 → G  Dm')).toEqual(['Cmaj7', 'Am7', 'Fmaj7', 'G', 'Dm']);
    expect(parseProgression('C, nope, Am').map((c) => c.symbol)).toEqual(['C', 'Am']);
    expect(parseProgression('C, Am')[1]).toEqual({ symbol: 'Am', pitches: [57, 60, 64] });
    expect(parseProgression('')).toEqual([]);
    expect(progressionError('  ,  ')).toMatch(/one or more/);
    expect(progressionError('C, nope')).toMatch(/"nope"/);
  });
});

describe('octave ranges (from Flow checks/octaves.test.mjs)', () => {
  it('normalizes the octave range', () => {
    expect(normalizeOctaveRange()).toEqual({ down: 0, up: 1 });
    expect(normalizeOctaveRange({ down: -9, up: 99 })).toEqual({ down: 0, up: 3 });
    expect(normalizeOctaveRange({ down: NaN, up: Infinity })).toEqual({ down: 0, up: 1 });
    expect(normalizeOctaveRange({ down: 1.6, up: 0.4 })).toEqual({ down: 2, up: 0 });
  });

  it('spans the range, with the base-only mode giving the chord itself', () => {
    expect(pitchesForRange(chord('Cmaj7'))).toEqual([48, 52, 55, 59, 60, 64, 67, 71]);
    expect(pitchesForRange(chord('C'), { down: 0, up: 0 })).toEqual(chord('C'));
  });

  it('has exact endpoints and clamps the position', () => {
    expect(pitchForPosition(chord('C'), 0, { down: 2, up: 3 })).toBe(24);
    expect(pitchForPosition(chord('C'), 1, { down: 2, up: 3 })).toBe(91);
    // Flow's voice 2 dropped an octave; the same chord an octave down reaches MIDI 0.
    expect(pitchForPosition(chord('C').map((p) => p - 12), 0, { down: 3, up: 3 })).toBe(0);
    expect(pitchForPosition(chord('C'), -2)).toBe(48);
    expect(pitchForPosition(chord('C'), 2)).toBe(67);
    expect(pitchForPosition(chord('C'), NaN)).toBe(48);
    expect(pitchForPosition([], 0.5)).toBeNull();
  });

  it('keeps chord tones, valid MIDI pitches and a monotonic left-to-right mapping for every chord and range', () => {
    const symbols = [...new Set([...Object.values(PROGRESSIONS).flatMap(chordSymbols), 'Cadd9', 'Badd9', 'F#sus2', 'Bbsus4', 'Cb7'])];
    let cases = 0;
    for (const symbol of symbols) {
      // Flow's voices 0–3: voice 2 sat an octave lower.
      for (const shift of [0, -12]) {
        const base = chord(symbol).map((p) => p + shift);
        const classes = new Set(base.map((n) => n % 12));
        for (let down = 0; down <= 3; down++) {
          for (let up = 0; up <= 3; up++) {
            const range = { down, up };
            const notes = pitchesForRange(base, range);
            expect(notes.length).toBeGreaterThanOrEqual(3);
            expect(new Set(notes).size).toBe(notes.length);
            expect(notes.every((n, i) => Number.isInteger(n) && n >= 0 && n <= 127 && classes.has(n % 12) && (i === 0 || n > notes[i - 1]!)), `${symbol} ${shift} ${down}/${up}`).toBe(true);
            // One assertion per sweep: hundreds of thousands of expect() calls time out on CI.
            const swept = Array.from({ length: 101 }, (_, i) => pitchForPosition(base, i / 100, range));
            const bad = swept.filter((n, i) => n === null || !notes.includes(n) || (i > 0 && n < swept[i - 1]!));
            expect(bad, `${symbol} ${shift} ${down}/${up} sweep`).toEqual([]);
            expect(pitchForPosition(base, 0, range)).toBe(notes[0]);
            expect(pitchForPosition(base, 1, range)).toBe(notes.at(-1));
            cases++;
          }
        }
      }
    }
    expect(cases).toBe(symbols.length * 2 * 16);
  });

  it('skips pitches outside MIDI and non-finite ones', () => {
    expect(pitchesForRange([120, 124, NaN], { down: 0, up: 1 })).toEqual([120, 124]);
    expect(pitchesForRange([2, 5], { down: 1, up: 0 })).toEqual([2, 5]);
  });
});

describe('chordFromValue', () => {
  it('reads a Chord, a symbol, or nothing', () => {
    expect(chordFromValue({ symbol: 'Am', pitches: [57, 60, 64] })).toEqual([57, 60, 64]);
    expect(chordFromValue('Dm')).toEqual([50, 53, 57]);
    expect(chordFromValue({ pitches: [60, NaN, 'x', 64] })).toEqual([60, 64]);
    for (const bad of [undefined, null, 3, 'nope', {}, { pitches: [] }, { pitches: 'C' }, [60, 64]]) expect(chordFromValue(bad), JSON.stringify(bad)).toBeNull();
  });
});

// Flow's checks/soundscapes.test.mjs and checks/chaos-voices.test.mjs, the parts
// that test the instrument table and softEnvelope. Soundscapes, chaos and color
// voices weren't ported. The sample files themselves are checked in instruments.test.ts.
describe('instruments', () => {
  it('has Flow\'s 28 instruments in five groups, and only them', () => {
    expect(INSTRUMENT_KEYS).toHaveLength(28);
    expect(INSTRUMENT_GROUPS).toHaveLength(5);
    for (const key of INSTRUMENT_KEYS) expect(INSTRUMENT_GROUPS).toContain(INSTRUMENTS[key]!.group);
    expect(instrumentFor('chaos')).toBeUndefined();
    expect(instrumentFor('toString')).toBeUndefined();
    expect(instrumentFor('missing')).toBeUndefined();
    expect(instrumentFor('vibes')?.name).toBe('Vibraphone');
    expect(new Set(INSTRUMENT_KEYS.map((k) => INSTRUMENTS[k]!.file)).size).toBe(28);
    expect(instrumentFile(INSTRUMENTS.piano!)).toBe('0000_FluidR3_GM_sf2_file.js');
  });

  it('has eight experimental textures with soft envelopes and valid sweeps', () => {
    const experimental = INSTRUMENT_KEYS.filter((k) => INSTRUMENTS[k]!.group === 'Experimental textures');
    expect(experimental).toHaveLength(8);
    for (const key of experimental) {
      const voice = INSTRUMENTS[key]!;
      expect(voice.attack).toBeGreaterThanOrEqual(0.18);
      expect(['lowpass', 'bandpass']).toContain(voice.tone!.type);
      expect(voice.tone!.from).toBeGreaterThanOrEqual(80);
      expect(voice.tone!.to).toBeGreaterThanOrEqual(80);
      expect(voice.tone!.time).toBeGreaterThan(0);
      expect(voice.tone!.q).toBeLessThanOrEqual(1);
    }
  });

  it('gives every soft voice an envelope that fits its duration', () => {
    const soft = INSTRUMENT_KEYS.map((k) => INSTRUMENTS[k]!).filter((v) => v.attack !== undefined);
    expect(soft).toHaveLength(20);
    for (const voice of soft) {
      const envelope = softEnvelope({ attack: voice.attack!, duration: voice.duration!, release: voice.release! });
      expect(envelope.every((s) => s.duration >= 0 && s.volume >= 0 && s.volume <= 1)).toBe(true);
      expect(Math.abs(envelope.reduce((sum, s) => sum + s.duration, 0) - voice.duration!)).toBeLessThan(1e-8);
      expect(envelope[0]!.volume).toBe(0);
      expect(envelope.at(-1)!.volume).toBe(0);
    }
  });

  it('never gives a negative hold for a voice shorter than its stages', () => {
    const envelope = softEnvelope({ attack: 1, duration: 1, release: 1 });
    expect(envelope[3]!.duration).toBe(0);
  });
});
