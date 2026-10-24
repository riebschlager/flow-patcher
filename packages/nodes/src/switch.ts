import type { EngineEvent, NodeDefinition, NodeState, PortSpec, QueryResult } from '@flow-patcher/engine';
import { PHASES, type Phase } from './pointer';

/** Outputs Switch chooses between: one per Flow tool mode (Paint, Conduct, Space, Orbit). */
export const SWITCH_OUTPUTS = 4;

const isPhase = (value: unknown): value is Phase => typeof value === 'string' && (PHASES as readonly string[]).includes(value);

/**
 * The route of each open contact, by channel: the output its `down` picked (0 for none: Pass on
 * the recognizers). Plain data, so rewind snapshots can clone it (ADR 0019).
 */
type Routes = Record<string, number>;

/**
 * Routes a phase-tagged stream (ADR 0028) contact by contact, shared by Switch, Modifier Router
 * and Zone: a `down` asks `pick` for its route and the contact keeps it, so the contact's later
 * `move`, `up` and `cancel` go the same way whatever `pick` would say then. `up` and `cancel`
 * close the contact. An event outside a contact asks `pick` for itself: a hover (a `move` with no
 * contact open), an `up` or `cancel` with none open, an event with no `phase` (Click, Wheel,
 * MIDI), and one whose channel isn't an integer, which can't be a contact. A second `down` on an
 * open channel starts a new contact (Pointer never sends one). Events whose time isn't finite are
 * dropped. `state.routes` holds the open contacts, so the result doesn't depend on windowing.
 */
export function routeContacts(state: NodeState, events: readonly EngineEvent[], pick: (event: EngineEvent) => number): { event: EngineEvent; route: number }[] {
  const routes = (state.routes ??= {}) as Routes;
  const out: { event: EngineEvent; route: number }[] = [];
  for (const event of events) {
    if (!Number.isFinite(event.time)) continue;
    const { phase } = event;
    if (!Number.isInteger(event.channel) || !isPhase(phase)) {
      out.push({ event, route: pick(event) });
      continue;
    }
    const key = String(event.channel);
    if (phase === 'down') {
      const route = pick(event);
      routes[key] = route;
      out.push({ event, route });
      continue;
    }
    const held = routes[key];
    if (held === undefined) {
      out.push({ event, route: pick(event) });
      continue;
    }
    if (phase === 'up' || phase === 'cancel') delete routes[key];
    out.push({ event, route: held });
  }
  return out;
}

/** A recognizer's Pass output and its per-phase splits (ADR 0028). */
export const PASS_PORTS: PortSpec[] = [
  { name: 'pass', type: 'event', direction: 'out', label: 'Pass' },
  { name: 'passDown', type: 'event', direction: 'out', label: 'Pass Down' },
  { name: 'passMove', type: 'event', direction: 'out', label: 'Pass Move' },
  { name: 'passUp', type: 'event', direction: 'out', label: 'Pass Up' },
  { name: 'passCancel', type: 'event', direction: 'out', label: 'Pass Cancel' },
];

const PASS_SPLIT: Record<Phase, string> = { down: 'passDown', move: 'passMove', up: 'passUp', cancel: 'passCancel' };

/**
 * Adds events to Pass as they came, and a copy of each to the Pass port of its phase, so no event
 * object is on two ports. Events with no phase go on Pass only.
 */
export function addPass(out: Record<string, EngineEvent[]>, events: readonly EngineEvent[]): void {
  for (const event of events) {
    (out.pass ??= []).push(event);
    if (isPhase(event.phase)) (out[PASS_SPLIT[event.phase]] ??= []).push({ ...event });
  }
}

/** Drops empty ports. */
export function nonEmpty(out: Record<string, EngineEvent[]>): QueryResult {
  const result: QueryResult = {};
  for (const [port, events] of Object.entries(out)) if (events.length) result[port] = events;
  return result;
}

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
 * time. Events pass unchanged. This is how Flow's tool modes become cables (ADR 0006): a contact
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
    { name: 'in', type: 'event', direction: 'in', label: 'In' },
    ...Array.from({ length: SWITCH_OUTPUTS }, (_, i): PortSpec => ({ name: `out${i + 1}`, type: 'event', direction: 'out', label: `Out ${i + 1}` })),
  ],
  params: [{ name: 'index', kind: 'number', min: 1, max: SWITCH_OUTPUTS, step: 1, default: 1, label: 'Index' }],
  query({ inputs, state, param }) {
    const out: Record<string, EngineEvent[]> = {};
    for (const { event, route } of routeContacts(state, inputs.in ?? [], (e) => outputOf(param('index', e.time, e.channel)))) (out[`out${route}`] ??= []).push(event);
    return nonEmpty(out);
  },
};
