import { describe, expect, it } from 'vitest';
import { compareEvents, compilePatch, Runtime, type EngineEvent, type Patch, type SignalSource } from '@flow-patcher/engine';
import { gate, nodeRegistry } from '../src';
import { query, queryTiled, ticks } from './helpers';

const times = Array.from({ length: 400 }, (_, i) => i * 0.025);
const timesOf = (events: readonly EngineEvent[] | undefined) => (events ?? []).map((e) => e.time);
/** Every event in `events` inside [t0, t1), as the runtime hands a window its inputs. */
const within = (events: EngineEvent[]) => (t0: number, t1: number) => ({ in: events.filter((e) => e.time >= t0 && e.time < t1) });

describe('gate', () => {
  it('passes an event when Gate is at or above Level, and blocks it below', () => {
    const at = (v: number) => query(gate, 0, 1, { params: { level: 0.5 }, inputs: { in: ticks([0.1]) }, signals: { gate: [() => v] } }).out;
    expect(timesOf(at(0.5))).toEqual([0.1]);
    expect(timesOf(at(0.7))).toEqual([0.1]);
    expect(timesOf(at(0.4999))).toEqual([]);
    expect(timesOf(at(-3))).toEqual([]);
  });

  it('reads Gate at each event\'s own time', () => {
    // Open for the second half of every second.
    const halves: SignalSource = (t) => t - Math.floor(t);
    const out = query(gate, 0, 10, { inputs: { in: ticks(times) }, signals: { gate: [halves] } }).out!;
    expect(timesOf(out)).toEqual(times.filter((t) => t - Math.floor(t) >= 0.5));
  });

  it('keeps each event\'s time, channel and payload untouched', () => {
    const e: EngineEvent = { time: 0.3, channel: 2, value: 7, x: 0.25, rising: true };
    expect(query(gate, 0, 1, { inputs: { in: [e] }, signals: { gate: [() => 1] } }).out).toEqual([e]);
  });

  it('reads Gate and a modulated Level per channel', () => {
    const both = [...ticks(times, 0), ...ticks(times, 1), ...ticks(times, 3)].sort(compareEvents);
    // Channel 0 is open throughout, channel 1 only before 5 s, channel 3 never.
    const perChannel: SignalSource = (t, c) => (c === 0 || (c === 1 && t < 5) ? 1 : 0);
    const out = query(gate, 0, 10, { inputs: { in: both }, signals: { gate: [perChannel] } }).out!;
    expect(timesOf(out.filter((e) => e.channel === 0))).toEqual(times);
    expect(timesOf(out.filter((e) => e.channel === 1))).toEqual(times.filter((t) => t < 5));
    expect(out.filter((e) => e.channel === 3)).toEqual([]);
    // Same Gate everywhere, Level raised on channel 1 only.
    const mods = { level: [{ depth: 1, signal: ((_t: number, c: number) => (c === 1 ? 1 : 0)) as SignalSource }] };
    const lifted = query(gate, 0, 10, { params: { level: 0.5 }, inputs: { in: both }, signals: { gate: [() => 1] }, mods }).out!;
    expect(new Set(lifted.map((e) => e.channel))).toEqual(new Set([0, 3]));
  });

  it('sums several Gate cables, dropping a non-finite one', () => {
    const out = query(gate, 0, 1, { inputs: { in: ticks([0.1]) }, signals: { gate: [() => 0.3, () => 0.3] } }).out;
    expect(timesOf(out)).toEqual([0.1]);
    const withNaN = query(gate, 0, 1, { params: { level: 0.5 }, inputs: { in: ticks([0.1]) }, signals: { gate: [() => 1, () => NaN] } }).out;
    expect(timesOf(withNaN)).toEqual([0.1]);
  });

  it('passes below a level when the signal is negated and Level is negative', () => {
    // Math (Multiply, Constant −1) in front: pass while the source is under 0.5.
    const source: SignalSource = (t) => t;
    const negated: SignalSource = (t, c) => -source(t, c);
    const out = query(gate, 0, 1, { params: { level: -0.5 }, inputs: { in: ticks([0.25, 0.5, 0.75]) }, signals: { gate: [negated] } }).out;
    expect(timesOf(out)).toEqual([0.25, 0.5]);
  });

  it('passes everything with Gate unwired and Open on, and nothing with Open off', () => {
    expect(timesOf(query(gate, 0, 10, { inputs: { in: ticks(times) } }).out)).toEqual(times);
    expect(query(gate, 0, 10, { params: { open: true }, inputs: { in: ticks(times) } }).out).toHaveLength(400);
    expect(query(gate, 0, 10, { params: { open: false }, inputs: { in: ticks(times) } }).out).toEqual([]);
    // Level doesn't matter without a Gate cable.
    expect(query(gate, 0, 10, { params: { level: 10 }, inputs: { in: ticks(times) } }).out).toHaveLength(400);
  });

  it('blocks everything with Open off, even with Gate wired and high', () => {
    expect(query(gate, 0, 10, { params: { open: false }, inputs: { in: ticks(times) }, signals: { gate: [() => 1] } }).out).toEqual([]);
    expect(query(gate, 0, 10, { params: { open: true }, inputs: { in: ticks(times) }, signals: { gate: [() => 1] } }).out).toHaveLength(400);
    expect(query(gate, 0, 10, { params: { open: true }, inputs: { in: ticks(times) }, signals: { gate: [() => 0] } }).out).toEqual([]);
  });

  it('gives the same events however time is split into windows', () => {
    const both = [...ticks(times, 0), ...ticks(times, 1)].sort(compareEvents);
    const wave: SignalSource = (t, c) => Math.sin(2 * Math.PI * (0.7 + c * 0.4) * t);
    const options = { inputs: { in: both }, signals: { gate: [wave] }, mods: { level: [{ depth: 0.3, signal: ((t: number) => Math.cos(t)) as SignalSource }] } };
    const whole = query(gate, 0, 10, options).out!;
    expect(whole.length).toBeGreaterThan(100);
    expect(whole.length).toBeLessThan(700);
    expect(new Set(whole.map((e) => e.channel)).size).toBe(2);
    for (const step of [0.025, 0.1, 0.333, 0.0013]) {
      expect(queryTiled(gate, 'out', 10, step, { ...options, inputsFor: within(both) }), `window ${step}`).toEqual(whole);
    }
    for (const open of [true, false]) {
      expect(queryTiled(gate, 'out', 10, 0.1, { params: { open }, inputsFor: within(both) })).toEqual(query(gate, 0, 10, { params: { open }, inputs: { in: both } }).out);
      expect(queryTiled(gate, 'out', 10, 0.1, { ...options, params: { open }, inputsFor: within(both) })).toEqual(query(gate, 0, 10, { ...options, params: { open } }).out);
    }
  });

  it('handles weird input without throwing', () => {
    // No events, wired or not.
    expect(query(gate, 0, 1, {}).out).toEqual([]);
    expect(query(gate, 0, 1, { signals: { gate: [() => 1] } }).out).toEqual([]);
    expect(query(gate, 0, 1, { inputs: { in: [] }, params: { open: false } }).out).toEqual([]);
    // A non-finite cable counts as 0 (fan-in rule): open only at Level ≤ 0.
    for (const v of [NaN, Infinity, -Infinity]) {
      const cable: SignalSource = () => v;
      expect(query(gate, 0, 1, { inputs: { in: ticks([0.1]) }, signals: { gate: [cable] } }).out).toEqual([]);
      expect(query(gate, 0, 1, { params: { level: 0 }, inputs: { in: ticks([0.1]) }, signals: { gate: [cable] } }).out).toHaveLength(1);
    }
    // Out-of-range and wrong-typed params fall back to the spec's range or default.
    const huge = (level: unknown, v: number) => query(gate, 0, 1, { params: { level }, inputs: { in: ticks([0.1]) }, signals: { gate: [() => v] } }).out!.length;
    expect(huge(999, 10)).toBe(1); // clamped to 10
    expect(huge(-999, -10)).toBe(1); // clamped to −10
    expect(huge(NaN, 0.5)).toBe(1); // default 0.5
    expect(huge('high', 0.4)).toBe(0);
    expect(query(gate, 0, 1, { params: { open: 'yes' }, inputs: { in: ticks([0.1]) } }).out).toHaveLength(1);
    // Odd event times and channels pass through as they are.
    const odd: EngineEvent[] = [{ time: -5, channel: 0 }, { time: 1e300, channel: 1e6 }];
    expect(query(gate, -10, Infinity, { inputs: { in: odd }, signals: { gate: [() => 1] } }).out).toEqual(odd);
  });
});

describe('gate in a patch', () => {
  // examples/gate-pulse.flowpatch in miniature: 1/8 ticks at 120 bpm, open while a 1/1 Clock's Phase ≥ 0.5.
  const node = (id: string, type: string, params: Record<string, string | number | boolean> = {}) =>
    ({ id, type, typeVersion: nodeRegistry.get(type)!.version, params, position: { x: 0, y: 0 } });
  const cable = (a: string, from: string, b: string, to: string) => ({ from: { node: a, port: from }, to: { node: b, port: to } });
  const patch: Patch = {
    format: 'flowpatch',
    version: 1,
    seed: 3,
    nodes: [
      node('fast', 'clock', { bpm: 120, division: '1/8' }),
      node('slow', 'clock', { bpm: 120, division: '1/1' }),
      node('gate', 'gate', { level: 0.5 }),
      node('note', 'make-note', { pitch: 60 }),
    ],
    cables: [cable('fast', 'tick', 'gate', 'in'), cable('slow', 'phase', 'gate', 'gate'), cable('gate', 'out', 'note', 'trigger')],
  };

  const notes = (window: number) => {
    const result = compilePatch(patch, nodeRegistry);
    if (!result.ok) throw new Error(result.errors.join('\n'));
    const runtime = new Runtime(result.plan);
    const log: EngineEvent[] = [];
    for (let t = 0; t < 4 - 1e-9; t += window) log.push(...runtime.query(t, Math.min(4, t + window)));
    return log.filter((e) => e.node === 'note').map((e) => e.time);
  };

  it('plays the ticks in the second half of each bar, whatever the window size', () => {
    const whole = notes(4);
    expect(whole).toEqual([1, 1.25, 1.5, 1.75, 3, 3.25, 3.5, 3.75]);
    expect(notes(0.025)).toEqual(whole);
    expect(notes(0.3)).toEqual(whole);
  });
});
