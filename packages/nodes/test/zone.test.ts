import { describe, expect, it } from 'vitest';
import { compilePatch, replayInput, Runtime, type EngineEvent, type EventField, type InputEvent, type LoggedEvent, type Patch, type SignalSource } from '@flow-patcher/engine';
import { nodeRegistry, zone } from '../src';
import { inside, maskError, parseMask, ZONE_OUTPUTS, zoneOf } from '../src/zone';
import { context, query, queryTiled } from './helpers';

const ZONES = Array.from({ length: ZONE_OUTPUTS }, (_, i) => `zone${i + 1}`);
const PORTS = [...ZONES, 'zones', 'pass', 'passDown', 'passMove', 'passUp', 'passCancel'];

const ev = (time: number, channel: number, phase: string | undefined, x: EventField, y: EventField): EngineEvent => ({ time, channel, ...(phase ? { phase } : {}), x, y });

/** The zone one point lands in under some params. */
const at = (x: number, y: number, params: Record<string, unknown> = {}, mods = {}) => {
  const ctx = context(zone, { params, mods });
  const polygons = ctx.params.shape === 'mask' ? parseMask(ctx.params.mask as string).polygons : [];
  return zoneOf(ctx, ev(0, 1, 'down', x, y), polygons);
};

/** [port, time, channel, phase, zone] for every event, ports in PORTS order. */
const flat = (result: Record<string, EngineEvent[] | undefined>) =>
  PORTS.flatMap((port) => (result[port] ?? []).map((e) => [port, e.time, e.channel, e.phase ?? '-', e.zone ?? '-']));

/** Channel 1 drags from the top-left cell across to the bottom-right; channel 2 taps top-right; 3 hovers across. */
const stream: EngineEvent[] = [
  ev(0.1, 1, 'down', 0.1, 0.1),
  ev(0.2, 2, 'down', 0.9, 0.1),
  ev(0.3, 1, 'move', 0.6, 0.4),
  ev(0.3, 3, 'move', 0.2, 0.9),
  ev(0.4, 2, 'up', 0.9, 0.1),
  ev(0.5, 1, 'move', 0.9, 0.9),
  ev(0.6, 3, 'move', 0.8, 0.9),
  ev(0.7, 1, 'cancel', 0.9, 0.9),
  ev(0.8, 0, undefined, 0.7, 0.2),
];

function tiled(step: number, params: Record<string, unknown> = {}, events = stream) {
  const state = {};
  const out: Record<string, EngineEvent[]> = {};
  for (let i = 0; i * step < 1 - 1e-9; i++) {
    const t0 = i * step, t1 = Math.min(1, (i + 1) * step);
    const result = query(zone, t0, t1, { state, params, inputs: { in: events.filter((e) => e.time >= t0 && e.time < t1) } });
    for (const [port, list] of Object.entries(result)) (out[port] ??= []).push(...list!);
  }
  return flat(out);
}

describe('zone', () => {
  it('is a recognizer with eight zone outputs, Zones, and Pass with its phase splits', () => {
    expect(zone.category).toBe('gesture-recognizers');
    expect(zone.ports.filter((p) => p.direction === 'out').map((p) => p.name)).toEqual(PORTS);
  });

  it('numbers grid cells left to right, then top to bottom', () => {
    expect([at(0.1, 0.1), at(0.9, 0.1), at(0.1, 0.9), at(0.9, 0.9)]).toEqual([1, 2, 3, 4]);
    const grid = { rows: 3, columns: 4 };
    expect([at(0, 0, grid), at(0.3, 0, grid), at(1, 0, grid), at(0.5, 0.5, grid), at(1, 1, grid)]).toEqual([1, 2, 4, 7, 12]);
    // Outside 0–1 counts as the nearest edge cell.
    expect([at(-2, 0.1), at(5, 5)]).toEqual([1, 4]);
  });

  it('splits left and right at Split', () => {
    expect([at(0.49, 0.5, { shape: 'left/right' }), at(0.5, 0.5, { shape: 'left/right' }), at(0.2, 0.5, { shape: 'left/right', split: 0.1 })]).toEqual([1, 2, 2]);
  });

  it('gives rings of equal width out to Radius, and no zone beyond', () => {
    const rings = { shape: 'rings', rings: 4, radius: 0.4 };
    expect([at(0.5, 0.5, rings), at(0.55, 0.5, rings), at(0.65, 0.5, rings), at(0.75, 0.5, rings), at(0.85, 0.5, rings), at(0.5, 0.9, rings), at(0.95, 0.5, rings)]).toEqual([1, 1, 2, 3, 4, 4, 0]);
    expect(at(0.2, 0.2, { shape: 'rings', centerX: 0.2, centerY: 0.2 })).toBe(1);
  });

  it('takes a mask of polygons, the first that holds the point', () => {
    const mask = { shape: 'mask', mask: '0,0 1,0 0.5,0.5; 0,1 1,1 0.5,0.5' };
    expect([at(0.5, 0.1, mask), at(0.5, 0.9, mask), at(0.1, 0.5, mask)]).toEqual([1, 2, 0]);
    expect(at(0.5, 0.5, { shape: 'mask' })).toBe(1);
    expect(at(0.1, 0.1, { shape: 'mask' })).toBe(0);
    expect(inside([[0, 0], [2, 0], [2, 2], [0, 2]], 1.5, 1.5)).toBe(true);
    expect(parseMask(' 0,0  1,0 0,1 ;').polygons).toEqual([[[0, 0], [1, 0], [0, 1]]]);
    expect(maskError('')).toMatch(/at least one polygon/);
    expect(maskError('0,0 1,0')).toMatch(/three points/);
    expect(maskError('0,0 1,x 0,1')).toMatch(/"1,x"/);
    expect(maskError('0,0 1 0,1')).toMatch(/"1"/);
    // An unusable mask has no zones.
    expect(at(0.5, 0.5, { shape: 'mask', mask: 'nope' })).toBe(0);
  });

  it('keeps each contact in the zone its down landed in until it ends (ADR 0028)', () => {
    expect(tiled(1)).toEqual([
      // Channel 1 starts top-left and stays in zone 1 across the canvas, through its cancel.
      ['zone1', 0.1, 1, 'down', 1], ['zone1', 0.3, 1, 'move', 1], ['zone1', 0.5, 1, 'move', 1], ['zone1', 0.7, 1, 'cancel', 1],
      ['zone2', 0.2, 2, 'down', 2], ['zone2', 0.4, 2, 'up', 2], ['zone2', 0.8, 0, '-', 2],
      // A hover goes by where it is.
      ['zone3', 0.3, 3, 'move', 3], ['zone4', 0.6, 3, 'move', 4],
      ['zones', 0.1, 1, 'down', 1], ['zones', 0.2, 2, 'down', 2], ['zones', 0.3, 1, 'move', 1], ['zones', 0.3, 3, 'move', 3], ['zones', 0.4, 2, 'up', 2],
      ['zones', 0.5, 1, 'move', 1], ['zones', 0.6, 3, 'move', 4], ['zones', 0.7, 1, 'cancel', 1], ['zones', 0.8, 0, '-', 2],
    ]);
  });

  it('sends contacts that go down in no zone to Pass, and keeps them there', () => {
    const rings = { shape: 'rings', rings: 2, radius: 0.3 };
    const events = [ev(0.1, 1, 'down', 0.95, 0.95), ev(0.2, 1, 'move', 0.5, 0.5), ev(0.3, 1, 'up', 0.5, 0.5), ev(0.4, 2, 'down', 0.5, 0.5), ev(0.5, 2, 'move', 0.99, 0.5), ev(0.6, 2, 'up', 0.99, 0.5)];
    expect(tiled(1, rings, events)).toEqual([
      ['zone1', 0.4, 2, 'down', 1], ['zone1', 0.5, 2, 'move', 1], ['zone1', 0.6, 2, 'up', 1],
      ['zones', 0.4, 2, 'down', 1], ['zones', 0.5, 2, 'move', 1], ['zones', 0.6, 2, 'up', 1],
      ['pass', 0.1, 1, 'down', '-'], ['pass', 0.2, 1, 'move', '-'], ['pass', 0.3, 1, 'up', '-'],
      ['passDown', 0.1, 1, 'down', '-'], ['passMove', 0.2, 1, 'move', '-'], ['passUp', 0.3, 1, 'up', '-'],
    ]);
  });

  it('puts cells past eight on Zones only', () => {
    const result = query(zone, 0, 1, { params: { rows: 4, columns: 4 }, inputs: { in: [ev(0.1, 1, undefined, 0.9, 0.9), ev(0.2, 1, undefined, 0.9, 0.3)] } });
    expect(flat(result)).toEqual([['zone8', 0.2, 1, '-', 8], ['zones', 0.1, 1, '-', 16], ['zones', 0.2, 1, '-', 8]]);
  });

  it('reads its knobs at the deciding event, per channel', () => {
    // Columns from a cable: 1 on channel 1, 2 on channel 2 (knob 1, depth 1 × channel − 1).
    const cols: SignalSource = (_t, channel) => channel - 1;
    const mods = { columns: [{ depth: 1, signal: cols }] };
    expect(at(0.9, 0.1, { rows: 1, columns: 1 }, mods)).toBe(1);
    const result = query(zone, 0, 1, { params: { rows: 1, columns: 1 }, mods, inputs: { in: [ev(0.1, 1, 'down', 0.9, 0.1), ev(0.1, 2, 'down', 0.9, 0.1)] } });
    expect(flat(result).filter((r) => r[0] !== 'zones')).toEqual([['zone1', 0.1, 1, 'down', 1], ['zone2', 0.1, 2, 'down', 2]]);
  });

  it('gives the same events in any windows', () => {
    const whole = tiled(1);
    for (const step of [0.025, 0.1, 0.35]) expect(tiled(step)).toEqual(whole);
    expect(queryTiled(zone, 'zone1', 1, 0.05, { state: {}, inputsFor: (t0, t1) => ({ in: stream.filter((e) => e.time >= t0 && e.time < t1) }) }).map((e) => e.time)).toEqual([0.1, 0.3, 0.5, 0.7]);
  });

  it('copies routed events, adding zone, and passes the rest unchanged', () => {
    const result = query(zone, 0, 1, { params: { shape: 'rings' }, inputs: { in: [ev(0.1, 1, 'down', 0.5, 0.5), ev(0.2, 2, 'down', 0, 0)] } });
    expect(result.zone1![0]).not.toBe(result.zones![0]);
    expect(result.zone1![0]).toEqual({ time: 0.1, channel: 1, phase: 'down', x: 0.5, y: 0.5, zone: 1 });
    expect(result.pass![0]).toEqual({ time: 0.2, channel: 2, phase: 'down', x: 0, y: 0 });
  });

  it('copes with weird input', () => {
    expect(query(zone, 0, 1)).toEqual({});
    expect(query(zone, 0, 1, { inputs: { in: [] } })).toEqual({});
    const weird = [ev(0.1, 1, 'down', NaN, 0.5), ev(0.2, 2, 'down', '0.5', 0.5), ev(0.3, 3, 'down', Infinity, 0.5), ev(NaN, 4, 'down', 0.5, 0.5)];
    const state: Record<string, unknown> = {};
    const result = query(zone, 0, 1, { state, params: { shape: 'nonsense', rows: NaN, mask: 7 }, inputs: { in: [...weird, { time: 0.4, channel: 5, phase: 'down' }] } });
    // No usable position: Pass. A bad shape reads as grid; a bad knob as its default.
    expect(flat(result).filter((r) => r[0] === 'pass').map((r) => r[2])).toEqual([1, 2, 3, 5]);
    expect(state.routes).toEqual({ 1: 0, 2: 0, 3: 0, 5: 0 });
    expect(at(0.9, 0.9, { shape: 'nonsense', rows: NaN })).toBe(4);
    expect(at(0.5, 0.5, { shape: 'mask', mask: 7 })).toBe(1);
  });

  it("splits Pointer's All live by where each touch goes down", () => {
    const node = (id: string, type: string, params = {}) => ({ id, type, typeVersion: nodeRegistry.get(type)!.version, params, position: { x: 0, y: 0 } });
    const patch: Patch = { format: 'flowpatch', version: 1, seed: 1, nodes: [node('p', 'pointer'), node('z', 'zone', { shape: 'left/right' })], cables: [{ from: { node: 'p', port: 'all' }, to: { node: 'z', port: 'in' } }] };
    const compiled = compilePatch(patch, nodeRegistry);
    if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
    const rt = new Runtime(compiled.plan);
    const t = (time: number, type: string, channel: number, x: number): InputEvent => ({ time, type, channel, x, y: 0.5, pressure: 0.5, pointerType: 'touch' } as InputEvent);
    replayInput(rt, { events: [t(0.1, 'pointerdown', 7, 0.2), t(0.15, 'pointerdown', 8, 0.8), t(0.2, 'pointermove', 7, 0.7), t(0.25, 'pointerup', 7, 0.7), t(0.3, 'pointerup', 8, 0.8)] });
    const log: LoggedEvent[] = [];
    for (let i = 0; i < 20; i++) log.push(...rt.query(i * 0.025, (i + 1) * 0.025));
    expect(log.filter((e) => e.node === 'z' && e.port !== 'zones').map((e) => [e.port, e.time, e.channel, e.phase])).toEqual([
      ['zone1', 0.1, 1, 'down'], ['zone2', 0.15, 2, 'down'], ['zone1', 0.2, 1, 'move'], ['zone1', 0.25, 1, 'up'], ['zone2', 0.3, 2, 'up'],
    ]);
  });
});
