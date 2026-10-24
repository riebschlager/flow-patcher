import { editRamp, paramAutomation, type NodeDefinition } from '@flow-patcher/engine';

export const gain: NodeDefinition = {
  type: 'gain',
  version: 1,
  label: 'Gain',
  category: 'effects-mix',
  description: 'Scales an audio bus. The gain follows its cable, so a Signal can swell or duck what is already sounding.',
  ports: [
    { name: 'in', type: 'audio', direction: 'in', label: 'In' },
    { name: 'out', type: 'audio', direction: 'out', label: 'Out' },
  ],
  params: [{ name: 'gain', kind: 'number', min: 0, max: 2, default: 1, unit: '×', label: 'Gain' }],
  // A knob turn ramps in place (ADR 0031).
  liveParams: ['gain'],
  audio({ audio, params, param, connected }) {
    const amp = audio.createGain();
    amp.gain.value = params.gain as number;
    // Fixed for the instance's life: a change to the cables into params builds a new one.
    const cabled = connected('gain');
    const edit = editRamp(amp.gain, params.gain as number);
    const automation = paramAutomation(amp.gain);
    return {
      inputs: { in: amp },
      outputs: { out: amp },
      automate(t0, t1, clock) {
        // A bus has no event channels: modulation is read on channel 0.
        if (cabled) automation.follow(t0, t1, (t) => param('gain', t), clock);
      },
      update(next, time) {
        // A cabled gain follows the re-run's automate, which reads the new base.
        if (!cabled) edit.set(next.gain as number, time);
      },
      dispose() {
        amp.disconnect();
      },
    };
  },
};
