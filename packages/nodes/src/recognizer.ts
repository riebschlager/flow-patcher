// Shared machinery for the gesture recognizers (docs/nodes/gesture-recognizers.md, ADR 0028):
// the In and Pass ports, the event budget, and routing a stream contact by contact.
// Not a node: each recognizer's own file holds its definition and its gesture logic.
import { limitWindowOf, NODE_EVENT_LIMIT, type EngineEvent, type NodeState, type PortSpec, type QueryResult } from '@flow-patcher/engine';
import { PHASES, type Phase } from './pointer';

export const IN_PORT: PortSpec = { name: 'in', type: 'event', direction: 'in', label: 'In' };

/** Pass, then its per-phase split (ADR 0028). */
export const PASS_PORTS: PortSpec[] = [
  { name: 'pass', type: 'event', direction: 'out', label: 'Pass' },
  { name: 'passDown', type: 'event', direction: 'out', label: 'Pass Down' },
  { name: 'passMove', type: 'event', direction: 'out', label: 'Pass Move' },
  { name: 'passUp', type: 'event', direction: 'out', label: 'Pass Up' },
  { name: 'passCancel', type: 'event', direction: 'out', label: 'Pass Cancel' },
];

const PASS_PHASE: Record<Phase, string> = { down: 'passDown', move: 'passMove', up: 'passUp', cancel: 'passCancel' };

/**
 * Events per limit window (ADR 0022) kept for Pass's downs, ups and cancels and the gesture
 * events that aren't moves: forwarded moves (two events each, Pass and Pass Move) and
 * move-like gesture events stop once a window's count would pass NODE_EVENT_LIMIT − RESERVE,
 * so the runtime's per-node cap never takes an end or a claim's cancel. As in Pointer.
 */
export const RESERVE = 64;

/** An event's contact phase, or null when it has none (Click, Wheel, MIDI, a Clock tick). */
export const phaseOf = (event: EngineEvent): Phase | null => ((PHASES as readonly unknown[]).includes(event.phase) ? (event.phase as Phase) : null);

/** Events emitted in one limit window: `k` its index, `n` the count so far. Plain data (ADR 0019). */
interface Cell {
  k: number;
  n: number;
}

/**
 * The node's output ports and its event budget for one query. `state.cell` counts what was
 * emitted in the current limit window, so the budget doesn't depend on windowing.
 */
export class Outputs {
  readonly out: Record<string, EngineEvent[]> = {};
  private readonly cell: Cell;

  constructor(state: NodeState) {
    this.cell = (state.cell ??= { k: -Infinity, n: 0 }) as Cell;
  }

  /** Counts `cost` events at `time`; a `thin` one (a move, a hover) only while the window has room below RESERVE. */
  admit(time: number, cost: number, thin: boolean): boolean {
    const k = limitWindowOf(time);
    if (k !== this.cell.k) Object.assign(this.cell, { k, n: 0 });
    if (thin && this.cell.n + cost > NODE_EVENT_LIMIT - RESERVE) return false;
    this.cell.n += cost;
    return true;
  }

  push(port: string, event: EngineEvent): void {
    (this.out[port] ??= []).push(event);
  }

  /**
   * Emits one event on several ports at once, or on none when the budget thins it. Thin are
   * moves and events with no phase; downs, ups and cancels always go out.
   */
  send(ports: readonly string[], event: EngineEvent, thin = isThin(event)): void {
    if (!ports.length || !this.admit(event.time, ports.length, thin)) return;
    ports.forEach((port, i) => this.push(port, i === 0 ? event : { ...event }));
  }

  /**
   * Forwards an event on Pass in its tagged shape, and on the Pass port of its phase without
   * `phase`, as Pointer's per-phase ports carry it. Events with no phase go on Pass alone.
   */
  pass(event: EngineEvent, thin = isThin(event)): void {
    const phase = phaseOf(event);
    if (!this.admit(event.time, phase ? 2 : 1, thin)) return;
    this.push('pass', event);
    if (phase) {
      const { phase: _phase, ...rest } = event;
      this.push(PASS_PHASE[phase], rest as EngineEvent);
    }
  }

  /** The ports that got events. */
  result(): QueryResult {
    const result: QueryResult = {};
    for (const [port, events] of Object.entries(this.out)) if (events.length) result[port] = events;
    return result;
  }
}

/** Moves (hovers included) and events with no phase are what the budget thins. */
export const isThin = (event: EngineEvent): boolean => {
  const phase = phaseOf(event);
  return phase === 'move' || phase === null;
};

/**
 * Routes a phase-tagged stream (ADR 0028) contact by contact, for Switch and Modifier Router: a
 * `down` asks `pick` for its route and the contact keeps it, so the contact's later `move`, `up`
 * and `cancel` go the same way whatever `pick` would say then. `up` and `cancel` close the
 * contact, so the channel's next event picks afresh. An event outside a contact asks `pick` for
 * itself: a hover (a `move` with no contact open), an `up` or `cancel` with none open, and an
 * event with no `phase` (Click, Wheel, MIDI). A second `down` on an open channel starts a new
 * contact (Pointer never sends one). Events whose time or channel isn't finite are dropped, as
 * the recognizers drop them. `state.routes` holds the open contacts (plain data), so the result
 * doesn't depend on windowing. `pick` runs once per down and once per event outside a contact,
 * in time order.
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
