import type { EngineEvent, NodeDefinition, QueryContext } from '@flow-patcher/engine';
import type { Phase } from './pointer';
import { claimParam, IN_PORT, num, PASS_PORTS, prune, record, runRecognizer, slot, stepAt, type Emitter, type Steps } from './recognizer';

/** Each finger must move this far (canvas units) from where the pair formed before the pair can pinch: Flow's `moved`. */
export const MIN_FINGER_TRAVEL = 0.012;
/** The midpoint may travel at most this fraction of the distance change, so a two-finger drag isn't a pinch: Flow's `travel < contraction * .7`. */
export const MAX_MIDPOINT_TRAVEL = 0.7;
/** Spread fires once the fingers open by max(SPREAD_MIN, SPREAD_RELATIVE × starting distance) from their closest: Flow's bloom, max(.06, distance × .16). */
export const SPREAD_MIN = 0.06;
export const SPREAD_RELATIVE = 0.16;

interface Finger {
  channel: number;
  x: number;
  y: number;
  pointerType: string | null;
  /** Down order, for "first two". */
  order: number;
}

/** The pair being watched, or pinching once claimed. Plain data. */
interface Pair {
  a: number;
  b: number;
  /** Where each finger was, and their distance, when the pair formed. */
  ax: number;
  ay: number;
  bx: number;
  by: number;
  d0: number;
  /** Claimed: the pinch is on. */
  active: boolean;
  /** Closest distance since the claim. */
  min: number;
  /** Unwrapped rotation since the pair formed, and the angle it was last measured at. */
  rotation: number;
  angle: number;
  /** Fingers of an active pinch that have lifted with an up. */
  lifted: number[];
  /** The midpoint and distance as last measured. */
  x: number;
  y: number;
  d: number;
}

interface Step {
  time: number;
  scale: number;
  rotation: number;
  x: number;
  y: number;
}

interface PinchState {
  fingers: Finger[];
  pair: Pair | null;
  order: number;
}

const wrap = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

function measure(fa: Finger, fb: Finger) {
  return { d: Math.hypot(fb.x - fa.x, fb.y - fa.y), angle: Math.atan2(fb.y - fa.y, fb.x - fa.x), x: (fa.x + fb.x) / 2, y: (fa.y + fb.y) / 2 };
}

/**
 * Gesture recognizer: two fingers pinching in or spreading (docs/nodes/gesture-recognizers.md),
 * from Flow's two-finger Gather and Bloom (performance.js `pair`, `finishPinch`).
 *
 * The pair (`pair`):
 * - "only two": a pair forms whenever exactly two contacts are open, both eligible. A third
 *   contact landing before the claim breaks the pair; it re-forms when two are left. (Flow.)
 * - "first two": the two eligible contacts that went down first, however many are open.
 * - Eligible (`pointers`): touch contacts only (`pointerType` "touch"), or any. Flow's pinch
 *   is touch only, so a pen or mouse beside a finger never pinches. A contact this node
 *   has claimed is never paired again: its claim lasts until it ends.
 * - Before the claim, the pair re-forms (new starting distance) whenever its fingers change.
 *
 * The claim: on a move of either finger, once both fingers have moved MIN_FINGER_TRAVEL from
 * where the pair formed, the distance has shrunk by more than the threshold, max(Threshold,
 * Relative × starting distance), and the midpoint has traveled less than MAX_MIDPOINT_TRAVEL
 * × that change, the pinch claims both fingers (ADR 0028) and emits Pinch in. With Starts
 * "either", a spread by the same amount claims too and emits Spread.
 *
 * Before the claim the fingers' events flow through Pass. (Changed from Flow, which held a
 * finger's stroke notes back while a pinch looked likely, its `pending`: ADR 0028 has no
 * hold-back, so what flowed before the claim is stopped by the claim's cancels instead.)
 *
 * A pinch ends one of three ways, each once (Flow's Bloom fired once per Gather):
 * - Spread: the fingers open by more than max(SPREAD_MIN, SPREAD_RELATIVE × starting
 *   distance) from their closest since the claim (Flow's bloom threshold, max(.06, d × .16),
 *   a little wider than the claim's max(Threshold, Relative × d), which defaults to Flow's
 *   max(.055, d × .14), so a finger's wobble at the claim doesn't spread at once). With Starts
 *   "either", the spread that claims is the Spread, and the pinch ends there.
 * - End: the second finger of the pinch lifts with an up and no Spread came first (Flow:
 *   "both fingers lift to Bloom").
 * - A cancel on either finger: nothing fires.
 * Either way both fingers stay claimed until they end (ADR 0028), so after a Spread lifting
 * them fires nothing. Contacts landing during a pinch don't touch it and flow through Pass.
 * (Changed from Flow, where a third finger ended the Gather silently: the claim stays either
 * way, so ending it early only lost the gesture.)
 *
 * Gesture events carry the pair's midpoint `x`, `y`, `scale` (distance over the starting
 * distance), `rotation` (radians, unwrapped, positive clockwise on screen) and `distance`, on
 * the channel of the finger that went down first. Positions are canvas units, x and y each
 * 0–1, so distances aren't corrected for the canvas's aspect ratio (Flow measured in pixels).
 *
 * Signals (the same on every channel): Scale, Rotation, X and Y follow the claimed pinch at
 * each finger move, and hold after it ends. Before any pinch Scale reads 1 and the rest 0.
 */
export const pinch: NodeDefinition = {
  type: 'pinch',
  version: 1,
  label: 'Pinch',
  category: 'gesture-recognizers',
  description: 'Two fingers pinching in or spreading: claims both, with Pinch in, Spread and End events and Scale, Rotation and midpoint signals.',
  ports: [
    IN_PORT,
    ...PASS_PORTS,
    { name: 'pinchIn', type: 'event', direction: 'out', label: 'Pinch in' },
    { name: 'spread', type: 'event', direction: 'out', label: 'Spread' },
    { name: 'end', type: 'event', direction: 'out', label: 'End' },
    { name: 'scale', type: 'signal', direction: 'out', label: 'Scale' },
    { name: 'rotation', type: 'signal', direction: 'out', label: 'Rotation' },
    { name: 'x', type: 'signal', direction: 'out', label: 'X' },
    { name: 'y', type: 'signal', direction: 'out', label: 'Y' },
  ],
  params: [
    { name: 'pair', kind: 'enum', options: ['only two', 'first two'], default: 'only two', label: 'Pair' },
    { name: 'pointers', kind: 'enum', options: ['touch', 'any'], default: 'touch', label: 'Pointers' },
    { name: 'starts', kind: 'enum', options: ['pinch in', 'either'], default: 'pinch in', label: 'Starts' },
    { name: 'threshold', kind: 'number', min: 0.005, max: 0.5, default: 0.055, label: 'Threshold' },
    { name: 'relative', kind: 'number', min: 0, max: 1, default: 0.14, label: 'Relative' },
    claimParam(true),
  ],
  query(ctx) {
    const steps = slot<Steps<Step>>(ctx.state, 'steps', () => []);
    prune(steps, ctx.t0);
    const s = slot<PinchState>(ctx.state, 'pinch', () => ({ fingers: [], pair: null, order: 0 }));
    return runRecognizer(ctx, { event: (event, phase, out) => step(ctx, s, steps, event, phase, out) });
  },
  signal({ state }, port, t) {
    const at = stepAt((state.steps ?? []) as Steps<Step>, t);
    if (port === 'scale') return at ? at.scale : 1;
    if (!at) return 0;
    return port === 'rotation' ? at.rotation : port === 'x' ? at.x : port === 'y' ? at.y : 0;
  },
};

function eligible(ctx: Pick<QueryContext, 'params'>, finger: Finger, out: Emitter): boolean {
  return (ctx.params.pointers === 'any' || finger.pointerType === 'touch') && !out.claimed(finger.channel);
}

/** The pair the open contacts make now, or null. */
function choose(ctx: Pick<QueryContext, 'params'>, fingers: Finger[], out: Emitter): [Finger, Finger] | null {
  const ok = fingers.filter((f) => eligible(ctx, f, out)).sort((p, q) => p.order - q.order);
  if (ctx.params.pair === 'first two') return ok.length >= 2 ? [ok[0]!, ok[1]!] : null;
  return fingers.length === 2 && ok.length === 2 ? [ok[0]!, ok[1]!] : null;
}

function form(fa: Finger, fb: Finger): Pair {
  const m = measure(fa, fb);
  return { a: fa.channel, b: fb.channel, ax: fa.x, ay: fa.y, bx: fb.x, by: fb.y, d0: m.d, active: false, min: m.d, rotation: 0, angle: m.angle, lifted: [], x: m.x, y: m.y, d: m.d };
}

function step(ctx: Pick<QueryContext, 'params' | 'param'>, s: PinchState, steps: Steps<Step>, event: EngineEvent, phase: Phase, out: Emitter): void {
  const { channel, time } = event;
  let finger = s.fingers.find((f) => f.channel === channel);
  if (phase === 'down') {
    if (finger) s.fingers.splice(s.fingers.indexOf(finger), 1);
    finger = { channel, x: num(event.x, 0), y: num(event.y, 0), pointerType: typeof event.pointerType === 'string' ? event.pointerType : null, order: s.order++ };
    s.fingers.push(finger);
  } else if (finger) {
    finger.x = num(event.x, finger.x);
    finger.y = num(event.y, finger.y);
  }
  const ends = phase === 'up' || phase === 'cancel';
  if (ends && finger) s.fingers.splice(s.fingers.indexOf(finger), 1);
  const pair = s.pair;

  if (pair?.active) {
    const member = channel === pair.a || channel === pair.b;
    if (!member) return;
    if (phase === 'cancel') {
      s.pair = null;
      return;
    }
    if (phase === 'up') {
      pair.lifted.push(channel);
      if (pair.lifted.includes(pair.a) && pair.lifted.includes(pair.b)) {
        out.emit('end', gesture(pair, time));
        s.pair = null;
      }
      return;
    }
    if (pair.lifted.length) return;
    const fa = s.fingers.find((f) => f.channel === pair!.a)!, fb = s.fingers.find((f) => f.channel === pair!.b)!;
    const m = update(pair, fa, fb);
    pair.min = Math.min(pair.min, m.d);
    record(steps, signalStep(pair, time));
    if (m.d - pair.min > Math.max(SPREAD_MIN, SPREAD_RELATIVE * pair.d0)) {
      out.emit('spread', gesture(pair, time));
      s.pair = null;
    }
    return;
  }

  // Watching: the pair follows the open contacts until it claims.
  const chosen = choose(ctx, s.fingers, out);
  if (!chosen) {
    s.pair = null;
    return;
  }
  const [fa, fb] = chosen;
  if (!pair || pair.a !== fa.channel || pair.b !== fb.channel) {
    s.pair = form(fa, fb);
    return;
  }
  if (phase !== 'move' || (channel !== pair.a && channel !== pair.b)) return;
  const m = update(pair, fa, fb);
  const change = pair.d0 - m.d;
  const travel = Math.hypot(m.x - (pair.ax + pair.bx) / 2, m.y - (pair.ay + pair.by) / 2);
  const moved = Math.hypot(fa.x - pair.ax, fa.y - pair.ay) > MIN_FINGER_TRAVEL && Math.hypot(fb.x - pair.bx, fb.y - pair.by) > MIN_FINGER_TRAVEL;
  const threshold = thresholdOf(ctx, pair, time, channel);
  const spreads = ctx.params.starts === 'either' && -change > threshold;
  if (!(moved && (change > threshold || spreads) && travel < Math.abs(change) * MAX_MIDPOINT_TRAVEL)) return;
  pair.active = true;
  pair.min = m.d;
  out.claim(pair.a);
  out.claim(pair.b);
  out.emit(spreads ? 'spread' : 'pinchIn', gesture(pair, time));
  record(steps, signalStep(pair, time));
  if (spreads) s.pair = null;
}

/** max(Threshold, Relative × starting distance): Flow's max(.055, distance × .14). */
function thresholdOf(ctx: Pick<QueryContext, 'param'>, pair: Pair, time: number, channel: number): number {
  return Math.max(ctx.param('threshold', time, channel), ctx.param('relative', time, channel) * pair.d0);
}

const scaleOf = (pair: Pair) => (pair.d0 > 1e-9 ? pair.d / pair.d0 : 1);

/** Measures the pair's fingers and folds the result in: rotation unwrapped, midpoint and distance kept. */
function update(pair: Pair, fa: Finger, fb: Finger) {
  const m = measure(fa, fb);
  pair.rotation += wrap(m.angle - pair.angle);
  pair.angle = m.angle;
  Object.assign(pair, { x: m.x, y: m.y, d: m.d });
  return m;
}

function signalStep(pair: Pair, time: number): Step {
  return { time, scale: scaleOf(pair), rotation: pair.rotation, x: pair.x, y: pair.y };
}

/** A gesture event: the pair's midpoint, scale, rotation and distance as last measured, on the first finger's channel. */
function gesture(pair: Pair, time: number): EngineEvent {
  return { time, channel: pair.a, x: pair.x, y: pair.y, scale: scaleOf(pair), rotation: pair.rotation, distance: pair.d };
}
