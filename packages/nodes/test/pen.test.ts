import { describe, expect, it } from 'vitest';
import { compilePatch, inputRouter, replayInput, Runtime, type EngineEvent, type InputEvent, type LoggedEvent, type Patch } from '@flow-patcher/engine';
import { nodeRegistry, pen, pointer } from '../src';
import { PEN_DEFAULTS, PEN_FIELDS, penFieldsOf } from '../src/pen';
import { context, query, queryTiled } from './helpers';

const EVENT_PORTS = ['down', 'move', 'up', 'cancel', 'all'] as const;
const POINTER_SIGNALS = ['x', 'y', 'pressure', 'speed', 'count'] as const;
const SIGNALS = [...POINTER_SIGNALS, ...PEN_FIELDS] as const;
type Port = (typeof EVENT_PORTS)[number] | 'enter' | 'leave';
type Push = { port: Port; event: EngineEvent };
const Q = Math.PI / 4, H = Math.PI / 2;

const node = (id: string, type: string) => ({ id, type, typeVersion: nodeRegistry.get(type)!.version, params: {}, position: { x: 0, y: 0 } });
/** Pen and Pointer side by side, reading the same stream. */
const patch: Patch = { format: 'flowpatch', version: 1, seed: 1, nodes: [node('pen', 'pen'), node('p', 'pointer')], cables: [] };
function plan() {
  const compiled = compilePatch(patch, nodeRegistry);
  if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
  return compiled.plan;
}

/**
 * Two pens (raw ids 7 and 9) as the host sends them, with tilt but no altitude or azimuth on pen
 * 7 (a browser without them): 7 hovers in tilted, presses, presses the barrel mid-drag (a chorded
 * button, so a move: buttons 3, button 2) and lifts;
 * 9 presses while 7 is down, twisting, with only altitude and azimuth, and is cancelled.
 */
const session: Push[] = [
  { port: 'enter', event: { time: 0.05, channel: 7, x: 0.1, y: 0.5, pointerType: 'pen', tiltX: 45, tiltY: 0 } },
  { port: 'move', event: { time: 0.06, channel: 7, x: 0.12, y: 0.5, pressure: 0, pointerType: 'pen', buttons: 0, tiltX: 45, tiltY: 0, twist: 0 } },
  { port: 'move', event: { time: 0.08, channel: 7, x: 0.14, y: 0.5, pressure: 0, pointerType: 'pen', buttons: 0, tiltX: 0, tiltY: -30, twist: 0 } },
  { port: 'down', event: { time: 0.1, channel: 7, x: 0.2, y: 0.5, pressure: 0.4, pointerType: 'pen', button: 0, buttons: 1, tiltX: 0, tiltY: -30, twist: 10, tangentialPressure: 0.5 } },
  { port: 'move', event: { time: 0.15, channel: 7, x: 0.3, y: 0.5, pressure: 0.6, pointerType: 'pen', button: 2, buttons: 3, tiltX: 20, tiltY: 20, twist: 20, tangentialPressure: 0.25 } },
  { port: 'down', event: { time: 0.2, channel: 9, x: 0.8, y: 0.8, pressure: 0.5, pointerType: 'pen', button: 0, buttons: 1, altitudeAngle: Q, azimuthAngle: H, twist: 90 } },
  { port: 'move', event: { time: 0.25, channel: 9, x: 0.8, y: 0.7, pressure: 0.5, pointerType: 'pen', buttons: 1, altitudeAngle: Q, azimuthAngle: H, twist: 180 } },
  { port: 'up', event: { time: 0.3, channel: 7, x: 0.3, y: 0.5, pressure: 0, pointerType: 'pen', button: 0, buttons: 0, tiltX: 20, tiltY: 20, twist: 20, tangentialPressure: 0.25 } },
  { port: 'move', event: { time: 0.32, channel: 7, x: 0.31, y: 0.5, pressure: 0, pointerType: 'pen', buttons: 0, tiltX: 20, tiltY: 20, twist: 20 } },
  { port: 'leave', event: { time: 0.35, channel: 7, x: 0.31, y: 0.5, pointerType: 'pen' } },
  { port: 'cancel', event: { time: 0.4, channel: 9, x: 0.8, y: 0.7, pressure: 0, pointerType: 'pen', buttons: 0, altitudeAngle: Q, azimuthAngle: H, twist: 180 } },
];

function pushedOf(list: readonly Push[]): Record<string, EngineEvent[]> {
  const out: Record<string, EngineEvent[]> = {};
  for (const { port, event } of list) (out[port] ??= []).push(event);
  return out;
}
const events = (list: readonly Push[], port: string, step = 1, end = 1) => queryTiled(pen, port, end, step, { state: {}, pushed: pushedOf(list) });

/** Queries [0, end) in windows of `step` on one state, reading every signal on `channels` at `times` after the window holding each. */
function readSignals(list: readonly Push[], step: number, times: number[], channels: number[], end = 1): Record<string, number>[] {
  const state: Record<string, unknown> = {};
  const pushed = pushedOf(list);
  const ctx = context(pen, { state });
  const rows: Record<string, number>[] = [];
  for (let i = 0; i * step < end - 1e-9; i++) {
    const t0 = i * step, t1 = Math.min(end, (i + 1) * step);
    query(pen, t0, t1, { state, pushed });
    for (const t of times.filter((time) => time >= t0 && time < t1)) {
      for (const channel of channels) {
        const row: Record<string, number> = { t, channel };
        for (const port of SIGNALS) row[port] = pen.signal!(ctx, port, t, channel);
        rows.push(row);
      }
    }
  }
  return rows;
}
const read = (list: readonly Push[], t: number, channel: number) => readSignals(list, 1, [t], [channel])[0]!;

const close = (actual: Record<string, unknown>, expected: Record<string, number>) => {
  for (const [field, value] of Object.entries(expected)) expect(actual[field], field).toBeCloseTo(value, 9);
};

describe('pen', () => {
  it("has Pointer's ports plus the pen signals, and reads only pens' pointer events (no coalesced samples)", () => {
    expect(pen.category).toBe('canvas-sources');
    expect(pen.ports.map((p) => [p.name, p.type, p.direction])).toEqual([
      ...EVENT_PORTS.map((name) => [name, 'event', 'out']),
      ...SIGNALS.map((name) => [name, 'signal', 'out']),
    ]);
    expect(pen.ports.slice(0, pointer.ports.length)).toEqual(pointer.ports);
    expect(pen.params).toEqual([]);
    expect(pen.input!.rewrites).toBe(true);
    const router = inputRouter(plan());
    const types = [['pointerenter', 'enter'], ['pointerdown', 'down'], ['pointermove', 'move'], ['pointerup', 'up'], ['pointercancel', 'cancel'], ['pointerleave', 'leave']] as const;
    for (const [type, port] of types) {
      const penFields = { channel: 3, x: 0.5, y: 0.5, pressure: 0.5, pointerType: 'pen', tiltX: 10 };
      expect(router.route({ type, ...penFields })).toEqual([{ node: 'pen', port, fields: penFields }, { node: 'p', port, fields: penFields }]);
      // A mouse, a touch, or no pointerType at all reaches Pointer only.
      for (const pointerType of ['mouse', 'touch', undefined]) {
        const fields = { channel: 3, x: 0.5, y: 0.5, ...(pointerType ? { pointerType } : {}) };
        expect(router.route({ type, ...fields })).toEqual([{ node: 'p', port, fields }]);
      }
    }
    expect(router.route({ type: 'pointermove', channel: 3, pointerType: 'pen', coalesced: true })).toEqual([]);
  });

  it('emits nothing by itself, in any window, and reads a pen held upright before any pen', () => {
    for (const port of EVENT_PORTS) expect(queryTiled(pen, port, 2, 0.025)).toEqual([]);
    for (const [t0, t1] of [[1, 1], [2, 1], [NaN, 1], [0, Infinity]]) expect(query(pen, t0!, t1!)).toEqual({});
    const ctx = context(pen, { state: {} });
    for (const field of PEN_FIELDS) expect(pen.signal!(ctx, field, 0.5, 0)).toBe(PEN_DEFAULTS[field]);
    expect(PEN_DEFAULTS).toEqual({ tiltX: 0, tiltY: 0, altitudeAngle: H, azimuthAngle: 0, twist: 0, tangentialPressure: 0, barrel: 0 });
  });

  it("puts two pens on slots 1 and 2 with Pointer's derived fields, and every event carries all seven pen fields", () => {
    expect(events(session, 'down').map((e) => [e.time, e.channel])).toEqual([[0.1, 1], [0.2, 2]]);
    expect(events(session, 'up').map((e) => [e.time, e.channel])).toEqual([[0.3, 1]]);
    expect(events(session, 'cancel').map((e) => [e.time, e.channel])).toEqual([[0.4, 2]]);
    // All: the hover moves (slot 1, no contact), every phase, and 7's leave while hovering (#101), in time order.
    expect(events(session, 'all').map((e) => [e.time, e.channel, e.phase])).toEqual([
      [0.06, 1, 'move'], [0.08, 1, 'move'], [0.1, 1, 'down'], [0.15, 1, 'move'], [0.2, 2, 'down'], [0.25, 2, 'move'], [0.3, 1, 'up'], [0.32, 1, 'move'], [0.35, 1, 'leave'], [0.4, 2, 'cancel'],
    ]);
    // The leave is at the slot's last position, with the pen fields of the pointerleave itself (penFieldsOf):
    // this one carries no tilt, so it reads a pen held upright, not the last move's 20°/20°. A browser's
    // pointerleave from a pen carries its tilt.
    const leave = events(session, 'all').find((e) => e.phase === 'leave')!;
    expect(leave).toMatchObject({ x: 0.31, y: 0.5, dx: 0, speed: 0, age: 0 });
    close(leave, { tiltX: 0, tiltY: 0, altitudeAngle: H, azimuthAngle: 0, twist: 0, tangentialPressure: 0, barrel: 0 });
    for (const e of events(session, 'all')) for (const field of PEN_FIELDS) expect(Number.isFinite(e[field]), `${e.time} ${field}`).toBe(true);
    const [hover, tilted] = events(session, 'move');
    // Tilt 45° along +x, no altitude or azimuth from the host: altitude π/4, azimuth 0.
    close(hover!, { tiltX: 45, tiltY: 0, altitudeAngle: Q, azimuthAngle: 0, twist: 0, tangentialPressure: 0, barrel: 0, age: 0 });
    // Tilt 30° toward −y: azimuth 3π/2, altitude 60°.
    close(tilted!, { tiltX: 0, tiltY: -30, altitudeAngle: Math.PI / 3, azimuthAngle: 3 * H, barrel: 0 });
    const [down7, down9] = events(session, 'down');
    expect(down7).toMatchObject({ pressure: 0.4, buttons: 1, twist: 10, tangentialPressure: 0.5, barrel: 0, dx: expect.any(Number), age: 0 });
    // Only altitude and azimuth from the host: tilt comes from them (45° toward +y).
    close(down9!, { altitudeAngle: Q, azimuthAngle: H, tiltX: 0, tiltY: 45, twist: 90, barrel: 0 });
    // Pointer's motion: 7 moved 0.06 in 20 ms before its Down.
    close(down7!, { dx: 3, dy: 0, speed: 3 });
    const [, , drag] = events(session, 'move');
    // The barrel pressed mid-drag: a chorded move.
    close(drag!, { age: 0.05, dx: 2, twist: 20, tangentialPressure: 0.25, barrel: 1, button: 2 });
    expect(events(session, 'up')[0]).toMatchObject({ barrel: 0, pressure: 0 });
  });

  it('gives the same events on every port in one, two and three windows and in 25 ms tiles', () => {
    for (const port of EVENT_PORTS) {
      const reference = JSON.stringify(events(session, port));
      for (const step of [0.5, 1 / 3, 0.025]) expect(JSON.stringify(events(session, port, step)), `${port} ${step}`).toBe(reference);
    }
  });

  it('gives the same signal values in one window and in 25 and 100 ms tiles', () => {
    const times = [0, 0.055, 0.07, 0.09, 0.12, 0.17, 0.22, 0.27, 0.31, 0.33, 0.36, 0.42, 0.9];
    const reference = readSignals(session, 1, times, [0, 1, 2, 5]);
    for (const step of [0.1, 0.025]) expect(readSignals(session, step, times, [0, 1, 2, 5])).toEqual(reference);
  });

  it('reads the pen signals per slot from its latest event, holding angles and dropping Barrel and Tangential pressure once the slot is free', () => {
    // Mid-drag, both pens down.
    const one = read(session, 0.22, 1), two = read(session, 0.22, 2);
    close(one, { x: 0.3, pressure: 0.6, count: 2, tiltX: 20, tiltY: 20, twist: 20, tangentialPressure: 0.25, barrel: 1 });
    close(two, { x: 0.8, y: 0.8, count: 2, tiltX: 0, tiltY: 45, altitudeAngle: Q, azimuthAngle: H, twist: 90, barrel: 0 });
    // Tilt 20°, 20°: azimuth π/4, altitude atan(1 / (√2 tan 20°)).
    close(one, { azimuthAngle: Q, altitudeAngle: Math.atan(1 / (Math.SQRT2 * Math.tan((20 * Math.PI) / 180))) });
    // Channel 0 and a channel no slot has had read the pen that changed last (9's move at 0.25).
    expect(read(session, 0.27, 0)).toEqual({ ...read(session, 0.27, 2), channel: 0 });
    expect(read(session, 0.27, 5)).toEqual({ ...read(session, 0.27, 2), channel: 5 });
    // After 7's Up: the slot is free, so Barrel and Tangential pressure read 0; tilt holds.
    close(read(session, 0.31, 1), { barrel: 0, tangentialPressure: 0, pressure: 0, tiltX: 20, twist: 20, count: 1 });
    // Its hover after the Up takes slot 1 again; then the leave frees it and the angles hold.
    close(read(session, 0.33, 1), { x: 0.31, barrel: 0, tiltX: 20 });
    close(read(session, 0.9, 1), { x: 0.31, tiltX: 20, twist: 20, barrel: 0, tangentialPressure: 0 });
    close(read(session, 0.9, 2), { twist: 180, count: 0, barrel: 0 });
  });

  it('keeps mice and touches out of the slots and signals, live from the stream, and Pointer beside it counts them all', () => {
    const stream: InputEvent[] = [
      { time: 0.05, type: 'pointerenter', channel: 1, x: 0, y: 0.2, pointerType: 'mouse' },
      { time: 0.06, type: 'pointermove', channel: 1, x: 0.1, y: 0.2, pressure: 0, pointerType: 'mouse', buttons: 0 },
      { time: 0.1, type: 'pointerdown', channel: 30, x: 0.9, y: 0.9, pressure: 0.5, pointerType: 'touch', interval: 0.01 },
      { time: 0.12, type: 'pointerdown', channel: 2, x: 0.5, y: 0.5, pressure: 0.3, pointerType: 'pen', buttons: 1, tiltX: -10, tiltY: 5, twist: 300 },
      { time: 0.14, type: 'pointermove', channel: 1, x: 0.15, y: 0.2, pressure: 0, pointerType: 'mouse', buttons: 0 },
      { time: 0.16, type: 'pointerup', channel: 2, x: 0.5, y: 0.5, pressure: 0, pointerType: 'pen', buttons: 0, tiltX: -10, tiltY: 5, twist: 300 },
      { time: 0.2, type: 'pointerup', channel: 30, x: 0.9, y: 0.9, pressure: 0, pointerType: 'touch' },
    ];
    const run = (step: number) => {
      const rt = new Runtime(plan());
      replayInput(rt, { events: stream });
      const log: LoggedEvent[] = [];
      for (let i = 0; i * step < 0.5 - 1e-9; i++) log.push(...rt.query(i * step, Math.min(0.5, (i + 1) * step)));
      return rt.sortLog(log);
    };
    const log = run(0.5);
    expect(JSON.stringify(run(0.025))).toBe(JSON.stringify(log));
    const pick = (id: string, port: string) => log.filter((e) => e.node === id && e.port === port);
    // Pen: only the pen, on slot 1. Pointer gave the mouse slot 1 and the touch 2, so the pen is 3 there.
    expect(pick('pen', 'all').map((e) => [e.time, e.channel, e.phase, e.pointerType])).toEqual([[0.12, 1, 'down', 'pen'], [0.16, 1, 'up', 'pen']]);
    expect(pick('p', 'down').map((e) => [e.time, e.channel])).toEqual([[0.1, 2], [0.12, 3]]);
    expect(pick('pen', 'down')[0]).toMatchObject({ tiltX: -10, tiltY: 5, twist: 300, barrel: 0 });
    // Pointer passes the pen fields through untouched: no completion, no barrel.
    expect(pick('p', 'down')[1]).toMatchObject({ tiltX: -10, tiltY: 5, twist: 300 });
    expect(pick('p', 'down')[1]!.altitudeAngle).toBeUndefined();
    // A non-pen push straight into the query (past the router) is dropped too.
    expect(query(pen, 0, 1, { state: {}, pushed: { down: [{ time: 0.1, channel: 4, x: 0.5, y: 0.5, pointerType: 'touch' }, { time: 0.2, channel: 5, x: 0.5, y: 0.5 }] } })).toEqual({});
  });

  it('follows the browser on the barrel: pressed in the air it is a Down with button 2 and the hover pressure, on Pen and Pointer', () => {
    const barrel: Push[] = [
      { port: 'move', event: { time: 0.1, channel: 3, x: 0.5, y: 0.5, pressure: 0, pointerType: 'pen', button: -1, buttons: 0, tiltX: 10 } },
      // The barrel in the air: the first button, so a pointerdown, with no tip pressure.
      { port: 'down', event: { time: 0.2, channel: 3, x: 0.5, y: 0.5, pressure: 0, pointerType: 'pen', button: 2, buttons: 2, tiltX: 10 } },
      // The tip touches while the barrel is held: a chorded button, so a move.
      { port: 'move', event: { time: 0.3, channel: 3, x: 0.55, y: 0.5, pressure: 0.5, pointerType: 'pen', button: 0, buttons: 3, tiltX: 10 } },
      { port: 'move', event: { time: 0.4, channel: 3, x: 0.6, y: 0.5, pressure: 0, pointerType: 'pen', button: 0, buttons: 2, tiltX: 10 } },
      { port: 'up', event: { time: 0.5, channel: 3, x: 0.6, y: 0.5, pressure: 0, pointerType: 'pen', button: 2, buttons: 0, tiltX: 10 } },
    ];
    expect(events(barrel, 'down').map((e) => [e.time, e.channel, e.button, e.pressure, e.barrel])).toEqual([[0.2, 1, 2, 0, 1]]);
    expect(events(barrel, 'all').map((e) => [e.time, e.phase, e.barrel])).toEqual([[0.1, 'move', 0], [0.2, 'down', 1], [0.3, 'move', 1], [0.4, 'move', 1], [0.5, 'up', 0]]);
    // Pointer reads the same press as a Down too (it has no barrel field).
    const fromPointer = queryTiled(pointer, 'down', 1, 1, { state: {}, pushed: pushedOf(barrel) });
    expect(fromPointer.map((e) => [e.time, e.button, e.pressure])).toEqual([[0.2, 2, 0]]);
    expect(fromPointer[0]!.barrel).toBeUndefined();
    const at = (t: number) => read(barrel, t, 1);
    close(at(0.25), { barrel: 1, pressure: 0, count: 1 });
    close(at(0.35), { barrel: 1, pressure: 0.5, count: 1 });
    close(at(0.45), { barrel: 1, pressure: 0, count: 1 });
    close(at(0.55), { barrel: 0, count: 0 });
    // An Up that still reports the barrel (or the airbrush wheel) frees the slot, and they read 0 there.
    const held: Push[] = [
      { port: 'down', event: { time: 0.1, channel: 3, x: 0.5, y: 0.5, pressure: 0.5, pointerType: 'pen', button: 0, buttons: 3, tangentialPressure: 0.4 } },
      { port: 'up', event: { time: 0.2, channel: 3, x: 0.5, y: 0.5, pressure: 0, pointerType: 'pen', button: 0, buttons: 2, tangentialPressure: 0.4 } },
    ];
    close(read(held, 0.15, 1), { barrel: 1, tangentialPressure: 0.4 });
    close(read(held, 0.25, 1), { barrel: 0, tangentialPressure: 0 });
  });

  it("reads a pen held upright on a slot a new pen has only entered, not the previous pen's values", () => {
    const list: Push[] = [
      { port: 'down', event: { time: 0.1, channel: 7, x: 0.5, y: 0.5, pressure: 0.5, pointerType: 'pen', button: 0, buttons: 3, tiltX: 40, tiltY: 0, twist: 100, tangentialPressure: 0.6 } },
      { port: 'up', event: { time: 0.2, channel: 7, x: 0.5, y: 0.5, pressure: 0, pointerType: 'pen', button: 0, buttons: 0, tiltX: 40, tiltY: 0, twist: 100, tangentialPressure: 0.6 } },
      { port: 'leave', event: { time: 0.25, channel: 7, x: 0.5, y: 0.5, pointerType: 'pen', tiltX: 40 } },
      // Pen 8 enters and takes slot 1, then sends its first move.
      { port: 'enter', event: { time: 0.5, channel: 8, x: 0, y: 0.5, pointerType: 'pen', tiltX: -10 } },
      { port: 'move', event: { time: 0.6, channel: 8, x: 0.1, y: 0.5, pressure: 0, pointerType: 'pen', buttons: 0, tiltX: -10, twist: 5 } },
      // Pen 9 enters slot 2 and leaves without a sample.
      { port: 'enter', event: { time: 0.7, channel: 9, x: 1, y: 0.5, pointerType: 'pen', tiltX: 60 } },
      { port: 'leave', event: { time: 0.75, channel: 9, x: 1, y: 0.5, pointerType: 'pen', tiltX: 60 } },
    ];
    // Pen 7's last values hold on its freed slot until another pen takes it.
    close(read(list, 0.4, 1), { tiltX: 40, twist: 100, altitudeAngle: (50 * Math.PI) / 180 });
    for (const t of [0.5, 0.55]) {
      const row = read(list, t, 1);
      for (const field of PEN_FIELDS) expect(row[field], `${t} ${field}`).toBe(PEN_DEFAULTS[field]);
    }
    close(read(list, 0.65, 1), { tiltX: -10, twist: 5, azimuthAngle: Math.PI });
    for (const t of [0.72, 0.8]) for (const field of PEN_FIELDS) expect(read(list, t, 2)[field], `${t} ${field}`).toBe(PEN_DEFAULTS[field]);
    // The same in 25 ms windows.
    const times = [0.15, 0.4, 0.5, 0.55, 0.65, 0.72, 0.8];
    expect(readSignals(list, 0.025, times, [1, 2])).toEqual(readSignals(list, 1, times, [1, 2]));
  });

  it('gives defined pen fields for weird and out-of-range payloads', () => {
    const fields = (event: Record<string, unknown>) => penFieldsOf(event);
    // Nothing, or nothing finite: a pen held upright.
    expect(fields({})).toEqual(PEN_DEFAULTS);
    expect(fields({ tiltX: NaN, tiltY: 'left', altitudeAngle: Infinity, azimuthAngle: null, twist: NaN, tangentialPressure: -Infinity, buttons: NaN })).toEqual(PEN_DEFAULTS);
    // One tilt axis NaN: it reads 0, and the angles follow the other.
    close(fields({ tiltX: NaN, tiltY: 60 }), { tiltX: 0, tiltY: 60, altitudeAngle: Math.PI / 6, azimuthAngle: H });
    // Out of range: tilt clamps to ±90 (lying flat), altitude to 0–π/2, tangential pressure to ±1.
    close(fields({ tiltX: 200, tiltY: -1000 }), { tiltX: 90, tiltY: -90, altitudeAngle: 0, azimuthAngle: 0 });
    close(fields({ tiltX: 0, tiltY: 0, altitudeAngle: 3, azimuthAngle: 0 }), { altitudeAngle: H });
    close(fields({ tiltX: 0, tiltY: 0, altitudeAngle: -1, azimuthAngle: 0 }), { altitudeAngle: 0 });
    close(fields({ tangentialPressure: 3 }), { tangentialPressure: 1 });
    close(fields({ tangentialPressure: -3 }), { tangentialPressure: -1 });
    // Angles wrap: azimuth into [0, 2π), twist into [0, 360).
    close(fields({ altitudeAngle: Q, azimuthAngle: -H }), { azimuthAngle: 3 * H, tiltX: 0, tiltY: -45 });
    close(fields({ altitudeAngle: Q, azimuthAngle: 5 * H }), { azimuthAngle: H });
    close(fields({ twist: 725 }), { twist: 5 });
    close(fields({ twist: -10 }), { twist: 350 });
    // Lying flat with only altitude and azimuth: ±90 along the azimuth's axes.
    close(fields({ altitudeAngle: 0, azimuthAngle: Math.PI }), { tiltX: -90, tiltY: 0 });
    close(fields({ altitudeAngle: 0, azimuthAngle: Q }), { tiltX: 90, tiltY: 90 });
    // Only an azimuth: upright, so no tilt whatever the azimuth.
    close(fields({ azimuthAngle: 1 }), { altitudeAngle: H, azimuthAngle: 1, tiltX: 0, tiltY: 0 });
    // Flat along an axis: altitude 0, azimuth along it (the spec checks the axes first). Flat off both axes: azimuth 0.
    close(fields({ tiltX: 90, tiltY: 0 }), { altitudeAngle: 0, azimuthAngle: 0 });
    close(fields({ tiltX: -90, tiltY: 0 }), { altitudeAngle: 0, azimuthAngle: Math.PI });
    close(fields({ tiltX: 0, tiltY: 90 }), { altitudeAngle: 0, azimuthAngle: H });
    close(fields({ tiltX: 0, tiltY: -90 }), { altitudeAngle: 0, azimuthAngle: 3 * H });
    close(fields({ tiltX: 90, tiltY: 90 }), { altitudeAngle: 0, azimuthAngle: 0 });
    // Angles to tilt and back agree, lying flat along each axis and leaning anywhere.
    for (const [altitudeAngle, azimuthAngle] of [[0, 0], [0, H], [0, Math.PI], [0, 3 * H], [0.7, 2], [1.2, 5], [Q, Q], [H, 0]] as const) {
      const { tiltX, tiltY } = fields({ altitudeAngle, azimuthAngle });
      close(fields({ tiltX, tiltY }), { altitudeAngle, azimuthAngle });
    }
    // Tilt to angles and back agree, and the host's own altitude and azimuth are kept as sent.
    const derived = fields({ tiltX: 30, tiltY: -40 });
    close(fields({ altitudeAngle: derived.altitudeAngle, azimuthAngle: derived.azimuthAngle }), { tiltX: 30, tiltY: -40 });
    close(fields({ tiltX: 30, tiltY: -40, altitudeAngle: 1, azimuthAngle: 2 }), { tiltX: 30, tiltY: -40, altitudeAngle: 1, azimuthAngle: 2 });
    // The barrel is bit 2 of a whole, non-negative `buttons`: the eraser (32) and the tip (1) aren't it.
    for (const [buttons, barrel] of [[2, 1], [3, 1], [34, 1], [1, 0], [32, 0], [0, 0], [-1, 0], [2.5, 0], ['2', 0]] as const) expect(fields({ buttons }).barrel, `${buttons}`).toBe(barrel);
  });

  it('emits and reads defined values for a weird pen session', () => {
    const weird: Push[] = [
      { port: 'down', event: { time: 0.1, channel: 1, x: NaN, y: 0.5, pressure: 'hard', pointerType: 'pen', tiltX: NaN, tiltY: Infinity, twist: -720, buttons: -3 } },
      { port: 'move', event: { time: 0.2, channel: 1, x: 2, y: -1, pointerType: 'pen', tiltX: 91, altitudeAngle: 9, azimuthAngle: -0 } },
      { port: 'up', event: { time: NaN, channel: 1, pointerType: 'pen' } },
      { port: 'up', event: { time: 0.3, channel: 1.5, pointerType: 'pen' } },
    ];
    const all = events(weird, 'all');
    expect(all.map((e) => [e.time, e.channel, e.phase])).toEqual([[0.1, 1, 'down'], [0.2, 1, 'move']]);
    for (const e of all) for (const field of PEN_FIELDS) expect(Number.isFinite(e[field]), field).toBe(true);
    close(all[0]!, { tiltX: 0, tiltY: 0, twist: 0, barrel: 0 });
    close(all[1]!, { tiltX: 90, altitudeAngle: H, azimuthAngle: 0 });
    const ctx = context(pen, { state: {} });
    query(pen, 0, 1, { state: ctx.state, pushed: pushedOf(weird) });
    for (const port of SIGNALS) for (const t of [NaN, -1, 0.15, Infinity]) expect(Number.isFinite(pen.signal!(ctx, port, t, 1)), `${port} ${t}`).toBe(true);
    expect(pen.signal!(ctx, 'nope', 0.5, 1)).toBe(0);
  });
});
