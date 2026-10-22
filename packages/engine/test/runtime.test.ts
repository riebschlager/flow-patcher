import { describe, expect, it } from 'vitest';
import { compilePatch, Runtime, type EngineEvent, type LoggedEvent, type NodeDefinition, type Patch } from '../src';

// Minimal definitions so engine tests don't depend on packages/nodes.
const source: NodeDefinition = {
  type: 'source', version: 1, label: 'Source', category: 'control-logic', description: '',
  ports: [{ name: 'out', type: 'event', direction: 'out' }],
  params: [{ name: 'at', kind: 'number', min: 0, max: 10, default: 0 }],
  query: ({ t0, t1, params, nodeId }) => {
    const at = params.at as number;
    return { out: at >= t0 && at < t1 ? [{ time: at, channel: 0, from: nodeId }] : [] };
  },
};
const pass: NodeDefinition = {
  type: 'pass', version: 1, label: 'Pass', category: 'control-logic', description: '',
  ports: [{ name: 'in', type: 'event', direction: 'in' }, { name: 'out', type: 'event', direction: 'out' }],
  params: [],
  query: ({ inputs }) => ({ out: [...(inputs.in ?? [])] }),
};
const note: NodeDefinition = {
  type: 'note', version: 1, label: 'Note', category: 'control-logic', description: '',
  ports: [{ name: 'in', type: 'note', direction: 'in' }],
  params: [],
  query: () => ({}),
};
const sink: NodeDefinition = {
  type: 'sink', version: 1, label: 'Sink', category: 'visual', description: '',
  ports: [{ name: 'in', type: 'event', direction: 'in' }],
  params: [],
  frame: ({ inputs, state }) => {
    const seen = ((state.seen as number[] | undefined) ??= []);
    seen.push(...(inputs.in ?? []).map((e) => e.time));
  },
};
/** Shifts events by params.time; the runtime hands it the previous window's inputs. */
const delay: NodeDefinition = {
  type: 'delay', version: 1, label: 'Delay', category: 'control-logic', description: '',
  ports: [{ name: 'in', type: 'event', direction: 'in' }, { name: 'out', type: 'event', direction: 'out' }],
  params: [{ name: 'time', kind: 'number', min: 0.01, max: 2, default: 0.025, modulatable: false }],
  delay: (params) => params.time as number,
  query: ({ inputs, params, state, t1 }) => {
    const pending = [...((state.pending as EngineEvent[] | undefined) ?? []), ...(inputs.in ?? []).map((e) => ({ ...e, time: e.time + (params.time as number) }))];
    state.pending = pending.filter((e) => e.time >= t1);
    return { out: pending.filter((e) => e.time < t1) };
  },
};
const definitions = new Map([source, pass, note, sink, delay].map((d) => [d.type, d]));

const node = (id: string, type: string, params = {}) => ({ id, type, typeVersion: 1, params, position: { x: 0, y: 0 } });
const cable = (a: string, b: string, from = 'out', to = 'in') => ({ from: { node: a, port: from }, to: { node: b, port: to } });
const patch = (nodes: Patch['nodes'], cables: Patch['cables']): Patch => ({ format: 'flowpatch', version: 1, seed: 1, nodes, cables });

function compile(p: Patch) {
  const result = compilePatch(p, definitions);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.plan;
}

describe('bootstrap runtime', () => {
  it('sorts nodes so inputs run first, whatever the patch order', () => {
    const plan = compile(patch([node('p', 'pass'), node('s', 'source')], [cable('s', 'p')]));
    expect(plan.order.map((n) => n.id)).toEqual(['s', 'p']);
  });

  it('merges several cables into one input in time order', () => {
    const runtime = new Runtime(compile(patch([node('late', 'source', { at: 0.02 }), node('early', 'source', { at: 0.01 }), node('p', 'pass')], [cable('late', 'p'), cable('early', 'p')])));
    const log = runtime.query(0, 0.025).filter((e) => e.node === 'p');
    expect(log.map((e) => e.from)).toEqual(['early', 'late']);
  });

  it('rejects unknown types, unknown ports, wrong port types and cycles', () => {
    const errors = (p: Patch) => {
      const result = compilePatch(p, definitions);
      return result.ok ? [] : result.errors;
    };
    expect(errors(patch([node('x', 'mystery')], []))[0]).toMatch(/unknown type/);
    expect(errors(patch([node('s', 'source'), node('p', 'pass')], [cable('s', 'p', 'nope')]))[0]).toMatch(/unknown port/);
    expect(errors(patch([node('s', 'source'), node('n', 'note')], [cable('s', 'n')]))[0]).toMatch(/cannot connect event to note/);
    expect(errors(patch([node('a', 'pass'), node('b', 'pass')], [cable('a', 'b'), cable('b', 'a')]))[0]).toMatch(/cycle without a delay edge/);
  });

  it('delivers events to visual nodes in the frame their time falls in', () => {
    const runtime = new Runtime(compile(patch([node('s', 'source', { at: 0.03 }), node('v', 'sink')], [cable('s', 'v')])));
    runtime.query(0, 0.12);
    runtime.frame(0, 0.02, 0.02);
    runtime.frame(0.02, 0.04, 0.02);
    runtime.frame(0.04, 0.06, 0.02);
    const state = runtime.stateOf('v') as { seen?: number[] } | undefined;
    expect(state?.seen).toEqual([0.03]);
  });

  it('clamps params to their ranges', () => {
    const plan = compile(patch([node('s', 'source', { at: 99 })], []));
    expect(plan.order[0]!.params.at).toBe(10);
  });
});

describe('runtime rules', () => {
  it('drops and counts events a query returns outside its window', () => {
    const sloppy: NodeDefinition = {
      type: 'sloppy', version: 1, label: 'Sloppy', category: 'control-logic', description: '',
      ports: [{ name: 'out', type: 'event', direction: 'out' }],
      params: [],
      query: ({ t0, t1 }) => ({ out: [{ time: t0 - 0.01, channel: 0 }, { time: t0, channel: 0 }, { time: t1, channel: 0 }, { time: NaN, channel: 0 }] }),
    };
    const result = compilePatch(patch([node('s', 'sloppy')], []), new Map([[sloppy.type, sloppy]]));
    if (!result.ok) throw new Error(result.errors.join('\n'));
    const runtime = new Runtime(result.plan);
    expect(runtime.query(1, 2).map((e) => e.time)).toEqual([1]);
    expect(runtime.counters.outOfWindow).toBe(3);
  });

  it('snapshots query nodes at window starts only with history, and rejects state that is not plain data', () => {
    const holder: NodeDefinition = {
      type: 'holder', version: 1, label: 'Holder', category: 'control-logic', description: '',
      ports: [{ name: 'out', type: 'event', direction: 'out' }],
      params: [],
      query: ({ state }) => {
        state.handle = new Map();
        return {};
      },
    };
    const result = compilePatch(patch([node('h', 'holder')], []), new Map([[holder.type, holder]]));
    if (!result.ok) throw new Error(result.errors.join('\n'));
    const plain = new Runtime(result.plan);
    plain.query(0, 1);
    expect(() => plain.query(1, 2)).not.toThrow();
    const kept = new Runtime(result.plan, { history: true });
    kept.query(0, 1);
    expect(() => kept.query(1, 2)).toThrow(/node "h" state\.handle is a Map/);
  });

  it('holds a live event past the horizon for the query that covers it', () => {
    const runtime = new Runtime(compile(patch([node('s', 'source', { at: 5 }), node('p', 'pass')], [cable('s', 'p')])));
    runtime.query(0, 0.1);
    expect(runtime.push('s', 'out', { time: 0.15, channel: 2 })).toBeNull();
    expect(runtime.query(0.1, 0.2).map((e) => [e.node, e.time, e.channel])).toEqual([['s', 0.15, 2], ['p', 0.15, 2]]);
  });

  it('refuses to rewind without history, or before the oldest retained window', () => {
    const p = patch([node('s', 'source'), node('p', 'pass')], [cable('s', 'p')]);
    const plain = new Runtime(compile(p));
    plain.query(0, 0.1);
    expect(() => plain.push('s', 'out', { time: 0.05, channel: 0 })).toThrow(/needs history/);
    const kept = new Runtime(compile(p), { history: true });
    for (let i = 0; i < 4; i++) kept.query(i * 0.1, (i + 1) * 0.1);
    kept.retain(0.25);
    expect(() => kept.push('s', 'out', { time: 0.15, channel: 0 })).toThrow(/before the oldest retained window \(0\.2\)/);
    expect(kept.push('s', 'out', { time: 0.25, channel: 0 })?.from).toBe(0.2);
  });
});

describe('delay nodes', () => {
  // source → a → d → b → a: every event through `a` comes back `time` later.
  const loop = (time: number) => patch(
    [node('s', 'source', { at: 0.125 }), node('a', 'pass'), node('d', 'delay', { time }), node('b', 'pass')],
    [cable('s', 'a'), cable('a', 'd'), cable('d', 'b'), cable('b', 'a')],
  );
  const tiled = (runtime: Runtime, seconds: number, window: number) => {
    const log: LoggedEvent[] = [];
    const windows = Math.ceil(seconds / window - 1e-9);
    for (let i = 0; i < windows; i++) log.push(...runtime.query(i * window, Math.min(seconds, (i + 1) * window)));
    return log;
  };

  it('returns an event at t at t + D, t + 2D and so on', () => {
    const runtime = new Runtime(compile(loop(0.25)));
    const times = tiled(runtime, 1, 0.025).filter((e) => e.node === 'a').map((e) => e.time);
    expect(times).toEqual([0.125, 0.375, 0.625, 0.875]);
  });

  it('runs a window wider than the delay as chunks, so it gives the same events', () => {
    for (const time of [0.25, 0.18, 0.025, 0.01]) {
      const one = new Runtime(compile(loop(time))).query(0, 1);
      expect(JSON.stringify(tiled(new Runtime(compile(loop(time))), 1, 0.025))).toBe(JSON.stringify(one));
      expect(JSON.stringify(tiled(new Runtime(compile(loop(time))), 1, 0.3))).toBe(JSON.stringify(one));
      // Every pass through the loop is logged, up to the last echo before 1 s.
      const expected: number[] = [];
      for (let t = 0.125; t < 1; t += time) expected.push(t);
      expect(one.filter((e) => e.node === 'a').map((e) => e.time)).toEqual(expected);
    }
  });

  it('delays events outside a cycle, across query windows', () => {
    const p = patch([node('s', 'source', { at: 0.1 }), node('d', 'delay', { time: 0.3 }), node('p', 'pass')], [cable('s', 'd'), cable('d', 'p')]);
    expect(new Runtime(compile(p)).query(0, 1).filter((e) => e.node === 'p').map((e) => e.time)).toEqual([0.1 + 0.3]);
    expect(tiled(new Runtime(compile(p)), 1, 0.025).filter((e) => e.node === 'p').map((e) => e.time)).toEqual([0.1 + 0.3]);
    // An input in the last chunk of one query reaches the delay node in the next query.
    const runtime = new Runtime(compile(p));
    expect(runtime.query(0, 0.11)).toHaveLength(1);
    // An empty window passes the held inputs on without losing them.
    expect(runtime.query(0.11, 0.11)).toEqual([]);
    expect(runtime.query(0.11, 0.5).map((e) => [e.node, e.time])).toEqual([['d', 0.1 + 0.3], ['p', 0.1 + 0.3]]);
  });
});
