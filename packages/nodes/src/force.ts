// Force: a Fluid writer (docs/nodes/visual.md) giving a continuous, dye-free
// push at a point that follows a Signal pair (X, Y). From Flow's fluid.js
// force() and pulse() and the way performance.js drives them:
// - Push (Conduct, and Paint's fast strokes): a push along the pair's motion.
// - Whirlpool (Hold's charge): a vortex with four inward pushes round it.
// - Twin (Orbit): a vortex and a smaller one beside it turning the other way.
// The writer contract is in packages/engine/src/fluid/field.ts: frame()
// queues this frame's pushes in frame-only state, and the Write output's
// FluidWriter hands them to Fluid, which calls it once a frame before stepping.
//
// Changed from Flow: Flow pushed at most once per 50 ms of wall clock, from
// whichever frame came first. Force pushes on a fixed 50 ms grid of the frame
// clock instead, sampling its inputs at each grid time, so the fluid gets the
// same pushes at any frame rate.
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

/** Frame-only state (Force has no query, so it is never snapshotted and may hold closures). */
interface ForceState extends NodeState {
  queue?: Write[];
  writer?: FluidWriter;
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
  // The epsilon keeps a tick that float error put a hair before t0 from being lost or counted twice.
  const first = Math.max(Math.ceil(t0 / FORCE_TICK - 1e-9), Math.ceil(t1 / FORCE_TICK - 1e-9) - MAX_FORCE_TICKS);
  const ticks: number[] = [];
  for (let k = first; k * FORCE_TICK < t1 - 1e-12; k++) ticks.push(k * FORCE_TICK + 0); // + 0 turns k = -0 into 0
  return ticks;
}

/** The writes for one tick at time t, or none. */
function writesAt(ctx: NodeContext, t: number): Write[] {
  if (!activeAt(ctx, t)) return [];
  const strength = ctx.param('strength', t);
  const radius = ctx.param('radius', t);
  if (!(strength > 0) || !Number.isFinite(radius)) return [];
  const [x, y] = positionAt(ctx, t);
  const mode = FORCE_MODES.includes(ctx.params.mode as ForceMode) ? (ctx.params.mode as ForceMode) : 'push';
  if (mode === 'push') {
    // Motion over the last tick. There is none before time 0, nor when the pair wasn't active then
    // (a new touch landing), nor across a jump: none of those is a push.
    if (t - FORCE_TICK < 0 || !activeAt(ctx, t - FORCE_TICK)) return [];
    const [px, py] = positionAt(ctx, t - FORCE_TICK);
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
    s.queue = forceTicks(ctx.t0, ctx.t1).flatMap((t) => writesAt(ctx, t));
  },
};
