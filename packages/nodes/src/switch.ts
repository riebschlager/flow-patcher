import type { EngineEvent, NodeDefinition, PortSpec } from '@flow-patcher/engine';
import { IN_PORT, Outputs, routeContact } from './recognizer';

/** Outputs Switch chooses between: one per Flow tool mode (Paint, Conduct, Space, Orbit). */
export const SWITCH_OUTPUTS = 4;

/** The output an Index or Select value picks: rounded and clamped to 1..SWITCH_OUTPUTS; not finite picks 1. */
export function outputOf(index: number): number {
  if (!Number.isFinite(index)) return 1;
  return Math.min(SWITCH_OUTPUTS, Math.max(1, Math.round(index)));
}

/**
 * What Select has latched. Plain data (ADR 0019). `selected` is the output a Select event chose,
 * or null while Index rules; `index` is Index on channel 0 as last seen, so a change is noticed.
 */
interface Latch {
  selected: number | null;
  index: number | null;
}

/**
 * Routes events to one of four outputs (docs/nodes/control-logic.md), contact by contact
 * (ADR 0028): the output is chosen at a contact's `down`, on its channel, and the contact's
 * `move`, `up` and `cancel` follow it to that output until it ends, so a change mid-drag only
 * moves contacts that start afterwards. Events outside a contact (hovers, events with no `phase`,
 * such as Click's or a Clock's) are routed at their own time. Events pass unchanged, every phase
 * included, so a mode patch puts a recognizer after each output.
 *
 * Two things choose the output, and the latest one wins:
 * - Index, the knob plus any cable into it, read at each choice on the event's channel.
 * - Select: each event latches an output until the next one. A finite `value` field picks
 *   output `value` (rounded, clamped to 1–4); an event without one steps from channel 0's
 *   current output (the latch, else Index on channel 0) to the next, 4 wrapping to 1, so a
 *   Key's Down can cycle modes.
 * A Select latch holds until Index changes: Index is compared, on channel 0, at each Select event
 * and each choice, and when it differs from the last reading the latch drops and Index rules
 * again. A change and its undo between two readings go unnoticed. A Select event and a `down` at
 * the same time: Select applies first.
 *
 * This is how Flow's tool modes become cables (ADR 0006): a contact source's All into In, each
 * output into one mode's chain, and a menu (the knob), a Key's Held signal (into Index) or a
 * Key's Down (into Select) picking the mode.
 *
 * State: `routes`, the open contacts; `latch`; `cell`, the event budget (moves and events with
 * no phase are thinned below NODE_EVENT_LIMIT − RESERVE, so downs, ups and cancels go out).
 */
export const switchNode: NodeDefinition = {
  type: 'switch',
  version: 1,
  label: 'Switch / Select',
  category: 'control-logic',
  description: 'Routes events to one of four outputs, chosen by Index or latched by Select, whichever changed last. A contact stays on the output its down picked until it ends.',
  ports: [
    IN_PORT,
    { name: 'select', type: 'event', direction: 'in', label: 'Select' },
    ...Array.from({ length: SWITCH_OUTPUTS }, (_, i): PortSpec => ({ name: `out${i + 1}`, type: 'event', direction: 'out', label: `Out ${i + 1}` })),
  ],
  params: [{ name: 'index', kind: 'number', min: 1, max: SWITCH_OUTPUTS, step: 1, default: 1, label: 'Index' }],
  query({ inputs, state, param }) {
    const latch = (state.latch ??= { selected: null, index: null }) as Latch;
    /** Index on channel 0 at t; a change since the last reading drops the latch. */
    const watchIndex = (t: number) => {
      const index = outputOf(param('index', t, 0));
      if (latch.index !== null && index !== latch.index) latch.selected = null;
      latch.index = index;
    };
    const pick = (e: EngineEvent) => {
      watchIndex(e.time);
      return latch.selected ?? outputOf(param('index', e.time, e.channel));
    };
    // Select and In merged by time, Select first at equal times.
    const events: { event: EngineEvent; select: boolean }[] = [
      ...(inputs.select ?? []).map((event) => ({ event, select: true })),
      ...(inputs.in ?? []).map((event) => ({ event, select: false })),
    ].filter(({ event }) => Number.isFinite(event.time));
    events.sort((a, b) => a.event.time - b.event.time || Number(b.select) - Number(a.select));
    const outputs = new Outputs(state);
    for (const { event, select } of events) {
      if (select) {
        watchIndex(event.time);
        const { value } = event;
        const current = latch.selected ?? latch.index ?? 1;
        latch.selected = typeof value === 'number' && Number.isFinite(value) ? outputOf(value) : (current % SWITCH_OUTPUTS) + 1;
        continue;
      }
      const route = routeContact(state, event, pick);
      if (route !== null) outputs.send([`out${route}`], event);
    }
    return outputs.result();
  },
};
