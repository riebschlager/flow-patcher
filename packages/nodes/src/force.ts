// Force: a Fluid writer (docs/nodes/visual.md) giving a continuous, dye-free
// push at a point that follows a Signal pair (X, Y). From Flow's fluid.js
// force() and pulse() and the way performance.js drives them:
// - Push (Conduct): a push along the pair's motion.
// - Whirlpool (Hold's charge): a vortex with four inward pushes round it.
// - Twin (Orbit): a vortex and a smaller one beside it turning the other way.
// The writer contract is in packages/engine/src/fluid/field.ts: frame()
// queues this frame's pushes in frame-only state, and the Write output's
// FluidWriter hands them to Fluid, which calls it once a frame before stepping.
//
// Each input is read once per tick, at the tick's time, and push mode takes
// its motion from the previous tick's sample, kept in frame state. frame()
// can't read a signal back in time: sources such as Pointer answer earlier
// times from their latest state (NodeState in definition.ts).
//
// Changed from Flow (also in docs/nodes/visual.md):
// - Timing: Flow pushed at most once per 50 ms of wall clock, from whichever
//   frame came first (about 15 pushes a second at 60 Hz). Force pushes on a
//   fixed 50 ms grid of the frame clock, 20 a second at any frame rate.
// - Push: speed × 30 along the motion, capped at 120, times Strength. Flow's
//   Conduct also scaled the horizontal move by the canvas aspect
//   (gestures.js), so its horizontal pushes were about 1.78× stronger on a
//   16:9 canvas; Force has no aspect factor. Flow multiplied by the gesture's
//   energy; here energy is whatever is cabled into Strength. Paint's push
//   (cos(heading) × energy × 65, radius 0.07) isn't a separate mode.
// - Sizes: whirlpool's and twin's offsets and secondary radii scale with
//   Radius. They match Flow's Hold at Radius 0.12 and Flow's Orbit at 0.15
//   (Conduct used 0.17); the default, 0.15, is Orbit's.
// - A new contact landing, the first tick, and a move of more than
//   MAX_TICK_MOVE within one tick give no push.
// - Reduced motion: Flow skipped these pushes for touch, synthetic and pinch
//   input under prefers-reduced-motion. Force ignores it: the reduced-motion
//   rule covers overlays (ADR 0012), and the fluid is the patch's own picture.
import type { FluidTarget, FluidWriter, NodeContext, NodeDefinition, NodeState } from '@flow-patcher/engine';

export const FORCE_MODES = ['push', 'whirlpool', 'twin'] as const;
export type ForceMode = (typeof FORCE_MODES)[number];
export const FORCE_DIRECTIONS = ['clockwise', 'counter-clockwise'] as const;

/** Seconds between pushes: Flow's 50 ms. */
export const FORCE_TICK = 0.05;
/** Most pushes one frame queues; a frame after a long gap keeps the latest. */
export const MAX_FORCE_TICKS = 4;
/** Push mode: solver units per (canvas unit per second). Flow's Conduct scaled a ~16 ms move by 1800, about 29× its speed. */
export const PUSH_GAIN = 30;
/** Push mode's cap before Strength, as Flow's Conduct. */
export const MAX_PUSH = 120;
/** Push mode: a move this far within one tick is a jump (a new contact, a ramp wrapping round), not motion. */
export const MAX_TICK_MOVE = 0.25;
/** The level at which Active counts as on. */
const ACTIVE_LEVEL = 0.5;

type Write = (target: FluidTarget) => void;

/** One tick's reading of the inputs. */
interface Sample {
  t: number;
  x: number;
  y: number;
  active: boolean;
}

/** Frame-only state (Force has no query, so it is never snapshotted and may hold closures). */
interface ForceState extends NodeState {
  queue?: Write[];
  writer?: FluidWriter;
  /** The last tick's sample: push mode's motion runs from it. */
  last?: Sample;
}

const clampUnit = (value: number) => Math.max(0, Math.min(1, value));

/** The pair's position at t: each coordinate 0–1, 0.5 when unwired or not finite. */
function positionAt(ctx: NodeContext, t: number): [number, number] {
  const read = (port: string) => {
    if (!ctx.connected(port)) return 0.5;
    const v = ctx.signal(port, t);
    return Number.isFinite(v) ? clampUnit(v) : 0.5;
  };
  return [read('x'), read('y')];
}

const activeAt = (ctx: NodeContext, t: number) => !ctx.connected('active') || ctx.signal('active', t) >= ACTIVE_LEVEL;

/** 1 for clockwise on screen, -1 for counter-clockwise: Spin's sign when wired (0 counts as clockwise, as Flow's turn >= 0), else Direction. */
function directionAt(ctx: NodeContext, t: number): 1 | -1 {
  if (ctx.connected('spin')) return ctx.signal('spin', t) < 0 ? -1 : 1;
  return ctx.params.direction === 'counter-clockwise' ? -1 : 1;
}

/** The grid times in [t0, t1), latest MAX_FORCE_TICKS of them. */
export function forceTicks(t0: number, t1: number): number[] {
  if (!(Number.isFinite(t0) && Number.isFinite(t1)) || t1 <= t0) return [];
  // Both ends round the same way, so a tick that float error put a hair before a frame boundary lands in
  // exactly one frame: the grid index at or after t, within 1e-9 of a tick.
  const index = (t: number) => Math.ceil(t / FORCE_TICK - 1e-9);
  const end = index(t1);
  const ticks: number[] = [];
  for (let k = Math.max(index(t0), end - MAX_FORCE_TICKS); k < end; k++) ticks.push(k * FORCE_TICK + 0); // + 0 turns k = -0 into 0
  return ticks;
}

/** Reads the inputs once, at tick time t. */
function sampleAt(ctx: NodeContext, t: number): Sample {
  const [x, y] = positionAt(ctx, t);
  return { t, x, y, active: activeAt(ctx, t) };
}

/** The writes for the tick `now`, or none. `last` is the previous tick's sample, if any. */
function writesAt(ctx: NodeContext, now: Sample, last: Sample | undefined): Write[] {
  const { t, x, y } = now;
  if (!now.active) return [];
  const strength = ctx.param('strength', t);
  const radius = ctx.param('radius', t);
  if (!(strength > 0) || !Number.isFinite(radius)) return [];
  const mode = FORCE_MODES.includes(ctx.params.mode as ForceMode) ? (ctx.params.mode as ForceMode) : 'push';
  if (mode === 'push') {
    // Motion over the last tick. There is none without a sample from the grid tick just before (the
    // first tick, or after a gap the frame skipped), nor when the pair wasn't active then (a new touch
    // landing), nor across a jump: none of those is a push.
    if (!last || !last.active || Math.abs(last.t - (t - FORCE_TICK)) > 1e-9) return [];
    const px = last.x, py = last.y;
    if (Math.hypot(x - px, y - py) > MAX_TICK_MOVE) return [];
    const push = (from: number, to: number) => Math.max(-MAX_PUSH, Math.min(MAX_PUSH, ((to - from) / FORCE_TICK) * PUSH_GAIN)) * strength;
    const dx = push(px, x), dy = push(py, y);
    if (dx === 0 && dy === 0) return [];
    return [(target) => target.force(x, y, dx, dy, radius)];
  }
  const direction = directionAt(ctx, t);
  if (mode === 'whirlpool') {
    // Flow's Hold: a pulse of 0.35 × charge at radius 0.12, ringed by four inward pushes of 30 × charge,
    // radius 0.06, 0.08 out. The ring scales with Radius.
    const ring = radius * (0.08 / 0.12);
    return [
      (target) => target.pulse(x, y, strength * 0.35, radius, direction),
      ...[0, 1, 2, 3].map((i): Write => {
        const a = (i / 4) * Math.PI * 2;
        return (target) => target.force(clampUnit(x + Math.cos(a) * ring), clampUnit(y + Math.sin(a) * ring), -Math.cos(a) * strength * 30, -Math.sin(a) * strength * 30, radius / 2);
      }),
    ];
  }
  // Flow's Orbit: a pulse of 1.15 × orbit at radius 0.15, and one of 0.5 × orbit at 0.12, 0.12 to the right, turning back.
  const side = radius * 0.8;
  return [
    (target) => target.pulse(x, y, strength * 1.15, radius, direction),
    (target) => target.pulse(clampUnit(x + side), y, strength * 0.5, side, -direction),
  ];
}

export const force: NodeDefinition = {
  type: 'force',
  version: 1,
  label: 'Force',
  category: 'visual',
  description: 'Pushes the fluid at X/Y while Active: along the motion, or as a whirlpool or twin whirlpools. Cable Write into Fluid’s Writers.',
  ports: [
    { name: 'x', type: 'signal', direction: 'in', label: 'X', unwiredHint: 'Pushes at the middle (0.5).' },
    { name: 'y', type: 'signal', direction: 'in', label: 'Y', unwiredHint: 'Pushes at the middle (0.5).' },
    { name: 'active', type: 'signal', direction: 'in', label: 'Active', unwiredHint: 'Always pushing.' },
    { name: 'spin', type: 'signal', direction: 'in', label: 'Spin' },
    { name: 'write', type: 'field', direction: 'out', label: 'Write', fieldKind: 'write' },
  ],
  params: [
    { name: 'mode', kind: 'enum', options: FORCE_MODES, default: 'push', label: 'Mode' },
    { name: 'strength', kind: 'number', min: 0, max: 1, default: 0.5, label: 'Strength' },
    { name: 'radius', kind: 'number', min: 0.02, max: 0.4, default: 0.15, label: 'Radius' },
    { name: 'direction', kind: 'enum', options: FORCE_DIRECTIONS, default: 'clockwise', label: 'Direction' },
  ],
  field(ctx) {
    const s = ctx.state as ForceState;
    return (s.writer ??= {
      write(target) {
        const queue = s.queue ?? [];
        s.queue = [];
        for (const write of queue) write(target);
      },
    });
  },
  frame(ctx) {
    const s = ctx.state as ForceState;
    // As Splat: Fluid writes the queue later this frame, so whatever is left was never written. Drop it.
    const queue: Write[] = (s.queue = []);
    for (const t of forceTicks(ctx.t0, ctx.t1)) {
      const now = sampleAt(ctx, t);
      queue.push(...writesAt(ctx, now, s.last));
      s.last = now;
    }
  },
};
