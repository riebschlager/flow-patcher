import type { NodeDefinition, NodeState } from '@flow-patcher/engine';

/** Grid steps per second. The filter steps on k / SMOOTH_RATE (2 ms), anchored to time 0, not to the window. */
export const SMOOTH_RATE = 500;

/**
 * Most grid points one query steps through. A wider window (a long stall, or a
 * bad caller) is treated as a gap: each channel jumps to In at its last grid
 * point, so the work per query and the state it stores stay bounded.
 */
export const MAX_GRID_POINTS = 100_000;

/** Highest channel count the node smooths (channels 0 … N−1). */
const MAX_CHANNELS = 8;

/** Knob range for Rise and Fall, in seconds. 0 follows In with no lag. */
export const SMOOTH_TIME_MAX = 10;

/**
 * The smoothed value on each grid point of the current chunk, per channel:
 * `v[i]` is Out at grid index `k0 + i`. The row starts at the last grid point
 * before the chunk when the channel carries on from it, else at the channel's
 * first grid point in the chunk. Plain data so a rewind snapshot can clone it
 * (ADR 0019); replaced on each query, so it never grows past one chunk.
 */
interface Row {
  k0: number;
  v: number[];
}
type Track = Record<number, Row>;

const trackOf = (state: NodeState): Track => (state.track ??= {}) as Track;

/** How far one step of length dt moves toward the target with time constant tau: 1 − e^(−dt/τ). */
export function blend(dt: number, tau: number): number {
  if (!(tau > 0)) return 1;
  if (!(dt > 0)) return 0;
  const a = -Math.expm1(-dt / tau);
  return Number.isFinite(a) ? a : 1;
}

/** One step from y toward x. Exact when x equals y; a convex mix when x − y overflows. */
function step(y: number, x: number, a: number): number {
  if (a >= 1) return x;
  const d = x - y;
  return Number.isFinite(d) ? y + d * a : y * (1 - a) + x * a;
}

/**
 * A one-pole lag per channel: Out eases toward In with time constant Rise while
 * In is above Out and Fall while it's below, the frame-rate-independent easing
 * Flow uses for its performance values (`1 − e^(−dt/τ)`). After a step in In,
 * Out has covered 63% of the way after one time constant and 95% after three.
 * Rise or Fall at 0 follows In without lag in that direction, so a slow Fall
 * and a 0 Rise give an envelope follower, and both at 0 pass In through.
 *
 * Out is a pure function of In over time, on a 2 ms grid anchored to time 0:
 * `query` steps the filter on every grid point in [t0, t1), reading In and the
 * time constants there, and keeps the chunk's grid values in `state.track`.
 * A read at t takes the grid value at or before t and finishes the partial step
 * to t toward In at t, so Out moves smoothly between grid points. Each step eases
 * toward In at its end, so a jump in In starts the ease up to one step (2 ms)
 * early; that's the whole discretization error. Windows tile time in order, so the
 * grid points and the value carried between them, and hence Out, are the same
 * whatever the window size, and a rewind replays them from the snapshot.
 *
 * A channel starts at In on its first grid point, and again after a gap in the
 * grid (skipped windows, Channels raised), rather than easing up from 0.
 * Channels at or above Channels, and channels not queried yet, pass In through.
 * Reads outside the current chunk (frame() behind it, an audio catch-up after
 * it) hold its first value or finish the step from its last. Several cables into In are summed, a non-finite cable counts
 * as 0, and an unconnected In is 0.
 */
export const smooth: NodeDefinition = {
  type: 'smooth',
  version: 1,
  label: 'Smooth',
  category: 'control-logic',
  description: 'Eases a Signal toward its input per channel, with separate rise and fall times.',
  ports: [
    { name: 'in', type: 'signal', direction: 'in', label: 'In' },
    { name: 'out', type: 'signal', direction: 'out', label: 'Out' },
  ],
  params: [
    { name: 'rise', kind: 'number', min: 0, max: SMOOTH_TIME_MAX, default: 0.1, unit: 's', label: 'Rise' },
    { name: 'fall', kind: 'number', min: 0, max: SMOOTH_TIME_MAX, default: 0.1, unit: 's', label: 'Fall' },
    { name: 'channels', kind: 'number', min: 1, max: MAX_CHANNELS, default: 1, step: 1, label: 'Channels', modulatable: false },
  ],
  query({ t0, t1, params, param, signal, state }) {
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || !(t1 > t0)) return {};
    const channels = params.channels as number;
    const track = trackOf(state);

    // First and last grid points in [t0, t1), tested on the computed times as Threshold does.
    let first = Math.ceil(t0 * SMOOTH_RATE);
    let last = Math.ceil(t1 * SMOOTH_RATE);
    // Near 2^53 grid indices k + 1 === k, so the loops below would never end.
    if (!(Math.abs(first) < 2 ** 52 && Math.abs(last) < 2 ** 52)) return {};
    while (first / SMOOTH_RATE >= t0) first--;
    while (first / SMOOTH_RATE < t0) first++;
    while (last / SMOOTH_RATE >= t1) last--;
    while ((last + 1) / SMOOTH_RATE < t1) last++;

    const fresh: Track = {};
    const big = last - first + 1 > MAX_GRID_POINTS;
    for (let c = 0; c < channels; c++) {
      const before = track[c];
      if (big) {
        fresh[c] = { k0: last, v: [signal('in', last / SMOOTH_RATE, c)] };
        continue;
      }
      if (first > last) {
        // No grid point in this window: keep the carried value, if it's the one just before.
        if (before && before.k0 + before.v.length - 1 === first - 1) fresh[c] = { k0: first - 1, v: [before.v[before.v.length - 1]!] };
        continue;
      }
      const carries = before !== undefined && before.k0 + before.v.length - 1 === first - 1;
      let y = carries ? before.v[before.v.length - 1]! : signal('in', first / SMOOTH_RATE, c);
      const v = [y];
      for (let k = first + (carries ? 0 : 1); k <= last; k++) {
        const time = k / SMOOTH_RATE;
        const x = signal('in', time, c);
        y = step(y, x, blend(1 / SMOOTH_RATE, param(x > y ? 'rise' : 'fall', time, c)));
        v.push(y);
      }
      fresh[c] = { k0: carries ? first - 1 : first, v };
    }
    // Channels not watched any more drop out.
    state.track = fresh;
    return {};
  },
  signal({ state, signal, param }, port, t, channel) {
    if (port !== 'out' || !Number.isFinite(t)) return 0;
    const x = signal('in', t, channel);
    const row = trackOf(state)[channel];
    if (!row) return x;
    const { k0, v } = row;
    // Grid point at or before t, kept inside the stored chunk: reads after it (an audio
    // catch-up) finish the step from its last point, reads before it (frame()) hold its first.
    if (t < k0 / SMOOTH_RATE) return v[0]!;
    let i = Math.floor(t * SMOOTH_RATE) - k0;
    if ((k0 + i + 1) / SMOOTH_RATE <= t) i++;
    else if ((k0 + i) / SMOOTH_RATE > t) i--;
    i = Math.max(0, Math.min(v.length - 1, i));
    const y = v[i]!;
    const dt = t - (k0 + i) / SMOOTH_RATE;
    if (!(dt > 0)) return y;
    return step(y, x, blend(dt, param(x > y ? 'rise' : 'fall', t, channel)));
  },
};
