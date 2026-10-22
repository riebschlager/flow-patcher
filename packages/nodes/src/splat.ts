// Splat: a Fluid writer (docs/nodes/visual.md). Each event on At drops dye,
// with the solver's swirl, at the event's x/y. The writer contract is in
// packages/engine/src/fluid/field.ts: frame() queues this frame's splats in
// frame-only state, and the Write output's FluidWriter hands them to Fluid,
// which calls it once a frame before stepping.
import { canonicalDyes, randomAt, timeKey, type Dye, type EngineEvent, type FluidWriter, type NodeDefinition, type NodeState } from '@flow-patcher/engine';

/** What `write` will splat: Fluid.splat's arguments without the impulse. */
interface QueuedSplat {
  x: number;
  y: number;
  dye: Dye;
  size: number;
}

/** Frame-only state (Splat has no query, so it is never snapshotted and may hold the writer). */
interface SplatState extends NodeState {
  queue?: QueuedSplat[];
  writer?: FluidWriter;
}

/** 'by event' picks a canonical dye from the event's index (or channel); the others fix one. */
export const SPLAT_COLORS = ['by event', 'dye 1', 'dye 2', 'dye 3', 'dye 4'] as const;
/** Fluid.splat's default size; the range the Fluid node's interim knob had. */
const DEFAULT_SIZE = 0.05;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const clampUnit = (value: number) => Math.max(0, Math.min(1, value));

/** The dye slot for an event: a fixed one, or its index (else channel) mod 4, as Fluid's interim input did. */
function slotOf(color: unknown, e: EngineEvent): number {
  const fixed = SPLAT_COLORS.indexOf(color as (typeof SPLAT_COLORS)[number]);
  if (fixed > 0) return fixed - 1;
  // `& 3` makes every number a slot: NaN and ±Infinity give 0, negatives wrap, fractions truncate.
  return (typeof e.index === 'number' ? e.index : e.channel) & 3;
}

export const splat: NodeDefinition = {
  type: 'splat',
  version: 1,
  label: 'Splat',
  category: 'visual',
  description: 'Drops dye into the fluid at each event’s x/y. Cable Write into Fluid’s Writers.',
  ports: [
    { name: 'at', type: 'event', direction: 'in', label: 'At' },
    { name: 'write', type: 'field', direction: 'out', label: 'Write', fieldKind: 'write' },
  ],
  params: [
    { name: 'size', kind: 'number', min: 0.01, max: 0.2, default: DEFAULT_SIZE, label: 'Size' },
    { name: 'color', kind: 'enum', options: SPLAT_COLORS, default: 'by event', label: 'Color' },
  ],
  field(ctx) {
    const s = ctx.state as SplatState;
    return (s.writer ??= {
      write(target) {
        const queue = s.queue ?? [];
        s.queue = [];
        for (const { x, y, dye, size } of queue) target.splat(x, y, dye, size);
      },
    });
  },
  frame({ inputs, params, param, state, seed, nodeId }) {
    const s = state as SplatState;
    // Fluid writes the queue in the same frame, after this one (the Writers cable orders the plan).
    // Whatever is still here was never written, because no Fluid reads this Splat: drop it, so the
    // queue holds at most one frame's events, which the engine already caps.
    const queue: QueuedSplat[] = (s.queue = []);
    for (const e of inputs.at ?? []) {
      // Events without a usable position land at a seeded point, keyed as Probability keys its coin.
      const key = timeKey(finite(e.time) ? e.time : 0);
      const x = finite(e.x) ? clampUnit(e.x) : 0.15 + 0.7 * randomAt(seed, nodeId, key, e.channel, 'x');
      const y = finite(e.y) ? clampUnit(e.y) : 0.15 + 0.7 * randomAt(seed, nodeId, key, e.channel, 'y');
      // Velocity scales the dye, as in the spike; events without one splat at full strength.
      const velocity = finite(e.velocity) ? clampUnit(e.velocity) : 1;
      const base = canonicalDyes[slotOf(params.color, e)]!;
      const size = param('size', finite(e.time) ? e.time : 0, e.channel);
      queue.push({ x, y, dye: [base[0] * velocity, base[1] * velocity, base[2] * velocity], size: finite(size) ? size : DEFAULT_SIZE });
    }
  },
};
