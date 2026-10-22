import { compareEvents, type EngineEvent, type NodeDefinition } from '@flow-patcher/engine';

/**
 * Shifts events later by a fixed time. It is a delay node (ADR 0010): cables into
 * it don't order the plan, so it can close a cycle. The runtime hands it the
 * inputs of the previous chunk and keeps chunks just under `time` wide, so
 * `e.time + time` is never before the current chunk and the output depends only
 * on event times, not on windowing.
 */
export const delayEdge: NodeDefinition = {
  type: 'delay-edge',
  version: 1,
  label: 'Delay Edge',
  category: 'control-logic',
  description: 'Delays events by a fixed time, so a cable through it can close a cycle.',
  ports: [
    { name: 'in', type: 'event', direction: 'in', label: 'In' },
    { name: 'out', type: 'event', direction: 'out', label: 'Out' },
  ],
  params: [{ name: 'time', kind: 'number', min: 0.01, max: 2, default: 0.025, unit: 's', label: 'Time', modulatable: false }],
  delay: (params) => params.time as number,
  query({ inputs, params, state, t0, t1 }) {
    const time = params.time as number;
    // Plain event objects only, so a rewind snapshot can clone the state (ADR 0019).
    const pending = [...((state.pending as EngineEvent[] | undefined) ?? [])];
    for (const e of inputs.in ?? []) {
      const shifted = e.time + time;
      if (Number.isFinite(shifted)) pending.push({ ...e, time: shifted });
    }
    pending.sort(compareEvents);
    // Events before t0 belong to windows that were skipped (ADR 0017): drop them, don't burst them.
    const due = pending.filter((e) => e.time >= t0 && e.time < t1);
    state.pending = pending.filter((e) => e.time >= t1);
    return { out: due };
  },
};
