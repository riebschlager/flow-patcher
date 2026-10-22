// Music-theory helpers ported from Flow's music.js (`parseChord`,
// `progressions`, `normalizeOctaveRange`, `pitchesForRange`,
// `pitchForPosition`), shared by Progression and Chord Tone.
// Changes from Flow:
// - `parseChord` returns null for an unknown symbol instead of throwing, so
//   weird text gives a defined result; `chordError` gives the message.
// - `pitchesForRange` and `pitchForPosition` take the chord's pitches, not its
//   symbol, so a chord Value from a cable is used as is. Flow's `voice`
//   argument (voice 2 dropped an octave) is gone: Chord Tone's octave range
//   and a later Transpose node cover it.
// - `pitchForPosition` gives null for an empty pitch list instead of undefined.
// - Chord strings hold any number of chords, split on commas, spaces, `|` or
//   `→`; Flow's custom progression took exactly four, comma-separated.
// - The progression presets are keyed by Flow's display names, and their text
//   is the chord string a Progression's param holds.

/** The current chord, as a Progression outputs it on a Value cable. */
export interface Chord {
  /** The symbol as written, such as "Cmaj7". */
  symbol: string;
  /** MIDI pitches from the root, which is in the octave from C3 (48) to B3 (59). */
  pitches: number[];
}

const ROOTS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Semitones above the root for each quality; no quality is a major triad. */
const SHAPES: Record<string, readonly number[]> = {
  '': [0, 4, 7],
  dim: [0, 3, 6], dim7: [0, 3, 6, 9], '°': [0, 3, 6], '°7': [0, 3, 6, 9],
  sus: [0, 5, 7], sus2: [0, 2, 7], sus4: [0, 5, 7],
  maj9: [0, 4, 7, 11, 14], m9: [0, 3, 7, 10, 14], 9: [0, 4, 7, 10, 14],
  6: [0, 4, 7, 9], m6: [0, 3, 7, 9],
  maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], m: [0, 3, 7], 7: [0, 4, 7, 10],
  add9: [0, 4, 7, 14],
};

const CHORD = /^([A-G])([#b]?)(maj9|maj7|dim7|dim|°7|°|m9|m7|m6|m|9|7|6|sus2|sus4|sus|add9)?$/;

export const CHORD_HINT = 'Try Cmaj7, Am7, Bdim, C#dim7, Dsus2, or Gsus4 (sus means sus4).';

/** The pitches of a chord symbol, root in 48–59; null when it isn't one. */
export function parseChord(symbol: string): number[] | null {
  const m = CHORD.exec(symbol.trim());
  if (!m) return null;
  const root = (ROOTS[m[1]!]! + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
  return SHAPES[m[3] ?? '']!.map((n) => 48 + root + n);
}

/** The chord symbols in a chord string, in order (unchecked). */
export const chordSymbols = (text: string): string[] => text.split(/[\s,|→]+/).filter(Boolean);

/** The usable chords in a chord string; unknown symbols are skipped. */
export function parseProgression(text: string): Chord[] {
  const chords: Chord[] = [];
  for (const symbol of chordSymbols(text)) {
    const pitches = parseChord(symbol);
    if (pitches) chords.push({ symbol, pitches });
  }
  return chords;
}

/** An error message for a chord string with no chords or an unknown one, else null. */
export function progressionError(text: string): string | null {
  const symbols = chordSymbols(text);
  if (!symbols.length) return `Enter one or more chords. ${CHORD_HINT}`;
  const bad = symbols.find((s) => !parseChord(s));
  return bad === undefined ? null : `"${bad}" isn't a chord. ${CHORD_HINT}`;
}

/** An error message for a single chord symbol, else null. */
export const chordError = (symbol: string): string | null =>
  parseChord(symbol) ? null : `"${symbol.trim()}" isn't a chord. ${CHORD_HINT}`;

/** Flow's progressions, by display name, as chord strings. */
export const PROGRESSIONS: Readonly<Record<string, string>> = Object.fromEntries(
  ([
    ['Daydream', ['Cmaj7', 'Am7', 'Fmaj7', 'G']],
    ['Weightless', ['Dmaj7', 'A', 'Bm7', 'Gmaj7']],
    ['After hours', ['Am7', 'Fmaj7', 'Cmaj7', 'Em7']],
    ['Open water', ['Fmaj7', 'Cmaj7', 'Em7', 'Am7']],
    ['Still light', ['Dbmaj9', 'Fm7', 'Bbm9', 'Gbmaj9']],
    ['Tidal glass', ['Dsus2', 'Aadd9', 'Gmaj7', 'Esus4']],
    ['Blue hour', ['Dm9', 'G9', 'Cmaj9', 'Am9']],
    ['Dorian bloom', ['Dm9', 'G6', 'Em7', 'G6']],
    ['Velvet undertow', ['Am9', 'Fmaj9', 'Dm9', 'Em7']],
    ['Borrowed light', ['Cmaj9', 'Em7', 'Fmaj9', 'Fm6']],
    ['Chromatic orbit', ['Cmaj9', 'Abmaj9', 'Emaj9', 'Abmaj9']],
    ['Slow descent', ['Fmaj9', 'Em7', 'Dm9', 'C6']],
    ['Suspended sky', ['Csus2', 'Gsus4', 'Asus2', 'Fsus4']],
    ['Passing cloud', ['Cmaj7', 'C#dim7', 'Dm7', 'G7']],
    ['Dusk turn', ['Am', 'Bdim', 'E7', 'Am']],
  ] as const).map(([name, chords]) => [name, chords.join(', ')]),
);

export interface OctaveRange {
  /** Octaves below the chord, 0–3. */
  down: number;
  /** Octaves above the chord, 0–3. */
  up: number;
}

const octaves = (x: number | undefined, fallback: number) =>
  x !== undefined && Number.isFinite(x) ? Math.max(0, Math.min(3, Math.round(x))) : fallback;

/** Clamps an octave range to whole octaves in 0–3; missing or non-finite sides default to 0 down, 1 up. */
export function normalizeOctaveRange({ down, up }: Partial<OctaveRange> = {}): OctaveRange {
  return { down: octaves(down, 0), up: octaves(up, 1) };
}

/**
 * The chord's pitches repeated from `down` octaves below to `up` above, without
 * duplicates, within MIDI 0–127, ascending. Non-finite pitches are skipped.
 */
export function pitchesForRange(chord: readonly number[], range: Partial<OctaveRange> = {}): number[] {
  const { down, up } = normalizeOctaveRange(range);
  const notes = new Set<number>();
  for (let octave = -down; octave <= up; octave++) {
    for (const note of chord) {
      const pitch = note + octave * 12;
      if (Number.isFinite(pitch) && pitch >= 0 && pitch <= 127) notes.add(pitch);
    }
  }
  // Extended chords overlap registers; always move upward from left to right.
  return [...notes].sort((a, b) => a - b);
}

/** The pitch at position x (0–1, clamped; non-finite is 0) across the range; null for no pitches. */
export function pitchForPosition(chord: readonly number[], x: number, range: Partial<OctaveRange> = {}): number | null {
  const notes = pitchesForRange(chord, range);
  if (!notes.length) return null;
  const position = Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
  return notes[Math.min(notes.length - 1, Math.floor(position * notes.length))]!;
}

/** A chord read off a Value cable: a Chord, or a symbol string. Anything else is null. */
export function chordFromValue(value: unknown): number[] | null {
  if (typeof value === 'string') return parseChord(value);
  if (typeof value !== 'object' || value === null) return null;
  const pitches = (value as Partial<Chord>).pitches;
  if (!Array.isArray(pitches)) return null;
  const finite = pitches.filter((p): p is number => typeof p === 'number' && Number.isFinite(p));
  return finite.length ? finite : null;
}

// Flow's instrument table (`instruments`, `instrumentGroups`, `softEnvelope`),
// for Sampled Voice. Changes from Flow:
// - No color voices: `chaos`, `isColorVoice` and `resolveColorVoice` are gone.
//   Picking a random instrument per note would be a node of its own.
// - `INSTRUMENT_KEYS` keeps the table's order, which is the menu's.
// - `softEnvelope` clamps its hold stage at 0, so a voice shorter than its
//   attack, swell and release never gives a negative duration.

/** An instrument's own filter sweep, applied per note before its envelope. */
export interface InstrumentTone {
  type: 'lowpass' | 'bandpass';
  /** Hz at the note's start. */
  from: number;
  /** Hz it ramps to (exponentially). */
  to: number;
  /** Seconds the ramp takes. */
  time: number;
  /** Flow's filter Q for the sweep. */
  q: number;
}

/** One of Flow's WebAudioFont instruments. */
export interface Instrument {
  /** Menu name. */
  name: string;
  /** The FluidR3 GM preset number: vendor/<file>_FluidR3_GM_sf2_file.js. */
  file: string;
  /** Per-instrument level that evens out loudness across the table. */
  gain: number;
  /** Menu group, one of INSTRUMENT_GROUPS. */
  group: string;
  /** Soft voices: Flow's swell (seconds), note length and release, for `softEnvelope`. */
  attack?: number;
  duration?: number;
  release?: number;
  tone?: InstrumentTone;
}

/** Menu groups, in Flow's order. */
export const INSTRUMENT_GROUPS: readonly string[] = ['Experimental textures', 'Pads & atmosphere', 'Strings & choir', 'Air & woodwind', 'Keys & bells'];

export const INSTRUMENTS: Readonly<Record<string, Instrument>> = {
  piano: { name: 'Grand piano', file: '0000', gain: 0.3, group: 'Keys & bells' },
  rhodes: { name: 'Electric piano', file: '0040', gain: 0.34, group: 'Keys & bells' },
  celesta: { name: 'Celesta', file: '0080', gain: 0.28, group: 'Keys & bells' },
  musicbox: { name: 'Music box', file: '0100', gain: 0.22, group: 'Keys & bells' },
  vibes: { name: 'Vibraphone', file: '0110', gain: 0.32, group: 'Keys & bells' },
  bells: { name: 'Tubular bells', file: '0140', gain: 0.2, group: 'Keys & bells' },
  strings: { name: 'Warm strings', file: '0480', gain: 0.13, group: 'Strings & choir' },
  pad: { name: 'Warm pad', file: '0890', gain: 0.26, group: 'Pads & atmosphere' },
  slowstrings: { name: 'Slow strings', file: '0490', gain: 0.18, group: 'Strings & choir', attack: 0.55, duration: 5, release: 1.5 },
  synthstrings: { name: 'Synth strings', file: '0500', gain: 0.2, group: 'Strings & choir', attack: 0.45, duration: 4.8, release: 1.4 },
  choir: { name: 'Choir aahs', file: '0520', gain: 0.17, group: 'Strings & choir', attack: 0.45, duration: 4.8, release: 1.4 },
  oohs: { name: 'Voice oohs', file: '0530', gain: 0.19, group: 'Strings & choir', attack: 0.4, duration: 4.6, release: 1.3 },
  flute: { name: 'Flute', file: '0730', gain: 0.25, group: 'Air & woodwind', attack: 0.18, duration: 3.8, release: 1 },
  panflute: { name: 'Pan flute', file: '0750', gain: 0.23, group: 'Air & woodwind', attack: 0.22, duration: 3.8, release: 1 },
  ocarina: { name: 'Ocarina', file: '0790', gain: 0.22, group: 'Air & woodwind', attack: 0.25, duration: 4, release: 1.1 },
  newage: { name: 'New age pad', file: '0880', gain: 0.075, group: 'Pads & atmosphere', attack: 0.75, duration: 3.8, release: 1.15, tone: { type: 'lowpass', from: 2800, to: 1700, time: 1.8, q: 0.45 } },
  choirpad: { name: 'Choir pad', file: '0910', gain: 0.19, group: 'Pads & atmosphere', attack: 0.65, duration: 5.2, release: 1.6 },
  bowedpad: { name: 'Bowed pad', file: '0920', gain: 0.2, group: 'Pads & atmosphere', attack: 0.6, duration: 5.2, release: 1.6 },
  halo: { name: 'Halo pad', file: '0940', gain: 0.21, group: 'Pads & atmosphere', attack: 0.7, duration: 5.4, release: 1.7 },
  sweeppad: { name: 'Sweep pad', file: '0950', gain: 0.2, group: 'Pads & atmosphere', attack: 0.75, duration: 5.4, release: 1.7 },
  prismrain: { name: 'Prism rain', file: '0960', gain: 0.2, group: 'Experimental textures', attack: 0.28, duration: 4.6, release: 1.4, tone: { type: 'lowpass', from: 1100, to: 6200, time: 2.2, q: 0.7 } },
  soundtrack: { name: 'Distant soundtrack', file: '0970', gain: 0.16, group: 'Experimental textures', attack: 0.8, duration: 6, release: 1.8, tone: { type: 'lowpass', from: 4300, to: 850, time: 3.5, q: 0.65 } },
  crystal: { name: 'Crystal bloom', file: '0980', gain: 0.23, group: 'Experimental textures', attack: 0.18, duration: 3.8, release: 1.2, tone: { type: 'lowpass', from: 7200, to: 1900, time: 2, q: 0.65 } },
  deepatmosphere: { name: 'Deep atmosphere', file: '0990', gain: 0.26, group: 'Experimental textures', attack: 0.4, duration: 6.2, release: 1.8, tone: { type: 'lowpass', from: 950, to: 4800, time: 3.3, q: 0.75 } },
  prismaticair: { name: 'Prismatic air', file: '1000', gain: 0.16, group: 'Experimental textures', attack: 0.32, duration: 4.5, release: 1.4, tone: { type: 'lowpass', from: 1500, to: 7500, time: 2.4, q: 0.65 } },
  alienchorus: { name: 'Alien chorus', file: '1010', gain: 0.16, group: 'Experimental textures', attack: 0.65, duration: 5.2, release: 1.6, tone: { type: 'bandpass', from: 450, to: 2300, time: 2.9, q: 0.65 } },
  echofragments: { name: 'Echo fragments', file: '1020', gain: 0.19, group: 'Experimental textures', attack: 0.25, duration: 4.2, release: 1.4, tone: { type: 'lowpass', from: 5800, to: 1500, time: 2.3, q: 0.7 } },
  orbitalsignal: { name: 'Orbital signal', file: '1030', gain: 0.2, group: 'Experimental textures', attack: 0.28, duration: 5, release: 1.5, tone: { type: 'bandpass', from: 1400, to: 420, time: 3, q: 0.45 } },
};

/** Instrument keys in menu order. */
export const INSTRUMENT_KEYS: readonly string[] = Object.keys(INSTRUMENTS);

/** The instrument for a key, or undefined; inherited Object properties ("toString") aren't instruments. */
export const instrumentFor = (key: string): Instrument | undefined => (Object.hasOwn(INSTRUMENTS, key) ? INSTRUMENTS[key] : undefined);

/** The vendored sample file behind an instrument, as `HostServices.samples` takes it. */
export const instrumentFile = (instrument: Instrument): string => `${instrument.file}_FluidR3_GM_sf2_file.js`;

/** One stage of a WebAudioFont envelope: ramp linearly to `volume` (0–1) over `duration` seconds. */
export interface EnvelopeStage {
  duration: number;
  volume: number;
}

/** Flow's soft voices' envelope: a gradual swell, a gentle settle and a long release, `duration` seconds in all. */
export function softEnvelope(voice: { attack: number; duration: number; release: number }): EnvelopeStage[] {
  return [
    { duration: 0, volume: 0 },
    { duration: voice.attack, volume: 1 },
    { duration: 0.65, volume: 0.82 },
    { duration: Math.max(0, voice.duration - voice.attack - 0.65 - voice.release), volume: 0.68 },
    { duration: voice.release, volume: 0 },
  ];
}
