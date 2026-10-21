import type { EngineEvent, NodeDefinition } from '@flow-patcher/engine';

/** Note values as fractions of a whole note; one beat is a quarter note. */
export const CLOCK_DIVISIONS: Record<string, number> = {
  '1/1': 1, '1/2': 1 / 2, '1/4': 1 / 4, '1/8': 1 / 8, '1/16': 1 / 16, '1/32': 1 / 32,
  '1/4T': 1 / 6, '1/8T': 1 / 12, '1/16T': 1 / 24,
};

export const clock: NodeDefinition = {
  type: 'clock',
  version: 1,
  label: 'Clock',
  category: 'time-rhythm',
  description: 'Emits ticks at a note division of a tempo, computed from absolute time.',
  ports: [{ name: 'tick', type: 'event', direction: 'out', label: 'Tick' }],
  params: [
    { name: 'bpm', kind: 'number', min: 20, max: 300, default: 120, unit: 'bpm', label: 'Tempo' },
    { name: 'division', kind: 'enum', options: Object.keys(CLOCK_DIVISIONS), default: '1/4', label: 'Division' },
  ],
  query({ t0, t1, params }) {
    const period = (60 / (params.bpm as number)) * 4 * (CLOCK_DIVISIONS[params.division as string] ?? 1 / 4);
    // Membership is tested on the computed tick times, so any split of time
    // into windows yields the same ticks.
    let k = Math.max(0, Math.ceil(t0 / period));
    while (k > 0 && (k - 1) * period >= t0) k--;
    while (k * period < t0) k++;
    const tick: EngineEvent[] = [];
    for (; k * period < t1; k++) tick.push({ time: k * period, channel: 0, index: k });
    return { tick };
  },
};
