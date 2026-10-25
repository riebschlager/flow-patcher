import type { NodeDefinition } from '@flow-patcher/engine';

/**
 * Passes an event while the gate is open, and drops it otherwise. Events keep
 * their time, channel and payload.
 *
 * - **Open off:** blocks every event, whether or not Gate is wired.
 * - **Open on, Gate wired:** open when the Gate signal, read at the event's
 *   time on the event's channel, is at or above Level. Each channel reads its
 *   own value, so a source with a channel rule answers by it (Pointer: a
 *   channel no pointer holds, such as a Clock's channel 0, reads the latest
 *   pointer). Several cables are summed, and a non-finite cable counts as 0.
 * - **Open on, Gate unwired:** passes every event.
 *
 * To pass while a signal is at or below a level instead, negate it with Math
 * (Multiply, Constant −1) and set Level to the negated level.
 *
 * Stateless and read only at event times, so the result doesn't depend on the
 * windowing, and a rewind needs nothing restored.
 */
export const gate: NodeDefinition = {
  type: 'gate',
  version: 1,
  label: 'Gate',
  category: 'control-logic',
  description: 'Passes events while Open is on and the Gate signal, if wired, is at or above Level.',
  ports: [
    { name: 'in', type: 'event', direction: 'in', label: 'In' },
    { name: 'gate', type: 'signal', direction: 'in', label: 'Gate' },
    { name: 'out', type: 'event', direction: 'out', label: 'Out' },
  ],
  params: [
    { name: 'level', kind: 'number', min: -10, max: 10, default: 0.5, label: 'Level' },
    { name: 'open', kind: 'toggle', default: true, label: 'Open' },
  ],
  query({ inputs, params, param, signal, connected }) {
    const events = inputs.in ?? [];
    if (!params.open) return { out: [] };
    if (!connected('gate')) return { out: events.slice() };
    return { out: events.filter((e) => signal('gate', e.time, e.channel) >= param('level', e.time, e.channel)) };
  },
};
