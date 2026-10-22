import type { NodeDefinition, NoteEvent } from '@flow-patcher/engine';

export const makeNote: NodeDefinition = {
  type: 'make-note',
  version: 2,
  label: 'Make Note',
  category: 'harmony-pitch',
  description: 'Turns each event into a note with a pitch, velocity and length.',
  ports: [
    { name: 'trigger', type: 'event', direction: 'in', label: 'Trigger' },
    { name: 'note', type: 'note', direction: 'out', label: 'Note' },
  ],
  params: [
    { name: 'pitch', kind: 'number', min: 0, max: 127, default: 60, step: 1, unit: 'MIDI', label: 'Pitch' },
    { name: 'velocity', kind: 'number', min: 0, max: 1, default: 0.8, label: 'Velocity' },
    { name: 'length', kind: 'number', min: 0.01, max: 8, default: 0.25, unit: 's', label: 'Length' },
  ],
  query({ inputs, param }) {
    // Each param is read at the trigger's time and channel, so cables into them modulate per note.
    const note: NoteEvent[] = (inputs.trigger ?? []).map((e) => ({
      ...e,
      pitch: param('pitch', e.time, e.channel),
      velocity: param('velocity', e.time, e.channel),
      duration: param('length', e.time, e.channel),
    }));
    return { note };
  },
};
