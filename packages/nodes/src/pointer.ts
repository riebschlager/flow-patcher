import type { EngineEvent, NodeDefinition, NodeState } from '@flow-patcher/engine';

const EVENT_PORTS = ['down', 'move', 'up', 'cancel'] as const;
type EventPort = (typeof EVENT_PORTS)[number];

/** What one pointer (channel) reads as. Plain data, so rewind snapshots can clone it (ADR 0019). */
interface Contact {
  channel: number;
  x: number;
  y: number;
  pressure: number;
  /** Between Down and Up/Cancel: counted by Count. */
  down: boolean;
}

/** One pushed event, reduced to what the signals need. */
interface Change {
  time: number;
  channel: number;
  /** Index into EVENT_PORTS: the tie-break order at one time and channel. */
  kind: number;
  x: number | null;
  y: number | null;
  pressure: number | null;
}

/**
 * Contacts in the order they last changed, most recent last. Lifted pointers stay
 * so X/Y hold, but only the latest MAX_LIFTED of them, so a long session of
 * touches (each a new pointerId) can't grow the state without bound.
 */
type Contacts = Contact[];
export const MAX_LIFTED = 16;

/** Pressure for a Down that carries none: the mouse's "pressed" value (docs/nodes/canvas-sources.md). */
const DEFAULT_PRESSURE = 0.5;

const validChannel = (channel: number) => Number.isInteger(channel) && channel >= 0;
/** A payload field as a 0–1 number, or null when it's missing or not finite. */
function unit(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
}

function changeOf(kind: number, e: EngineEvent): Change {
  return { time: e.time, channel: e.channel, kind, x: unit(e.x), y: unit(e.y), pressure: unit(e.pressure) };
}

/** Applies one change in place, moving its contact to the end (most recent). */
function apply(contacts: Contacts, change: Change): void {
  const i = contacts.findIndex((c) => c.channel === change.channel);
  const contact: Contact = i >= 0 ? contacts.splice(i, 1)[0]! : { channel: change.channel, x: 0, y: 0, pressure: 0, down: false };
  const port: EventPort = EVENT_PORTS[change.kind]!;
  contact.x = change.x ?? contact.x;
  contact.y = change.y ?? contact.y;
  if (port === 'down') {
    contact.down = true;
    contact.pressure = change.pressure ?? DEFAULT_PRESSURE;
  } else if (port === 'move') {
    contact.pressure = change.pressure ?? contact.pressure;
  } else {
    contact.down = false;
    contact.pressure = 0;
  }
  contacts.push(contact);
  // Forget the oldest lifted contacts past the cap; pointers that are down are always kept.
  let lifted = contacts.reduce((n, c) => n + (c.down ? 0 : 1), 0);
  for (let k = 0; lifted > MAX_LIFTED && k < contacts.length; ) {
    if (contacts[k]!.down) k++;
    else {
      contacts.splice(k, 1);
      lifted--;
    }
  }
}

const contactsOf = (state: NodeState): Contacts => (state.contacts ??= []) as Contacts;
const pendingOf = (state: NodeState): Change[] => (state.pending ?? []) as Change[];

/** The contacts as they are at time t: the base plus this window's changes at or before t. */
function contactsAt(state: NodeState, t: number): readonly Contact[] {
  const base = contactsOf(state);
  const pending = pendingOf(state);
  if (!(pending.length && pending[0]!.time <= t)) return base;
  const contacts = base.map((c) => ({ ...c }));
  for (const change of pending) {
    if (change.time > t) break;
    apply(contacts, change);
  }
  return contacts;
}

/**
 * Canvas source: the pointers on the performance canvas (docs/nodes/canvas-sources.md),
 * M1 basic. The host turns pointerdown, pointermove, pointerup and pointercancel
 * into `scheduler.push(nodeId, 'down' | 'move' | 'up' | 'cancel', { channel:
 * pointerId, x, y, pressure, pointerType })`, with x and y normalized 0–1 and
 * y = 0 at the top. The scheduler stamps them currentTime + 5 ms and the runtime
 * merges them into this node's event outputs (ADR 0019), so they pass through
 * unchanged and `query` returns no events of its own.
 *
 * Signals, per channel (one channel per pointer):
 * - X, Y: the pointer's last position, clamped to 0–1. Down and Move set them, and
 *   so do Up and Cancel when they carry a position. After Up or Cancel they hold
 *   the last position. A hover Move (a mouse with no button down) updates them too.
 * - Pressure: the payload's pressure while down (0.5 if a Down carries none, a Move
 *   without one keeps the last), and 0 after Up or Cancel.
 * - Count: the number of pointers down, the same on every channel.
 * A missing or non-finite x, y or pressure keeps the previous value.
 *
 * A read on a channel this node hasn't seen (including channel 0, the default,
 * unless a pointer has that id, as Firefox's mouse does) reads the pointer that
 * changed most recently, so a clock-driven note can follow whoever touched last.
 * Before any pointer, X, Y and Pressure are 0. Events on channels that aren't
 * non-negative integers pass through but don't touch the signals.
 *
 * State (plain data): `contacts` holds every pointer as the current window began,
 * and `pending` this window's pushed changes, sorted by time, then channel, then
 * Down, Move, Up, Cancel. `query` folds the previous window's pending changes in
 * first; `signal(t)` applies the pending ones at or before t, so a read mid-window
 * sees only earlier changes and the results don't depend on the window size.
 */
export const pointer: NodeDefinition = {
  type: 'pointer',
  version: 2,
  label: 'Pointer',
  category: 'canvas-sources',
  description: 'Down, Move, Up and Cancel events from pointers on the canvas, one channel per pointer, with X, Y, Pressure and Count signals.',
  ports: [
    { name: 'down', type: 'event', direction: 'out', label: 'Down' },
    { name: 'move', type: 'event', direction: 'out', label: 'Move' },
    { name: 'up', type: 'event', direction: 'out', label: 'Up' },
    { name: 'cancel', type: 'event', direction: 'out', label: 'Cancel' },
    { name: 'x', type: 'signal', direction: 'out', label: 'X' },
    { name: 'y', type: 'signal', direction: 'out', label: 'Y' },
    { name: 'pressure', type: 'signal', direction: 'out', label: 'Pressure' },
    { name: 'count', type: 'signal', direction: 'out', label: 'Count' },
  ],
  params: [],
  query({ state, pushed }) {
    const contacts = contactsOf(state);
    for (const change of pendingOf(state)) apply(contacts, change);
    const pending: Change[] = [];
    EVENT_PORTS.forEach((port, kind) => {
      for (const e of pushed[port] ?? []) if (Number.isFinite(e.time) && validChannel(e.channel)) pending.push(changeOf(kind, e));
    });
    pending.sort((a, b) => a.time - b.time || a.channel - b.channel || a.kind - b.kind);
    state.pending = pending;
    // The runtime merges the pushed events into the outputs itself.
    return {};
  },
  signal(ctx, port, t, channel) {
    const contacts = contactsAt(ctx.state, t);
    if (port === 'count') return contacts.reduce((n, c) => n + (c.down ? 1 : 0), 0);
    const contact = contacts.find((c) => c.channel === channel) ?? contacts[contacts.length - 1];
    if (!contact) return 0;
    if (port === 'x') return contact.x;
    if (port === 'y') return contact.y;
    if (port === 'pressure') return contact.pressure;
    return 0;
  },
};
