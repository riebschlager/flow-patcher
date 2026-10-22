import type { NodeDefinition, NodeState } from '@flow-patcher/engine';

/** Held steps per channel, times ascending. Plain data so a rewind snapshot can clone it (ADR 0019). */
interface Held {
  times: number[];
  values: number[];
}
type HeldState = Record<number, Held>;

const heldOf = (state: NodeState): HeldState => (state.held ??= {}) as HeldState;

/** Index of the first time greater than t. */
function upperBound(times: readonly number[], t: number): number {
  let lo = 0, hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Adapter, Event → Signal. Each trigger samples the In signal at its time and
 * channel, and Out holds that value on the same channel until the next trigger
 * there. Out is 0 on a channel before its first trigger.
 *
 * Stateful: Out is a pure function of the triggers up to t, but `signal()`
 * doesn't see event inputs, so `query` records each capture in `state.held`.
 * A read at t only needs the triggers at or before t, and every reader of Out
 * is ordered after this node, so the result doesn't depend on windowing.
 */
export const sampleAndHold: NodeDefinition = {
  type: 'sample-and-hold',
  version: 1,
  label: 'Sample & Hold',
  category: 'control-logic',
  description: "Captures a Signal's value at each event and holds it until the next one, per channel.",
  ports: [
    { name: 'trigger', type: 'event', direction: 'in', label: 'Trigger' },
    { name: 'in', type: 'signal', direction: 'in', label: 'In' },
    { name: 'out', type: 'signal', direction: 'out', label: 'Out' },
  ],
  params: [],
  adapter: { from: 'event', to: 'signal', input: 'trigger', output: 'out' },
  query({ inputs, state, signal, t0 }) {
    const held = heldOf(state);
    // Forget steps before t0, keeping the one in force at t0, so reads in this window and later are unchanged.
    for (const { times, values } of Object.values(held)) {
      const drop = upperBound(times, t0) - 1;
      if (drop > 0) {
        times.splice(0, drop);
        values.splice(0, drop);
      }
    }
    for (const e of inputs.trigger ?? []) {
      if (!Number.isFinite(e.time) || !Number.isFinite(e.channel)) continue;
      // ctx.signal counts a non-finite cable as 0 and an unconnected In as 0.
      const value = signal('in', e.time, e.channel);
      const { times, values } = (held[e.channel] ??= { times: [], values: [] });
      const i = upperBound(times, e.time);
      // Several triggers at one time on one channel: the last one wins.
      if (i > 0 && times[i - 1] === e.time) values[i - 1] = value;
      else {
        times.splice(i, 0, e.time);
        values.splice(i, 0, value);
      }
    }
    return {};
  },
  signal({ state }, _port, t, channel) {
    const steps = heldOf(state)[channel];
    if (!steps || !Number.isFinite(t)) return 0;
    const i = upperBound(steps.times, t);
    return i === 0 ? 0 : steps.values[i - 1]!;
  },
};
