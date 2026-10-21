import { ramp } from '../audio';
import type { NodeType } from '../registry';

/** Master gain to the speakers. The analyser feeds the debug level meter (window.spike.level()). */
export const output: NodeType = {
  type: 'output',
  label: 'Output',
  inputs: [{ name: 'in', label: 'In', type: 'audio' }],
  outputs: [],
  knobs: [{ name: 'level', label: 'Level', min: 0, max: 1, default: 0.5 }],
  create(ctx) {
    const gain = new GainNode(ctx, { gain: 0.5 });
    gain.connect(ctx.destination);
    gain.connect(analyser(ctx));
    return {
      inputs: { in: gain },
      set(knob, value) {
        if (knob === 'level') ramp(gain.gain, value);
      },
      dispose() {
        gain.disconnect();
      },
    };
  },
};

// One analyser shared by every Output node, so the spike can report whether sound is flowing.
let meter: AnalyserNode | null = null;
function analyser(ctx: AudioContext) {
  return (meter ??= new AnalyserNode(ctx, { fftSize: 2048 }));
}

/** RMS of what reaches the Output nodes, 0 when nothing does. */
export function outputLevel() {
  if (!meter) return 0;
  const buf = new Float32Array(meter.fftSize);
  meter.getFloatTimeDomainData(buf);
  return Math.sqrt(buf.reduce((sum, v) => sum + v * v, 0) / buf.length);
}
