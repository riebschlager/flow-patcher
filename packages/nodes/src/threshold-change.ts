import type { EngineEvent, NodeDefinition, NodeState } from '@flow-patcher/engine';

/** Samples per second. In is read on the grid k / SAMPLE_RATE (2 ms), anchored to time 0, not to the window. */
export const SAMPLE_RATE = 500;

/** Highest channel count the node watches (channels 0 … N−1). */
const MAX_CHANNELS = 8;

/** Per-channel memory of the last sample. Plain data so a rewind snapshot can clone it (ADR 0019). */
interface Watch {
  /** Grid index of the last sample taken. */
  k: number;
  /** Threshold mode: In was at or above Level (Schmitt state). */
  high: boolean;
  /** Change mode: the value last reported, or the baseline. */
  ref: number;
}
type WatchState = Record<number, Watch>;

const watchOf = (state: NodeState): WatchState => (state.watch ??= {}) as WatchState;

/**
 * Adapter, Signal → Event. Samples In every 2 ms on a grid anchored to time 0
 * and emits an event on the grid point where:
 *
 * - **threshold**: In crosses Level. Rising means In ≥ Level after being below
 *   Level − Hysteresis; falling means In < Level − Hysteresis after being at or
 *   above Level. So Hysteresis is a dead band under Level.
 * - **change**: In has moved more than Hysteresis away from the last value
 *   reported (with 0, any change). Direction picks increases, decreases or both;
 *   the reference follows every move past Hysteresis, reported or not.
 *
 * Each event carries `value` (In at that sample) and `rising`. Channels 0 …
 * Channels−1 are watched independently. The first sample on a channel, or the
 * first after a gap in the grid (skipped windows, a channel added), only sets the
 * baseline: a signal already above Level at start gives no event.
 *
 * The previous sample per channel lives in `state.watch`. Windows tile time in
 * order, so the grid points and the state carried between them, and hence the
 * events, are the same whatever the window size.
 */
export const thresholdChange: NodeDefinition = {
  type: 'threshold-change',
  version: 1,
  label: 'Threshold / Change',
  category: 'control-logic',
  description: 'Emits an event when a Signal crosses a level or changes, per channel, sampled every 2 ms.',
  ports: [
    { name: 'in', type: 'signal', direction: 'in', label: 'In' },
    { name: 'out', type: 'event', direction: 'out', label: 'Out' },
  ],
  params: [
    { name: 'mode', kind: 'enum', options: ['threshold', 'change'], default: 'threshold', label: 'Mode' },
    { name: 'direction', kind: 'enum', options: ['rising', 'falling', 'both'], default: 'rising', label: 'Direction' },
    { name: 'level', kind: 'number', min: -10, max: 10, default: 0.5, label: 'Level' },
    { name: 'hysteresis', kind: 'number', min: 0, max: 10, default: 0, label: 'Hysteresis' },
    { name: 'channels', kind: 'number', min: 1, max: MAX_CHANNELS, default: 1, step: 1, label: 'Channels', modulatable: false },
  ],
  adapter: { from: 'signal', to: 'event', input: 'in', output: 'out' },
  query({ t0, t1, params, param, signal, state }) {
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || !(t1 > t0)) return { out: [] };
    const change = params.mode === 'change';
    const rising = params.direction !== 'falling';
    const falling = params.direction !== 'rising';
    const channels = params.channels as number;
    const watch = watchOf(state);

    // First grid point at or after t0, tested on the computed times as Clock does.
    let first = Math.ceil(t0 * SAMPLE_RATE);
    while (first / SAMPLE_RATE >= t0) first--;
    while (first / SAMPLE_RATE < t0) first++;

    const out: EngineEvent[] = [];
    for (let k = first; k / SAMPLE_RATE < t1; k++) {
      const time = k / SAMPLE_RATE;
      for (let channel = 0; channel < channels; channel++) {
        // A non-finite cable counts as 0, and an unconnected In is 0.
        const v = signal('in', time, channel);
        const level = param('level', time, channel);
        const band = param('hysteresis', time, channel);
        const w = watch[channel];
        if (!w || w.k !== k - 1) {
          watch[channel] = { k, high: v >= level, ref: v };
          continue;
        }
        w.k = k;
        // Both modes' memories advance on every sample, so switching Mode live needs no re-baseline.
        const wasHigh = w.high;
        if (!wasHigh && v >= level) w.high = true;
        else if (wasHigh && v < level - band) w.high = false;
        const d = v - w.ref;
        const moved = Math.abs(d) > band;
        if (moved) w.ref = v;
        const up = change ? moved && d > 0 : !wasHigh && w.high;
        const down = change ? moved && d < 0 : wasHigh && !w.high;
        if ((up && rising) || (down && falling)) out.push({ time, channel, value: v, rising: up });
      }
    }
    return { out };
  },
};
