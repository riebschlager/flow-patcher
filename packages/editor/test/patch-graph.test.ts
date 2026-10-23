// Param cables in the graph: handles that can't collide with ports, and the editor's connection rules for them.
import { describe, expect, it } from 'vitest';
import { parsePatch, type Patch } from '@flow-patcher/engine';
import { nodeRegistry } from '@flow-patcher/nodes';
import { readFileSync } from 'node:fs';
import { cableFor, handleParam, handlePort, paramHandle, patchToGraph } from '../src/patch-graph';
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
