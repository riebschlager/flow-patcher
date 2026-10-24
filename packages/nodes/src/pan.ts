import { editRamp, paramAutomation, type NodeDefinition } from '@flow-patcher/engine';

export const pan: NodeDefinition = {
  type: 'pan',
  version: 1,
  label: 'Pan',
  category: 'effects-mix',
  description: 'Places an audio bus between left (−1) and right (1), equal-power. The position follows its cable.',
  ports: [
    { name: 'in', type: 'audio', direction: 'in', label: 'In' },
    { name: 'out', type: 'audio', direction: 'out', label: 'Out' },
  ],
  params: [{ name: 'pan', kind: 'number', min: -1, max: 1, default: 0, label: 'Pan' }],
  // A knob turn ramps in place (ADR 0031).
  liveParams: ['pan'],
  audio({ audio, params, param, connected }) {
    const panner = audio.createStereoPanner();
    panner.pan.value = params.pan as number;
    // Fixed for the instance's life: a change to the cables into params builds a new one.
    const cabled = connected('pan');
    const edit = editRamp(panner.pan, params.pan as number);
    const automation = paramAutomation(panner.pan);
    return {
      inputs: { in: panner },
      outputs: { out: panner },
      automate(t0, t1, clock) {
        // A bus has no event channels: modulation is read on channel 0.
        if (cabled) automation.follow(t0, t1, (t) => param('pan', t), clock);
      },
      update(next, time) {
        // A cabled pan follows the re-run's automate, which reads the new base.
        if (!cabled) edit.set(next.pan as number, time);
      },
      dispose() {
        panner.disconnect();
      },
    };
  },
};
