import { describe, expect, it } from 'vitest';
import { compilePatch, replayInput, Runtime, type EngineEvent, type EventField, type InputEvent, type LoggedEvent, type Patch, type SignalSource } from '@flow-patcher/engine';
import { nodeRegistry, zone } from '../src';
import { SHAPES, ZONE_OUTPUTS, zoneOf } from '../src/zone';
import { context, query, queryTiled } from './helpers';
import { burst, expectUnderCap, expectWellFormed, splitsMatchPass } from './routing';

const ZONES = Array.from({ length: ZONE_OUTPUTS }, (_, i) => `zone${i + 1}`);
const PORTS = [...ZONES, 'zones', 'pass', 'passDown', 'passMove', 'passUp', 'passCancel'];

const ev = (time: number, channel: number, phase: string | undefined, x: EventField, y: EventField): EngineEvent => ({ time, channel, ...(phase ? { phase } : {}), x, y });

/** The zone one point lands in under some params. */
const at = (x: number, y: number, params: Record<string, unknown> = {}, mods = {}) => zoneOf(context(zone, { params, mods }), ev(0, 1, 'down', x, y));

/** [port, time, channel, phase, zone] for every event, ports in PORTS order. */
const flat = (result: Record<string, EngineEvent[] | undefined>, ports = PORTS) =>
  ports.flatMap((port) => (result[port] ?? []).map((e) => [port, e.time, e.channel, e.phase ?? '-', e.zone ?? '-']));

/** Channel 1 drags from the top-left cell across to the bottom-right; channel 2 taps top-right; 3 hovers across. */
const stream: EngineEvent[] = [
  ev(0.1, 1, 'down', 0.1, 0.1),
  ev(0.2, 2, 'down', 0.9, 0.1),
  ev(0.3, 1, 'move', 0.4, 0.4),
  ev(0.3, 3, 'move', 0.2, 0.9),
  ev(0.4, 2, 'up', 0.9, 0.1),
  ev(0.5, 1, 'move', 0.9, 0.9),
  ev(0.6, 3, 'move', 0.8, 0.9),
  ev(0.65, 1, 'move', 0.95, 0.95),
  ev(0.7, 1, 'cancel', 0.95, 0.95),
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
  return out;
}

describe('zone', () => {
  it('is a recognizer with eight zone outputs, Zones, and Pass with its phase splits; no mask until #102', () => {
    expect(zone.category).toBe('gesture-recognizers');
    expect(zone.version).toBe(2);
    expect(zone.ports.filter((p) => p.direction === 'out').map((p) => p.name)).toEqual(PORTS);
    expect(SHAPES).toEqual(['grid', 'left/right', 'rings']);
    expect(zone.params.map((p) => p.name)).not.toContain('mask');
    expect(zone.params.find((p) => p.name === 'outputs')).toMatchObject({ kind: 'enum', options: ['All phases', 'Presses only'], default: 'All phases' });
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

  it('follows the pointer: a crossing ends the contact in one zone with an up and starts it in the next with a down', () => {
    const out = tiled(1);
    expect(flat(out, [...ZONES, 'pass'])).toEqual([
      // Channel 1 starts in 1 and crosses into 4 at 0.5; its cancel ends it there.
      ['zone1', 0.1, 1, 'down', 1], ['zone1', 0.3, 1, 'move', 1], ['zone1', 0.5, 1, 'up', 1],
      ['zone2', 0.2, 2, 'down', 2], ['zone2', 0.4, 2, 'up', 2], ['zone2', 0.8, 0, '-', 2],
      // A hover goes by where it is, with no crossing.
      ['zone3', 0.3, 3, 'move', 3],
      ['zone4', 0.5, 1, 'down', 4], ['zone4', 0.6, 3, 'move', 4], ['zone4', 0.65, 1, 'move', 4], ['zone4', 0.7, 1, 'cancel', 4],
    ]);
    // The crossing events are copies of the move, at its time and place, in its place.
    expect(out.zone1!.at(-1)).toEqual({ ...stream[5], phase: 'up', zone: 1 });
    expect(out.zone4![0]).toEqual({ ...stream[5], phase: 'down', zone: 4 });
    // Zones carries the up with A's number, then the down with B's.
    expect(flat(out, ['zones']).filter((r) => r[2] === 1)).toEqual([
      ['zones', 0.1, 1, 'down', 1], ['zones', 0.3, 1, 'move', 1], ['zones', 0.5, 1, 'up', 1], ['zones', 0.5, 1, 'down', 4], ['zones', 0.65, 1, 'move', 4], ['zones', 0.7, 1, 'cancel', 4],
    ]);
    expectWellFormed(out);
  });

  it('crosses into and out of Pass the same way, with Pass Down and Up', () => {
    const rings = { shape: 'rings', rings: 2, radius: 0.3 };
    const events = [
      ev(0.1, 1, 'down', 0.95, 0.95), ev(0.2, 1, 'move', 0.9, 0.9), ev(0.3, 1, 'move', 0.5, 0.5), ev(0.35, 1, 'move', 0.7, 0.5), ev(0.4, 1, 'move', 0.99, 0.5), ev(0.5, 1, 'up', 0.99, 0.5),
    ];
    const out = tiled(1, rings, events);
    expect(flat(out, ['zone1', 'zone2', 'pass'])).toEqual([
      ['zone1', 0.3, 1, 'down', 1], ['zone1', 0.35, 1, 'up', 1],
      ['zone2', 0.35, 1, 'down', 2], ['zone2', 0.4, 1, 'up', 2],
      ['pass', 0.1, 1, 'down', '-'], ['pass', 0.2, 1, 'move', '-'], ['pass', 0.3, 1, 'up', '-'], ['pass', 0.4, 1, 'down', '-'], ['pass', 0.5, 1, 'up', '-'],
    ]);
    splitsMatchPass(out);
    expect(out.passDown!.map((e) => e.time)).toEqual([0.1, 0.4]);
    for (const port of ['passDown', 'passMove', 'passUp']) for (const e of out[port]!) expect(e).not.toHaveProperty('phase');
    expectWellFormed(out);
  });

  it('keeps channels apart: one crossing leaves another contact in place', () => {
    const events = [
      ev(0.1, 1, 'down', 0.2, 0.2), ev(0.1, 2, 'down', 0.3, 0.3),
      ev(0.2, 1, 'move', 0.8, 0.2), ev(0.2, 2, 'move', 0.35, 0.3),
      ev(0.3, 2, 'move', 0.3, 0.8), ev(0.4, 1, 'up', 0.8, 0.2), ev(0.4, 2, 'up', 0.3, 0.8),
    ];
    const out = tiled(1, {}, events);
    expect(flat(out, ['zone1', 'zone2', 'zone3'])).toEqual([
      ['zone1', 0.1, 1, 'down', 1], ['zone1', 0.1, 2, 'down', 1], ['zone1', 0.2, 1, 'up', 1], ['zone1', 0.2, 2, 'move', 1], ['zone1', 0.3, 2, 'up', 1],
      ['zone2', 0.2, 1, 'down', 2], ['zone2', 0.4, 1, 'up', 2],
      ['zone3', 0.3, 2, 'down', 3], ['zone3', 0.4, 2, 'up', 3],
    ]);
    expectWellFormed(out);
  });

  it('with Presses only, Zone 1–8 carry downs alone, crossing downs included; Zones and Pass carry everything', () => {
    const out = tiled(1, { outputs: 'Presses only' });
    expect(flat(out, ZONES)).toEqual([['zone1', 0.1, 1, 'down', 1], ['zone2', 0.2, 2, 'down', 2], ['zone4', 0.5, 1, 'down', 4]]);
    expect(out.zones).toEqual(tiled(1).zones);
    const rings = tiled(1, { shape: 'rings', radius: 0.2, outputs: 'Presses only' });
    expect(rings.pass).toEqual(tiled(1, { shape: 'rings', radius: 0.2 }).pass);
  });

  it('picks afresh after a cancel', () => {
    const events = [ev(0.1, 1, 'down', 0.1, 0.1), ev(0.2, 1, 'cancel', 0.9, 0.9), ev(0.3, 1, 'move', 0.9, 0.1), ev(0.4, 1, 'up', 0.1, 0.9)];
    expect(flat(tiled(1, {}, events), ZONES)).toEqual([['zone1', 0.1, 1, 'down', 1], ['zone1', 0.2, 1, 'cancel', 1], ['zone2', 0.3, 1, 'move', 2], ['zone3', 0.4, 1, 'up', 3]]);
  });

  it('puts cells past eight on Zones only', () => {
    const result = query(zone, 0, 1, { params: { rows: 4, columns: 4 }, inputs: { in: [ev(0.1, 1, undefined, 0.9, 0.9), ev(0.2, 1, undefined, 0.9, 0.3)] } });
    expect(flat(result)).toEqual([['zone8', 0.2, 1, '-', 8], ['zones', 0.1, 1, '-', 16], ['zones', 0.2, 1, '-', 8]]);
  });

  it('reads its knobs at each event, per channel', () => {
    // Columns from a cable: 1 on channel 1, 2 on channel 2 (knob 1, depth 1 × channel − 1).
    const cols: SignalSource = (_t, channel) => channel - 1;
    const mods = { columns: [{ depth: 1, signal: cols }] };
    expect(at(0.9, 0.1, { rows: 1, columns: 1 }, mods)).toBe(1);
    const result = query(zone, 0, 1, { params: { rows: 1, columns: 1 }, mods, inputs: { in: [ev(0.1, 1, 'down', 0.9, 0.1), ev(0.1, 2, 'down', 0.9, 0.1)] } });
    expect(flat(result, ZONES)).toEqual([['zone1', 0.1, 1, 'down', 1], ['zone2', 0.1, 2, 'down', 2]]);
  });

  it('gives the same events in any windows', () => {
    const whole = tiled(1);
    for (const step of [0.025, 0.1, 0.35]) expect(tiled(step)).toEqual(whole);
    expect(queryTiled(zone, 'zone1', 1, 0.05, { state: {}, inputsFor: (t0, t1) => ({ in: stream.filter((e) => e.time >= t0 && e.time < t1) }) }).map((e) => e.time)).toEqual([0.1, 0.3, 0.5]);
  });

  it('thins moves in an over-budget burst, so every down, crossing ones included, gets its up or cancel', () => {
    // 10 contacts sweeping left to right across a 1 × 4 grid in 62 ms, 60 moves each, in one limit window.
    const events = burst(10, 60, (c, step) => ({ x: Math.min(0.99, step / 61), y: c / 11 }));
    const out = query(zone, 0, 1, { state: {}, params: { rows: 1, columns: 4 }, inputs: { in: events } }) as Record<string, EngineEvent[]>;
    expectWellFormed(out);
    expectUnderCap(out);
    const ends = (e: EngineEvent) => e.phase === 'up' || e.phase === 'cancel';
    expect(out.zone1!.filter((e) => e.phase === 'down')).toHaveLength(10);
    // Each contact's real end goes out once, in the zone it's in: the burst's last 10 events.
    expect(ZONES.flatMap((port) => out[port] ?? []).filter((e) => ends(e) && e.time === events.at(-1)!.time)).toHaveLength(10);
    // Moves were thinned, and crossings with them once the window filled.
    expect(out.zones!.filter((e) => e.phase === 'move').length).toBeLessThan(10 * 60 - 30);
    // In a fresh window the crossings go through: here, spread over 0.5 s.
    const slow = burst(10, 60, (c, step) => ({ x: Math.min(0.99, step / 61), y: c / 11 })).map((e) => ({ ...e, time: e.time * 10 }));
    const relaxed = query(zone, 0, 1, { state: {}, params: { rows: 1, columns: 4 }, inputs: { in: slow } }) as Record<string, EngineEvent[]>;
    expectWellFormed(relaxed);
    for (const port of ['zone1', 'zone2', 'zone3', 'zone4']) expect(relaxed[port]!.filter((e) => e.phase === 'down'), port).toHaveLength(10);
  });

  it('copes with weird input', () => {
    expect(query(zone, 0, 1)).toEqual({});
    expect(query(zone, 0, 1, { inputs: { in: [] } })).toEqual({});
    const weird = [ev(0.1, 1, 'down', NaN, 0.5), ev(0.2, 2, 'down', '0.5', 0.5), ev(0.3, 3, 'down', Infinity, 0.5), ev(NaN, 4, 'down', 0.5, 0.5), ev(0.35, NaN, 'down', 0.5, 0.5)];
    const state: Record<string, unknown> = {};
    const result = query(zone, 0, 1, { state, params: { shape: 'mask', rows: NaN, outputs: 'sometimes' }, inputs: { in: [...weird, { time: 0.4, channel: 5, phase: 'down' }] } });
    // No usable position: Pass. A bad shape (mask included) reads as grid; a bad knob as its default.
    expect(flat(result).filter((r) => r[0] === 'pass').map((r) => r[2])).toEqual([1, 2, 3, 5]);
    expect(state.zones).toEqual({ 1: 0, 2: 0, 3: 0, 5: 0 });
    expect(at(0.9, 0.9, { shape: 'mask', rows: NaN })).toBe(4);
    // A contact that goes down with no position and then gets one crosses out of Pass.
    expect(flat(query(zone, 0, 1, { state: {}, inputs: { in: [ev(0.1, 1, 'down', NaN, 0), ev(0.2, 1, 'move', 0.1, 0.1)] } }), ['zone1', 'pass'])).toEqual([['zone1', 0.2, 1, 'down', 1], ['pass', 0.1, 1, 'down', '-'], ['pass', 0.2, 1, 'up', '-']]);
  });

  it("splits Pointer's All live by where each touch is", () => {
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
      ['zone1', 0.1, 1, 'down'], ['zone2', 0.15, 2, 'down'], ['zone1', 0.2, 1, 'up'], ['zone2', 0.2, 1, 'down'], ['zone2', 0.25, 1, 'up'], ['zone2', 0.3, 2, 'up'],
    ]);
  });
});
