import { describe, expect, it } from 'vitest';
import { compilePatch, type EngineEvent, type NodeDefinition, type Patch } from '../src';

// Minimal definitions so engine tests don't depend on packages/nodes.
const source: NodeDefinition = {
  type: 'source', version: 1, label: 'Source', category: 'control-logic', description: '',
  ports: [{ name: 'out', type: 'event', direction: 'out' }],
  params: [],
  query: () => ({}),
};
const pass: NodeDefinition = {
  type: 'pass', version: 1, label: 'Pass', category: 'control-logic', description: '',
  ports: [{ name: 'in', type: 'event', direction: 'in' }, { name: 'out', type: 'event', direction: 'out' }],
  params: [],
  query: ({ inputs }) => ({ out: [...(inputs.in ?? [])] }),
};
/** Shifts events by params.time; the runtime hands it the previous window's inputs. */
const delay: NodeDefinition = {
  type: 'delay', version: 1, label: 'Delay', category: 'control-logic', description: '',
  ports: [{ name: 'in', type: 'event', direction: 'in' }, { name: 'out', type: 'event', direction: 'out' }],
  params: [{ name: 'time', kind: 'number', min: 0, max: 2, default: 0.025, modulatable: false }],
  delay: (params) => params.time as number,
  query: ({ inputs, params, state, t1 }) => {
    const pending = [...((state.pending as EngineEvent[] | undefined) ?? []), ...(inputs.in ?? []).map((e) => ({ ...e, time: e.time + (params.time as number) }))];
    state.pending = pending.filter((e) => e.time >= t1);
    return { out: pending.filter((e) => e.time < t1) };
  },
};
/** A fluid: Write fields in, the fluid out, plus a Signal input. */
const fluid: NodeDefinition = {
  type: 'fluid', version: 1, label: 'Fluid', category: 'visual', description: '',
  unique: true,
  ports: [
    { name: 'writers', type: 'field', fieldKind: 'write', direction: 'in' },
    { name: 'force', type: 'signal', direction: 'in' },
    { name: 'fluid', type: 'field', direction: 'out' },
  ],
  params: [],
};
/** Reads the fluid and outputs a Signal: a Field → Signal read. */
const probe: NodeDefinition = {
  type: 'probe', version: 1, label: 'Probe', category: 'visual', description: '',
  ports: [{ name: 'fluid', type: 'field', direction: 'in' }, { name: 'level', type: 'signal', direction: 'out' }],
  params: [],
};
/** Writes into the fluid. */
const writer: NodeDefinition = {
  type: 'writer', version: 1, label: 'Writer', category: 'visual', description: '',
  ports: [{ name: 'fluid', type: 'field', direction: 'in' }, { name: 'write', type: 'field', fieldKind: 'write', direction: 'out' }],
  params: [],
};
const definitions = new Map([source, pass, delay, fluid, probe, writer].map((d) => [d.type, d]));

const node = (id: string, type: string, params = {}) => ({ id, type, typeVersion: 1, params, position: { x: 0, y: 0 } });
const cable = (a: string, b: string, from = 'out', to = 'in') => ({ from: { node: a, port: from }, to: { node: b, port: to } });
const patch = (nodes: Patch['nodes'], cables: Patch['cables']): Patch => ({ format: 'flowpatch', version: 1, seed: 1, nodes, cables });

function compile(p: Patch) {
  const result = compilePatch(p, definitions);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.plan;
}
function failure(p: Patch) {
  const result = compilePatch(p, definitions);
  if (result.ok) throw new Error('expected a compile error');
  return result;
}

describe('graph compiler: cycles', () => {
  it('rejects a two-node cycle without a delay edge, naming its nodes and cables', () => {
    const result = failure(patch([node('s', 'source'), node('a', 'pass'), node('b', 'pass')], [cable('s', 'a'), cable('a', 'b'), cable('b', 'a')]));
    expect(result.errors).toEqual(['cycle without a delay edge through: a → b → a']);
    expect(result.cycles).toEqual([{ nodes: ['a', 'b'], cables: [1, 2] }]);
  });

  it('rejects a self-loop', () => {
    const result = failure(patch([node('a', 'pass')], [cable('a', 'a')]));
    expect(result.errors).toEqual(['cycle without a delay edge through: a → a']);
    expect(result.cycles).toEqual([{ nodes: ['a'], cables: [0] }]);
  });

  it('reports each separate cycle, and not the nodes downstream of them', () => {
    const result = failure(patch(
      [node('a', 'pass'), node('b', 'pass'), node('c', 'pass'), node('d', 'pass'), node('e', 'pass'), node('after', 'pass')],
      [cable('c', 'd'), cable('a', 'b'), cable('d', 'e'), cable('b', 'a'), cable('e', 'c'), cable('b', 'after')],
    ));
    expect(result.cycles).toEqual([
      { nodes: ['a', 'b'], cables: [1, 3] },
      { nodes: ['c', 'd', 'e'], cables: [0, 2, 4] },
    ]);
    expect(result.errors).toEqual([
      'cycle without a delay edge through: a → b → a',
      'cycle without a delay edge through: c → d → e → c',
    ]);
  });

  it('extracts one simple cycle from a component with several', () => {
    // a → b → a and a → b → c → a share nodes: one component, one reported cycle.
    const result = failure(patch([node('a', 'pass'), node('b', 'pass'), node('c', 'pass')], [cable('a', 'b'), cable('b', 'c'), cable('c', 'a'), cable('b', 'a')]));
    expect(result.cycles).toHaveLength(1);
    const [cycle] = result.cycles!;
    expect(cycle!.nodes[0]).toBe('a');
    expect(new Set(cycle!.nodes).size).toBe(cycle!.nodes.length);
    expect(cycle!.cables).toHaveLength(cycle!.nodes.length);
  });

  it('compiles the same cycle through a delay node and marks the delay edge', () => {
    const plan = compile(patch([node('a', 'pass'), node('d', 'delay'), node('b', 'pass')], [cable('a', 'd'), cable('d', 'b'), cable('b', 'a')]));
    expect(plan.delayEdges).toEqual([0]);
    expect(plan.incoming.get('d')!.events[0]!.delay).toBe(true);
    expect(plan.incoming.get('b')!.events[0]!.delay).toBeUndefined();
    // The delay node runs first: its cables in don't order it.
    expect(plan.order.map((n) => n.id)).toEqual(['d', 'b', 'a']);
  });

  it('closes a cycle with a Field → Signal read', () => {
    const plan = compile(patch([node('f', 'fluid'), node('p', 'probe')], [cable('f', 'p', 'fluid', 'fluid'), cable('p', 'f', 'level', 'force')]));
    expect(plan.delayEdges).toEqual([0]);
    expect(plan.incoming.get('p')!.fields[0]!.delay).toBe(true);
    expect(plan.order.map((n) => n.id)).toEqual(['p', 'f']);
  });

  it('still orders Field Write → Writers cables, and rejects a cycle through them alone', () => {
    const plan = compile(patch([node('f', 'fluid'), node('w', 'writer')], [cable('w', 'f', 'write', 'writers')]));
    expect(plan.delayEdges).toEqual([]);
    expect(plan.order.map((n) => n.id)).toEqual(['w', 'f']);
    const result = failure(patch([node('f', 'fluid'), node('w', 'writer')], [cable('w', 'f', 'write', 'writers'), cable('f', 'w', 'fluid', 'fluid')]));
    expect(result.cycles).toEqual([{ nodes: ['f', 'w'], cables: [1, 0] }]);
  });

  it('still orders Signal cables into a delay node: they are sampled lazily', () => {
    const level: NodeDefinition = { ...probe, type: 'level', ports: [{ name: 'in', type: 'event', direction: 'in' }, { name: 'level', type: 'signal', direction: 'out' }] };
    const gated: NodeDefinition = { ...delay, type: 'gated', ports: [...delay.ports, { name: 'gate', type: 'signal', direction: 'in' }] };
    const result = compilePatch(
      patch([node('g', 'gated'), node('l', 'level')], [cable('l', 'g', 'level', 'gate'), cable('g', 'l')]),
      new Map([...definitions, ['level', level], ['gated', gated]]),
    );
    expect(result.ok ? undefined : result.cycles).toEqual([{ nodes: ['g', 'l'], cables: [1, 0] }]);
  });

  it("doesn't force a delay node after its inputs", () => {
    const plan = compile(patch([node('d', 'delay'), node('s', 'source')], [cable('s', 'd')]));
    expect(plan.order.map((n) => n.id)).toEqual(['d', 's']);
  });
});

describe('graph compiler: window limit', () => {
  it('is Infinity without delay nodes', () => {
    expect(compile(patch([node('s', 'source'), node('a', 'pass')], [cable('s', 'a')])).maxWindow).toBe(Infinity);
  });

  it('is the shortest delay among wired delay nodes', () => {
    const nodes = [node('s', 'source'), node('d1', 'delay', { time: 0.3 }), node('d2', 'delay', { time: 0.05 }), node('d3', 'delay')];
    expect(compile(patch(nodes, [cable('s', 'd1'), cable('s', 'd2'), cable('s', 'd3')])).maxWindow).toBe(0.025);
    expect(compile(patch(nodes, [cable('s', 'd1'), cable('s', 'd2')])).maxWindow).toBe(0.05);
    expect(compile(patch(nodes, [])).maxWindow).toBe(Infinity);
  });

  it('treats a Note cable into a delay node as a delay edge', () => {
    const notes: NodeDefinition = {
      ...pass, type: 'notes',
      ports: [{ name: 'in', type: 'event', direction: 'in' }, { name: 'out', type: 'note', direction: 'out' }],
    };
    const result = compilePatch(patch([node('n', 'notes'), node('d', 'delay')], [cable('n', 'd'), cable('d', 'n')]), new Map([...definitions, ['notes', notes]]));
    expect(result.ok && result.plan.delayEdges).toEqual([0]);
  });

  it('rejects a delay that is zero or not a number', () => {
    expect(failure(patch([node('d', 'delay', { time: 0 })], [])).errors[0]).toMatch(/node "d": delay must be a positive number/);
    const nan: NodeDefinition = { ...delay, type: 'nan', delay: () => NaN };
    const result = compilePatch(patch([node('n', 'nan')], []), new Map([...definitions, ['nan', nan]]));
    expect(result.ok ? [] : result.errors).toEqual(['node "n": delay must be a positive number of seconds, got NaN']);
  });
});

describe('graph compiler: one per patch', () => {
  it('rejects a second node of a unique type, naming both', () => {
    const result = failure(patch([node('f1', 'fluid'), node('w', 'writer'), node('f2', 'fluid'), node('f3', 'fluid')], [cable('w', 'f2', 'write', 'writers')]));
    expect(result.errors).toEqual([
      'node "f2": only one Fluid per patch ("f1" is one already)',
      'node "f3": only one Fluid per patch ("f1" is one already)',
    ]);
  });

  it('allows one, and any number of nodes of types that are not unique', () => {
    expect(compile(patch([node('f', 'fluid'), node('p1', 'probe'), node('p2', 'probe')], [])).order).toHaveLength(3);
  });
});
