import { editRamp, paramAutomation, type NodeDefinition } from '@flow-patcher/engine';

export const FILTER_MODES = ['lowpass', 'highpass', 'bandpass'] as const;

/**
 * Web Audio reads a low-pass or high-pass biquad's Q in dB and a band-pass one's
 * as a plain ratio. The knob is a plain Q in every mode (0.71 is flat at the
 * cutoff), so the two pass modes get it in dB.
 */
export function biquadQ(mode: string, q: number): number {
  return mode === 'bandpass' ? q : 20 * Math.log10(q);
}

export const filter: NodeDefinition = {
  type: 'filter',
  version: 1,
  label: 'Filter',
  category: 'effects-mix',
  description: 'Low-pass, high-pass or band-pass filter on an audio bus. Cutoff and Q follow their cables, so a sweep reaches notes already sounding.',
  ports: [
    { name: 'in', type: 'audio', direction: 'in', label: 'In' },
    { name: 'out', type: 'audio', direction: 'out', label: 'Out' },
  ],
  params: [
    { name: 'mode', kind: 'enum', options: FILTER_MODES, default: 'lowpass', label: 'Mode' },
    { name: 'cutoff', kind: 'number', min: 20, max: 20000, default: 1200, unit: 'Hz', label: 'Cutoff' },
    { name: 'q', kind: 'number', min: 0.1, max: 20, default: 0.71, label: 'Q' },
  ],
  // Knob turns ramp in place; a mode change builds a new filter (ADR 0031).
  liveParams: ['cutoff', 'q'],
  audio({ audio, params, param, connected }) {
    const mode = params.mode as string;
    const biquad = audio.createBiquadFilter();
    biquad.type = mode;
    biquad.frequency.value = params.cutoff as number;
    biquad.Q.value = biquadQ(mode, params.q as number);
    // Fixed for the instance's life: a change to the cables into params builds a new one.
    const cabled = { cutoff: connected('cutoff'), q: connected('q') };
    const edits = { cutoff: editRamp(biquad.frequency, biquad.frequency.value), q: editRamp(biquad.Q, biquad.Q.value) };
    const automation = { cutoff: paramAutomation(biquad.frequency), q: paramAutomation(biquad.Q) };
    return {
      inputs: { in: biquad },
      outputs: { out: biquad },
      automate(t0, t1) {
        // A bus has no event channels: modulation is read on channel 0.
        if (cabled.cutoff) automation.cutoff.follow(t0, t1, (t) => param('cutoff', t));
        if (cabled.q) automation.q.follow(t0, t1, (t) => biquadQ(mode, param('q', t)));
      },
      update(next, time) {
        // Cabled params follow the re-run's automate, which reads the new base.
        if (!cabled.cutoff) edits.cutoff.set(next.cutoff as number, time);
        if (!cabled.q) edits.q.set(biquadQ(mode, next.q as number), time);
      },
      dispose() {
        biquad.disconnect();
      },
    };
  },
};
