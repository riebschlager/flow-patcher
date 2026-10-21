import { pitchForPosition } from '../flow/music.js';
import { menu } from '../menu';
import type { NodeType } from '../registry';

// A stand-in chord menu until Progression feeds Chord Tone a Value (issue #6).
const CHORDS = ['Cmaj7', 'Am7', 'Fmaj7', 'G', 'Dm9', 'Em7', 'Bbmaj9', 'Gsus4'];

/** Turns each trigger into a note: the position (a Signal, else the event's x) picks a chord tone, low to high. */
export const chordTone: NodeType = {
  type: 'chord-tone',
  label: 'Chord Tone',
  inputs: [
    { name: 'trigger', label: 'Trigger', type: 'event' },
    { name: 'position', label: 'Position', type: 'signal' },
  ],
  outputs: [{ name: 'note', label: 'Note', type: 'note' }],
  knobs: [
    menu('chord', 'Chord', CHORDS),
    { name: 'down', label: 'Oct down', min: 0, max: 3, default: 0, step: 1 },
    { name: 'up', label: 'Oct up', min: 0, max: 3, default: 1, step: 1 },
  ],
  create() {
    const knobs = { chord: 0, down: 0, up: 1 };
    return {
      query(_t0, _t1, inputs) {
        const position = inputs.signal('position');
        const note = inputs.events('trigger').map((e) => {
          const x = position ? position(e.time) : typeof e.x === 'number' ? e.x : 0.5;
          const pitch = pitchForPosition(CHORDS[knobs.chord], x, 0, { down: knobs.down, up: knobs.up });
          return { ...e, pitch, velocity: 1 };
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
