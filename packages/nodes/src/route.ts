// Routing a phase-tagged stream contact by contact (ADR 0028), for Switch and Modifier Router.
// Not a node.
import type { EngineEvent, NodeState } from '@flow-patcher/engine';
import { phaseOf } from './recognizer';

/**
 * Routes a phase-tagged stream (ADR 0028) contact by contact: a `down` asks `pick` for its route
 * and the contact keeps it, so the contact's later `move`, `up` and `cancel` go the same way
 * whatever `pick` would say then. `up` and `cancel` close the contact, so the channel's next
 * event picks afresh. An event outside a contact asks `pick` for itself: a hover (a `move` with
 * no contact open), an `up` or `cancel` with none open, and an event with no `phase` (Click,
 * Wheel, MIDI). A second `down` on an open channel starts a new contact (Pointer never sends
 * one). Events whose time or channel isn't finite are dropped, as the recognizers drop them.
 * `state.routes` holds the open contacts (plain data), so the result doesn't depend on
 * windowing. `pick` runs once per down and once per event outside a contact, in time order.
 */
export function routeContacts(state: NodeState, events: readonly EngineEvent[], pick: (event: EngineEvent) => number): { event: EngineEvent; route: number }[] {
  const out: { event: EngineEvent; route: number }[] = [];
  for (const event of events) {
    const route = routeContact(state, event, pick);
    if (route !== null) out.push({ event, route });
  }
  return out;
}

/** One event of `routeContacts`: its route, or null when it's dropped. */
export function routeContact(state: NodeState, event: EngineEvent, pick: (event: EngineEvent) => number): number | null {
  const routes = (state.routes ??= {}) as Record<string, number>;
  if (!Number.isFinite(event.time) || !Number.isFinite(event.channel)) return null;
  const phase = phaseOf(event);
  if (!phase) return pick(event);
  const key = String(event.channel);
  if (phase === 'down') return (routes[key] = pick(event));
  const held = routes[key];
  if (held === undefined) return pick(event);
  if (phase === 'up' || phase === 'cancel') delete routes[key];
  return held;
}
