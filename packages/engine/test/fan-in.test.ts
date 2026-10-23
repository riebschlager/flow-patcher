// Fan-in rules (design.md, Core concepts) through the bootstrap runtime.
import { describe, expect, it } from 'vitest';
import { compilePatch, Runtime, type AudioContextLike, type EngineEvent, type NodeDefinition, type Patch, type PatchCable } from '../src';

// Ticks every 1/8 s on one channel; membership is per tick, so windowing can't change them.
const metro: NodeDefinition = {
  type: 'metro', version: 1, label: 'Metro', category: 'time-rhythm', description: '',
  ports: [{ name: 'out', type: 'event', direction: 'out' }],
  params: [{ name: 'channel', kind: 'number', min: 0, max: 7, default: 0, step: 1 }],
  query: ({ t0, t1, params }) => ({
    out: Array.from({ length: 8 }, (_, k) => k / 8).filter((t) => t >= t0 && t < t1).map((time) => ({ time, channel: params.channel as number })),
  }),
};
// One event at `at`, labelled with its node id.
const once: NodeDefinition = {
  type: 'once', version: 1, label: 'Once', category: 'control-logic', description: '',
  ports: [{ name: 'out', type: 'event', direction: 'out' }],
  params: [{ name: 'at', kind: 'number', min: 0, max: 10, default: 0 }],
  query: ({ t0, t1, params, nodeId }) => {
    const at = params.at as number;
    return { out: at >= t0 && at < t1 ? [{ time: at, channel: 0, label: nodeId }] : [] };
  },
};
// A Signal per channel that steps at 0.5 s: level + 10 × channel, + 100 from 0.5 s on.
const lfo: NodeDefinition = {
  type: 'lfo', version: 1, label: 'LFO', category: 'control-logic', description: '',
  ports: [{ name: 'out', type: 'signal', direction: 'out' }],
  params: [{ name: 'level', kind: 'number', min: -10, max: 10, default: 1 }],
  signal: (ctx, _port, t, channel) => (ctx.params.level as number) + 10 * channel + (t >= 0.5 ? 100 : 0),
};
const broken: NodeDefinition = {
  type: 'broken', version: 1, label: 'Broken', category: 'control-logic', description: '',
  ports: [{ name: 'out', type: 'signal', direction: 'out' }],
  params: [],
  signal: () => NaN,
};
// A Value that changes when an event arrives: the label of the latest `set` at or before t.
const chooser: NodeDefinition = {
  type: 'chooser', version: 1, label: 'Chooser', category: 'control-logic', description: '',
  ports: [{ name: 'set', type: 'event', direction: 'in' }, { name: 'out', type: 'value', direction: 'out' }],
  params: [],
  query: ({ inputs, state }) => {
    const changes = ((state.changes as EngineEvent[] | undefined) ??= []);
    changes.push(...(inputs.set ?? []));
    return {};
  },
  value: (ctx, _port, t) => (ctx.state.changes as EngineEvent[] | undefined)?.filter((e) => e.time <= t).at(-1)?.label ?? 'none',
};
// Reports what it reads on every trigger.
const reader: NodeDefinition = {
  type: 'reader', version: 1, label: 'Reader', category: 'control-logic', description: '',
  ports: [
    { name: 'trig', type: 'event', direction: 'in' },
    { name: 'sig', type: 'signal', direction: 'in' },
    { name: 'chord', type: 'value', direction: 'in' },
    { name: 'out', type: 'event', direction: 'out' },
  ],
  params: [
    { name: 'knob', kind: 'number', min: 0, max: 260, default: 2 },
    { name: 'fixed', kind: 'number', min: 0, max: 1, default: 0, modulatable: false },
    { name: 'mode', kind: 'enum', options: ['a', 'b'], default: 'a' },
  ],
  query: (ctx) => ({
    out: (ctx.inputs.trig ?? []).map((e) => ({
      time: e.time,
      channel: e.channel,
      sig: ctx.signal('sig', e.time, e.channel),
      knob: ctx.param('knob', e.time, e.channel),
      chord: String(ctx.value('chord', e.time)),
      wired: ['sig', 'chord', 'knob'].filter((p) => ctx.connected(p)).join(','),
    })),
  }),
  audio: ({ param, state }) => {
    state.knob = param('knob', 0, 1);
    return {};
  },
};
const writer: NodeDefinition = {
  type: 'writer', version: 1, label: 'Writer', category: 'visual', description: '',
  ports: [{ name: 'write', type: 'field', direction: 'out', fieldKind: 'write' }],
  params: [],
  field: (ctx) => ctx.state,
};
const pool: NodeDefinition = {
  type: 'pool', version: 1, label: 'Pool', category: 'visual', description: '',
  ports: [
    { name: 'writers', type: 'field', direction: 'in', fieldKind: 'write' },
    { name: 'field', type: 'field', direction: 'in' },
    { name: 'out', type: 'field', direction: 'out' },
  ],
  params: [],
  field: (ctx) => ctx.state,
  frame: (ctx) => {
    ctx.state.writers = ctx.fields('writers');
    ctx.state.fields = ctx.fields('field');
  },
};
const definitions = new Map([metro, once, lfo, broken, chooser, reader, writer, pool].map((d) => [d.type, d]));

const node = (id: string, type: string, params = {}) => ({ id, type, typeVersion: 1, params, position: { x: 0, y: 0 } });
const cable = (a: string, from: string, b: string, to: string, depth?: number): PatchCable =>
  ({ from: { node: a, port: from }, to: { node: b, port: to }, ...(depth === undefined ? {} : { depth }) });
const patch = (nodes: Patch['nodes'], cables: Patch['cables']): Patch => ({ format: 'flowpatch', version: 1, seed: 1, nodes, cables });

function runtime(p: Patch) {
  const result = compilePatch(p, definitions);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return new Runtime(result.plan);
}
const errors = (p: Patch) => {
  const result = compilePatch(p, definitions);
  return result.ok ? [] : result.errors;
};

/** Runs [0, 1) in windows of `step` and returns one node's events. */
function run(p: Patch, step: number, id = 'r') {
  const rt = runtime(p);
  const log = [];
  for (let i = 0; i * step < 1 - 1e-9; i++) log.push(...rt.query(i * step, Math.min(1, (i + 1) * step)));
  return log.filter((e) => e.node === id);
}

const twoChannels = [node('m0', 'metro'), node('m1', 'metro', { channel: 1 }), node('r', 'reader')];
const intoReader = [cable('m1', 'out', 'r', 'trig'), cable('m0', 'out', 'r', 'trig')];

describe('fan-in', () => {
  it('merges Event cables in time order, then by channel', () => {
    // Sources listed (and cabled) against time order, so only the merge can sort them.
    const p = patch([...twoChannels, node('late', 'once', { at: 0.3 }), node('early', 'once', { at: 0.0625 })], [
      cable('late', 'out', 'r', 'trig'), ...intoReader, cable('early', 'out', 'r', 'trig'),
    ]);
    const expected = [...Array.from({ length: 8 }, (_, k) => [[k / 8, 0], [k / 8, 1]]).flat(), [0.3, 0], [0.0625, 0]]
      .sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!);
    for (const step of [0.025, 1]) expect(run(p, step).map((e) => [e.time, e.channel]), `${step} s windows`).toEqual(expected);
  });

  it('sums Signal cables per channel, counting a non-finite cable as 0', () => {
    const p = patch([...twoChannels, node('a', 'lfo', { level: 1 }), node('b', 'lfo', { level: 2 }), node('x', 'broken')], [
      ...intoReader, cable('a', 'out', 'r', 'sig'), cable('b', 'out', 'r', 'sig'), cable('x', 'out', 'r', 'sig'),
    ]);
    const log = run(p, 0.025);
    // Sampled at each event's time: (1 + 2) + 20 × channel, + 200 from 0.5 s on.
    expect(log.filter((e) => e.channel === 0).map((e) => e.sig)).toEqual([3, 3, 3, 3, 203, 203, 203, 203]);
    expect(log.filter((e) => e.channel === 1).map((e) => e.sig)).toEqual([23, 23, 23, 23, 223, 223, 223, 223]);
    expect(run(p, 1)).toEqual(log);
  });

  it('adds depth × cable to a param\'s base, depth 1 by default, clamped to the knob\'s range', () => {
    const p = patch([...twoChannels, node('a', 'lfo', { level: 1 }), node('b', 'lfo', { level: 2 }), node('c', 'lfo', { level: -1 })], [
      ...intoReader, cable('a', 'out', 'r', 'knob', 2), cable('b', 'out', 'r', 'knob', -0.5), cable('c', 'out', 'r', 'knob'),
    ]);
    const log = run(p, 0.025);
    // Before 0.5 s, channel 0: 2 + 2×1 − 0.5×2 − 1 = 2; channel 1: 2 + 2×11 − 0.5×12 + 9 = 27.
    // From 0.5 s each cable is 100 higher, adding (2 − 0.5 + 1) × 100: 252, and 277 clamped to 260.
    expect(log.filter((e) => e.channel === 0).map((e) => e.knob)).toEqual([2, 2, 2, 2, 252, 252, 252, 252]);
    expect(log.filter((e) => e.channel === 1).map((e) => e.knob)).toEqual([27, 27, 27, 27, 260, 260, 260, 260]);
    expect(run(p, 1)).toEqual(log);
  });

  it('gives unconnected inputs their defaults: Signal 0, Value undefined, param at its base', () => {
    const [first] = run(patch(twoChannels, intoReader), 1);
    expect(first).toMatchObject({ sig: 0, chord: 'undefined', knob: 2, wired: '' });
  });

  it('reads a Value at each event\'s time, the same in 25 ms windows and in one window', () => {
    const p = patch([node('m', 'metro'), node('c0', 'once', { at: 0 }), node('g5', 'once', { at: 0.5 }), node('r', 'reader'), node('ch', 'chooser')], [
      cable('m', 'out', 'r', 'trig'), cable('c0', 'out', 'ch', 'set'), cable('g5', 'out', 'ch', 'set'), cable('ch', 'out', 'r', 'chord'),
    ]);
    const windowed = run(p, 0.025);
    expect(windowed.map((e) => e.chord)).toEqual(['c0', 'c0', 'c0', 'c0', 'g5', 'g5', 'g5', 'g5']);
    expect(windowed.every((e) => e.wired === 'chord')).toBe(true);
    expect(run(p, 1)).toEqual(windowed);
  });

  it('hands Field objects to frame() by reference, one per cable', () => {
    const rt = runtime(patch([node('w1', 'writer'), node('w2', 'writer'), node('src', 'pool'), node('p', 'pool')], [
      cable('w1', 'write', 'p', 'writers'), cable('w2', 'write', 'p', 'writers'), cable('src', 'out', 'p', 'field'),
    ]));
    rt.frame(0, 1 / 60, 1 / 60);
    const states = { get: (id: string) => rt.stateOf(id) };
    expect(states.get('p')!.writers).toEqual([states.get('w1'), states.get('w2')]);
    expect((states.get('p')!.writers as unknown[])[0]).toBe(states.get('w1'));
    expect((states.get('p')!.fields as unknown[])[0]).toBe(states.get('src'));
  });

  it('gives audio setup the modulated param', () => {
    const rt = runtime(patch([node('a', 'lfo', { level: 1 }), node('r', 'reader')], [cable('a', 'out', 'r', 'knob', 0.5)]));
    rt.attachAudio({} as AudioContextLike);
    // Channel 1: 2 + 0.5 × 11.
    expect(rt.stateOf('r')!.knob).toBe(7.5);
  });
});

describe('Runtime.paramAt', () => {
  it('reads a param as the node does: base + depth × cable, clamped, per channel', () => {
    // Base 2; the LFO is 1 + 10 × channel, + 100 from 0.5 s on.
    const rt = runtime(patch([node('a', 'lfo', { level: 1 }), node('r', 'reader')], [cable('a', 'out', 'r', 'knob', 2)]));
    expect(rt.paramAt('r', 'knob', 0)).toBe(4);
    expect(rt.paramAt('r', 'knob', 0, 1)).toBe(24);
    expect(rt.paramAt('r', 'knob', 0.5)).toBe(204);
    expect(rt.paramAt('r', 'knob', 0.5, 1)).toBe(224);
    const steep = runtime(patch([node('a', 'lfo', { level: 1 }), node('r', 'reader')], [cable('a', 'out', 'r', 'knob', 3)]));
    expect(steep.paramAt('r', 'knob', 0.5, 1)).toBe(260);
    const negative = runtime(patch([node('a', 'lfo', { level: 1 }), node('r', 'reader')], [cable('a', 'out', 'r', 'knob', -24)]));
    expect(negative.paramAt('r', 'knob', 0)).toBe(0);
  });

  it('gives the base without cables, and undefined for a non-number param or an unknown node', () => {
    const rt = runtime(patch([node('r', 'reader', { knob: 7 })], []));
    expect(rt.paramAt('r', 'knob', 3)).toBe(7);
    expect(rt.paramAt('r', 'mode', 0)).toBeUndefined();
    expect(rt.paramAt('r', 'nope', 0)).toBeUndefined();
    expect(rt.paramAt('missing', 'knob', 0)).toBeUndefined();
  });
});

describe('fan-in compile errors', () => {
  const base = [node('m', 'metro'), node('a', 'lfo'), node('r', 'reader'), node('ch', 'chooser'), node('ch2', 'chooser'), node('w', 'writer'), node('p', 'pool')];
  const one = (c: PatchCable) => errors(patch(base, [c]));

  it('rejects a second cable into a Value input', () => {
    expect(errors(patch(base, [cable('ch', 'out', 'r', 'chord'), cable('ch2', 'out', 'r', 'chord')]))).toEqual([
      'cables[1] ch2.out → r.chord: value input "chord" already has a cable',
    ]);
  });

  it('rejects bad cables into params', () => {
    expect(one(cable('a', 'out', 'r', 'nope'))[0]).toMatch(/unknown port/);
    expect(one(cable('a', 'out', 'r', 'mode'))[0]).toMatch(/parameter "mode" is not a number/);
    expect(one(cable('a', 'out', 'r', 'fixed'))[0]).toMatch(/parameter "fixed" cannot be modulated/);
    expect(one(cable('m', 'out', 'r', 'knob'))[0]).toMatch(/only signal cables can feed a parameter, not event/);
    expect(one(cable('ch', 'out', 'r', 'knob'))[0]).toMatch(/not value/);
  });

  it('rejects Field cables whose kinds differ', () => {
    expect(one(cable('w', 'write', 'p', 'field'))[0]).toMatch(/cannot connect field \(write\) to field \(fluid\)/);
    expect(one(cable('p', 'out', 'p', 'writers'))[0]).toMatch(/cannot connect field \(fluid\) to field \(write\)/);
  });

  it('rejects Signal into Event and the reverse', () => {
    expect(one(cable('a', 'out', 'r', 'trig'))[0]).toMatch(/cannot connect signal to event/);
    expect(one(cable('m', 'out', 'r', 'sig'))[0]).toMatch(/cannot connect event to signal/);
  });

  it('rejects cycles through Signal and param cables', () => {
    const loop = definitions.get('reader')!;
    const echo: NodeDefinition = { ...loop, type: 'echo', ports: [...loop.ports, { name: 'level', type: 'signal', direction: 'out' }] };
    const result = compilePatch(patch([node('e1', 'echo'), node('e2', 'echo')], [cable('e1', 'level', 'e2', 'knob'), cable('e2', 'level', 'e1', 'sig')]), new Map([...definitions, ['echo', echo]]));
    expect(result.ok ? [] : result.errors).toEqual(['cycle without a delay edge through: e1 → e2 → e1']);
  });
});
