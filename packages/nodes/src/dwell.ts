import type { EngineEvent, NodeDefinition } from '@flow-patcher/engine';
import { addPass, nonEmpty, PASS_PORTS } from './switch';

/** Pointer types that can hover. A touch has no hover. */
const HOVERING = ['mouse', 'pen'];

/**
 * One channel's hover. Plain data, so rewind snapshots can clone it (ADR 0019). `open` while a
 * contact is down: no dwell then. Otherwise, once anchored, the stay began at (ax, ay) and fires at
 * `fireAt` unless the pointer leaves `radius` first; null once it fired.
 */
interface Stay {
  open: boolean;
  anchored: boolean;
  ax: number;
  ay: number;
  radius: number;
  fireAt: number | null;
  /** The latest hover position and pointer type, for the Dwell event. */
  x: number;
  y: number;
  pointerType: string;
}

const closed = (open: boolean): Stay => ({ open, anchored: false, ax: 0, ay: 0, radius: 0, fireAt: null, x: 0, y: 0, pointerType: '' });

/**
 * Gesture recognizer: fires when a mouse or pen hovers in one spot (docs/nodes/gesture-recognizers.md).
 * A hover is a `move` with no contact open on its channel (ADR 0028), from a pointer whose
 * `pointerType` is mouse or pen. The first hover move anchors a stay at its position. A later
 * hover move farther than Radius from the anchor starts a new stay there; nearer ones don't. When
 * a stay lasts Time with no such move, Dwell fires once, at the anchor's time + Time, even though
 * a pointer held still sends no events then. It fires again only after the pointer leaves Radius
 * and stays still somewhere else. A `down` ends the stay without firing; after the contact's `up`
 * or `cancel`, the next hover move anchors a new one. Radius and Time are read when a stay is
 * anchored, on its channel. Distances are in canvas units, as x and y are.
 *
 * Dwell: `{ x, y, pointerType }` at the fire time, x and y being the latest hover position.
 *
 * Dwell never claims: a hover isn't a contact, so there's nothing to take from downstream. Pass
 * carries every event unchanged, split by phase on Pass Down, Move, Up and Cancel, so Dwell can
 * sit anywhere in a recognizer chain.
 *
 * All has no leave phase: a pointer that leaves the canvas still and its last hover move near
 * the edge fires a Dwell there.
 *
 * State: `stays` per channel. Events are processed in time order and due fires before each event
 * (a fire due at an event's time comes first), then those due before the window ends, so neither
 * depends on windowing.
 */
export const dwell: NodeDefinition = {
  type: 'dwell',
  version: 1,
  label: 'Dwell',
  category: 'gesture-recognizers',
  description: 'Fires when a mouse or pen hovers within Radius for Time. Passes every event through.',
  ports: [
    { name: 'in', type: 'event', direction: 'in', label: 'In' },
    { name: 'dwell', type: 'event', direction: 'out', label: 'Dwell' },
    ...PASS_PORTS,
  ],
  params: [
    { name: 'radius', kind: 'number', min: 0.001, max: 0.2, default: 0.02, label: 'Radius' },
    { name: 'time', kind: 'number', min: 0.1, max: 5, default: 0.6, unit: 's', label: 'Time' },
  ],
  query({ inputs, state, param, t1 }) {
    const stays = (state.stays ??= {}) as Record<string, Stay>;
    const fires: EngineEvent[] = [];
    const flush = (until: number, inclusive: boolean) => {
      const due: { channel: number; stay: Stay }[] = [];
      for (const [key, stay] of Object.entries(stays)) {
        if (stay.fireAt !== null && (stay.fireAt < until || (inclusive && stay.fireAt === until))) due.push({ channel: Number(key), stay });
      }
      due.sort((a, b) => a.stay.fireAt! - b.stay.fireAt! || a.channel - b.channel);
      for (const { channel, stay } of due) {
        fires.push({ time: stay.fireAt!, channel, x: stay.x, y: stay.y, pointerType: stay.pointerType });
        stay.fireAt = null;
      }
    };
    const pass: EngineEvent[] = [];
    for (const event of inputs.in ?? []) {
      if (!Number.isFinite(event.time)) continue;
      flush(event.time, true);
      pass.push(event);
      const { channel, phase, x, y, pointerType } = event;
      if (!Number.isInteger(channel)) continue;
      const key = String(channel);
      if (phase === 'down') stays[key] = closed(true);
      else if (phase === 'up' || phase === 'cancel') delete stays[key];
      else if (phase === 'move') {
        const stay = stays[key];
        if (stay?.open) continue;
        if (typeof pointerType !== 'string' || !HOVERING.includes(pointerType)) continue;
        if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (stay?.anchored && !(Math.hypot(x - stay.ax, y - stay.ay) > stay.radius)) {
          Object.assign(stay, { x, y, pointerType });
          continue;
        }
        const time = event.time;
        stays[key] = { open: false, anchored: true, ax: x, ay: y, radius: param('radius', time, channel), fireAt: time + param('time', time, channel), x, y, pointerType };
      }
    }
    flush(t1, false);
    const out: Record<string, EngineEvent[]> = { dwell: fires };
    addPass(out, pass);
    return nonEmpty(out);
  },
};
