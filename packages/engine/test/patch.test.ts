import { describe, expect, it } from 'vitest';
import { parsePatch, serializePatch } from '../src';

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
});
