import { limitWindowOf, NODE_EVENT_LIMIT, type EngineEvent, type EventField, type InputSpec, type NodeDefinition, type NodeState, type PortSpec, type QueryContext, type QueryResult } from '@flow-patcher/engine';

/** The contact phases (ADR 0028), which are also the per-phase Event outputs. */
export const PHASES = ['down', 'move', 'up', 'cancel'] as const;
export type Phase = (typeof PHASES)[number];
/** All's hover-end marker (ADR 0028, amended for #101): a hovering pointer left and gave its slot up.
 *  Not a contact phase: it opens and ends no contact, and has no per-phase port. */
export const LEAVE = 'leave';

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
/** Shortest span motion is measured over, seconds: closer samples add their intervals up first, so a
 *  burst of samples microseconds apart can't make the speed spike. */
export const MIN_INTERVAL = 0.001;
/**
 * Events per limit window (ADR 0022) kept for Down, Up and Cancel: moves stop being emitted once a
 * window's count would pass NODE_EVENT_LIMIT − RESERVE, so the runtime's per-node cap, which drops the
 * latest events, never takes an Up or a Cancel. The patch-wide cap (PATCH_EVENT_LIMIT) still can. 32 contacts' worth of starts and ends per 120 ms.
 */
export const RESERVE = 64;
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
  /** The sample motion is measured from: its stamp (null before the holder's first) and position, and
   *  the `interval`s of later samples too close to it to measure from yet (MIN_INTERVAL). */
  refAt: number | null;
  refX: number;
  refY: number;
  gap: number;
  /** Motion at the latest sample, canvas units per second; `angle` in radians. */
  dx: number;
  dy: number;
  speed: number;
  angle: number;
  /** Time of the latest down, move, up or cancel. */
  last: number;
  /** Whether the holder has emitted a Down or Move since it took the slot. Until it has, the record's
   *  position and payload are the previous holder's, so it gets no leave (ADR 0028, #101). */
  seen: boolean;
  /** The rest of the latest event's payload (pointerType, size, buttons, modifiers), for a Cancel when it's evicted. */
  payload: Record<string, EventField>;
}

/** Slots in the order they last changed, most recent last. At most MAX_SLOTS. */
type Contacts = Contact[];

/** One pushed event, reduced to what the state needs. */
interface Change {
  time: number;
  /** The payload's `interval`: seconds since this pointer's previous sample, by the browser's clock. Null when missing. */
  interval: number | null;
  /** The raw pointerId. */
  id: number;
  /** Index into KINDS. */
  kind: number;
  x: number | null;
  y: number | null;
  pressure: number | null;
  /** The event's other fields (`payloadOf`). */
  payload: Record<string, EventField>;
}

/** Fields an event carries that Pointer neither reads nor derives: what an eviction's Cancel repeats. */
const OWN_FIELDS = new Set(['time', 'channel', 'x', 'y', 'pressure', 'dx', 'dy', 'speed', 'angle', 'age', 'phase', 'coalesced', 'interval']);
function payloadOf(event: EngineEvent): Record<string, EventField> {
  const out: Record<string, EventField> = {};
  for (const [name, value] of Object.entries(event)) if (!OWN_FIELDS.has(name) && value !== undefined) out[name] = value;
  return out;
}

/** What one change emits: its event's slot, phase and derived fields, and a contact it pushed out. */
interface Stepped {
  slot: number;
  /** A contact phase, or `leave` when a hovering pointer left (All only), or null for nothing. */
  phase: Phase | typeof LEAVE | null;
  dx: number;
  dy: number;
  speed: number;
  angle: number;
  age: number;
  /** The contact whose slot was taken (MAX_SLOTS): a Cancel first if it was down, a leave if it
   *  hovered and emitted since it took the slot, else nothing. */
  evicted: Contact | null;
}

/** A payload field as a 0–1 number, or null when it's missing or not finite. */
function unit(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
}

function fresh(slot: number): Contact {
  return { slot, id: null, x: 0, y: 0, pressure: 0, down: false, downAt: 0, refAt: null, refX: 0, refY: 0, gap: 0, dx: 0, dy: 0, speed: 0, angle: 0, last: -Infinity, payload: {}, seen: false };
}

/**
 * Gives pointer `id` a slot: the lowest free one, or when all MAX_SLOTS are held, the
 * slot of the pointer that changed least recently, preferring one that isn't down.
 * A new slot's record goes first (least recent), so binding alone (an enter) puts it
 * behind every pointer that has changed, though it's still the latest when it's the
 * only one. The holder starts with no motion history. The pointer it took the slot from
 * comes back as `evicted` (a Cancel if it was down, a leave if it hovered).
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
    evicted = { ...contact, payload: { ...contact.payload } };
  }
  Object.assign(contact, { id, down: false, refAt: null, gap: 0, dx: 0, dy: 0, speed: 0, angle: 0, seen: false });
  return { contact, evicted };
}

/** Applies one change in place and says what it emits, or null when it emits nothing. */
function step(contacts: Contacts, change: Change): Stepped | null {
  const kind: Kind = KINDS[change.kind]!;
  let contact = contacts.find((c) => c.id === change.id);
  if (kind === 'leave') {
    // A pointer that's down keeps its slot until its Up or Cancel. A hovering one gives it up, and
    // All marks the end of its hover, at the slot's last position, if it emitted anything since it
    // took the slot: before that, the position and payload are the previous holder's.
    if (!contact || contact.down) return null;
    contact.id = null;
    if (!contact.seen) return null;
    return { slot: contact.slot, phase: LEAVE, dx: 0, dy: 0, speed: 0, angle: contact.angle, age: 0, evicted: null };
  }
  // An Up or Cancel ends a contact; with none open for this pointer (pressed outside the canvas,
  // or its Down already ended in this quantum) there's nothing to end, so it takes no slot.
  if ((kind === 'up' || kind === 'cancel') && !contact?.down) return null;
  let evicted: Contact | null = null;
  if (!contact) ({ contact, evicted } = bind(contacts, change.id));
  const { time, interval } = change;
  const quiet = { slot: contact.slot, phase: null, dx: 0, dy: 0, speed: 0, angle: 0, age: 0, evicted };
  if (kind === 'enter') return evicted ? quiet : null;
  const phase = kind as Phase;
  const x = change.x ?? contact.x, y = change.y ?? contact.y;
  // Motion since the reference sample, over the browser's spacing (`interval`) when the event has it,
  // else over the stamps. Stamps mix render quanta and handler delays, so only the fallback uses them.
  // Under MIN_INTERVAL (samples at one stamp, or microseconds apart) a sample keeps the previous motion
  // and the reference stays, so the next sample spans the real time.
  const dt = contact.refAt === null ? null : interval !== null ? contact.gap + interval : time - contact.refAt;
  if (dt === null || dt >= MIN_INTERVAL) {
    if (dt !== null) {
      contact.dx = (x - contact.refX) / dt;
      contact.dy = (y - contact.refY) / dt;
      contact.speed = Math.hypot(contact.dx, contact.dy);
      if (contact.speed > 0) contact.angle = Math.atan2(contact.dy, contact.dx);
    }
    contact.refAt = time;
    contact.refX = x;
    contact.refY = y;
    contact.gap = 0;
  } else if (interval !== null) contact.gap += interval;
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
  contact.payload = change.payload;
  contact.seen = true;
  // Most recent last.
  contacts.splice(contacts.indexOf(contact), 1);
  contacts.push(contact);
  return { ...quiet, phase, dx: contact.dx, dy: contact.dy, speed: contact.speed, angle: contact.angle, age };
}

const pendingOf = (state: NodeState): Change[] => (state.pending ?? []) as Change[];

/** Events emitted in one limit window (ADR 0022): `k` its index, `n` the count so far. */
interface Cell {
  k: number;
  n: number;
}

/**
 * Counts what a stepped change emits in its limit window and says whether its event is emitted:
 * an eviction's Cancel or leave and every Down, Up, Cancel and leave always are, a Move only while
 * the window has room for it below the reserve. Each phase event costs two (its phase port and
 * All), a leave one (All only).
 */
function admit(cell: Cell, time: number, stepped: Stepped): boolean {
  const k = limitWindowOf(time);
  if (k !== cell.k) Object.assign(cell, { k, n: 0 });
  if (stepped.evicted) cell.n += stepped.evicted.down ? 2 : stepped.evicted.seen ? 1 : 0;
  if (!stepped.phase) return false;
  const cost = stepped.phase === LEAVE ? 1 : 2;
  if (stepped.phase === 'move' && cell.n + cost > NODE_EVENT_LIMIT - RESERVE) return false;
  cell.n += cost;
  return true;
}

/** Pushes at one time on one pointer, in the order they apply: `KINDS`, except that a hover move
 *  (`buttons` 0) goes before a Down at that time, and after an Up or Cancel. */
function rank(change: Change, hover: boolean, group: { down: boolean; end: boolean }): number {
  const kind = KINDS[change.kind]!;
  if (kind === 'move' && hover) {
    if (group.down && !group.end) return 0.5;
    if (group.end && !group.down) return 4.5;
  }
  return change.kind;
}

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
  const cell = (state.cell ??= { k: -Infinity, n: 0 }) as Cell;
  for (const change of pendingOf(state)) {
    const stepped = step(contacts, change);
    if (stepped) admit(cell, change.time, stepped);
  }
  const items: { change: Change; event: EngineEvent; hover: boolean; rank: number }[] = [];
  KINDS.forEach((kind, k) => {
    for (const event of pushed[kind] ?? []) {
      // Raw pointerIds are integers; anything else has no pointer to give a slot to.
      if (!Number.isFinite(event.time) || !Number.isInteger(event.channel)) continue;
      const interval = typeof event.interval === 'number' && event.interval >= 0 && Number.isFinite(event.interval) ? event.interval : null;
      const change = { time: event.time, interval, id: event.channel, kind: k, x: unit(event.x), y: unit(event.y), pressure: unit(event.pressure), payload: payloadOf(event) };
      items.push({ change, event, hover: event.buttons === 0, rank: k });
    }
  });
  // Per time and pointer: whether it starts there (enter or down) and whether it ends (up or cancel).
  const groups = new Map<string, { down: boolean; end: boolean; starts: boolean }>();
  const keyOf = (change: Change) => `${change.time}|${change.id}`;
  for (const { change } of items) {
    let group = groups.get(keyOf(change));
    if (!group) groups.set(keyOf(change), (group = { down: false, end: false, starts: false }));
    const kind = KINDS[change.kind]!;
    group.down ||= kind === 'down';
    group.end ||= kind === 'up' || kind === 'cancel';
    group.starts ||= kind === 'enter' || kind === 'down';
  }
  for (const item of items) item.rank = rank(item.change, item.hover, groups.get(keyOf(item.change))!);
  // At one time, pointers that don't start there go first, so a pointer that lifts (or drags to its
  // Up) frees its slot for one that arrives in the same quantum. Then by raw id and rank; stable, so
  // ties keep each port's order.
  const starting = (change: Change) => (groups.get(keyOf(change))!.starts ? 1 : 0);
  items.sort((a, b) => a.change.time - b.change.time || starting(a.change) - starting(b.change) || a.change.id - b.change.id || a.rank - b.rank);
  state.pending = items.map((item) => item.change);
  if (!items.length) return {};
  const out: Record<Phase | 'all', EngineEvent[]> = { down: [], move: [], up: [], cancel: [], all: [] };
  const work = contacts.map((c) => ({ ...c }));
  const budget = { ...cell };
  for (const { change, event } of items) {
    const stepped = step(work, change);
    if (!stepped) continue;
    const emit = admit(budget, change.time, stepped);
    const { evicted } = stepped;
    if (evicted?.down) {
      const cancel: EngineEvent = { ...evicted.payload, time: change.time, channel: evicted.slot, x: evicted.x, y: evicted.y, pressure: 0, dx: 0, dy: 0, speed: 0, angle: evicted.angle, age: change.time - evicted.downAt };
      out.cancel.push(cancel);
      out.all.push({ ...cancel, phase: 'cancel' });
    } else if (evicted?.seen) {
      out.all.push({ ...evicted.payload, time: change.time, channel: evicted.slot, x: evicted.x, y: evicted.y, pressure: evicted.pressure, dx: 0, dy: 0, speed: 0, angle: evicted.angle, age: 0, phase: LEAVE });
    }
    if (!emit || !stepped.phase) continue;
    const { slot, phase, dx, dy, speed, angle, age } = stepped;
    if (phase === LEAVE) {
      // Where the hover was: the leave's own position is the canvas edge, and the signals hold the last sample's.
      const held = work.find((c) => c.slot === slot)!;
      out.all.push({ ...event, channel: slot, x: held.x, y: held.y, pressure: held.pressure, dx, dy, speed, angle, age, phase });
      continue;
    }
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
 * (`coalesced: true`) are Pointer (high rate)'s, so Pointer skips them: the browser's
 * coalesced list includes the dispatched move itself, so the host pushes every sample
 * with `coalesced: true` for Pointer (high rate) and the plain move for Pointer, and
 * neither node sees a sample twice. The scheduler stamps them currentTime + 5 ms.
 *
 * `interval` (seconds, optional): the time since this pointer's previous sample, by the
 * browser's event clock (`timeStamp`), as the host records it. Stamps carry render quanta
 * and handler delays, and a browser event's coalesced samples share one, so motion uses
 * the intervals and falls back to the stamps only for events without one (hand-written
 * streams). Stamps still order events and drive `age`.
 *
 * It rewrites its pushes (`InputSpec.rewrites`): the runtime doesn't pass them through,
 * and `query` returns each Down, Move, Up and Cancel at its own time, so it stays on the
 * immediate path (ADR 0020), with
 * - `channel`: the pointer's slot, not its pointerId. A pointer takes the lowest free
 *   slot from 1 on its first event (an enter or a hover move included) and frees it on
 *   Up, Cancel or a leave while not down; the next pointer reuses it. An Up or Cancel
 *   with no contact down for its pointer (pressed outside the canvas, then dragged in
 *   and released) is dropped and takes no slot. So touches, whose
 *   pointerIds keep counting up, stay on small channels, live and on replay alike
 *   (streams record raw pointerIds). Past MAX_SLOTS see `bind`; a contact down when its
 *   slot is taken gets a Cancel (on Cancel and All) at the taking event's time first,
 *   with its last event's payload, and a hovering one a leave on All.
 * - `dx`, `dy`: motion since this slot's previous sample, in canvas units per second,
 *   over its `interval` (above); `speed` their length and `angle` their direction,
 *   atan2(dy, dx) in radians (0 to the right, π/2 down). A slot's first sample after it's
 *   taken has 0 motion. A sample less than MIN_INTERVAL after the reference keeps the
 *   previous motion and the next one measures from that reference. When the pointer
 *   doesn't move, `angle` keeps the last direction it moved in.
 * - `age`: seconds since this slot's Down; 0 on a hover move and on the Down itself.
 * The rest of the payload passes through as pushed. All carries the same events with
 * `phase` down, move, up or cancel (ADR 0028); a move with no contact open is a hover.
 * Enter updates the slots only and emits nothing. A leave while not down frees the slot and
 * puts a hover-end marker on All (ADR 0028, amended for #101): `phase: 'leave'` on the slot's
 * channel, at the leave's time, with the slot's last x, y and pressure, no motion, age 0, and
 * the leave's other payload fields (an eviction's leave: the evicted pointer's last payload). A
 * pointer that emitted nothing since it took the slot (an enter, then a leave) gets no leave:
 * the slot's record still holds the previous holder's position. It has no per-phase port and costs one event (All only), and
 * like Down, Up and Cancel it's never thinned. A leave while down emits nothing: the slot waits
 * for its Up or Cancel, which ends the contact. Events whose channel isn't an integer have no
 * pointer and are dropped.
 *
 * Event budget: in each limit window (120 ms on the absolute grid, ADR 0022) Moves stop
 * being emitted once the node's count would pass NODE_EVENT_LIMIT − RESERVE, so Down, Up,
 * Cancel and leave always fit under the runtime's per-node cap. The patch-wide cap
 * (PATCH_EVENT_LIMIT, 2,048) counts every node, so a busy patch can still drop them there. Thinned moves still move the signals and
 * the motion. A plain Pointer only reaches it with many fingers on a fast screen; Pointer
 * (high rate) with three fingers at a few hundred samples a second.
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
 * recently, so a clock-driven note can follow whoever touched last. An enter alone
 * doesn't make a pointer the latest, unless no other pointer has changed yet. Before any pointer, every signal is 0.
 *
 * State (plain data): `contacts` holds every slot as the current window began, `cell`
 * the event count of the limit window it began in, and `pending` this window's pushes,
 * sorted as below. `query` folds the previous window's pending changes in first,
 * then steps a copy through this window's for the events; `signal(t)` applies the
 * pending ones at or before t. Slots, motion and age all come from this one fold, so
 * neither events nor signals depend on the window size, and rewinds replay them.
 *
 * Same-time ties: the scheduler stamps pushes on render quanta (about 2.7 ms), so a
 * Down and an Up on one pointer can share a time. They then apply enter, Down, Move,
 * Up, Cancel, leave in that order, whatever the push order, and so does All. A hover
 * move (`buttons` 0) is the exception: it goes before a Down at its time (browsers
 * flush the pending move just before pointerdown) and after an Up or Cancel. A tap shorter than a
 * quantum so ends lifted rather than stuck down, but a re-press (Up then Down) inside
 * one quantum reads lifted, and its next events are a hover (its Up then dropped)
 * until its next Down. At one time, pointers that don't start there (no enter or Down)
 * go first, so one that lifts, or drags to its Up, frees its slot before another takes
 * one, and two new pointers take slots in pointerId order.
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
