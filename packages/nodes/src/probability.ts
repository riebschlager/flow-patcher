import { randomAt, timeKey, type NodeDefinition } from '@flow-patcher/engine';

export const probability: NodeDefinition = {
  type: 'probability',
  version: 2,
  label: 'Probability',
  category: 'time-rhythm',
  description: 'Passes each event with a chance, from its own seeded random stream.',
  ports: [
    { name: 'in', type: 'event', direction: 'in', label: 'In' },
    { name: 'out', type: 'event', direction: 'out', label: 'Out' },
  ],
  params: [{ name: 'chance', kind: 'number', min: 0, max: 1, default: 0.5, label: 'Chance' }],
  query({ inputs, param, seed, nodeId }) {
    // Keyed by event time and channel, and chance is read at the event's time,
    // so the result never depends on windowing.
    return { out: (inputs.in ?? []).filter((e) => randomAt(seed, nodeId, timeKey(e.time), e.channel) < param('chance', e.time, e.channel)) };
  },
};
