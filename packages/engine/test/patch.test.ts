import { describe, expect, it } from 'vitest';
import { parsePatch, PATCH_FORMAT, PATCH_VERSION, serializePatch, type Patch } from '../src';

const valid = {
  format: 'flowpatch',
  version: 1,
  seed: 3,
  nodes: [{ id: 'a', type: 'clock', typeVersion: 1, params: { bpm: 100 }, position: { x: 0, y: 0 } }],
  cables: [{ from: { node: 'a', port: 'tick' }, to: { node: 'a', port: 'in' }, depth: 0.5 }],
};

describe('patch format', () => {
  it('parses a valid patch', () => {
    const result = parsePatch(valid);
    expect(result.ok).toBe(true);
  });

  it('reports every structural problem', () => {
    const result = parsePatch({ ...valid, format: 'flow', seed: 1.5, nodes: [{ id: 'a' }, { id: 'a', type: 'x', typeVersion: 1, params: { p: {} }, position: { x: 0, y: 0 } }] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('format'))).toBe(true);
      expect(result.errors.some((e) => e.startsWith('seed'))).toBe(true);
    }
    const nodes = parsePatch({ ...valid, nodes: [{ id: 'a' }, { id: 'a', type: 'x', typeVersion: 1, params: { p: {} }, position: { x: 0, y: 0 } }] });
    expect(nodes.ok ? [] : nodes.errors).toEqual(expect.arrayContaining([expect.stringContaining('duplicate id'), expect.stringContaining('params')]));
  });

  it('rejects non-objects', () => {
    for (const input of [null, 3, 'x', []]) expect(parsePatch(input).ok).toBe(false);
  });

  it('serializes canonically: key order does not matter, save → load → save is stable', () => {
    const shuffled = { cables: valid.cables, nodes: [{ position: { y: 0, x: 0 }, params: { z: 1, bpm: 100 }, typeVersion: 1, type: 'clock', id: 'a' }], seed: 3, version: 1, format: 'flowpatch' };
    const parsed = parsePatch(shuffled);
    if (!parsed.ok) throw new Error(parsed.errors.join());
    const once = serializePatch(parsed.patch);
    const again = parsePatch(JSON.parse(once));
    if (!again.ok) throw new Error(again.errors.join());
    expect(serializePatch(again.patch)).toBe(once);
    expect(once.indexOf('"bpm"')).toBeLessThan(once.indexOf('"z"'));
  });

  it('drops unknown top-level and node fields', () => {
    const parsed = parsePatch({ ...valid, extra: true, nodes: [{ ...valid.nodes[0], code: 'alert(1)' }] });
    if (!parsed.ok) throw new Error(parsed.errors.join());
    expect(serializePatch(parsed.patch)).not.toMatch(/extra|alert/);
  });

  it('always writes the format, the version and every node\'s type version', () => {
    const parsed = parsePatch(valid);
    if (!parsed.ok) throw new Error(parsed.errors.join());
    const saved = JSON.parse(serializePatch(parsed.patch));
    expect(Object.keys(saved).slice(0, 3)).toEqual(['format', 'version', 'seed']);
    expect([saved.format, saved.version]).toEqual([PATCH_FORMAT, PATCH_VERSION]);
    expect(Object.keys(saved.nodes[0]).slice(0, 3)).toEqual(['id', 'type', 'typeVersion']);
    const missing = { ...parsed.patch, nodes: [{ ...parsed.patch.nodes[0]!, typeVersion: undefined as unknown as number }] };
    expect(() => serializePatch(missing)).toThrow(/node "a" has no integer typeVersion/);
  });

  it('refuses numbers JSON cannot hold, rather than saving a patch that will not load', () => {
    const parsed = parsePatch(valid);
    if (!parsed.ok) throw new Error(parsed.errors.join());
    const nan: Patch = { ...parsed.patch, nodes: [{ ...parsed.patch.nodes[0]!, position: { x: NaN, y: 0 } }] };
    expect(() => serializePatch(nan)).toThrow(/"x" is NaN/);
    const infinite: Patch = { ...parsed.patch, cables: [{ ...parsed.patch.cables[0]!, depth: Infinity }] };
    expect(() => serializePatch(infinite)).toThrow(/"depth" is Infinity/);
    expect(parsePatch({ ...valid, nodes: [{ ...valid.nodes[0], position: { x: null, y: 0 } }] }).ok).toBe(false);
  });

  it('keeps node, cable and pinned order, and sorts subpatch keys at every depth', () => {
    const input = {
      ...valid,
      nodes: [{ ...valid.nodes[0], id: 'z', pinned: ['bpm', 'division'] }, { ...valid.nodes[0], id: 'b', pinned: ['division', 'bpm'] }],
      subpatches: { y: { nodes: [{ b: 1, a: 2 }] }, x: { list: [3, 1, 2] } },
    };
    const parsed = parsePatch(input);
    if (!parsed.ok) throw new Error(parsed.errors.join());
    const once = serializePatch(parsed.patch);
    const saved = JSON.parse(once);
    expect(saved.nodes.map((n: { id: string; pinned: string[] }) => [n.id, n.pinned])).toEqual([['z', ['bpm', 'division']], ['b', ['division', 'bpm']]]);
    expect(Object.keys(saved.subpatches)).toEqual(['x', 'y']);
    expect(Object.keys(saved.subpatches.y.nodes[0])).toEqual(['a', 'b']);
    expect(saved.subpatches.x.list).toEqual([3, 1, 2]);
    const again = parsePatch(saved);
    if (!again.ok) throw new Error(again.errors.join());
    expect(serializePatch(again.patch)).toBe(once);
  });
});
