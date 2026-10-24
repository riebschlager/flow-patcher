import type { NodeDefinition } from '@flow-patcher/engine';
import { LEAVE } from './pointer';
import { IN_PORT, Outputs, PASS_PORTS } from './recognizer';

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
 * and stays still somewhere else. A `down` ends the stay without firing. A mouse or pen `up`
 * anchors a new stay where it lifted, so a click then holding still dwells; after a `cancel` (or
 * an up from a touch) the next hover move anchors one. Radius and Time are read when a stay is
 * anchored, on its channel. Distances are in canvas units, as x and y are. Events whose time or
 * channel isn't finite are dropped, as the other recognizers drop them.
 *
 * Dwell: `{ x, y, pointerType }` at the fire time, x and y being the latest hover position.
 *
 * Dwell never claims: a hover isn't a contact, so there's nothing to take from downstream. Pass
 * carries every event unchanged, and on Pass Down, Move, Up and Cancel without `phase`, so Dwell
 * can sit anywhere in a recognizer chain (or split a routed output by phase).
 *
 * A hover's leave (`phase: 'leave'` on All, ADR 0028 amended for #101) drops the channel's stay
 * without firing, so a pointer that leaves the canvas still doesn't dwell at the edge, and a
 * later pointer that reuses the slot starts afresh. The leave goes out on Pass alone.
 *
 * State: `stays` per channel, and `cell`, the event budget: forwarded moves and events with no
 * phase are thinned below NODE_EVENT_LIMIT − RESERVE, so downs, ups, cancels, leaves and Dwell's
 * fires always go out. Events are processed in time order and due fires before each event
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
    IN_PORT,
    { name: 'dwell', type: 'event', direction: 'out', label: 'Dwell' },
    ...PASS_PORTS,
  ],
  params: [
    { name: 'radius', kind: 'number', min: 0.001, max: 0.2, default: 0.02, label: 'Radius' },
    { name: 'time', kind: 'number', min: 0.1, max: 5, default: 0.6, unit: 's', label: 'Time' },
  ],
  query({ inputs, state, param, t1 }) {
    const stays = (state.stays ??= {}) as Record<string, Stay>;
    const outputs = new Outputs(state);
    const flush = (until: number, inclusive: boolean) => {
      const due: { channel: number; stay: Stay }[] = [];
      for (const [key, stay] of Object.entries(stays)) {
        if (stay.fireAt !== null && (stay.fireAt < until || (inclusive && stay.fireAt === until))) due.push({ channel: Number(key), stay });
      }
      due.sort((a, b) => a.stay.fireAt! - b.stay.fireAt! || a.channel - b.channel);
      for (const { channel, stay } of due) {
        outputs.send(['dwell'], { time: stay.fireAt!, channel, x: stay.x, y: stay.y, pointerType: stay.pointerType }, false);
        stay.fireAt = null;
      }
    };
    for (const event of inputs.in ?? []) {
      if (!Number.isFinite(event.time) || !Number.isFinite(event.channel)) continue;
      flush(event.time, true);
      outputs.pass(event);
      const { time, channel, phase, x, y, pointerType } = event;
      const key = String(channel);
      const hovering = typeof pointerType === 'string' && HOVERING.includes(pointerType) && typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y);
      const anchor = () => {
        stays[key] = { open: false, anchored: true, ax: x as number, ay: y as number, radius: param('radius', time, channel), fireAt: time + param('time', time, channel), x: x as number, y: y as number, pointerType: pointerType as string };
      };
      if (phase === 'down') stays[key] = closed(true);
      else if (phase === 'cancel' || phase === LEAVE) delete stays[key];
      else if (phase === 'up') {
        // A mouse or pen still over the canvas hovers from where it lifted: click, then hold still.
        if (hovering) anchor();
        else delete stays[key];
      } else if (phase === 'move') {
        const stay = stays[key];
        if (stay?.open || !hovering) continue;
        if (stay?.anchored && !(Math.hypot((x as number) - stay.ax, (y as number) - stay.ay) > stay.radius)) Object.assign(stay, { x, y, pointerType });
        else anchor();
      }
    }
    flush(t1, false);
    return outputs.result();
  },
};
