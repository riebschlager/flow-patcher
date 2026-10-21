import { ramp } from '../audio';
import type { NodeType } from '../registry';

/** Placeholder sound source: a sawtooth that plays from the moment it's added. */
export const tone: NodeType = {
  type: 'tone',
  label: 'Tone',
  inputs: [],
  outputs: [{ name: 'out', label: 'Out', type: 'audio' }],
  knobs: [
    { name: 'pitch', label: 'Pitch', min: 40, max: 2000, default: 220, curve: 'log', unit: 'Hz' },
    { name: 'level', label: 'Level', min: 0, max: 1, default: 0.3 },
  ],
  create(ctx) {
    const osc = new OscillatorNode(ctx, { type: 'sawtooth', frequency: 220 });
    const gain = new GainNode(ctx, { gain: 0.3 });
    osc.connect(gain);
    osc.start();
    return {
      outputs: { out: gain },
      set(knob, value) {
        if (knob === 'pitch') ramp(osc.frequency, value);
        if (knob === 'level') ramp(gain.gain, value);
      },
      dispose() {
        osc.stop();
        osc.disconnect();
        gain.disconnect();
      },
    };
  },
};
