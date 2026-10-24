import { describe, expect, it } from 'vitest';
import { clonePlain, compilePatch, replayInput, Runtime, type EngineEvent, type InputEvent, type LoggedEvent, type Patch, type SignalSource } from '@flow-patcher/engine';
import { nodeRegistry, switchNode } from '../src';
import { outputOf, SWITCH_OUTPUTS } from '../src/switch';
import { routeContacts } from '../src/recognizer';
import { query, queryTiled } from './helpers';
import { burst, expectUnderCap, expectWellFormed } from './routing';

const OUTS = Array.from({ length: SWITCH_OUTPUTS }, (_, i) => `out${i + 1}`);

const ev = (time: number, channel: number, phase?: string, extra: Record<string, number | string | boolean> = {}): EngineEvent => ({ time, channel, ...(phase ? { phase } : {}), ...extra });

/** Two drags on channels 1 and 2 that overlap, a hover on 3, and a phaseless event on channel 0. */
const stream: EngineEvent[] = [
  ev(0.1, 1, 'down'), ev(0.2, 1, 'move'), ev(0.25, 3, 'move'), ev(0.3, 0),
  ev(0.4, 2, 'down'), ev(0.5, 1, 'move'), ev(0.55, 2, 'move'), ev(0.6, 1, 'up'),
  ev(0.7, 2, 'move'), ev(0.8, 3, 'move'), ev(0.9, 2, 'cancel'), ev(1.0, 0),
];

/** Index stepping 1 → 2 at 0.35 s → 4 at 0.65 s as a cable (depth 1) into Index, the knob at 1. */
const stepping: SignalSource = (t) => (t < 0.35 ? 0 : t < 0.65 ? 1 : 3);

/** [time, channel, port] for every event the node gives, in time order. */
function routed(result: Record<string, EngineEvent[] | undefined>): [number, number, string][] {
  const out: [number, number, string][] = [];
  for (const port of OUTS) for (const e of result[port] ?? []) out.push([e.time, e.channel, port]);
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function tiled(step: number, events = stream, signal = stepping) {
  const state = {};
  const out: Record<string, EngineEvent[]> = {};
  for (const port of OUTS) out[port] = [];
  const count = Math.ceil(1.2 / step - 1e-9);
  for (let i = 0; i < count; i++) {
    const t0 = i * step, t1 = Math.min(1.2, (i + 1) * step);
    const result = query(switchNode, t0, t1, { state, mods: { index: [{ depth: 1, signal }] }, inputs: { in: events.filter((e) => e.time >= t0 && e.time < t1) } });
    for (const port of OUTS) out[port]!.push(...(result[port] ?? []));
  }
  return routed(out);
}

describe('switch', () => {
  it('has In, four outputs and an integer Index knob', () => {
    expect(switchNode.category).toBe('control-logic');
    expect(switchNode.ports.map((p) => [p.name, p.direction, p.type])).toEqual([['in', 'in', 'event'], ...OUTS.map((o) => [o, 'out', 'event'])]);
    expect(switchNode.params).toEqual([{ name: 'index', kind: 'number', min: 1, max: 4, step: 1, default: 1, label: 'Index' }]);
  });

  it('sends everything to the output Index names, unchanged', () => {
    for (const index of [1, 2, 3, 4]) {
      const result = query(switchNode, 0, 2, { params: { index }, inputs: { in: stream } });
      expect(Object.keys(result)).toEqual([`out${index}`]);
      expect(result[`out${index}`]).toEqual(stream);
      // The same objects: Switch copies nothing.
      expect(result[`out${index}`]![0]).toBe(stream[0]);
    }
  });

  it('keeps each contact on the output its down picked, until its up or cancel (ADR 0028)', () => {
    expect(tiled(2)).toEqual([
      // Channel 1 goes down at Index 1 and stays on Out 1 after Index moves to 2 and 4.
      [0.1, 1, 'out1'], [0.2, 1, 'out1'],
      // A hover and a phaseless event go by Index at their own time.
      [0.25, 3, 'out1'], [0.3, 0, 'out1'],
      // Channel 2 goes down at Index 2 and stays there, through its cancel.
      [0.4, 2, 'out2'], [0.5, 1, 'out1'], [0.55, 2, 'out2'], [0.6, 1, 'out1'],
      [0.7, 2, 'out2'], [0.8, 3, 'out4'], [0.9, 2, 'out2'], [1.0, 0, 'out4'],
    ]);
  });

  it('starts a new contact on a channel after its up, at the Index then', () => {
    const events = [ev(0.1, 1, 'down'), ev(0.2, 1, 'up'), ev(0.7, 1, 'down'), ev(0.8, 1, 'move'), ev(0.9, 1, 'up')];
    expect(tiled(2, events)).toEqual([[0.1, 1, 'out1'], [0.2, 1, 'out1'], [0.7, 1, 'out4'], [0.8, 1, 'out4'], [0.9, 1, 'out4']]);
  });

  it('reads Index per channel, so a cable can route channels apart', () => {
    const byChannel: SignalSource = (_t, channel) => channel;
    const events = [ev(0.1, 1, 'down'), ev(0.1, 2, 'down'), ev(0.2, 1, 'move'), ev(0.2, 2, 'move'), ev(0.3, 3, 'down')];
    expect(tiled(2, events, byChannel)).toEqual([[0.1, 1, 'out2'], [0.1, 2, 'out3'], [0.2, 1, 'out2'], [0.2, 2, 'out3'], [0.3, 3, 'out4']]);
  });

  it('gives the same events in any windows, with the open contacts in plain-data state', () => {
    const whole = tiled(2);
    for (const step of [0.025, 0.1, 0.33]) expect(tiled(step)).toEqual(whole);
    // A drag that spans windows stays put across them.
    const state: Record<string, unknown> = {};
    query(switchNode, 0, 0.15, { state, mods: { index: [{ depth: 1, signal: stepping }] }, inputs: { in: stream.slice(0, 1) } });
    expect(clonePlain(state).routes).toEqual({ 1: 1 });
    expect(queryTiled(switchNode, 'out3', 1.2, 0.05, { params: { index: 3 }, inputsFor: (t0, t1) => ({ in: stream.filter((e) => e.time >= t0 && e.time < t1) }) })).toEqual(stream);
  });

  it('copes with weird input', () => {
    expect(query(switchNode, 0, 1)).toEqual({});
    expect(query(switchNode, 0, 1, { inputs: { in: [] } })).toEqual({});
    // Out-of-range or non-finite Index clamps; a non-finite time or channel is dropped; any finite channel can hold a contact.
    expect([outputOf(NaN), outputOf(-3), outputOf(2.4), outputOf(2.6), outputOf(99), outputOf(Infinity)]).toEqual([1, 1, 2, 3, 4, 1]);
    const weird = [ev(NaN, 1, 'down'), ev(0.1, 1.5, 'down'), ev(0.2, NaN, 'down'), ev(0.3, -1, 'down'), ev(0.4, 1, 'sideways'), ev(0.5, 1, 'up')];
    const state: Record<string, unknown> = {};
    const result = query(switchNode, 0, 1, { state, params: { index: 3 }, inputs: { in: weird } });
    expect(result.out3!.map((e) => e.time)).toEqual([0.1, 0.3, 0.4, 0.5]);
    expect(state.routes).toEqual({ 1.5: 3, '-1': 3 });
    // An up with no contact open, or a stored knob value out of range, still routes.
    expect(Object.keys(query(switchNode, 0, 1, { params: { index: 12 }, inputs: { in: [ev(0.1, 4, 'up')] } }))).toEqual(['out4']);
  });

  it('routes a pick of 0 (none) for the recognizers that share it, and remembers it for the contact', () => {
    let pick = 0;
    const state = {};
    const first = routeContacts(state, [ev(0.1, 1, 'down')], () => pick);
    pick = 2;
    const rest = routeContacts(state, [ev(0.2, 1, 'move'), ev(0.3, 1, 'up'), ev(0.4, 1, 'move')], () => pick);
    expect([...first, ...rest].map((r) => r.route)).toEqual([0, 0, 0, 2]);
  });

  it('forgets a contact at its cancel, so a hover after it picks afresh', () => {
    let pick = 1;
    const state = {};
    const routes = [ev(0.1, 1, 'down'), ev(0.2, 1, 'cancel'), ev(0.3, 1, 'move'), ev(0.4, 1, 'up')].map((e) => {
      const [r] = routeContacts(state, [e], () => pick++);
      return r!.route;
    });
    // Down picks 1 and the cancel keeps it; the hover and the stray up each pick on their own.
    expect(routes).toEqual([1, 1, 2, 3]);
    expect(state).toEqual({ routes: {} });
    const events = [ev(0.1, 1, 'down'), ev(0.5, 1, 'cancel'), ev(0.7, 1, 'move')];
    expect(tiled(2, events)).toEqual([[0.1, 1, 'out1'], [0.5, 1, 'out1'], [0.7, 1, 'out4']]);
  });

  it('thins moves in an over-budget burst, so every down still gets its up or cancel', () => {
    const events = burst(30, 20, () => ({}));
    const byChannel: SignalSource = (_t, channel) => channel % 4;
    const state = {};
    const out = query(switchNode, 0, 1, { state, mods: { index: [{ depth: 1, signal: byChannel }] }, inputs: { in: events } }) as Record<string, EngineEvent[]>;
    expectWellFormed(out);
    expectUnderCap(out);
    for (const port of OUTS) expect(out[port]!.filter((e) => e.phase === 'down').length).toBeGreaterThanOrEqual(7);
    expect(Object.values(out).flat().filter((e) => e.phase === 'move').length).toBeLessThan(30 * 20);
  });

  it('routes Pointer All live: an input stream through Pointer into Switch', () => {
    const node = (id: string, type: string, params = {}) => ({ id, type, typeVersion: nodeRegistry.get(type)!.version, params, position: { x: 0, y: 0 } });
    const patch: Patch = {
      format: 'flowpatch', version: 1, seed: 1,
      nodes: [node('p', 'pointer'), node('s', 'switch', { index: 2 })],
      cables: [{ from: { node: 'p', port: 'all' }, to: { node: 's', port: 'in' } }],
    };
    const compiled = compilePatch(patch, nodeRegistry);
    if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
    const rt = new Runtime(compiled.plan);
    const events: InputEvent[] = [
      { time: 0.1, type: 'pointerdown', channel: 40, x: 0.2, y: 0.2, pressure: 0.5, pointerType: 'touch' },
      { time: 0.2, type: 'pointermove', channel: 40, x: 0.3, y: 0.2, pressure: 0.5, pointerType: 'touch' },
      { time: 0.3, type: 'pointerup', channel: 40, x: 0.3, y: 0.2, pressure: 0, pointerType: 'touch' },
    ];
    replayInput(rt, { events });
    const log: LoggedEvent[] = [];
    for (let i = 0; i < 20; i++) log.push(...rt.query(i * 0.025, (i + 1) * 0.025));
    const out = log.filter((e) => e.node === 's');
    expect(out.map((e) => [e.port, e.time, e.channel, e.phase])).toEqual([['out2', 0.1, 1, 'down'], ['out2', 0.2, 1, 'move'], ['out2', 0.3, 1, 'up']]);
  });
});
