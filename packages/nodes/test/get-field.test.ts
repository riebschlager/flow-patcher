import { describe, expect, it } from 'vitest';
import { clonePlain, compareEvents, compilePatch, Runtime, type EngineEvent, type ParamValue, type Patch } from '@flow-patcher/engine';
import { getField, nodeRegistry } from '../src';
import { FIELD_PRESETS, fieldError, fieldValue, RETAIN } from '../src/get-field';
import { context, query, queryTiled } from './helpers';

/** Out on a channel at time t, read through the same state the queries wrote. */
const read = (state: Record<string, unknown>, t: number, channel = 0, params: Record<string, unknown> = {}) =>
  getField.signal!(context(getField, { state, params }), 'out', t, channel);

/** Pointer-like events: pressure and x differ per channel and over time. */
const pointerEvents = (times: number[], channel = 0): EngineEvent[] =>
  times.map((time) => ({ time, channel, pressure: time / 10 + channel, x: 1 - time / 10, pointerType: 'pen' }));

/**
 * Tiles [0, end) in windows of `step` as the runtime does: each window gets the
 * events whose times fall in it, then a reader samples Out at `readTimes` in that
 * window on every channel. With `rewindAt`, the state is snapshotted at every
 * boundary, and after the window holding `rewindAt` the node goes back to the
 * snapshot at or before it and re-runs from there, as ADR 0019 does.
 */
function runTiled(events: EngineEvent[], end: number, step: number, readTimes: number[], channels: number[], params: Record<string, unknown> = {}, rewindAt?: number): number[][] {
  let state: Record<string, unknown> = {};
  const snapshots: { t: number; state: Record<string, unknown> }[] = [];
  const reads = new Map<number, number[]>();
  const count = Math.ceil(end / step - 1e-9);
  let rewound = false;
  for (let i = 0; i < count; i++) {
    const t0 = i * step, t1 = Math.min(end, (i + 1) * step);
    snapshots.push({ t: t0, state: clonePlain(state) as Record<string, unknown> });
    query(getField, t0, t1, { state, params, inputs: { in: events.filter((e) => e.time >= t0 && e.time < t1) } });
    for (const t of readTimes.filter((t) => t >= t0 && t < t1)) reads.set(t, channels.map((c) => read(state, t, c, params)));
    if (rewindAt !== undefined && !rewound && rewindAt >= t0 && rewindAt < t1) {
      rewound = true;
      const back = snapshots.filter((s) => s.t <= rewindAt - step).at(-1) ?? snapshots[0]!;
      state = clonePlain(back.state) as Record<string, unknown>;
      i = Math.round(back.t / step) - 1;
      snapshots.length = i + 1;
    }
  }
  return readTimes.map((t) => reads.get(t)!);
}

describe('get-field', () => {
  it('is an Event → Signal node with a text Field param defaulting to pressure', () => {
    expect(getField.ports).toEqual([
      expect.objectContaining({ name: 'in', type: 'event', direction: 'in' }),
      expect.objectContaining({ name: 'out', type: 'signal', direction: 'out' }),
    ]);
    expect(getField.params).toEqual([expect.objectContaining({ name: 'field', kind: 'text', default: 'pressure' })]);
    // The menu offers the numeric payload fields of design.md and the Note fields.
    expect(Object.values(FIELD_PRESETS)).toEqual(expect.arrayContaining(['x', 'y', 'dx', 'dy', 'speed', 'angle', 'pressure', 'width', 'height', 'age', 'pitch', 'velocity', 'duration']));
    expect(fieldError('pressure')).toBeNull();
    expect(fieldError('  ')).not.toBeNull();
  });

  it('holds the named field of each event until the next one', () => {
    const state = {};
    expect(query(getField, 0, 1, { state, inputs: { in: pointerEvents([0.2, 0.5]) } })).toEqual({});
    expect(read(state, 0.1)).toBe(0); // before the first event
    expect(read(state, 0.2)).toBe(0.02); // at the event itself
    expect(read(state, 0.49)).toBe(0.02);
    expect(read(state, 0.5)).toBe(0.05);
    expect(read(state, 0.99)).toBe(0.05);
  });

  it('reads whichever field the param names, trimmed, including Note fields, time and channel', () => {
    const x = {};
    query(getField, 0, 1, { state: x, params: { field: ' x ' }, inputs: { in: pointerEvents([0.2]) } });
    expect(read(x, 0.5)).toBe(0.98);
    const notes: EngineEvent[] = [{ time: 0.1, channel: 0, pitch: 64, velocity: 0.7, duration: 0.25 }];
    for (const [field, expected] of [['pitch', 64], ['velocity', 0.7], ['duration', 0.25], ['time', 0.1], ['channel', 0]] as const) {
      const state = {};
      query(getField, 0, 1, { state, params: { field }, inputs: { in: notes } });
      expect(read(state, 0.5), field).toBe(expected);
    }
  });

  it('keeps channels separate', () => {
    const state = {};
    const events = [...pointerEvents([0.1, 0.4], 0), ...pointerEvents([0.3], 2)].sort(compareEvents);
    query(getField, 0, 1, { state, inputs: { in: events } });
    expect([0.2, 0.35, 0.5].map((t) => read(state, t, 0))).toEqual([0.01, 0.01, 0.04]);
    expect([0.2, 0.35, 0.5].map((t) => read(state, t, 2))).toEqual([0, 2.03, 2.03]);
    expect(read(state, 0.5, 1)).toBe(0); // never had an event
  });

  it('gives the same held values however time is split into windows, and across a rewind', () => {
    const events = [...pointerEvents([0, 0.013, 0.05, 0.2, 0.31, 0.5, 0.77, 1.2], 0), ...pointerEvents([0.007, 0.25, 0.9], 3)].sort(compareEvents);
    const readTimes = [0, 0.01, 0.013, 0.04, 0.2, 0.3, 0.6, 0.77, 0.95, 1.5, 1.99];
    const whole = runTiled(events, 2, 2, readTimes, [0, 3]);
    expect(whole[3]).toEqual([0.0013, 3.0007]);
    expect(whole[8]).toEqual([0.077, 3.09]);
    expect(runTiled(events, 2, 0.025, readTimes, [0, 3])).toEqual(whole);
    expect(runTiled(events, 2, 0.1, readTimes, [0, 3])).toEqual(whole);
    expect(runTiled(events, 2, 0.333, readTimes, [0, 3])).toEqual(whole);
    expect(runTiled(events, 2, 0.025, readTimes, [0, 3], {}, 0.31)).toEqual(whole);
    expect(runTiled(events, 2, 0.1, readTimes, [0, 3], {}, 0.95)).toEqual(whole);
    // It emits no events on any windowing.
    expect(queryTiled(getField, 'out', 2, 0.1, { inputs: { in: events } })).toEqual([]);
  });

  it('keeps history back to RETAIN before the window start, as plain data', () => {
    const state: { held?: Record<number, { times: number[] }> } = {};
    query(getField, 0, 1, { state, inputs: { in: pointerEvents([0.1, 0.2, 0.3]) } });
    query(getField, 2.25, 3, { state });
    // t0 − RETAIN = 0.25: the step at 0.2 is in force then, so only 0.1 goes.
    expect(RETAIN).toBe(2);
    expect(state.held![0]!.times).toEqual([0.2, 0.3]);
    query(getField, 100, 101, { state });
    expect(state.held![0]!.times).toEqual([0.3]); // the last step stays in force
    expect(read(state, 100.5)).toBe(0.03);
    expect(clonePlain(state)).toEqual(state);
  });

  it('holds through events without the field or with text in it, and maps booleans and non-finite numbers', () => {
    const state = {};
    const events: EngineEvent[] = [
      { time: 0.1, channel: 0, pressure: 0.4 },
      { time: 0.2, channel: 0 }, // no pressure: hold 0.4
      { time: 0.3, channel: 0, pressure: 'hard' }, // text: hold 0.4
      { time: 0.4, channel: 0, pressure: NaN },
      { time: 0.5, channel: 0, pressure: Infinity },
      { time: 0.6, channel: 0, pressure: true },
      { time: 0.7, channel: 0, pressure: false },
      { time: 0.8, channel: 0, pressure: -1e300 },
    ];
    query(getField, 0, 1, { state, inputs: { in: events } });
    expect([0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85].map((t) => read(state, t))).toEqual([0.4, 0.4, 0.4, 0, 0, 1, 0, -1e300]);
    // Prototype names aren't fields.
    expect(fieldValue({ time: 0, channel: 0 }, 'constructor')).toBeUndefined();
    expect(fieldValue({ time: 0, channel: 0 }, 'toString')).toBeUndefined();
  });

  it('handles weird input without throwing', () => {
    const state = {};
    const weird: EngineEvent[] = [
      { time: NaN, channel: 0, pressure: 9 },
      { time: Infinity, channel: 0, pressure: 9 },
      { time: 0.1, channel: NaN, pressure: 9 },
      { time: 0.1, channel: -1, pressure: 9 },
      { time: 0.1, channel: 0.5, pressure: 9 },
      { time: 0.2, channel: 1, pressure: 0.3 },
      // Out of order and tied at one time: the last at a time wins.
      { time: 0.5, channel: 1, pressure: 0.6 },
      { time: 0.4, channel: 1, pressure: 0.7 },
      { time: 0.4, channel: 1, pressure: 0.8 },
    ];
    query(getField, 0, 1, { state, inputs: { in: weird } });
    expect(Object.keys((state as { held: object }).held)).toEqual(['1']);
    expect([0.3, 0.45, 0.6].map((t) => read(state, t, 1))).toEqual([0.3, 0.8, 0.6]);
    expect(read(state, 0.5, -1)).toBe(0);
    expect(read(state, 0.5, 0.5)).toBe(0);
    // Non-finite or early read times, and an unknown port, give 0.
    expect(read(state, NaN, 1)).toBe(0);
    expect(read(state, Infinity, 1)).toBe(0);
    expect(read(state, -5, 1)).toBe(0);
    expect(getField.signal!(context(getField, { state }), 'nope', 0.6, 1)).toBe(0);
    // Empty, unconnected, an empty field name, and a field nothing carries.
    expect(query(getField, 0, 1, { inputs: { in: [] } })).toEqual({});
    expect(query(getField, 0, 1)).toEqual({});
    for (const field of ['', '   ', 'nothing']) {
      const s = {};
      query(getField, 0, 1, { state: s, params: { field }, inputs: { in: pointerEvents([0.5]) } });
      expect(read(s, 0.7), field).toBe(0);
    }
    // A bad window doesn't throw.
    expect(query(getField, NaN, 1, { state: {}, inputs: { in: pointerEvents([0.5]) } })).toEqual({});
    expect(query(getField, 1, 0, { state: {} })).toEqual({});
  });
});

describe('get-field in a patch', () => {
  const node = (id: string, type: string, params: Record<string, ParamValue> = {}) =>
    ({ id, type, typeVersion: nodeRegistry.get(type)!.version, params, position: { x: 0, y: 0 } });
  const cable = (a: string, from: string, b: string, to: string, depth?: number) =>
    ({ from: { node: a, port: from }, to: { node: b, port: to }, ...(depth === undefined ? {} : { depth }) });
  // A melody's pitch, read off its notes, drives a faster echo.
  const patch: Patch = {
    format: 'flowpatch',
    version: 1,
    seed: 7,
    nodes: [
      node('beat', 'clock', { bpm: 120, division: '1/4' }),
      node('fast', 'clock', { bpm: 120, division: '1/8' }),
      node('sweep', 'clock', { bpm: 120, division: '1/1' }),
      node('tone', 'chord-tone', { symbol: 'C', down: 0, up: 1 }),
      node('get', 'get-field', { field: 'pitch' }),
      node('echo', 'make-note', { pitch: 0 }),
    ],
    cables: [
      cable('beat', 'tick', 'tone', 'trigger'),
      cable('sweep', 'phase', 'tone', 'position'),
      cable('tone', 'note', 'get', 'in'),
      cable('fast', 'tick', 'echo', 'trigger'),
      cable('get', 'out', 'echo', 'pitch', 1),
    ],
  };

  const log = (window: number) => {
    const result = compilePatch(patch, nodeRegistry);
    if (!result.ok) throw new Error(result.errors.join('\n'));
    const runtime = new Runtime(result.plan);
    const events = [];
    for (let t = 0; t < 4 - 1e-9; t += window) events.push(...runtime.query(t, Math.min(4, t + window)));
    return events;
  };

  it('gives each echo the pitch of the latest melody note, whatever the window size', () => {
    const whole = log(4);
    const melody = whole.filter((e) => e.node === 'tone').map((e) => [e.time, e.pitch]);
    const echo = whole.filter((e) => e.node === 'echo').map((e) => [e.time, e.pitch]);
    expect(echo).toHaveLength(16);
    for (const [time, pitch] of echo) {
      const latest = melody.filter(([t]) => t! <= time!).at(-1)!;
      expect(pitch).toBe(latest[1]);
    }
    expect(new Set(echo.map(([, p]) => p)).size).toBeGreaterThan(1);
    expect(log(0.025)).toEqual(whole);
    expect(log(0.3)).toEqual(whole);
  });
});
