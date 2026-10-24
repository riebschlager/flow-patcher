import type { NodeDefinition, PortSpec } from '@flow-patcher/engine';
import { IN_PORT, Outputs, routeContacts } from './recognizer';

/** Outputs Switch chooses between: one per Flow tool mode (Paint, Conduct, Space, Orbit). */
export const SWITCH_OUTPUTS = 4;

/** The output an Index value picks: rounded and clamped to 1..SWITCH_OUTPUTS; not finite picks 1. */
export function outputOf(index: number): number {
  if (!Number.isFinite(index)) return 1;
  return Math.min(SWITCH_OUTPUTS, Math.max(1, Math.round(index)));
}

/**
 * Routes events to one of four outputs by Index (docs/nodes/control-logic.md), contact by
 * contact (ADR 0028): Index is read at a contact's `down`, on its channel, and the contact's
 * `move`, `up` and `cancel` follow it to that output until it ends, so turning the knob, or a
 * cable into Index changing, mid-drag only moves contacts that start afterwards. Events outside a
 * contact (hovers, events with no `phase`, such as Click's or a Clock's) go by Index at their own
 * time. Events pass unchanged. Moves and events with no phase are thinned below
 * NODE_EVENT_LIMIT − RESERVE (recognizer.ts), so downs, ups and cancels always go out.
 * This is how Flow's tool modes become cables (ADR 0006): a contact
 * source's All into In, and each output into one mode's chain; a Key's Held signal into Index (or
 * the knob, as a menu) picks the mode.
 */
export const switchNode: NodeDefinition = {
  type: 'switch',
  version: 1,
  label: 'Switch / Select',
  category: 'control-logic',
  description: 'Routes events to one of four outputs by Index. A contact stays on the output its down picked until it ends.',
  ports: [
    IN_PORT,
    ...Array.from({ length: SWITCH_OUTPUTS }, (_, i): PortSpec => ({ name: `out${i + 1}`, type: 'event', direction: 'out', label: `Out ${i + 1}` })),
  ],
  params: [{ name: 'index', kind: 'number', min: 1, max: SWITCH_OUTPUTS, step: 1, default: 1, label: 'Index' }],
  query({ inputs, state, param }) {
    const outputs = new Outputs(state);
    for (const { event, route } of routeContacts(state, inputs.in ?? [], (e) => outputOf(param('index', e.time, e.channel)))) outputs.send([`out${route}`], event);
    return outputs.result();
  },
};
