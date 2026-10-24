import type { EngineEvent, InputFields, NodeDefinition, NodeState, PortSpec, QueryContext, QueryResult } from '@flow-patcher/engine';
import { POINTER_PORTS, POINTER_READS, pointerContactAt, pointerQuery, pointerSignal } from './pointer';

/**
 * The pen fields, which are also Pen's own signal outputs (ADR 0029: a field is named as the
 * output that reads it). The host sends the first six as the browser reports them, on pen events
 * only; `barrel` is derived from `buttons`.
 */
export const PEN_FIELDS = ['tiltX', 'tiltY', 'altitudeAngle', 'azimuthAngle', 'twist', 'tangentialPressure', 'barrel'] as const;
export type PenField = (typeof PEN_FIELDS)[number];

const HALF_PI = Math.PI / 2;
const TAU = 2 * Math.PI;
const DEG = 180 / Math.PI;
/** A pen held straight up, as the Pointer Events spec defaults it: no tilt, no twist, no barrel. */
export const PEN_DEFAULTS: Readonly<Record<PenField, number>> = { tiltX: 0, tiltY: 0, altitudeAngle: HALF_PI, azimuthAngle: 0, twist: 0, tangentialPressure: 0, barrel: 0 };
/** The barrel (side) button's bit in `buttons`, for a pen (Pointer Events: the pen's "right" button). */
const BARREL = 2;

const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));
/** Into [0, m): angles that wrap. Values already in range stay exactly as they are. */
const wrap = (value: number, m: number) => (value >= 0 && value < m ? value : ((value % m) + m) % m);

/** Altitude and azimuth (radians) from tilt (degrees), as the Pointer Events spec converts them
 *  (tilt2spherical): the azimuth along an axis first, so a pen lying flat along one keeps its direction. */
function sphericalOf(tiltX: number, tiltY: number): { altitudeAngle: number; azimuthAngle: number } {
  const tx = tiltX / DEG, ty = tiltY / DEG;
  const flat = Math.abs(tiltX) === 90 || Math.abs(tiltY) === 90;
  let azimuthAngle = 0;
  if (tiltX === 0) azimuthAngle = tiltY > 0 ? HALF_PI : tiltY < 0 ? 3 * HALF_PI : 0;
  else if (tiltY === 0) azimuthAngle = tiltX < 0 ? Math.PI : 0;
  // Flat off both axes: the spec leaves the azimuth undefined, and says 0.
  else if (!flat) azimuthAngle = wrap(Math.atan2(Math.tan(ty), Math.tan(tx)), TAU);
  let altitudeAngle: number;
  if (flat) altitudeAngle = 0;
  else if (tiltX === 0) altitudeAngle = HALF_PI - Math.abs(ty);
  else if (tiltY === 0) altitudeAngle = HALF_PI - Math.abs(tx);
  else altitudeAngle = Math.atan(1 / Math.hypot(Math.tan(tx), Math.tan(ty)));
  return { altitudeAngle, azimuthAngle };
}

/** Tilt (degrees) from altitude and azimuth (radians), as the Pointer Events spec converts them. */
function tiltOf(altitudeAngle: number, azimuthAngle: number): { tiltX: number; tiltY: number } {
  const c = Math.cos(azimuthAngle), s = Math.sin(azimuthAngle);
  // Lying flat: ±90° along each axis the azimuth points along (rounding error isn't a direction).
  if (altitudeAngle === 0) return { tiltX: Math.abs(c) < 1e-9 ? 0 : Math.sign(c) * 90, tiltY: Math.abs(s) < 1e-9 ? 0 : Math.sign(s) * 90 };
  const t = Math.tan(altitudeAngle);
  return { tiltX: Math.atan(c / t) * DEG, tiltY: Math.atan(s / t) * DEG };
}

/**
 * One event's pen fields, in range and complete. Tilt is clamped to ±90°, altitude to 0–π/2,
 * tangential pressure to ±1; azimuth wraps into [0, 2π) and twist into [0°, 360°). A missing or
 * non-finite value is filled in: altitude and azimuth from tilt (browsers without them), tilt from
 * altitude and azimuth (a stream that has only those), the other tilt axis as 0, and with neither
 * the defaults (PEN_DEFAULTS). `barrel` is 1 while `buttons` has the barrel bit (2), else 0.
 */
export function penFieldsOf(event: Readonly<Record<string, unknown>>): Record<PenField, number> {
  let tiltX = finite(event.tiltX), tiltY = finite(event.tiltY);
  let altitudeAngle = finite(event.altitudeAngle), azimuthAngle = finite(event.azimuthAngle);
  if (altitudeAngle !== null) altitudeAngle = clamp(altitudeAngle, 0, HALF_PI);
  if (azimuthAngle !== null) azimuthAngle = wrap(azimuthAngle, TAU);
  if (tiltX === null && tiltY === null) {
    if (altitudeAngle === null && azimuthAngle === null) ({ tiltX, tiltY, altitudeAngle, azimuthAngle } = PEN_DEFAULTS);
    else ({ tiltX, tiltY } = tiltOf((altitudeAngle ??= HALF_PI), (azimuthAngle ??= 0)));
  } else {
    tiltX = clamp(tiltX ?? 0, -90, 90);
    tiltY = clamp(tiltY ?? 0, -90, 90);
    if (altitudeAngle === null || azimuthAngle === null) {
      const derived = sphericalOf(tiltX, tiltY);
      altitudeAngle ??= derived.altitudeAngle;
      azimuthAngle ??= derived.azimuthAngle;
    }
  }
  const twist = finite(event.twist), tangential = finite(event.tangentialPressure), buttons = finite(event.buttons);
  return {
    tiltX: tiltX!, tiltY: tiltY!, altitudeAngle: altitudeAngle!, azimuthAngle: azimuthAngle!,
    twist: twist === null ? 0 : wrap(twist, 360),
    tangentialPressure: tangential === null ? 0 : clamp(tangential, -1, 1),
    barrel: buttons !== null && Number.isInteger(buttons) && buttons >= 0 && (buttons & BARREL) !== 0 ? 1 : 0,
  };
}

const isPen = (event: Readonly<InputFields> | EngineEvent) => event.pointerType === 'pen';

const PEN_PORTS: PortSpec[] = [
  ...POINTER_PORTS,
  { name: 'tiltX', type: 'signal', direction: 'out', label: 'Tilt X' },
  { name: 'tiltY', type: 'signal', direction: 'out', label: 'Tilt Y' },
  { name: 'altitudeAngle', type: 'signal', direction: 'out', label: 'Altitude' },
  { name: 'azimuthAngle', type: 'signal', direction: 'out', label: 'Azimuth' },
  { name: 'twist', type: 'signal', direction: 'out', label: 'Twist' },
  { name: 'tangentialPressure', type: 'signal', direction: 'out', label: 'Tangential pressure' },
  { name: 'barrel', type: 'signal', direction: 'out', label: 'Barrel button' },
];

/** Pointer's query over this window's pen pushes, each with its pen fields completed (`penFieldsOf`). */
function penQuery({ state, pushed }: Pick<QueryContext, 'state' | 'pushed'>): QueryResult {
  const pens: Record<string, EngineEvent[]> = {};
  for (const [port, events] of Object.entries(pushed)) {
    const kept = events.filter(isPen).map((event) => ({ ...event, ...penFieldsOf(event) }));
    if (kept.length) pens[port] = kept;
  }
  return pointerQuery({ state, pushed: pens });
}

/** Pen's signals: Pointer's, and the pen fields of the slot's latest event. */
function penSignal(state: NodeState, port: string, t: number, channel: number): number {
  if (!(PEN_FIELDS as readonly string[]).includes(port)) return pointerSignal(state, port, t, channel);
  const field = port as PenField;
  const contact = pointerContactAt(state, t, channel);
  // Before any pen, or on a slot whose holder has had no Down, Move, Up or Cancel since it took the slot
  // (`seen`, #101: an enter only, so its payload is still the previous holder's): a pen held upright.
  if (!contact || !contact.seen) return PEN_DEFAULTS[field];
  // A free slot has no pen on it: nothing presses the barrel or the airbrush wheel.
  if ((field === 'barrel' || field === 'tangentialPressure') && contact.id === null) return 0;
  const value = contact.payload[field];
  return typeof value === 'number' ? value : PEN_DEFAULTS[field];
}

/**
 * Canvas source: Pointer for pens only (docs/nodes/canvas-sources.md, Pen). It reads what
 * Pointer reads (enter, down, plain move, up, cancel, leave; not coalesced samples) where
 * `pointerType` is `pen`, so a mouse or a touch never reaches it, and everything Pointer does
 * comes from pointer.ts unchanged: slots, the derived fields, All with `phase` (a pen is a contact
 * source and hovers, so its hover moves are All moves with no contact open), same-time ties,
 * the move budget and the signals X, Y, Pressure, Speed and Count. It keeps its own slot map, so
 * the first pen is slot 1 here whatever slot it has on a Pointer beside it. Whatever All gains in
 * pointerQuery (#101's hover-end `leave`) Pen gains too, with its pen fields.
 *
 * The host adds the pen fields to every pen event it sends (enter and leave too): `tiltX`, `tiltY`
 * (degrees, −90 to 90), `twist` (degrees, 0 to 359), `tangentialPressure` (−1 to 1), and
 * `altitudeAngle` and `azimuthAngle` (radians: 0 lying flat to π/2 upright, and 0 to 2π
 * clockwise from +x) where the browser has them. Pen rewrites each push with `penFieldsOf`,
 * so every event it emits carries all six, in range, and `barrel` (1 while the barrel button,
 * `buttons` bit 2, is held).
 *
 * Signals, per channel (slot), from the slot's latest event: Tilt X, Tilt Y, Altitude, Azimuth
 * and Twist in the fields' units, held after Up, Cancel or a leave as X and Y are; Tangential
 * pressure and Barrel button, which read 0 once the slot is free. Channel 0 reads the latest pen.
 * Before any pen, and on a slot a pen has only entered (no Down or Move yet), they read a pen held
 * upright (PEN_DEFAULTS), not the previous holder's values.
 *
 * The barrel button follows the browser: pressed in the air it's a pointerdown with `button` 2
 * (Pointer Events counts any button as the active buttons state), so Pen emits a Down with the
 * hover's pressure, and Pointer does too; a press while another button is held is a pointermove.
 * A patch that wants tip contacts only filters on `button` or `pressure`.
 */
export const pen: NodeDefinition = {
  type: 'pen',
  version: 1,
  label: 'Pen',
  category: 'canvas-sources',
  description: 'Pointer for pens: Down, Move, Up, Cancel and All, with Tilt, Altitude, Azimuth, Twist, Tangential pressure and Barrel button signals.',
  ports: PEN_PORTS,
  params: [],
  input: {
    reads: POINTER_READS,
    accepts: (event) => isPen(event) && event.coalesced !== true,
    rewrites: true,
  },
  query: penQuery,
  signal: (ctx, port, t, channel) => penSignal(ctx.state, port, t, channel),
};
