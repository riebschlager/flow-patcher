import { pitchForPosition } from '../flow/music.js';
import { menu } from '../menu';
import type { NodeType } from '../registry';

// The chord when nothing is cabled to the Chord input.
const CHORDS = ['Cmaj7', 'Am7', 'Fmaj7', 'G', 'Dm9', 'Em7', 'Bbmaj9', 'Gsus4'];

/**
 * Turns each trigger into a note. The chord is the Chord Value at the trigger's time, else the Chord menu.
 * The position picks a chord tone, low to high: the Position Signal, else the event's x (pointer events),
 * else the Position knob (generated events such as Euclidean hits). Velocity passes through.
 */
export const chordTone: NodeType = {
  type: 'chord-tone',
  label: 'Chord Tone',
  inputs: [
    { name: 'trigger', label: 'Trigger', type: 'event' },
    { name: 'position', label: 'Position', type: 'signal' },
    { name: 'chord', label: 'Chord', type: 'value' },
  ],
  outputs: [{ name: 'note', label: 'Note', type: 'note' }],
  knobs: [
    menu('chord', 'Chord', CHORDS),
    { name: 'down', label: 'Oct down', min: 0, max: 3, default: 0, step: 1 },
    { name: 'up', label: 'Oct up', min: 0, max: 3, default: 1, step: 1 },
    { name: 'position', label: 'Position', min: 0, max: 1, default: 0.5 },
  ],
  create() {
    const knobs = { chord: 0, down: 0, up: 1, position: 0.5 };
    return {
      query(_t0, _t1, inputs) {
        const position = inputs.signal('position');
        const chordAt = inputs.value('chord');
        const note = inputs.events('trigger').map((e) => {
          const x = position ? position(e.time) : typeof e.x === 'number' ? e.x : knobs.position;
          const chord = chordAt?.(e.time);
          const pitch = pitchForPosition(typeof chord === 'string' ? chord : CHORDS[knobs.chord], x, 0, { down: knobs.down, up: knobs.up });
          return { ...e, pitch, velocity: typeof e.velocity === 'number' ? e.velocity : 1 };
        });
        return { note };
      },
      set(knob, value) {
        if (knob in knobs) knobs[knob as keyof typeof knobs] = value;
      },
      dispose() {},
    };
  },
};
