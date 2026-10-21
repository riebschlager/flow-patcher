import { createOutputStage, DEFAULT_MASTER_LEVEL, type NodeDefinition } from '@flow-patcher/engine';

export const output: NodeDefinition = {
  type: 'output',
  version: 1,
  label: 'Output',
  category: 'effects-mix',
  description: 'Makeup gain, limiter, peak guard and master level. Exactly one per patch.',
  ports: [{ name: 'audio', type: 'audio', direction: 'in', label: 'Audio' }],
  params: [{ name: 'level', kind: 'number', min: 0, max: 1, default: DEFAULT_MASTER_LEVEL, label: 'Level' }],
  audio({ audio, params }) {
    const stage = createOutputStage(audio, params.level as number);
    stage.output.connect(audio.destination);
    return {
      inputs: { audio: stage.input },
      dispose() {
        stage.output.disconnect();
      },
    };
  },
};
