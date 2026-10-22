import { describe, expect, it } from 'vitest';
import { compareEvents, compilePatch, Runtime, type EngineEvent, type NodeDefinition, type ParamValue, type Patch, type SignalSource } from '@flow-patcher/engine';
import { nodeRegistry, sampleAndHold } from '../src';
import { RETAIN } from '../src/sample-and-hold';
import { context, query, queryTiled, ticks } from './helpers';

/** A test In signal: different on every channel, and changing over time. */
const ramp: SignalSource = (t, channel) => 10 * t + 100 * channel;
const signals = { in: [ramp] };

/** Out on a channel at time t, read through the same state the queries wrote. */
const read = (state: Record<string, unknown>, t: number, channel = 0) => sampleAndHold.signal!(context(sampleAndHold, { state }), 'out', t, channel);

/**
 * Tiles [0, end) in windows of `step` as the runtime does: each window gets the
 * triggers whose times fall in it, then a reader samples Out at `readTimes` in
 * that window, on every channel.
 */
function runTiled(triggers: EngineEvent[], end: number, step: number, readTimes: number[], channels: number[]): number[][] {
  const state = {};
  const reads: number[][] = [];
  const count = Math.ceil(end / step - 1e-9);
  for (let i = 0; i < count; i++) {
    const t0 = i * step, t1 = Math.min(end, (i + 1) * step);
    query(sampleAndHold, t0, t1, { state, signals, inputs: { trigger: triggers.filter((e) => e.time >= t0 && e.time < t1) } });
    for (const t of readTimes.filter((t) => t >= t0 && t < t1)) reads.push(channels.map((c) => read(state, t, c)));
  }
  return reads;
}

describe('sample-and-hold', () => {
  it('is an Event → Signal adapter whose ports match its adapter spec', () => {
    expect(sampleAndHold.adapter).toEqual({ from: 'event', to: 'signal', input: 'trigger', output: 'out' });
    expect(sampleAndHold.ports.find((p) => p.name === 'trigger')).toMatchObject({ type: 'event', direction: 'in' });
    expect(sampleAndHold.ports.find((p) => p.name === 'out')).toMatchObject({ type: 'signal', direction: 'out' });
  });

  it('holds the In value from each trigger until the next one', () => {
    const state = {};
    expect(query(sampleAndHold, 0, 1, { state, signals, inputs: { trigger: ticks([0.2, 0.5]) } })).toEqual({});
    expect(read(state, 0.1)).toBe(0); // before the first trigger
    expect(read(state, 0.2)).toBe(2); // at the trigger itself
    expect(read(state, 0.49)).toBe(2); // held, although In has moved on
    expect(read(state, 0.5)).toBe(5);
    expect(read(state, 0.99)).toBe(5);
  });

  it('keeps channels separate', () => {
    const state = {};
    const trigger = [...ticks([0.1, 0.4], 0), ...ticks([0.3], 2)].sort(compareEvents);
    query(sampleAndHold, 0, 1, { state, signals, inputs: { trigger } });
    expect([0.2, 0.35, 0.5].map((t) => read(state, t, 0))).toEqual([1, 1, 4]);
    expect([0.2, 0.35, 0.5].map((t) => read(state, t, 2))).toEqual([0, 203, 203]);
    // A channel that never triggered reads 0.
    expect(read(state, 0.5, 1)).toBe(0);
  });

  it('gives the same held values however time is split into windows', () => {
    const triggers = [...ticks([0, 0.013, 0.05, 0.2, 0.31, 0.5, 0.77, 1.2], 0), ...ticks([0.007, 0.25, 0.9], 3)].sort(compareEvents);
    const readTimes = [0, 0.01, 0.013, 0.04, 0.2, 0.3, 0.6, 0.77, 0.95, 1.5, 1.99];
    const whole = runTiled(triggers, 2, 2, readTimes, [0, 3]);
    expect(whole[3]).toEqual([0.13, 300.07]);
    expect(runTiled(triggers, 2, 0.025, readTimes, [0, 3])).toEqual(whole);
    expect(runTiled(triggers, 2, 0.1, readTimes, [0, 3])).toEqual(whole);
    expect(runTiled(triggers, 2, 0.333, readTimes, [0, 3])).toEqual(whole);
    // It emits no events on any windowing.
    expect(queryTiled(sampleAndHold, 'out', 2, 0.1, { signals, inputs: { trigger: triggers } })).toEqual([]);
  });

  it('keeps history back to RETAIN before the window start, as plain data', () => {
    expect(RETAIN).toBeGreaterThanOrEqual(2);
    const state: { held?: Record<number, { times: number[] }> } = {};
    query(sampleAndHold, 0, 1, { state, signals, inputs: { trigger: ticks([0.1, 0.2, 0.3]) } });
    query(sampleAndHold, 1, 2, { state, signals });
    expect(state.held![0]!.times).toEqual([0.1, 0.2, 0.3]);
    query(sampleAndHold, 2.25, 3, { state, signals });
    // t0 − RETAIN = 0.25: the step at 0.2 is in force then, so only 0.1 goes.
    expect(state.held![0]!.times).toEqual([0.2, 0.3]);
    query(sampleAndHold, 3, 4, { state, signals });
    expect(state.held![0]!.times).toEqual([0.3]);
    expect(read(state, 3)).toBe(3);
    expect(structuredClone(state)).toEqual(state);
  });

  it('reads the true held value behind the last queried window start (rewind, frame reads)', () => {
    const state = {};
    const trigger = ticks([0.1, 0.6, 1.1, 1.6, 2.1]);
    for (let t = 0; t < 2.5 - 1e-9; t += 0.025) query(sampleAndHold, t, t + 0.025, { state, signals, inputs: { trigger: trigger.filter((e) => e.time >= t && e.time < t + 0.025) } });
    // Last t0 ≈ 2.475; every read back to t0 − RETAIN gives the value captured then.
    expect([0.5, 0.7, 1.2, 1.7, 2.0, 2.2].map((t) => read(state, t))).toEqual([1, 6, 11, 16, 16, 21]);
  });

  it('keeps one step per channel forever, since that step stays in force', () => {
    const state: { held?: Record<number, { times: number[] }> } = {};
    query(sampleAndHold, 0, 1, { state, signals, inputs: { trigger: ticks([0.5], 1) } });
    query(sampleAndHold, 100, 101, { state, signals });
    expect(state.held![1]!.times).toEqual([0.5]);
    expect(read(state, 100.5, 1)).toBe(105);
  });

  it('ignores triggers on negative or fractional channels, so they add no state', () => {
    const state: { held?: Record<string, unknown> } = {};
    const trigger: EngineEvent[] = [{ time: 0.1, channel: -1 }, { time: 0.2, channel: 0.5 }, { time: 0.3, channel: 1e-9 }, { time: 0.4, channel: 2 }];
    query(sampleAndHold, 0, 1, { state, signals, inputs: { trigger } });
    expect(Object.keys(state.held!)).toEqual(['2']);
    expect(read(state, 0.5, -1)).toBe(0);
    expect(read(state, 0.5, 0.5)).toBe(0);
    expect(read(state, 0.5, 2)).toBe(204);
  });

  it('lets the last of several triggers at one time win, and accepts out-of-order triggers', () => {
    const state = {};
    query(sampleAndHold, 0, 1, { state, signals: { in: [(t, c) => t + c] }, inputs: { trigger: [{ time: 0.5, channel: 0 }, { time: 0.2, channel: 0 }] } });
    expect(read(state, 0.3)).toBe(0.2);
    expect(read(state, 0.6)).toBe(0.5);
    let n = 0;
    const counting: SignalSource = () => ++n;
    const tie = {};
    query(sampleAndHold, 0, 1, { state: tie, signals: { in: [counting] }, inputs: { trigger: ticks([0.4, 0.4]) } });
    expect(read(tie, 0.4)).toBe(2);
  });

  it('handles weird input without throwing', () => {
    const state = {};
    const weird: EngineEvent[] = [
      { time: NaN, channel: 0 },
      { time: Infinity, channel: 0 },
      { time: 0.1, channel: NaN },
      { time: 0.2, channel: 0 },
      { time: 0.3, channel: 1 },
      { time: 0.4, channel: 2 },
    ];
    const nasty: SignalSource = (_t, c) => [0, NaN, Infinity][c] ?? 0;
    query(sampleAndHold, 0, 1, { state, signals: { in: [nasty, () => 1e300] }, inputs: { trigger: weird } });
    // A non-finite cable counts as 0 (fan-in rule); huge values pass through.
    expect(read(state, 0.5, 0)).toBe(1e300);
    expect(read(state, 0.5, 1)).toBe(1e300);
    expect(read(state, 0.5, 2)).toBe(1e300);
    // A non-finite or pre-trigger read time gives 0.
    expect(read(state, NaN, 0)).toBe(0);
    expect(read(state, Infinity, 0)).toBe(0);
    expect(read(state, -5, 0)).toBe(0);
    // Empty and unconnected inputs.
    expect(query(sampleAndHold, 0, 1, { inputs: { trigger: [] } })).toEqual({});
    expect(query(sampleAndHold, 0, 1)).toEqual({});
    const unwired = {};
    query(sampleAndHold, 0, 1, { state: unwired, inputs: { trigger: ticks([0.5]) } });
    expect(read(unwired, 0.7)).toBe(0);
    expect(read({}, 0.7)).toBe(0);
  });
});

describe('sample-and-hold in a patch', () => {
  // A stand-in Signal source until the catalog has one.
  const rampNode: NodeDefinition = {
    type: 'test-ramp',
    version: 1,
    label: 'Ramp',
    category: 'control-logic',
    description: 'Test only.',
    ports: [{ name: 'out', type: 'signal', direction: 'out' }],
    params: [],
    query: () => ({}),
    signal: (_ctx, _port, t) => 10 * t,
  };
  const registry = new Map([...nodeRegistry, [rampNode.type, rampNode]]);
  const node = (id: string, type: string, params: Record<string, ParamValue> = {}) =>
    ({ id, type, typeVersion: registry.get(type)!.version, params, position: { x: 0, y: 0 } });
  const cable = (a: string, from: string, b: string, to: string, depth?: number) =>
    ({ from: { node: a, port: from }, to: { node: b, port: to }, ...(depth === undefined ? {} : { depth }) });
  const patch: Patch = {
    format: 'flowpatch',
    version: 1,
    seed: 7,
    nodes: [node('clock', 'clock', { bpm: 120, division: '1/4' }), node('ramp', 'test-ramp'), node('hold', 'sample-and-hold'), node('note', 'make-note', { pitch: 40 })],
    cables: [
      cable('clock', 'tick', 'hold', 'trigger'),
      cable('ramp', 'out', 'hold', 'in'),
      cable('clock', 'tick', 'note', 'trigger'),
      cable('hold', 'out', 'note', 'pitch', 1),
    ],
  };

  const pitches = (window: number) => {
    const result = compilePatch(patch, registry);
    if (!result.ok) throw new Error(result.errors.join('\n'));
    const runtime = new Runtime(result.plan);
    const log = [];
    for (let t = 0; t < 4 - 1e-9; t += window) log.push(...runtime.query(t, Math.min(4, t + window)));
    return log.filter((e) => e.node === 'note').map((e) => [e.time, e.pitch]);
  };

  it('feeds each note the value captured at its own tick, whatever the window size', () => {
    const whole = pitches(4);
    // Ticks every 0.5 s; pitch = 40 + 10 × tick time.
    expect(whole).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((t) => [t, 40 + 10 * t]));
    expect(pitches(0.025)).toEqual(whole);
    expect(pitches(0.3)).toEqual(whole);
  });
});
