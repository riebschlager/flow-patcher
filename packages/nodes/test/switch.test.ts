import { describe, expect, it } from 'vitest';
import { clonePlain, compilePatch, inputRouter, replayInput, Runtime, type EngineEvent, type EventField, type InputEvent, type LoggedEvent, type NodeDefinition, type Patch, type SignalSource } from '@flow-patcher/engine';
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
  it('has In, Select, four outputs and an integer Index knob', () => {
    expect(switchNode.category).toBe('control-logic');
    expect(switchNode.ports.map((p) => [p.name, p.direction, p.type])).toEqual([['in', 'in', 'event'], ['select', 'in', 'event'], ...OUTS.map((o) => [o, 'out', 'event'])]);
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

  describe('Select', () => {
    /** Runs In and Select through windows of `step` with one state; [time, channel, port] per routed event. */
    function selected(step: number, inEvents: EngineEvent[], selects: EngineEvent[], params: Record<string, unknown> = {}, mods = {}) {
      const state = {};
      const out: Record<string, EngineEvent[]> = {};
      for (let i = 0; i * step < 3 - 1e-9; i++) {
        const t0 = i * step, t1 = Math.min(3, (i + 1) * step);
        const within = (e: EngineEvent) => e.time >= t0 && e.time < t1;
        const result = query(switchNode, t0, t1, { state, params, mods, inputs: { in: inEvents.filter(within), select: selects.filter(within) } });
        for (const port of OUTS) (out[port] ??= []).push(...(result[port] ?? []));
      }
      return routed(out);
    }
    const sel = (time: number, value?: EventField): EngineEvent => ({ time, channel: 0, ...(value === undefined ? {} : { value }) });
    const taps = (times: number[]) => times.flatMap((t, i) => [ev(t, i + 1, 'down'), ev(t + 0.05, i + 1, 'up')]);
    const ports = (rows: [number, number, string][]) => rows.filter((_, i) => i % 2 === 0).map((r) => r[2]);

    it("latches the output an event's value names, until the next Select event", () => {
      const selects = [sel(0.5, 3), sel(1.5, 2.6), sel(2.5, 99)];
      expect(ports(selected(3, taps([0.2, 0.7, 1.2, 1.7, 2.7]), selects))).toEqual(['out1', 'out3', 'out3', 'out3', 'out4']);
    });

    it('steps to the next output on an event with no finite value, wrapping 4 to 1', () => {
      const selects = [sel(0.5), sel(1.0, 'two'), sel(1.5, NaN), sel(2.0)];
      expect(ports(selected(3, taps([0.2, 0.7, 1.2, 1.7, 2.2]), selects, { index: 2 }))).toEqual(['out2', 'out3', 'out4', 'out1', 'out2']);
    });

    it('gives way to Index when Index changes, and takes over again at the next Select: the latest wins', () => {
      // Index (knob 1 + cable) steps to 2 at 1.0 s and back to 1 at 2.0 s.
      const index: SignalSource = (t) => (t >= 1 && t < 2 ? 1 : 0);
      const selects = [sel(0.5, 4), sel(1.5, 3)];
      const out = selected(3, taps([0.2, 0.7, 1.2, 1.7, 2.2]), selects, {}, { index: [{ depth: 1, signal: index }] });
      expect(ports(out)).toEqual(['out1', 'out4', 'out2', 'out3', 'out1']);
      // A knob that doesn't move leaves the latch alone.
      expect(ports(selected(3, taps([0.2, 0.7, 2.2]), [sel(0.5, 4)], { index: 2 }))).toEqual(['out2', 'out4', 'out4']);
    });

    it('applies before a down at the same time, and never moves an open contact', () => {
      const drag = [ev(0.5, 1, 'down'), ev(0.8, 1, 'move'), ev(1.2, 1, 'move'), ev(1.4, 1, 'up'), ev(1.0, 2, 'down'), ev(1.1, 2, 'up')].sort((a, b) => a.time - b.time);
      expect(selected(3, drag, [sel(0.5, 2), sel(1.0, 3)])).toEqual([
        [0.5, 1, 'out2'], [0.8, 1, 'out2'], [1.0, 2, 'out3'], [1.1, 2, 'out3'], [1.2, 1, 'out2'], [1.4, 1, 'out2'],
      ]);
    });

    it('gives the same events in any windows', () => {
      const index: SignalSource = (t) => (t >= 1 && t < 2 ? 1 : 0);
      const run = (step: number) => selected(step, [...taps([0.2, 0.7, 1.2, 1.7, 2.2]), ...stream], [sel(0.5, 4), sel(1.5), sel(1.9, 3)], {}, { index: [{ depth: 1, signal: index }] });
      const whole = run(3);
      for (const step of [0.025, 0.1, 0.37]) expect(run(step)).toEqual(whole);
    });

    it('replays Select pushed live, rewinds included, as when the events are known in advance', () => {
      const key: NodeDefinition = { type: 'test-key', version: 1, label: 'Key', category: 'canvas-sources', description: '', ports: [{ name: 'down', type: 'event', direction: 'out' }], params: [] };
      const registry = new Map([...nodeRegistry, [key.type, key]]);
      const node = (id: string, type: string, params = {}) => ({ id, type, typeVersion: registry.get(type)!.version, params, position: { x: 0, y: 0 } });
      const patch: Patch = {
        format: 'flowpatch', version: 1, seed: 1,
        nodes: [node('p', 'pointer'), node('k', 'test-key'), node('s', 'switch')],
        cables: [{ from: { node: 'p', port: 'all' }, to: { node: 's', port: 'in' } }, { from: { node: 'k', port: 'down' }, to: { node: 's', port: 'select' } }],
      };
      const compiled = compilePatch(patch, registry);
      if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
      const touch = (time: number, type: string, channel: number): InputEvent => ({ time, type, channel, x: 0.5, y: 0.5, pressure: type === 'pointerup' ? 0 : 0.5, pointerType: 'touch' } as InputEvent);
      // Select-cycles at 0.3 and 0.9 (no value), and touches around them.
      const script: ({ key: number } | { input: InputEvent })[] = [
        { input: touch(0.1, 'pointerdown', 9) }, { key: 0.3 }, { input: touch(0.35, 'pointerup', 9) },
        { input: touch(0.5, 'pointerdown', 10) }, { input: touch(0.6, 'pointerup', 10) }, { key: 0.9 }, { input: touch(1.0, 'pointerdown', 11) }, { input: touch(1.1, 'pointerup', 11) },
      ];
      const run = (lag: number) => {
        const rt = new Runtime(compiled.plan, { history: true });
        const router = inputRouter(rt.plan);
        let log: LoggedEvent[] = [];
        let next = 0;
        const queryTo = (t: number) => {
          for (; next * 0.025 < t - 1e-9; next++) log.push(...rt.query(next * 0.025, (next + 1) * 0.025));
        };
        for (const step of script) {
          const time = 'key' in step ? step.key : step.input.time;
          queryTo(time + lag);
          const pushes = 'key' in step
            ? [{ node: 'k', port: 'down', event: { time, channel: 0 } }]
            : router.route(step.input).map(({ node: id, port, fields }) => ({ node: id, port, event: { time, ...fields } as EngineEvent }));
          const report = rt.pushAll(pushes);
          if (report) log = [...log.filter((e) => !(report.affected.has(e.node) && e.time >= report.time)), ...report.added];
        }
        queryTo(1.5);
        return rt.sortLog(log).filter((e) => e.node === 's').map((e) => [e.port, e.time, e.channel, e.phase]);
      };
      const ahead = run(0);
      expect(ahead).toEqual([
        ['out1', 0.1, 1, 'down'], ['out1', 0.35, 1, 'up'], ['out2', 0.5, 1, 'down'], ['out2', 0.6, 1, 'up'], ['out3', 1.0, 1, 'down'], ['out3', 1.1, 1, 'up'],
      ]);
      expect(run(0.3)).toEqual(ahead);
    });
  });
});
