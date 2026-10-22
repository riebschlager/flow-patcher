import { describe, expect, it } from 'vitest';
import { applyPatchEdits, invertPatchEdits, PATCH_FORMAT, PATCH_VERSION, serializePatch, type Patch, type PatchCable, type PatchEdit, type PatchNode } from '../src';

const node = (id: string, params: PatchNode['params'] = {}, extra: Partial<PatchNode> = {}): PatchNode =>
  ({ id, type: 't', typeVersion: 1, params, position: { x: id.length, y: 2 }, ...extra });
const cable = (from: string, to: string, depth?: number): PatchCable =>
  ({ from: { node: from, port: 'out' }, to: { node: to, port: 'in' }, ...(depth === undefined ? {} : { depth }) });

/** a → b → c, b → d, a → c's rate (with depth), d → b: cables into and out of b on both sides of others. */
const base = (): Patch => ({
  format: PATCH_FORMAT,
  version: PATCH_VERSION,
  seed: 7,
  nodes: [node('a', { rate: 2 }), node('b', { mode: 'up', on: true }, { pinned: ['mode'] }), node('c'), node('d', { x: 1 })],
  cables: [cable('a', 'b'), cable('a', 'c', 0.5), cable('b', 'c'), cable('c', 'd'), cable('b', 'd'), cable('d', 'b', -1)],
});

/** apply → invert → apply gives back the document byte for byte, and inverting the inverse redoes the edits. */
function roundTrips(edits: PatchEdit[], patch = base()): Patch {
  const before = serializePatch(patch);
  const after = applyPatchEdits(patch, edits);
  const undo = invertPatchEdits(patch, edits);
  const undone = applyPatchEdits(after, undo);
  expect(serializePatch(undone)).toBe(before);
  expect(undone).toEqual(patch);
  const redo = invertPatchEdits(after, undo);
  expect(serializePatch(applyPatchEdits(undone, redo))).toBe(serializePatch(after));
  expect(serializePatch(patch)).toBe(before); // left alone
  return after;
}

describe('applyPatchEdits', () => {
  it('inserts nodes and cables at an index, or appends them', () => {
    const p = applyPatchEdits(base(), [
      { op: 'add-node', node: node('e'), index: 1 },
      { op: 'add-node', node: node('f') },
      { op: 'add-node', node: node('g'), index: 0 },
      { op: 'add-cable', cable: cable('e', 'f'), index: 2 },
      { op: 'add-cable', cable: cable('f', 'g'), index: 7 },
    ]);
    expect(p.nodes.map((n) => n.id)).toEqual(['g', 'a', 'e', 'b', 'c', 'd', 'f']);
    expect(p.cables[2]).toEqual(cable('e', 'f'));
    expect(p.cables[7]).toEqual(cable('f', 'g'));
  });

  it('rejects an index outside the list', () => {
    for (const index of [-1, 5, 1.5, NaN]) {
      expect(() => applyPatchEdits(base(), [{ op: 'add-node', node: node('e'), index }])).toThrow(RangeError);
    }
    expect(() => applyPatchEdits(base(), [{ op: 'add-cable', cable: cable('a', 'd'), index: 7 }])).toThrow(/index 7 is outside 0..6/);
    expect(() => applyPatchEdits(base(), [{ op: 'remove-cable', from: cable('a', 'b').from, to: cable('a', 'b').to, index: 1 }])).toThrow(/at index 1/);
  });

  it('moves a node and unsets a param', () => {
    const p = applyPatchEdits(base(), [
      { op: 'move-node', node: 'c', position: { x: -4, y: 9.5 } },
      { op: 'unset-param', node: 'b', param: 'mode' },
      { op: 'unset-param', node: 'b', param: 'absent' },
    ]);
    expect(p.nodes[2]!.position).toEqual({ x: -4, y: 9.5 });
    expect(p.nodes[1]!.params).toEqual({ on: true });
    expect(() => applyPatchEdits(base(), [{ op: 'move-node', node: 'z', position: { x: 0, y: 0 } }])).toThrow(/no node "z"/);
  });

  it('removes the cable at an index when duplicates share its ends', () => {
    const p = applyPatchEdits(base(), [{ op: 'add-cable', cable: cable('a', 'b', 3) }, { op: 'remove-cable', from: cable('a', 'b').from, to: cable('a', 'b').to, index: 0 }]);
    expect(p.cables.filter((c) => c.from.node === 'a' && c.to.node === 'b')).toEqual([cable('a', 'b', 3)]);
  });
});

describe('invertPatchEdits', () => {
  it('set-param: restores the old value, or removes a key that was absent', () => {
    roundTrips([{ op: 'set-param', node: 'a', param: 'rate', value: 9 }]);
    const after = roundTrips([{ op: 'set-param', node: 'c', param: 'new', value: 'x' }]);
    expect(after.nodes[2]!.params).toEqual({ new: 'x' });
    expect(invertPatchEdits(base(), [{ op: 'set-param', node: 'c', param: 'new', value: 'x' }])).toEqual([{ op: 'unset-param', node: 'c', param: 'new' }]);
  });

  it('unset-param: restores the key, and an absent key needs no undo', () => {
    roundTrips([{ op: 'unset-param', node: 'b', param: 'mode' }]);
    expect(invertPatchEdits(base(), [{ op: 'unset-param', node: 'c', param: 'absent' }])).toEqual([]);
    roundTrips([{ op: 'unset-param', node: 'c', param: 'absent' }]);
  });

  it('add-node and move-node', () => {
    roundTrips([{ op: 'add-node', node: node('e', { k: 1 }, { pinned: ['k'] }), index: 2 }]);
    roundTrips([{ op: 'add-node', node: node('e') }]);
    roundTrips([{ op: 'move-node', node: 'd', position: { x: 100, y: -3 } }]);
  });

  it('add-node over cables that already named its id puts them back on undo', () => {
    const dangling = { ...base(), cables: [...base().cables.slice(0, 2), cable('e', 'a'), ...base().cables.slice(2)] };
    roundTrips([{ op: 'add-node', node: node('e'), index: 0 }], dangling);
  });

  it('remove-node: re-adds the node and its cables in and out at their old indices', () => {
    const after = roundTrips([{ op: 'remove-node', node: 'b' }]);
    expect(after.cables).toEqual([cable('a', 'c', 0.5), cable('c', 'd')]);
    expect(invertPatchEdits(base(), [{ op: 'remove-node', node: 'b' }])).toEqual([
      { op: 'add-node', node: base().nodes[1], index: 1 },
      { op: 'add-cable', cable: cable('a', 'b'), index: 0 },
      { op: 'add-cable', cable: cable('b', 'c'), index: 2 },
      { op: 'add-cable', cable: cable('b', 'd'), index: 4 },
      { op: 'add-cable', cable: cable('d', 'b', -1), index: 5 },
    ]);
    roundTrips([{ op: 'remove-node', node: 'a' }]);
    roundTrips([{ op: 'remove-node', node: 'd' }]);
  });

  it('remove-cable: re-adds a cable from the middle at its index, keeping its depth', () => {
    const after = roundTrips([{ op: 'remove-cable', from: cable('a', 'c').from, to: cable('a', 'c').to }]);
    expect(after.cables).toHaveLength(5);
    expect(invertPatchEdits(base(), [{ op: 'remove-cable', from: cable('a', 'c').from, to: cable('a', 'c').to }]))
      .toEqual([{ op: 'add-cable', cable: cable('a', 'c', 0.5), index: 1 }]);
  });

  it('add-cable: removes exactly the added cable, even beside a duplicate', () => {
    roundTrips([{ op: 'add-cable', cable: cable('a', 'b', 2), index: 3 }]);
    roundTrips([{ op: 'add-cable', cable: cable('a', 'c') }]);
  });

  it('mixed batches, each inverse computed against the document just before its edit', () => {
    roundTrips([
      { op: 'set-param', node: 'b', param: 'mode', value: 'down' },
      { op: 'set-param', node: 'b', param: 'mode', value: 'random' },
      { op: 'add-node', node: node('e'), index: 1 },
      { op: 'add-cable', cable: cable('e', 'b'), index: 1 },
      { op: 'add-cable', cable: cable('b', 'e', 0.25) },
      { op: 'remove-cable', from: cable('b', 'c').from, to: cable('b', 'c').to },
      { op: 'move-node', node: 'b', position: { x: 50, y: 60 } },
      { op: 'set-param', node: 'b', param: 'fresh', value: false },
      { op: 'remove-node', node: 'b' },
      { op: 'add-node', node: node('b', { other: 1 }), index: 0 },
      { op: 'add-cable', cable: cable('b', 'b'), index: 0 },
      { op: 'unset-param', node: 'a', param: 'rate' },
      { op: 'move-node', node: 'a', position: { x: 0, y: 0 } },
      { op: 'remove-node', node: 'e' },
    ]);
    roundTrips([]);
  });

  it('throws where applyPatchEdits would', () => {
    expect(() => invertPatchEdits(base(), [{ op: 'remove-node', node: 'z' }])).toThrow(/edit 0 \(remove-node\): no node "z"/);
    expect(() => invertPatchEdits(base(), [{ op: 'add-node', node: node('a') }])).toThrow(/already exists/);
  });
});
