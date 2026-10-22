import type { EngineEvent, NodeDefinition } from '@flow-patcher/engine';

// Pattern helpers ported from Flow's rhythm.js (`euclidean`, `rotatePattern`).
// Changes from Flow:
// - `euclideanPattern` (Flow's `euclidean`) takes a step count instead of a fixed 16 steps.
// - Non-finite hits give no hits (Flow fell back to 4), so a broken cable is silent, not busy.
// - An empty pattern (zero or non-finite steps) stays empty instead of rotating by NaN.

/** Velocity of an accented hit (one on every fourth step of the unrotated pattern) and of the others. */
export const ACCENT = 1;
export const SOFT = 0.65;

const MAX_STEPS = 64;

/** Rounds to an integer in [lo, hi]; non-finite input gives `fallback`. */
const intIn = (x: number, lo: number, hi: number, fallback: number) =>
  Number.isFinite(x) ? Math.max(lo, Math.min(hi, Math.round(x))) : fallback;

/** Positive modulo, so negative offsets and indices wrap. */
const wrap = (i: number, n: number) => ((i % n) + n) % n;

/** Shifts a pattern later by `offset` steps (wrapping; negative shifts earlier). */
export function rotatePattern<T>(steps: readonly T[], offset = 1): T[] {
  const n = steps.length;
  if (n === 0) return [];
  const k = Number.isFinite(offset) ? wrap(Math.round(offset), n) : 0;
  return steps.map((_, i) => steps[wrap(i - k, n)]!);
}

/** Velocity (0 for a rest) at step `i` of the unrotated pattern, which is assumed to be in range. */
function stepVelocity(i: number, hits: number, steps: number): number {
  // Bresenham spread: exactly `hits` of the `steps` slots, the first on step 0.
  return (i * hits) % steps < hits ? (i % 4 === 0 ? ACCENT : SOFT) : 0;
}

/** Normalized knobs: steps in [0, 64], hits in [0, steps], rotation any integer. */
function knobs(hits: number, steps: number, rotation: number) {
  const n = intIn(steps, 0, MAX_STEPS, 0);
  return { n, k: intIn(hits, 0, n, 0), r: Number.isFinite(rotation) ? Math.round(rotation) : 0 };
}

/**
 * A Euclidean rhythm: `hits` spread as evenly as possible over `steps`,
 * rotated later by `rotation`. Each entry is a velocity, 0 for a rest.
 * Hits above `steps` clamp to `steps`; zero steps give an empty pattern.
 */
export function euclideanPattern(hits = 4, steps = 16, rotation = 0): number[] {
  const { n, k, r } = knobs(hits, steps, rotation);
  return rotatePattern(Array.from({ length: n }, (_, i) => stepVelocity(i, k, n)), r);
}

/** The velocity at one transport step of the pattern, without building it; 0 for a rest. */
export function euclideanAt(index: number, hits: number, steps: number, rotation: number): number {
  const { n, k, r } = knobs(hits, steps, rotation);
  if (n === 0 || k === 0 || !Number.isFinite(index)) return 0;
  return stepVelocity(wrap(Math.round(index) - r, n), k, n);
}

/**
 * Passes the ticks that land on a hit of a Euclidean pattern. The step is the
 * tick's own transport `index` (from Clock), never a counter, so the result
 * doesn't depend on windowing and survives rewinds. Knobs are read at each
 * tick's time and channel, so every channel can run its own pattern.
 */
export const euclidean: NodeDefinition = {
  type: 'euclidean',
  version: 1,
  label: 'Euclidean',
  category: 'time-rhythm',
  description: 'Spreads hits evenly over steps and fires on the clock ticks that land on one.',
  ports: [
    { name: 'tick', type: 'event', direction: 'in', label: 'Tick' },
    { name: 'hit', type: 'event', direction: 'out', label: 'Hit' },
  ],
  params: [
    { name: 'hits', kind: 'number', min: 0, max: MAX_STEPS, default: 4, step: 1, label: 'Hits' },
    { name: 'steps', kind: 'number', min: 1, max: MAX_STEPS, default: 16, step: 1, label: 'Steps' },
    { name: 'rotate', kind: 'number', min: -MAX_STEPS, max: MAX_STEPS, default: 0, step: 1, label: 'Rotate' },
  ],
  query({ inputs, param }) {
    const hit: EngineEvent[] = [];
    for (const e of inputs.tick ?? []) {
      // A tick without a numeric step index (not from a Clock) has no place in the pattern; it's dropped.
      if (typeof e.index !== 'number') continue;
      const velocity = euclideanAt(e.index, param('hits', e.time, e.channel), param('steps', e.time, e.channel), param('rotate', e.time, e.channel));
      if (velocity > 0) hit.push({ ...e, velocity });
    }
    return { hit };
  },
};
