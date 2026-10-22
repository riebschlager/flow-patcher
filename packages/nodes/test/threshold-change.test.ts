import { describe, expect, it } from 'vitest';
import { compilePatch, Runtime, type EngineEvent, type NodeDefinition, type ParamValue, type Patch, type SignalSource } from '@flow-patcher/engine';
import { nodeRegistry, thresholdChange } from '../src';
import { SAMPLE_RATE } from '../src/threshold-change';
import { query, queryTiled } from './helpers';

/** Piecewise-constant signal: `steps` are [from time, value] pairs, ascending; 0 before the first. */
const stepped = (steps: [number, number][]): ((t: number) => number) => (t) => {
  let v = 0;
  for (const [from, value] of steps) if (t >= from) v = value;
  return v;
};

/** Runs [0, end) in windows of `step` with fresh state and returns [time, channel, value, rising] per event. */
const run = (end: number, step: number, source: SignalSource, params: Record<string, unknown> = {}) =>
  queryTiled(thresholdChange, 'out', end, step, { state: {}, params, signals: { in: [source] } }).map((e) => [e.time, e.channel, e.value, e.rising]);

const times = (events: unknown[][]) => events.map((e) => e[0]);

describe('threshold-change', () => {
  it('is a Signal → Event adapter whose ports match its adapter spec', () => {
    expect(thresholdChange.adapter).toEqual({ from: 'signal', to: 'event', input: 'in', output: 'out' });
    expect(SAMPLE_RATE).toBe(500);
  });

  describe('threshold mode', () => {
    const pulse = stepped([[0.3, 1], [0.7, 0], [1.1, 0.8], [1.5, 0.2]]);

    it('emits on the grid point where In rises to Level', () => {
      expect(run(2, 2, pulse)).toEqual([[0.3, 0, 1, true], [1.1, 0, 0.8, true]]);
    });

    it('emits on falling crossings, or both', () => {
      expect(run(2, 2, pulse, { direction: 'falling' })).toEqual([[0.7, 0, 0, false], [1.5, 0, 0.2, false]]);
      expect(times(run(2, 2, pulse, { direction: 'both' }))).toEqual([0.3, 0.7, 1.1, 1.5]);
    });

    it('rounds a crossing between grid points up to the next one', () => {
      // sin crosses 0.5 at t = 1/12 ≈ 0.0833; the next 2 ms grid point is 0.084.
      const out = run(1, 1, (t) => Math.sin(2 * Math.PI * t));
      expect(times(out)).toEqual([42 / SAMPLE_RATE]);
    });

    it('ignores chatter inside the hysteresis band', () => {
      // Alternates 0.45 / 0.55 on every grid point around Level 0.5.
      const chatter: SignalSource = (t) => (t < 0.2 ? 0 : Math.round(t * SAMPLE_RATE) % 2 ? 0.55 : 0.45);
      expect(run(1, 1, chatter).length).toBeGreaterThan(100);
      expect(run(1, 1, chatter, { hysteresis: 0.1 })).toEqual([[0.202, 0, 0.55, true]]);
      // A real drop below Level − Hysteresis re-arms it.
      const drop: SignalSource = (t) => (t >= 0.6 && t < 0.7 ? 0 : chatter(t, 0));
      expect(times(run(1, 1, drop, { hysteresis: 0.1, direction: 'both' }))).toEqual([0.202, 0.6, 0.702]);
    });

    it('takes the first sample as the baseline, so a signal already above Level gives no event', () => {
      expect(run(1, 1, () => 5)).toEqual([]);
      expect(run(1, 1, () => 5, { direction: 'both' })).toEqual([]);
    });
  });

  describe('change mode', () => {
    const steps = stepped([[0.1, 1], [0.2, 1], [0.3, 3], [0.4, 2.5], [0.5, 2.4]]);

    it('emits when the value moves, with its direction', () => {
      expect(run(1, 1, steps, { mode: 'change', direction: 'both' })).toEqual([
        [0.1, 0, 1, true], [0.3, 0, 3, true], [0.4, 0, 2.5, false], [0.5, 0, 2.4, false],
      ]);
      expect(times(run(1, 1, steps, { mode: 'change', direction: 'rising' }))).toEqual([0.1, 0.3]);
      expect(times(run(1, 1, steps, { mode: 'change', direction: 'falling' }))).toEqual([0.4, 0.5]);
    });

    it('needs a move larger than Hysteresis from the last reported value', () => {
      // 3 → 2.5 is 0.5 (not > 0.5); 3 → 2.4 is 0.6.
      expect(run(1, 1, steps, { mode: 'change', direction: 'both', hysteresis: 0.5 })).toEqual([[0.1, 0, 1, true], [0.3, 0, 3, true], [0.5, 0, 2.4, false]]);
    });

    it('fires on a moving signal at most once per Interval', () => {
      expect(times(run(0.1, 0.1, (t) => t, { mode: 'change' }))).toEqual([0.002, 0.022, 0.042, 0.062, 0.082]);
      // At the shortest Interval, every sample of a ramp fires.
      expect(run(0.1, 0.1, (t) => t, { mode: 'change', interval: 0.002 }).length).toBe(0.1 * SAMPLE_RATE - 1);
      // Interval is whole grid steps, at least one.
      expect(times(run(0.1, 0.1, (t) => t, { mode: 'change', interval: 0.0301 }))).toEqual([0.002, 0.032, 0.062, 0.092]);
    });

    it('reports a move made during Interval when it ends, against the last reported value', () => {
      const quick = stepped([[0.1, 1], [0.11, 2]]);
      expect(run(1, 1, quick, { mode: 'change' })).toEqual([[0.1, 0, 1, true], [0.12, 0, 2, true]]);
      // A move that comes back within Interval is no change at all.
      const blip = stepped([[0.1, 1], [0.106, 5], [0.11, 1]]);
      expect(run(1, 1, blip, { mode: 'change' })).toEqual([[0.1, 0, 1, true]]);
    });

    it('keeps a moving signal on 8 channels under the event budget in 120 ms windows', () => {
      const state = {};
      const sine: SignalSource = (t, c) => Math.sin(2 * Math.PI * (3 + c) * t);
      let most = 0;
      for (let i = 0; i < 50; i++) {
        const out = query(thresholdChange, i * 0.12, (i + 1) * 0.12, { state, params: { mode: 'change', channels: 8 }, signals: { in: [sine] } }).out!;
        most = Math.max(most, out.length);
      }
      expect(most).toBeGreaterThan(0);
      expect(most).toBeLessThanOrEqual(8 * 6);
    });
  });

  it('watches each channel separately, up to Channels', () => {
    const perChannel: SignalSource = (t, c) => (t >= [0.1, 0.2, 0.3][c]! ? 1 : 0);
    expect(run(1, 1, perChannel)).toEqual([[0.1, 0, 1, true]]);
    expect(run(1, 1, perChannel, { channels: 3 })).toEqual([[0.1, 0, 1, true], [0.2, 1, 1, true], [0.3, 2, 1, true]]);
    // Level modulation is read per channel too.
    const mods = { level: [{ depth: 1, signal: ((_t: number, c: number) => c) as SignalSource }] };
    const out = queryTiled(thresholdChange, 'out', 1, 1, { state: {}, params: { channels: 2, level: 0.5 }, mods, signals: { in: [(t, c) => (t >= 0.5 ? c + 1 : 0)] } });
    expect(out.map((e) => [e.time, e.channel])).toEqual([[0.5, 0], [0.5, 1]]);
  });

  it('gives the same events however time is split into windows', () => {
    const source: SignalSource = (t, c) => Math.sin(2 * Math.PI * (1.3 + c) * t) + (t > 1.7 ? 0.4 : 0);
    for (const params of [{ channels: 3, direction: 'both', hysteresis: 0.05 }, { channels: 2, mode: 'change', hysteresis: 0.3 }]) {
      const whole = run(3, 3, source, params);
      expect(whole.length).toBeGreaterThan(10);
      expect(new Set(whole.map((e) => e[1])).size).toBe(params.channels);
      for (const step of [0.025, 0.1, 0.333, 0.0013, 0.12]) expect(run(3, step, source, params), `window ${step}`).toEqual(whole);
    }
  });

  it('re-baselines after a gap in the grid instead of comparing across it', () => {
    const state = {};
    const signals = { in: [stepped([[0.5, 1]])] };
    expect(query(thresholdChange, 0, 0.1, { state, signals }).out).toEqual([]);
    // Windows skipped from 0.1 to 1: the rise at 0.5 was never seen, so no late event.
    expect(query(thresholdChange, 1, 1.1, { state, signals }).out).toEqual([]);
  });

  it('bounds the work of a huge window, treating it as a gap', () => {
    const state: { watch?: Record<number, { k: number }> } = {};
    const signals = { in: [(t: number) => (t >= 1e7 + 0.05 ? 1 : 0)] };
    const started = performance.now();
    expect(query(thresholdChange, 0, 1e7, { state, signals })).toEqual({ out: [] });
    expect(performance.now() - started).toBeLessThan(100);
    // Re-baselined at the last grid point, so the next window carries on from it.
    expect(state.watch![0]!.k).toBe(1e7 * SAMPLE_RATE - 1);
    expect(query(thresholdChange, 1e7, 1e7 + 0.1, { state, signals }).out!.map((e) => e.time)).toEqual([1e7 + 0.05]);
    // Times too large for a grid index give nothing, without hanging.
    expect(query(thresholdChange, 1e300, 2e300, { signals })).toEqual({ out: [] });
    expect(query(thresholdChange, 1e16, 1e16 + 1, { signals })).toEqual({ out: [] });
  });

  it('keeps plain-data state', () => {
    const state: { watch?: Record<number, { k: number }> } = {};
    query(thresholdChange, 0, 0.5, { state, params: { channels: 2 }, signals: { in: [(t) => t] } });
    expect(state.watch![0]!.k).toBe(0.5 * SAMPLE_RATE - 1);
    expect(state.watch![1]!.k).toBe(0.5 * SAMPLE_RATE - 1);
    expect(structuredClone(state)).toEqual(state);
  });

  it('handles weird input without throwing', () => {
    // A non-finite cable counts as 0 (fan-in rule).
    const nasty: SignalSource = (t) => (t < 0.3 ? 0 : t < 0.6 ? NaN : t < 0.8 ? Infinity : 1);
    expect(run(1, 1, nasty)).toEqual([[0.8, 0, 1, true]]);
    // Unconnected In is 0 throughout.
    expect(queryTiled(thresholdChange, 'out', 1, 0.1, { state: {} })).toEqual([]);
    expect(queryTiled(thresholdChange, 'out', 1, 0.1, { state: {}, params: { level: -1, direction: 'both' } })).toEqual([]);
    // Bad windows.
    for (const [t0, t1] of [[NaN, 1], [0, Infinity], [1, 1], [1, 0.5], [-Infinity, 0]]) expect(query(thresholdChange, t0!, t1!, { signals: { in: [() => 1] } })).toEqual({ out: [] });
    // Negative time works on the same grid.
    expect(query(thresholdChange, -0.1, 0.1, { state: {}, signals: { in: [stepped([[0, 1]])] } }).out!.map((e) => e.time)).toEqual([0]);
    // Out-of-range and wrong-typed params fall back to the spec's range or default.
    expect(run(1, 1, (t, c) => (t >= 0.5 ? 20 + c : 0), { level: 999, channels: 100, mode: 'bogus', direction: 7 }).map((e) => e[1])).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(run(1, 1, (t) => (t >= 0.5 ? 1 : 0), { level: NaN, hysteresis: -3 })).toEqual([[0.5, 0, 1, true]]);
    // Huge values pass through.
    expect(run(1, 1, (t) => (t >= 0.5 ? 1e300 : -1e300), { mode: 'change' })).toEqual([[0.5, 0, 1e300, true]]);
  });
});

describe('threshold-change in a patch', () => {
  // A stand-in Signal source until the catalog has one: a 1 Hz sawtooth from 0 to 1.
  const saw: NodeDefinition = {
    type: 'test-saw',
    version: 1,
    label: 'Saw',
    category: 'control-logic',
    description: 'Test only.',
    ports: [{ name: 'out', type: 'signal', direction: 'out' }],
    params: [],
    query: () => ({}),
    signal: (_ctx, _port, t) => t - Math.floor(t),
  };
  const registry = new Map([...nodeRegistry, [saw.type, saw]]);
  const node = (id: string, type: string, params: Record<string, ParamValue> = {}) =>
    ({ id, type, typeVersion: registry.get(type)!.version, params, position: { x: 0, y: 0 } });
  const cable = (a: string, from: string, b: string, to: string) => ({ from: { node: a, port: from }, to: { node: b, port: to } });
  const patch: Patch = {
    format: 'flowpatch',
    version: 1,
    seed: 7,
    nodes: [node('saw', 'test-saw'), node('cross', 'threshold-change', { level: 0.25, direction: 'both' }), node('note', 'make-note', { pitch: 60 })],
    cables: [cable('saw', 'out', 'cross', 'in'), cable('cross', 'out', 'note', 'trigger')],
  };

  const notes = (window: number) => {
    const result = compilePatch(patch, registry);
    if (!result.ok) throw new Error(result.errors.join('\n'));
    const runtime = new Runtime(result.plan);
    const log: EngineEvent[] = [];
    for (let t = 0; t < 3 - 1e-9; t += window) log.push(...runtime.query(t, Math.min(3, t + window)));
    return log.filter((e) => e.node === 'note').map((e) => [e.time, e.rising]);
  };

  it('plays a note at each crossing of the saw, whatever the window size', () => {
    const whole = notes(3);
    // Up through 0.25 at k + 0.25, down at each wrap to 0.
    expect(whole).toEqual([[0.25, true], [1, false], [1.25, true], [2, false], [2.25, true]]);
    expect(notes(0.025)).toEqual(whole);
    expect(notes(0.3)).toEqual(whole);
  });
});
