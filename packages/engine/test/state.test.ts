import { describe, expect, it } from 'vitest';
import { clonePlain, restoreState, StateCloneError } from '../src';

describe('clonePlain', () => {
  it('deep-copies plain data', () => {
    const state = { count: 3, name: 'a', on: true, none: null, gone: undefined, list: [1, [2, { x: 3 }]], held: { 0: 0.5 }, buf: new Float32Array([1, 2]) };
    const copy = clonePlain(state);
    expect(copy).toEqual(state);
    (copy.list[1] as [number, { x: number }])[1].x = 9;
    copy.buf[0] = 7;
    expect(state.list).toEqual([1, [2, { x: 3 }]]);
    expect(state.buf[0]).toBe(1);
    expect(clonePlain(Object.assign(Object.create(null) as object, { a: 1 }))).toEqual({ a: 1 });
  });

  it('copies shared subtrees as separate copies', () => {
    const shared = { n: 1 };
    const copy = clonePlain({ a: shared, b: shared });
    copy.a.n = 2;
    expect(copy.b.n).toBe(1);
  });

  it('rejects what a snapshot cannot copy, naming the path', () => {
    class Voice {}
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => clonePlain({ voices: [new Voice()] }, 'node "s" state')).toThrow(new StateCloneError('node "s" state.voices[0] is a Voice; node state must be plain data'));
    expect(() => clonePlain({ f: () => 1 })).toThrow(/state\.f is a function/);
    expect(() => clonePlain({ m: new Map() })).toThrow(/state\.m is a Map/);
    expect(() => clonePlain(cyclic)).toThrow(/state\.self refers back to itself/);
  });
});

describe('restoreState', () => {
  it('replaces the contents in place, from a copy', () => {
    const state: Record<string, unknown> = { a: 1, b: [1] };
    const snapshot = { b: [2], c: 'x' };
    restoreState(state, snapshot);
    expect(state).toEqual({ b: [2], c: 'x' });
    (state.b as number[]).push(3);
    expect(snapshot.b).toEqual([2]);
  });
});
