// Param cables in the graph: handles that can't collide with ports, and the editor's connection rules for them.
import { describe, expect, it } from 'vitest';
import { applyPatchEdits, defaultParams, parsePatch, type Patch, type PortSpec } from '@flow-patcher/engine';
import { nodeRegistry } from '@flow-patcher/nodes';
import { readFileSync } from 'node:fs';
import { adaptersBetween, cableFor, handleParam, handlePort, loadErrors, matchingPort, paramHandle, patchToGraph } from '../src/patch-graph';
import { snapTo } from '../src/drag-edit';
import { formatParam, parseTyped } from '../src/param-format';

function example(name: string): Patch {
  const parsed = parsePatch(JSON.parse(readFileSync(new URL(`../../../examples/${name}.flowpatch`, import.meta.url), 'utf8')));
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  return parsed.patch;
}

describe('param handles', () => {
  it('round-trip a param name and are never a port name', () => {
    expect(handleParam(paramHandle('pitch'))).toBe('pitch');
    expect(handleParam('pitch')).toBeUndefined();
    expect(handleParam(null)).toBeUndefined();
    for (const definition of nodeRegistry.values()) for (const port of definition.ports) expect(handleParam(port.name)).toBeUndefined();
  });
});

describe('patchToGraph', () => {
  it('draws a cable into a param, ending on its handle, with the param and depth', () => {
    const { nodes, edges } = patchToGraph(example('pointer-notes'), nodeRegistry);
    const edge = edges.find((e) => e.id === 'pointer.y→note.pitch')!;
    expect(edge).toMatchObject({ targetHandle: 'param:pitch', data: { portType: 'signal', param: { name: 'pitch' }, cable: { depth: -24 } } });
    expect(nodes.find((n) => n.id === 'note')!.data.modulated).toEqual(['pitch']);
    expect(nodes.find((n) => n.id === 'synth')!.data.modulated).toEqual([]);
  });

  it('raises a selected cable above the nodes', () => {
    const { edges } = patchToGraph(example('pointer-notes'), nodeRegistry, new Set(['pointer.y→note.pitch']));
    expect(edges.find((e) => e.id === 'pointer.y→note.pitch')!.zIndex).toBeGreaterThan(1000);
    expect(edges.find((e) => e.id === 'note.note→synth.note')!.zIndex).toBeUndefined();
  });
});

describe('cableFor into a param', () => {
  const patch = example('pointer-notes');
  const into = (sourceHandle: string, targetHandle: string, target = 'note') => cableFor(patch, nodeRegistry, { source: 'pointer', sourceHandle, target, targetHandle });

  it('takes a Signal into a modulatable number param, named by the param', () => {
    expect(into('x', 'param:velocity')).toEqual({ from: { node: 'pointer', port: 'x' }, to: { node: 'note', port: 'velocity' } });
  });

  it('refuses a cable already there, an Event, an unknown param and one that can\'t be modulated', () => {
    expect(into('y', 'param:pitch')).toBeNull();
    expect(into('down', 'param:velocity')).toBeNull();
    expect(into('x', 'param:nope')).toBeNull();
    // Output level is marked modulatable: false.
    expect(into('x', 'param:level', 'out')).toBeNull();
  });

  it('names a param handle as a Signal input, so a cable dragged from it finds Signal sources', () => {
    expect(handlePort(patch, nodeRegistry, 'note', 'param:pitch', 'in')).toMatchObject({ name: 'param:pitch', type: 'signal', direction: 'in' });
    expect(handlePort(patch, nodeRegistry, 'note', 'param:pitch', 'out')).toBeUndefined();
  });
});

describe('palette for a dropped cable', () => {
  const end = (type: PortSpec['type'], direction: PortSpec['direction']) => ({ node: 'a', port: { name: 'p', type, direction } });
  const filter = nodeRegistry.get('filter')!;

  it('offers a node whose only Signal input is a knob, wired to its first knob', () => {
    expect(matchingPort(filter, end('signal', 'out'))).toMatchObject({ name: 'param:cutoff', type: 'signal', direction: 'in' });
    // An Audio port still comes before any knob.
    expect(matchingPort(filter, end('audio', 'out'))?.type).toBe('audio');
  });

  it('wires the knob it matched on the new node as a param cable', () => {
    const synth = nodeRegistry.get('simple-synth')!;
    const patch = applyPatchEdits(example('pointer-notes'), [{ op: 'add-node', node: { id: 'synth2', type: synth.type, typeVersion: synth.version, params: defaultParams(synth), position: { x: 0, y: 0 } } }]);
    const port = matchingPort(synth, { node: 'pointer', port: handlePort(patch, nodeRegistry, 'pointer', 'x', 'out')! })!;
    expect(cableFor(patch, nodeRegistry, { source: 'pointer', sourceHandle: 'x', target: 'synth2', targetHandle: port.name })).toEqual({ from: { node: 'pointer', port: 'x' }, to: { node: 'synth2', port: 'attack' } });
  });

  it('never offers a knob for an Event, or as a source for a dragged input', () => {
    expect(matchingPort(filter, end('event', 'out'))).toBeUndefined();
    expect(matchingPort(filter, end('signal', 'in'))).toBeUndefined();
  });
});

describe('number fields', () => {
  it('snap to the step or a thousandth of the range, within it', () => {
    expect(snapTo(63.6, 0, 127, 1)).toBe(64);
    expect(snapTo(0.30000000000000004, 0, 1)).toBe(0.3);
    expect(snapTo(-5, 0, 1)).toBe(0);
    expect(snapTo(400, -127, 127, 1)).toBe(127);
  });

  it('format with the unit and a typographic minus, and read typed text back', () => {
    const spec = { name: 'pitch', kind: 'number', min: 0, max: 127, default: 60, step: 1, unit: 'MIDI' } as const;
    expect(formatParam(spec, 76)).toBe('76 MIDI');
    expect(formatParam(spec, -24)).toBe('−24 MIDI');
    expect(formatParam({ name: 'v', kind: 'number', min: 0, max: 1, default: 0 }, 0.8)).toBe('0.800');
    expect(parseTyped('−12 MIDI')).toBe(-12);
    expect(parseTyped('abc')).toBeNaN();
  });
});

describe('adapter offer', () => {
  const port = (type: PortSpec['type'], direction: PortSpec['direction']): PortSpec => ({ name: 'p', type, direction });
  const names = (from: PortSpec, to: PortSpec) => adaptersBetween(nodeRegistry, from, to).map((o) => [o.definition.type, o.input.name, o.output.name]);

  it('offers the adapter that converts one type into the other, in each direction', () => {
    expect(names(port('event', 'out'), port('signal', 'in'))).toEqual([['sample-and-hold', 'trigger', 'out']]);
    // A Note is an Event, so it takes the same adapter.
    expect(names(port('note', 'out'), port('signal', 'in'))).toEqual([['sample-and-hold', 'trigger', 'out']]);
    expect(names(port('signal', 'out'), port('event', 'in'))).toEqual([['threshold-change', 'in', 'out']]);
  });

  it('offers nothing when the types connect already, or nothing converts them', () => {
    expect(names(port('event', 'out'), port('event', 'in'))).toEqual([]);
    expect(names(port('value', 'out'), port('signal', 'in'))).toEqual([]);
    expect(names(port('audio', 'out'), port('event', 'in'))).toEqual([]);
  });
});

describe('opening a file', () => {
  it('opens a loop with no delay edge, so its nodes can show it, but refuses what else would not compile', () => {
    const loop = example('clock-blips');
    loop.cables.push({ from: { node: 'maybe', port: 'out' }, to: { node: 'maybe', port: 'in' } });
    expect(loadErrors(loop, nodeRegistry)).toEqual([]);
    const unknown = example('clock-blips');
    unknown.nodes[0] = { ...unknown.nodes[0]!, type: 'no-such-node' };
    expect(loadErrors(unknown, nodeRegistry)[0]).toBe('node "clock": unknown type "no-such-node"');
  });
});

describe('unwired hints', () => {
  it("shows an input's hint while no cable comes in", () => {
    const doc = example('chord-progression');
    const hints = (p: Patch) => patchToGraph(p, nodeRegistry).nodes.find((n) => n.id === 'prog')!.data.hints;
    expect(hints(doc)).toEqual([]);
    const unwired = { ...doc, cables: doc.cables.filter((c) => !(c.to.node === 'prog' && c.to.port === 'transport')) };
    expect(hints(unwired)).toEqual(['No transport: holding the first chord']);
  });

  it('says a hint shared by several unwired inputs once', () => {
    const hints = patchToGraph(example('orbit-rings'), nodeRegistry).nodes.find((n) => n.id === 'rings')!.data.hints;
    expect(hints.filter((h) => h === 'Rings in the middle (0.5).')).toHaveLength(1);
  });
});
