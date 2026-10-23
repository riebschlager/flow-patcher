import { createOutputStage, DEFAULT_MASTER_LEVEL, type NodeDefinition } from '@flow-patcher/engine';

export const output: NodeDefinition = {
  type: 'output',
  version: 2,
  label: 'Output',
  category: 'effects-mix',
  description: 'Limiter (unity gain below −9 dBFS), soft-knee peak guard and master level. Exactly one per patch.',
  ports: [{ name: 'audio', type: 'audio', direction: 'in', label: 'Audio' }],
  // Not modulatable: the master level is a knob, set at setup and ramped on edits.
  params: [{ name: 'level', kind: 'number', min: 0, max: 1, default: DEFAULT_MASTER_LEVEL, label: 'Level', modulatable: false }],
  // A level edit ramps the master gain in place, so the limiter keeps running (ADR 0031).
  liveParams: ['level'],
  audio({ audio, params }) {
    const stage = createOutputStage(audio, params.level as number);
    stage.output.connect(audio.destination);
    return {
      inputs: { audio: stage.input },
      update(next, time) {
        stage.setLevel(next.level as number, time);
      },
      dispose() {
        stage.output.disconnect();
      },
    };
  },
};
