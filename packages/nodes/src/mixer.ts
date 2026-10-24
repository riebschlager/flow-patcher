import { automateParam, editRamp, type AudioParamLike, type NodeDefinition, type NumberParamSpec, type PortSpec } from '@flow-patcher/engine';

/** Inputs on a Mixer. */
export const MIXER_INPUTS = 4;

const inputs = Array.from({ length: MIXER_INPUTS }, (_, i) => i + 1);
const LEVEL = { kind: 'number', min: 0, max: 2, default: 1, unit: '×' } as const;
const LEVELS = [...inputs.map((i) => `level${i}`), 'master'];

export const mixer: NodeDefinition = {
  type: 'mixer',
  version: 1,
  label: 'Mixer',
  category: 'effects-mix',
  description: `Sums ${MIXER_INPUTS} audio buses, each at its own level, through a master level. Every level follows its cable.`,
  ports: [
    ...inputs.map((i): PortSpec => ({ name: `in${i}`, type: 'audio', direction: 'in', label: `In ${i}` })),
    { name: 'out', type: 'audio', direction: 'out', label: 'Out' },
  ],
  params: [
    ...inputs.map((i): NumberParamSpec => ({ name: `level${i}`, ...LEVEL, label: `Level ${i}` })),
    { name: 'master', ...LEVEL, label: 'Master' },
  ],
  // Knob turns ramp in place (ADR 0031).
  liveParams: LEVELS,
  audio({ audio, params, param, connected }) {
    const master = audio.createGain();
    const strips = inputs.map(() => audio.createGain());
    for (const strip of strips) strip.connect(master);
    // One param per level, its knob edits, and whether a cable feeds it (fixed for the instance's life).
    const levels = LEVELS.map((name, i) => {
      const target: AudioParamLike = (strips[i] ?? master).gain;
      target.value = params[name] as number;
      return { name, target, edit: editRamp(target, params[name] as number), cabled: connected(name) };
    });
    return {
      inputs: Object.fromEntries(strips.map((strip, i) => [`in${i + 1}`, strip])),
      outputs: { out: master },
      automate(t0, t1) {
        // A bus has no event channels: modulation is read on channel 0.
        for (const { name, target, cabled } of levels) if (cabled) automateParam(target, t0, t1, (t) => param(name, t));
      },
      update(next, time) {
        // Cabled levels follow the re-run's automate, which reads the new base.
        for (const { name, edit, cabled } of levels) if (!cabled) edit.set(next[name] as number, time);
      },
      dispose() {
        for (const strip of strips) strip.disconnect();
        master.disconnect();
      },
    };
  },
};
