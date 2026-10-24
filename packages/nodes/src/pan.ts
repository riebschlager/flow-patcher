import { automateParam, editRamp, type AudioContextLike, type AudioNodeLike, type AudioParamLike, type NodeDefinition, type NodeStatus } from '@flow-patcher/engine';

/** Web Audio's StereoPannerNode, which the engine's AudioContextLike doesn't list yet. */
interface StereoPannerLike extends AudioNodeLike {
  readonly pan: AudioParamLike;
}
type PannerContext = AudioContextLike & { createStereoPanner?(): StereoPannerLike };

/** Whether `audio` can build a StereoPannerNode. Browsers and node-web-audio-api can; a host's
 *  wrapper around them must pass `createStereoPanner` through. */
export const canPan = (audio: AudioContextLike): boolean => typeof (audio as PannerContext).createStereoPanner === 'function';

export const PAN_UNAVAILABLE: NodeStatus = { kind: 'error', message: "Panning isn't available on this audio context — audio passes through centred" };

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
  status: ({ audio }) => (canPan(audio) ? null : PAN_UNAVAILABLE),
  audio({ audio, params, param, connected }) {
    if (!canPan(audio)) {
      // No panner to build: pass the bus through unchanged, and say so on the card (status).
      const through = audio.createGain();
      return { inputs: { in: through }, outputs: { out: through }, dispose: () => through.disconnect() };
    }
    const panner = (audio as PannerContext).createStereoPanner!();
    panner.pan.value = params.pan as number;
    // Fixed for the instance's life: a change to the cables into params builds a new one.
    const cabled = connected('pan');
    const edit = editRamp(panner.pan, params.pan as number);
    return {
      inputs: { in: panner },
      outputs: { out: panner },
      automate(t0, t1) {
        // A bus has no event channels: modulation is read on channel 0.
        if (cabled) automateParam(panner.pan, t0, t1, (t) => param('pan', t));
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
