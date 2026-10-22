import { transportBeat, type NodeContext, type NodeDefinition } from '@flow-patcher/engine';
import { parseProgression, PROGRESSIONS, progressionError, type Chord } from './music';

/** A beat within this distance below a chord boundary counts as on it, so a tick on the boundary reads the new chord. */
const SNAP = 1e-9;

/** The chord in force at beat `beat`, holding the first one before beat 0; undefined for no chords. */
export function chordAtBeat(chords: readonly Chord[], beat: number, beatsPerChord: number): Chord | undefined {
  if (!chords.length) return undefined;
  if (!(beatsPerChord > 0) || !Number.isFinite(beat) || beat <= 0) return chords[0];
  const slot = Math.floor(beat / beatsPerChord + SNAP);
  return chords[Number.isFinite(slot) ? slot % chords.length : 0];
}

/** The chord at time t, read through the Transport cable (beat 0, so the first chord, when there is none). */
function chordAt(ctx: NodeContext, t: number): Chord | undefined {
  const chords = parseProgression(ctx.params.chords as string);
  return chordAtBeat(chords, transportBeat(ctx, 'transport', t), ctx.param('beats', t));
}

/**
 * Value source of the current chord (ADR 0018). It counts beats on its
 * Transport cable and moves to the next chord of its chord string every
 * `beats` beats, looping. With no Transport cable it stays at beat 0, so it
 * holds its first chord. Unknown symbols in the chord string are skipped (the
 * inspector flags them); with no usable chord the Value is undefined, as if
 * unwired. Stateless: the chord at t is a pure function of the beat at t.
 *
 * `beats` is read at each read time and the slot is counted from beat 0, so
 * changing (or modulating) beats-per-chord re-slots from beat 0 rather than
 * continuing from the current chord: the chord can jump to an unrelated one.
 * That keeps it windowing-independent without state.
 */
export const progression: NodeDefinition = {
  type: 'progression',
  version: 1,
  label: 'Progression',
  category: 'harmony-pitch',
  description: 'Steps through a chord string on the beat of its Transport, and outputs the current chord. Holds the first chord until a Transport is wired.',
  ports: [
    { name: 'transport', type: 'value', direction: 'in', label: 'Transport' },
    { name: 'chord', type: 'value', direction: 'out', label: 'Chord' },
  ],
  params: [
    { name: 'chords', kind: 'text', default: PROGRESSIONS.Daydream!, label: 'Chords', presets: PROGRESSIONS, check: progressionError },
    { name: 'beats', kind: 'number', min: 1, max: 64, default: 8, step: 1, unit: 'beats', label: 'Beats per chord' },
  ],
  // No events: the chord is read through value(). A query keeps it in the plan's window checks.
  query: () => ({}),
  value(ctx, port, t) {
    return port === 'chord' ? chordAt(ctx, t) : undefined;
  },
};
