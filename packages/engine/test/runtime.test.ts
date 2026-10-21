import { describe, expect, it } from 'vitest';
import { compilePatch, Runtime, type NodeDefinition, type Patch } from '../src';

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
const definitions = new Map([source, pass, note, sink].map((d) => [d.type, d]));

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
    const state = (runtime as unknown as { states: Map<string, { seen?: number[] }> }).states.get('v');
    expect(state?.seen).toEqual([0.03]);
  });

  it('clamps params to their ranges', () => {
    const plan = compile(patch([node('s', 'source', { at: 99 })], []));
    expect(plan.order[0]!.params.at).toBe(10);
  });
});
