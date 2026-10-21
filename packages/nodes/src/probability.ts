import { randomAt, timeKey, type NodeDefinition } from '@flow-patcher/engine';

export const probability: NodeDefinition = {
  type: 'probability',
  version: 1,
  label: 'Probability',
  category: 'time-rhythm',
  description: 'Passes each event with a chance, from its own seeded random stream.',
  ports: [
    { name: 'in', type: 'event', direction: 'in', label: 'In' },
    { name: 'out', type: 'event', direction: 'out', label: 'Out' },
  ],
  params: [{ name: 'chance', kind: 'number', min: 0, max: 1, default: 0.5, label: 'Chance' }],
  query({ inputs, params, seed, nodeId }) {
    const chance = params.chance as number;
    // Keyed by event time and channel, so the result never depends on windowing.
    return { out: (inputs.in ?? []).filter((e) => randomAt(seed, nodeId, timeKey(e.time), e.channel) < chance) };
  },
};
