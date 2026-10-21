import { parseChord, progressions } from '../flow/music.js';
import { menu } from '../menu';
import type { NodeType } from '../registry';

const PRESETS = Object.values(progressions).map((chords) => chords.join(' '));
// Display names from Flow's progressionDetails; the first four have none there.
const NAMES: Record<string, string> = {
  daydream: 'Daydream', weightless: 'Weightless', afterhours: 'After hours', openwater: 'Open water',
  stilllight: 'Still light', tidalglass: 'Tidal glass', bluehour: 'Blue hour', dorianbloom: 'Dorian bloom',
  velvetundertow: 'Velvet undertow', borrowedlight: 'Borrowed light', chromaticorbit: 'Chromatic orbit',
  slowdescent: 'Slow descent', suspendedsky: 'Suspended sky', passingcloud: 'Passing cloud', duskturn: 'Dusk turn',
};
const PRESET_NAMES = Object.keys(progressions).map((key) => NAMES[key] ?? key);

const chordsOf = (text: string) => text.split(/[\s,]+/).filter(Boolean);

/** Null when every chord parses, else parseChord's hint naming the first bad one. */
function check(text: string) {
  const chords = chordsOf(text);
  if (!chords.length) return 'Type some chords, such as Cmaj9 Am9 Dm7 G7sus4.';
  for (const chord of chords) {
    try { parseChord(chord); } catch (e) { return `${chord}: ${(e as Error).message}`; }
  }
  return null;
}

/**
 * The current chord as a Value, moving on every Per chord beats of the Clock ticks it hears.
 * It keeps the beat of each tick it has been queried for, so a reader gets the chord at any event's time,
 * including ticks queried ahead of a live tap. With no ticks it holds the first chord.
 */
export const progression: NodeType = {
  type: 'progression',
  label: 'Progression',
  inputs: [{ name: 'tick', label: 'Tick', type: 'event' }],
  outputs: [{ name: 'chord', label: 'Chord', type: 'value' }],
  knobs: [
    { ...menu('preset', 'Preset', ['Custom', ...PRESET_NAMES]), fills: { text: 'chords', values: ['', ...PRESETS] } },
    { name: 'perChord', label: 'Per chord', min: 1, max: 16, default: 4, step: 1, unit: 'beats' },
  ],
  texts: [{ name: 'chords', label: 'Chords', default: 'Cmaj9 Am9 Dm7 G7sus4', check }],
  create() {
    let chords = chordsOf('Cmaj9 Am9 Dm7 G7sus4');
    let perChord = 4;
    const beats: { time: number; beat: number }[] = []; // time order; the last 256 ticks, about 8 s at the fastest Clock

    return {
      query(_t0, _t1, inputs) {
        for (const tick of inputs.events('tick')) {
          if (typeof tick.beat !== 'number') continue; // only Clock ticks carry a beat
          // One Clock at a time: a second Clock's unrelated beat count would flip the chord back and forth.
          if (beats.length && tick.beat <= beats[beats.length - 1].beat) continue;
          beats.push({ time: tick.time, beat: tick.beat });
        }
        if (beats.length > 256) beats.splice(0, beats.length - 256);
      },
      values: {
        // The chord is worked out at read time, so Per chord and the chord text apply to every read after a change.
        chord: (t) => {
          let i = beats.length - 1;
          while (i >= 0 && beats[i].time > t) i--;
          const beat = i >= 0 ? beats[i].beat : 0;
          const n = chords.length;
          return chords[((Math.floor(beat / perChord) % n) + n) % n];
        },
      },
      set(knob, value) {
        if (knob === 'perChord') perChord = Math.max(1, Math.round(value));
      },
      setText(name, text) {
        if (name === 'chords') chords = chordsOf(text);
      },
      dispose() {},
    };
  },
};
