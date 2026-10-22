import type { NodeDefinition, NoteEvent } from '@flow-patcher/engine';
import { chordError, chordFromValue, parseChord, pitchForPosition } from './music';

/**
 * Flow's horizontal pitch: each trigger becomes a note whose pitch is the
 * chord tone at Position (0–1, read at the trigger's time and channel) across
 * the chord repeated from `down` octaves below to `up` above. The chord is the
 * Value on the Chord cable at the trigger's time; with no cable, or one that
 * carries no chord, it is the node's own chord. With no usable chord at all
 * the trigger is dropped. Stateless, so it doesn't depend on windowing.
 */
export const chordTone: NodeDefinition = {
  type: 'chord-tone',
  version: 1,
  label: 'Chord Tone',
  category: 'harmony-pitch',
  description: 'Turns each event into a note on a chord tone, picked by Position across an octave range.',
  ports: [
    { name: 'trigger', type: 'event', direction: 'in', label: 'Trigger' },
    { name: 'position', type: 'signal', direction: 'in', label: 'Position' },
    { name: 'chord', type: 'value', direction: 'in', label: 'Chord' },
    { name: 'note', type: 'note', direction: 'out', label: 'Note' },
  ],
  params: [
    { name: 'symbol', kind: 'text', default: 'Cmaj7', label: 'Own chord', check: chordError },
    { name: 'down', kind: 'number', min: 0, max: 3, default: 0, step: 1, unit: 'oct', label: 'Octaves down' },
    { name: 'up', kind: 'number', min: 0, max: 3, default: 1, step: 1, unit: 'oct', label: 'Octaves up' },
    { name: 'velocity', kind: 'number', min: 0, max: 1, default: 0.8, label: 'Velocity' },
    { name: 'length', kind: 'number', min: 0.01, max: 8, default: 0.25, unit: 's', label: 'Length' },
  ],
  query(ctx) {
    const own = parseChord(ctx.params.symbol as string);
    const note: NoteEvent[] = [];
    for (const e of ctx.inputs.trigger ?? []) {
      const chord = chordFromValue(ctx.value('chord', e.time)) ?? own;
      if (!chord) continue;
      const range = { down: ctx.param('down', e.time, e.channel), up: ctx.param('up', e.time, e.channel) };
      // An unconnected Position reads 0: the lowest tone.
      const pitch = pitchForPosition(chord, ctx.signal('position', e.time, e.channel), range);
      if (pitch === null) continue;
      note.push({ ...e, pitch, velocity: ctx.param('velocity', e.time, e.channel), duration: ctx.param('length', e.time, e.channel) });
    }
    return { note };
  },
};
