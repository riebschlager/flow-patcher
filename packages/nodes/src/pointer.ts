import type { EngineEvent, InputSpec, NodeDefinition, NodeState, PortSpec, QueryContext, QueryResult } from '@flow-patcher/engine';

/** The contact phases (ADR 0028), which are also the per-phase Event outputs. */
export const PHASES = ['down', 'move', 'up', 'cancel'] as const;
export type Phase = (typeof PHASES)[number];

/** What the pushes are, in tie order at one time on one pointer: enter first, leave last. */
const KINDS = ['enter', 'down', 'move', 'up', 'cancel', 'leave'] as const;
type Kind = (typeof KINDS)[number];

/**
 * Slots 1..MAX_SLOTS. More pointers than any reference device can hold at once
 * (10 touches on the Surface, plus a mouse and a pen), so it only binds when
 * pointers never end: a lost pointerup or pointerleave. Then the stalest pointer
 * gives its slot up (see `bind`), so the state stays this size however long the
 * session runs.
 */
export const MAX_SLOTS = 16;
/** Seconds without a sample after which Speed reads 0: a pointer held still sends no moves. */
export const STILL = 0.1;
/** Pressure for a Down that carries none: the mouse's "pressed" value (docs/nodes/canvas-sources.md). */
const DEFAULT_PRESSURE = 0.5;

/** One slot: the pointer holding it, or the last one that did. Plain data, so rewind snapshots can clone it (ADR 0019). */
interface Contact {
  slot: number;
  /** The raw pointerId holding the slot, or null once it's free (up, cancel, leave). */
  id: number | null;
  x: number;
  y: number;
  pressure: number;
  /** Between Down and Up/Cancel: counted by Count, and `age` runs from `downAt`. */
  down: boolean;
  downAt: number;
  /** The sample motion is measured from: its time (null before the holder's first) and position. */
  refAt: number | null;
  refX: number;
  refY: number;
  /** Motion at the latest sample, canvas units per second; `angle` in radians. */
  dx: number;
  dy: number;
  speed: number;
  angle: number;
  /** Time of the latest down, move, up or cancel. */
  last: number;
}

/** Slots in the order they last changed, most recent last. At most MAX_SLOTS. */
type Contacts = Contact[];

/** One pushed event, reduced to what the state needs. */
interface Change {
  time: number;
  /** The raw pointerId. */
  id: number;
  /** Index into KINDS. */
  kind: number;
  x: number | null;
  y: number | null;
  pressure: number | null;
}

/** What one change emits: its event's slot, phase and derived fields, and a contact it pushed out. */
interface Stepped {
  slot: number;
  phase: Phase | null;
  dx: number;
  dy: number;
  speed: number;
  angle: number;
  age: number;
  /** A contact that was down when its slot was taken (MAX_SLOTS): it gets a Cancel first. */
  evicted: Contact | null;
}

/** A payload field as a 0–1 number, or null when it's missing or not finite. */
function unit(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
}

function fresh(slot: number): Contact {
  return { slot, id: null, x: 0, y: 0, pressure: 0, down: false, downAt: 0, refAt: null, refX: 0, refY: 0, dx: 0, dy: 0, speed: 0, angle: 0, last: -Infinity };
}

/**
 * Gives pointer `id` a slot: the lowest free one, or when all MAX_SLOTS are held, the
 * slot of the pointer that changed least recently, preferring one that isn't down.
 * A new slot's record goes first (least recent), so binding alone doesn't make it
 * the latest pointer. The holder starts with no motion history.
 */
function bind(contacts: Contacts, id: number): { contact: Contact; evicted: Contact | null } {
  const held = new Set(contacts.filter((c) => c.id !== null).map((c) => c.slot));
  let evicted: Contact | null = null;
  let contact: Contact | undefined;
  let slot = 1;
  while (slot <= MAX_SLOTS && held.has(slot)) slot++;
  if (slot <= MAX_SLOTS) {
    contact = contacts.find((c) => c.slot === slot);
    if (!contact) contacts.unshift((contact = fresh(slot)));
  } else {
    contact = contacts.find((c) => !c.down) ?? contacts[0]!;
    if (contact.down) evicted = { ...contact };
  }
  Object.assign(contact, { id, down: false, refAt: null, dx: 0, dy: 0, speed: 0, angle: 0 });
  return { contact, evicted };
}

/** Applies one change in place and says what it emits, or null when it emits nothing. */
function step(contacts: Contacts, change: Change): Stepped | null {
  const kind: Kind = KINDS[change.kind]!;
  let contact = contacts.find((c) => c.id === change.id);
  if (kind === 'leave') {
    // A pointer that's down keeps its slot until its Up or Cancel.
    if (contact && !contact.down) contact.id = null;
    return null;
  }
  let evicted: Contact | null = null;
  if (!contact) ({ contact, evicted } = bind(contacts, change.id));
  const { time } = change;
  const quiet = { slot: contact.slot, phase: null, dx: 0, dy: 0, speed: 0, angle: 0, age: 0, evicted };
  if (kind === 'enter') return evicted ? quiet : null;
  const phase = kind as Phase;
  const x = change.x ?? contact.x, y = change.y ?? contact.y;
  // Motion since the previous sample. Samples at one time (the same render quantum) keep the
  // previous motion and the earlier reference, so the next sample spans the real time.
  if (contact.refAt === null || time > contact.refAt) {
    if (contact.refAt !== null) {
      const dt = time - contact.refAt;
      contact.dx = (x - contact.refX) / dt;
      contact.dy = (y - contact.refY) / dt;
      contact.speed = Math.hypot(contact.dx, contact.dy);
      if (contact.speed > 0) contact.angle = Math.atan2(contact.dy, contact.dx);
    }
    contact.refAt = time;
    contact.refX = x;
    contact.refY = y;
  }
  contact.x = x;
  contact.y = y;
  if (phase === 'down') {
    contact.down = true;
    contact.downAt = time;
    contact.pressure = change.pressure ?? DEFAULT_PRESSURE;
  } else if (phase === 'move') contact.pressure = change.pressure ?? contact.pressure;
  const age = contact.down ? time - contact.downAt : 0;
  if (phase === 'up' || phase === 'cancel') {
    contact.down = false;
    contact.pressure = 0;
    contact.id = null;
  }
  contact.last = time;
  // Most recent last.
  contacts.splice(contacts.indexOf(contact), 1);
  contacts.push(contact);
  return { ...quiet, phase, dx: contact.dx, dy: contact.dy, speed: contact.speed, angle: contact.angle, age };
}

const pendingOf = (state: NodeState): Change[] => (state.pending ?? []) as Change[];

/** The contacts as they are at time t: the base plus this window's changes at or before t. */
function contactsAt(state: NodeState, t: number): readonly Contact[] {
  // Reads never write state: only query() changes it (NodeState contract).
  const base = (state.contacts ?? []) as Contacts;
  const pending = pendingOf(state);
  if (!(pending.length && pending[0]!.time <= t)) return base;
  const contacts = base.map((c) => ({ ...c }));
  for (const change of pending) {
    if (change.time > t) break;
    step(contacts, change);
  }
  return contacts;
}

/** The port each kind is pushed on: the phases on their outputs, enter and leave on push-only ports. */
export const POINTER_READS: InputSpec['reads'] = {
  pointerenter: 'enter',
  pointerdown: 'down',
  pointermove: 'move',
  pointerup: 'up',
  pointercancel: 'cancel',
  pointerleave: 'leave',
};

export const POINTER_PORTS: PortSpec[] = [
  { name: 'down', type: 'event', direction: 'out', label: 'Down' },
  { name: 'move', type: 'event', direction: 'out', label: 'Move' },
  { name: 'up', type: 'event', direction: 'out', label: 'Up' },
  { name: 'cancel', type: 'event', direction: 'out', label: 'Cancel' },
  { name: 'all', type: 'event', direction: 'out', label: 'All' },
  { name: 'x', type: 'signal', direction: 'out', label: 'X' },
  { name: 'y', type: 'signal', direction: 'out', label: 'Y' },
  { name: 'pressure', type: 'signal', direction: 'out', label: 'Pressure' },
  { name: 'speed', type: 'signal', direction: 'out', label: 'Speed' },
  { name: 'count', type: 'signal', direction: 'out', label: 'Count' },
];

/**
 * Pointer's query, shared with the pointer sources that rewrite the same way (Pointer
 * (high rate)): folds the previous window's changes into `contacts`, keeps this
 * window's in `pending` for `signal()`, and returns each push rewritten.
 */
export function pointerQuery({ state, pushed }: Pick<QueryContext, 'state' | 'pushed'>): QueryResult {
  const contacts = (state.contacts ??= []) as Contacts;
  for (const change of pendingOf(state)) step(contacts, change);
  const items: { change: Change; event: EngineEvent }[] = [];
  KINDS.forEach((kind, k) => {
    for (const event of pushed[kind] ?? []) {
      // Raw pointerIds are integers; anything else has no pointer to give a slot to.
      if (!Number.isFinite(event.time) || !Number.isInteger(event.channel)) continue;
      items.push({ change: { time: event.time, id: event.channel, kind: k, x: unit(event.x), y: unit(event.y), pressure: unit(event.pressure) }, event });
    }
  });
  // Stable: ties keep each port's order (time, then raw id, then push order).
  items.sort((a, b) => a.change.time - b.change.time || a.change.id - b.change.id || a.change.kind - b.change.kind);
  state.pending = items.map((item) => item.change);
  if (!items.length) return {};
  const out: Record<Phase | 'all', EngineEvent[]> = { down: [], move: [], up: [], cancel: [], all: [] };
  const work = contacts.map((c) => ({ ...c }));
  for (const { change, event } of items) {
    const stepped = step(work, change);
    if (!stepped) continue;
    const { evicted } = stepped;
    if (evicted) {
      const cancel: EngineEvent = { time: change.time, channel: evicted.slot, x: evicted.x, y: evicted.y, pressure: 0, dx: 0, dy: 0, speed: 0, angle: evicted.angle, age: change.time - evicted.downAt };
      out.cancel.push(cancel);
      out.all.push({ ...cancel, phase: 'cancel' });
    }
    if (!stepped.phase) continue;
    const { slot, phase, dx, dy, speed, angle, age } = stepped;
    const rewritten: EngineEvent = { ...event, channel: slot, dx, dy, speed, angle, age };
    out[phase].push(rewritten);
    out.all.push({ ...rewritten, phase });
  }
  const result: QueryResult = {};
  for (const [port, events] of Object.entries(out)) if (events.length) result[port] = events;
  return result;
}

/** Pointer's signals at t on a channel (a slot; any other channel reads the latest pointer). */
export function pointerSignal(state: NodeState, port: string, t: number, channel: number): number {
  const contacts = contactsAt(state, t);
  if (port === 'count') return contacts.reduce((n, c) => n + (c.down ? 1 : 0), 0);
  const contact = contacts.find((c) => c.slot === channel) ?? contacts[contacts.length - 1];
  if (!contact) return 0;
  if (port === 'x') return contact.x;
  if (port === 'y') return contact.y;
  if (port === 'pressure') return contact.pressure;
  if (port === 'speed') return contact.id !== null && !(t - contact.last > STILL) ? contact.speed : 0;
  return 0;
}

/**
 * Canvas source: the pointers on the performance canvas (docs/nodes/canvas-sources.md),
 * M2 complete. `input` reads pointerenter, pointerdown, pointermove, pointerup,
 * pointercancel and pointerleave (ADR 0029); the host pushes each as
 * `{ channel: pointerId, x, y, pressure, pointerType, width, height, button, buttons,
 * shift, alt, ctrl, meta }`, x and y normalized 0–1, y = 0 at the top. Coalesced moves
 * (`coalesced: true`) are Pointer (high rate)'s, so Pointer skips them. The scheduler
 * stamps them currentTime + 5 ms.
 *
 * It rewrites its pushes (`InputSpec.rewrites`): the runtime doesn't pass them through,
 * and `query` returns each Down, Move, Up and Cancel at its own time, so it stays on the
 * immediate path (ADR 0020), with
 * - `channel`: the pointer's slot, not its pointerId. A pointer takes the lowest free
 *   slot from 1 on its first event (an enter or a hover move included) and frees it on
 *   Up, Cancel or a leave while not down; the next pointer reuses it. So touches, whose
 *   pointerIds keep counting up, stay on small channels, live and on replay alike
 *   (streams record raw pointerIds). Past MAX_SLOTS see `bind`; a contact down when its
 *   slot is taken gets a Cancel (on Cancel and All) at the taking event's time first.
 * - `dx`, `dy`: motion since this slot's previous sample, in canvas units per second,
 *   from the event times; `speed` their length and `angle` their direction, atan2(dy, dx)
 *   in radians (0 to the right, π/2 down). A slot's first sample after it's taken has
 *   0 motion, and a sample at the same time as the previous one keeps its motion. When
 *   the pointer doesn't move, `angle` keeps the last direction it moved in.
 * - `age`: seconds since this slot's Down; 0 on a hover move and on the Down itself.
 * The rest of the payload passes through as pushed. All carries the same events with
 * `phase` down, move, up or cancel (ADR 0028); a move with no contact open is a hover.
 * Enter and leave update the slots only: they emit nothing and have no phase. Events
 * whose channel isn't an integer have no pointer and are dropped.
 *
 * Signals, per channel (slot):
 * - X, Y: the slot's last position, clamped to 0–1, held after Up, Cancel or leave.
 *   A missing or non-finite x or y keeps the previous value.
 * - Pressure: the payload's pressure while down (0.5 if a Down carries none, a Move
 *   without one keeps the last), 0 after Up or Cancel. A hover Move sets it too.
 * - Speed: the latest sample's speed while a pointer holds the slot, and 0 once STILL
 *   passes with no sample, or once the slot is freed.
 * - Count: the number of pointers down, the same on every channel.
 * Channel 0, or any channel no slot has had, reads the pointer that changed most
 * recently (an enter alone doesn't count), so a clock-driven note can follow whoever
 * touched last. Before any pointer, every signal is 0.
 *
 * State (plain data): `contacts` holds every slot as the current window began, and
 * `pending` this window's pushes, sorted by time, then pointerId, then enter, down,
 * move, up, cancel, leave. `query` folds the previous window's pending changes in first,
 * then steps a copy through this window's for the events; `signal(t)` applies the
 * pending ones at or before t. Slots, motion and age all come from this one fold, so
 * neither events nor signals depend on the window size, and rewinds replay them.
 *
 * Same-time ties: the scheduler stamps pushes on render quanta (about 2.7 ms), so a
 * Down and an Up on one pointer can share a time. They then apply Down, Move, Up,
 * Cancel in that order, whatever the push order, and so does All. A tap shorter than a
 * quantum so ends lifted rather than stuck down, but a re-press (Up then Down) inside
 * one quantum reads lifted, and its next events are a hover until its next Down. Two new
 * pointers at one time take slots in pointerId order.
 */
export const pointer: NodeDefinition = {
  type: 'pointer',
  version: 2,
  label: 'Pointer',
  category: 'canvas-sources',
  description: 'Down, Move, Up, Cancel and All events from pointers on the canvas, one channel per pointer, with X, Y, Pressure, Speed and Count signals.',
  ports: POINTER_PORTS,
  params: [],
  input: {
    reads: POINTER_READS,
    accepts: (event) => event.coalesced !== true,
    rewrites: true,
  },
  query: pointerQuery,
  signal: (ctx, port, t, channel) => pointerSignal(ctx.state, port, t, channel),
};
