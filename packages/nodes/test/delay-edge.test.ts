import { describe, expect, it } from 'vitest';
import { compareEvents, compilePatch, Runtime, type EngineEvent, type ParamValue, type Patch } from '@flow-patcher/engine';
import { delayEdge, nodeRegistry } from '../src';
import { query, queryTiled, ticks } from './helpers';

const times = [0, 0.013, 0.05, 0.2, 0.31, 0.5, 0.77, 1.2];
const shifted = (events: EngineEvent[], by: number) => events.map((e) => ({ ...e, time: e.time + by }));

/**
 * Tiles [0, end) in windows of `step` as the runtime does: each window sees the
 * inputs whose times fell in the previous window.
 */
function runTiled(source: EngineEvent[], end: number, step: number, time: number): EngineEvent[] {
  let previous = 0;
  return queryTiled(delayEdge, 'out', end, step, {
    params: { time },
    state: {},
    inputsFor: (t0) => {
      const inputs = { in: source.filter((e) => e.time >= previous && e.time < t0) };
      previous = t0;
      return inputs;
    },
  });
}

describe('delay-edge', () => {
  it('declares itself a delay node with a fixed, unmodulated time', () => {
    expect(delayEdge.delay?.({ time: 0.18 })).toBe(0.18);
    const spec = delayEdge.params.find((p) => p.name === 'time');
    expect(spec).toMatchObject({ kind: 'number', min: 0.01, max: 2, default: 0.025, unit: 's', modulatable: false });
  });

  it('shifts events by time and keeps their fields', () => {
    const out = query(delayEdge, 0, 10, { params: { time: 0.25 }, inputs: { in: ticks(times) } }).out!;
    expect(out).toEqual(shifted(ticks(times), 0.25));
    expect(out[3]).toMatchObject({ index: 3, channel: 0 });
  });

  it('holds events until their delayed time falls in a window', () => {
    const state = {};
    const first = query(delayEdge, 0, 0.1, { params: { time: 0.5 }, state, inputs: { in: ticks([0.02, 0.07]) } }).out;
    expect(first).toEqual([]);
    expect((state as { pending: EngineEvent[] }).pending.map((e) => e.time)).toEqual([0.52, 0.5700000000000001]);
    // Pending state is plain data, so a rewind snapshot can clone it.
    expect(structuredClone(state)).toEqual(state);
    expect(query(delayEdge, 0.1, 0.55, { params: { time: 0.5 }, state }).out!.map((e) => e.time)).toEqual([0.52]);
    expect(query(delayEdge, 0.55, 0.6, { params: { time: 0.5 }, state }).out!.map((e) => e.time)).toEqual([0.5700000000000001]);
    expect(query(delayEdge, 0.6, 2, { params: { time: 0.5 }, state }).out).toEqual([]);
  });

  it('drops held events whose window was skipped', () => {
    const state = {};
    query(delayEdge, 0, 0.1, { params: { time: 0.5 }, state, inputs: { in: ticks([0.02]) } });
    expect(query(delayEdge, 1, 1.1, { params: { time: 0.5 }, state }).out).toEqual([]);
    expect((state as { pending: EngineEvent[] }).pending).toEqual([]);
  });

  it('keeps channels separate and emits in time order', () => {
    const input = [...ticks([0.1, 0.3], 2), ...ticks([0.2], 0), ...ticks([0.1], 1)].sort(compareEvents);
    const state = {};
    const a = query(delayEdge, 0, 0.35, { params: { time: 0.1 }, state, inputs: { in: input } }).out!;
    const b = query(delayEdge, 0.35, 1, { params: { time: 0.1 }, state }).out!;
    expect([...a, ...b].map((e) => [e.time, e.channel])).toEqual([[0.2, 1], [0.2, 2], [0.30000000000000004, 0], [0.4, 2]]);
    expect(a.every((e, i) => i === 0 || compareEvents(a[i - 1]!, e) <= 0)).toBe(true);
  });

  it('gives the same events however time is split into windows no wider than the delay', () => {
    const source = [...ticks(times, 0), ...ticks(times.map((t) => t + 0.004), 3)].sort(compareEvents);
    const time = 0.1, end = 2;
    const expected = shifted(source, time).filter((e) => e.time < end).sort(compareEvents);
    const fine = runTiled(source, end, 0.01, time);
    expect(fine).toEqual(expected);
    expect(runTiled(source, end, 0.025, time)).toEqual(fine);
    expect(runTiled(source, end, 0.0999, time)).toEqual(fine);
  });

  it('drops events with non-finite times and handles empty input', () => {
    const input: EngineEvent[] = [{ time: NaN, channel: 0 }, { time: Infinity, channel: 0 }, { time: 0.1, channel: 0 }];
    const state: { pending?: EngineEvent[] } = {};
    expect(query(delayEdge, 0, 10, { params: { time: 0.1 }, state, inputs: { in: input } }).out).toEqual([{ time: 0.2, channel: 0 }]);
    expect(state.pending).toEqual([]);
    expect(query(delayEdge, 0, 1, { inputs: { in: [] } }).out).toEqual([]);
    expect(query(delayEdge, 0, 1).out).toEqual([]);
  });

  it('clamps an out-of-range time', () => {
    const at = (time: unknown) => query(delayEdge, 0, 10, { params: { time }, inputs: { in: ticks([1]) } }).out!.map((e) => e.time);
    expect(at(0)).toEqual([1.01]);
    expect(at(99)).toEqual([3]);
    expect(at(NaN)).toEqual([1.025]);
  });
});

describe('delay-edge in a patch', () => {
  const node = (id: string, type: string, params: Record<string, ParamValue> = {}) =>
    ({ id, type, typeVersion: nodeRegistry.get(type)!.version, params, position: { x: 0, y: 0 } });
  const cable = (a: string, from: string, b: string, to: string) => ({ from: { node: a, port: from }, to: { node: b, port: to } });
  const patch = (nodes: Patch['nodes'], cables: Patch['cables']): Patch => ({ format: 'flowpatch', version: 1, seed: 7, nodes, cables });

  it('is needed to close a cycle', () => {
    const result = compilePatch(patch(
      [node('clock', 'clock'), node('maybe', 'probability')],
      [cable('clock', 'tick', 'maybe', 'in'), cable('maybe', 'out', 'maybe', 'in')],
    ), nodeRegistry);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatch(/cycle without a delay edge/);
    expect(result.cycles).toEqual([{ nodes: ['maybe'], cables: [1] }]);
  });

  it('closes a cycle, and each event comes back time later', () => {
    const time = 0.18;
    const result = compilePatch(patch(
      [node('clock', 'clock', { bpm: 60, division: '1/1' }), node('maybe', 'probability', { chance: 1 }), node('echo', 'delay-edge', { time })],
      [cable('clock', 'tick', 'maybe', 'in'), cable('maybe', 'out', 'echo', 'in'), cable('echo', 'out', 'maybe', 'in')],
    ), nodeRegistry);
    if (!result.ok) throw new Error(result.errors.join('\n'));
    expect(result.plan.delayEdges).toEqual([1]);
    const log = new Runtime(result.plan).query(0, 1);
    // One tick at 0, then an echo every `time` through a chance of 1.
    const maybe = log.filter((e) => e.node === 'maybe').map((e) => e.time);
    expect(maybe).toHaveLength(6);
    maybe.forEach((t, i) => expect(t).toBeCloseTo(i * time, 9));
    const echo = log.filter((e) => e.node === 'echo').map((e) => e.time);
    expect(echo).toEqual(maybe.slice(1));
  });
});
