import type { EngineEvent, InputFields, InputSpec, NodeDefinition, NodeState, QueryContext, QueryResult } from '@flow-patcher/engine';
import { POINTER_READS, pointerContactAt, pointerQuery } from './pointer';

/** Contact sizes clamp to 0–this many CSS pixels, so one wild event can't swamp a modulation. */
export const MAX_SIZE = 1_000;
/** Scale clamps to MIN_SCALE–1 / MIN_SCALE: a gesture's cumulative scale is a ratio, always above 0. */
export const MIN_SCALE = 0.001;
/** What Scale and Rotation read before any gesturechange, and always outside Safari: no pinch, no turn. */
export const GESTURE_DEFAULTS = { scale: 1, rotation: 0 } as const;

const RAD = Math.PI / 180;

/** Touch extras reads the pointer events (for touches' slots and sizes) onto push-only ports, and `gesturechange` onto Gesture. */
export const TOUCH_EXTRAS_READS = { ...POINTER_READS, gesturechange: 'gesture' } as const satisfies InputSpec['reads'];

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isTouch = (event: Readonly<InputFields> | EngineEvent) => event.pointerType === 'touch';

/** A contact size in CSS pixels, clamped to 0–MAX_SIZE; 0 when it's missing or not finite (no size reported). */
export function contactSize(value: unknown): number {
  return finite(value) ? Math.min(MAX_SIZE, Math.max(0, value)) + 0 : 0;
}

/** The gesture as of its latest change: Scale (a ratio) and Rotation (radians, positive clockwise). */
interface Gesture {
  scale: number;
  rotation: number;
}

/** One gesturechange, reduced to what the signals need. */
interface GestureChange extends Gesture {
  time: number;
}

/**
 * One gesturechange as Touch extras emits it, given the gesture before it: `scale` clamped to
 * MIN_SCALE–1 / MIN_SCALE, `rotation` converted from Safari's degrees to radians; a scale that isn't
 * a finite number above 0, or a rotation that isn't finite, keeps the previous value. x and y clamp
 * to 0–1 (left out when not finite), the channel is 0, and the rest passes through.
 */
function rewriteGesture(event: EngineEvent, previous: Gesture): EngineEvent {
  const scale = finite(event.scale) && event.scale > 0 ? Math.min(1 / MIN_SCALE, Math.max(MIN_SCALE, event.scale)) : previous.scale;
  const rotation = finite(event.rotation) ? event.rotation * RAD + 0 : previous.rotation;
  const out: EngineEvent = { ...event, channel: 0, scale, rotation };
  for (const axis of ['x', 'y'] as const) {
    const value = event[axis];
    if (finite(value)) out[axis] = Math.min(1, Math.max(0, value));
    else delete out[axis];
  }
  return out;
}

/** The gesture at t: the latest of this window's changes at or before t, else the one the window began with. */
function gestureAt(state: NodeState, t: number): Gesture {
  // Reads never write state: only query() changes it (NodeState contract).
  let at = (state.gesture as Gesture | undefined) ?? GESTURE_DEFAULTS;
  for (const change of (state.gesturePending ?? []) as GestureChange[]) {
    if (change.time > t) break;
    at = change;
  }
  return at;
}

function touchExtrasQuery({ state, pushed }: Pick<QueryContext, 'state' | 'pushed'>): QueryResult {
  // Touches: Pointer's slots over the touch pushes alone, in its own state keys (contacts, cell,
  // pending). Its events aren't outputs here: only the slots' sizes are read, by the signals.
  const touches: Record<string, EngineEvent[]> = {};
  for (const port of Object.values(POINTER_READS)) {
    const kept = (pushed[port] ?? []).filter(isTouch);
    if (kept.length) touches[port] = kept;
  }
  pointerQuery({ state, pushed: touches });

  // Gestures: fold the previous window's changes in, then rewrite this window's in time order.
  let gesture = (state.gesture as Gesture | undefined) ?? { ...GESTURE_DEFAULTS };
  const previous = (state.gesturePending ?? []) as GestureChange[];
  if (previous.length) {
    const last = previous[previous.length - 1]!;
    gesture = { scale: last.scale, rotation: last.rotation };
  }
  state.gesture = gesture;
  const out: EngineEvent[] = [];
  const pending: GestureChange[] = [];
  const events = (pushed.gesture ?? []).filter((event) => Number.isFinite(event.time));
  // Stable, so pushes at one time keep their order.
  events.sort((a, b) => a.time - b.time);
  for (const event of events) {
    const e = rewriteGesture(event, gesture);
    gesture = { scale: e.scale as number, rotation: e.rotation as number };
    pending.push({ time: e.time, ...gesture });
    out.push(e);
  }
  state.gesturePending = pending;
  return out.length ? { gesture: out } : {};
}

/** Width and Height: the touch slot's latest size, 0 once the slot is free, before any touch, and on a
 *  slot whose holder has only entered (no down or move of its own, so its payload is still the previous finger's). */
function sizeAt(state: NodeState, port: 'width' | 'height', t: number, channel: number): number {
  const contact = pointerContactAt(state, t, channel);
  if (!contact || contact.id === null || contact.refAt === null) return 0;
  return contactSize(contact.payload[port]);
}

/**
 * Canvas source: what touch screens and Safari add beyond Pointer (docs/nodes/canvas-sources.md,
 * Touch extras). Not a contact source in ADR 0028's sense, so it has no All and no phase outputs.
 *
 * **Contact size.** It reads Pointer's event types (enter, down, plain move, up, cancel, leave;
 * not coalesced samples) where `pointerType` is `touch`, and numbers the touches with pointer.ts's
 * slots, its own map as Pen keeps one: the first finger is slot 1 here whatever Pointer gave it,
 * and with only fingers on the canvas the two agree. **Width** and **Height**, per channel (slot),
 * are the slot's latest event's `width` and `height`, in CSS pixels as the browser reports them
 * (Chrome: the contact ellipse's bounding box), clamped to 0–MAX_SIZE. A browser with no contact
 * geometry reports 1 × 1 (the Pointer Events spec's default), so they read 1 there; only hand-written
 * streams can leave a size out, and a missing or non-finite one reads 0. They read 0 once the finger
 * lifts (Up or Cancel), before any touch, and on a slot taken by an enter alone until that touch's
 * first down or move. Channel 0, or a channel no
 * slot has had, reads the latest touch. Mice and pens never reach it (a mouse reports 1 × 1).
 *
 * **Gesture.** Safari sends a pinch or twist (two fingers on iOS, the trackpad on macOS) as
 * gesturestart, gesturechange and gestureend; the host pushes each `gesturechange` (ADR 0029) as
 * `{ x, y, scale, rotation, shift, alt, ctrl, meta }` where it has them: the gesture's centre (0–1),
 * its scale since gesturestart (1 at the start, 2 spread to twice the distance) and rotation since
 * gesturestart in degrees, positive clockwise. **Gesture** emits each one at its own time on channel
 * 0, rewritten: `scale` clamped to MIN_SCALE–1/MIN_SCALE, `rotation` in radians (as Pinch's), x and y
 * clamped to 0–1 or left out; a non-positive or non-finite scale, or a non-finite rotation, keeps
 * the previous value. **Scale** and **Rotation**, the same on every channel, hold the latest
 * gesturechange's values, and read 1 and 0 before any. gesturestart and gestureend aren't stream
 * types, so after a gesture ends they hold its last values until the next gesture's first change,
 * which starts near 1 and 0 again: Safari's scale and rotation are per gesture, not running totals,
 * so a patch mapping Scale or Rotation to a param jumps back at the start of every new pinch. Other browsers send no gesturechange: there Gesture never
 * fires and Scale and Rotation stay 1 and 0 (Chrome, Edge and Firefox send a trackpad pinch as
 * wheel + ctrlKey: Wheel's Zoom; on touch screens, Pinch).
 *
 * State (plain data): Pointer's (`contacts`, `cell`, `pending`), and `gesture` the gesture as of the
 * window's start with `gesturePending` this window's changes. Each folds once, so neither events
 * nor signals depend on the window size.
 */
export const touchExtras: NodeDefinition = {
  type: 'touch-extras',
  version: 1,
  label: 'Touch extras',
  category: 'canvas-sources',
  description: "Each touch's contact Width and Height, and Safari's native pinch: Gesture events with Scale and Rotation signals.",
  ports: [
    { name: 'gesture', type: 'event', direction: 'out', label: 'Gesture' },
    { name: 'width', type: 'signal', direction: 'out', label: 'Width' },
    { name: 'height', type: 'signal', direction: 'out', label: 'Height' },
    { name: 'scale', type: 'signal', direction: 'out', label: 'Scale' },
    { name: 'rotation', type: 'signal', direction: 'out', label: 'Rotation' },
  ],
  params: [],
  input: {
    reads: TOUCH_EXTRAS_READS,
    accepts: (event) => event.type === 'gesturechange' || (isTouch(event) && event.coalesced !== true),
    rewrites: true,
  },
  query: touchExtrasQuery,
  signal({ state }, port, t, channel) {
    if (port === 'width' || port === 'height') return sizeAt(state, port, t, channel);
    if (port === 'scale') return gestureAt(state, t).scale;
    if (port === 'rotation') return gestureAt(state, t).rotation;
    return 0;
  },
};
