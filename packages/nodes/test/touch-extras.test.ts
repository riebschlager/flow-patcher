import { describe, expect, it } from 'vitest';
import { compilePatch, inputRouter, replayInput, Runtime, type EngineEvent, type InputEvent, type LoggedEvent, type Patch } from '@flow-patcher/engine';
import { nodeRegistry, touchExtras } from '../src';
import { contactSize, GESTURE_DEFAULTS, MAX_SIZE, MIN_SCALE } from '../src/touch-extras';
import { context, query, queryTiled } from './helpers';

const SIGNALS = ['width', 'height', 'scale', 'rotation'] as const;
type Port = 'enter' | 'down' | 'move' | 'up' | 'cancel' | 'leave' | 'gesture';
type Push = { port: Port; event: EngineEvent };
const RAD = Math.PI / 180;

const node = (id: string, type: string) => ({ id, type, typeVersion: nodeRegistry.get(type)!.version, params: {}, position: { x: 0, y: 0 } });
/** Touch extras and Pointer side by side, reading the same stream. */
const patch: Patch = { format: 'flowpatch', version: 1, seed: 1, nodes: [node('t', 'touch-extras'), node('p', 'pointer')], cables: [] };
function plan() {
  const compiled = compilePatch(patch, nodeRegistry);
  if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
  return compiled.plan;
}

/**
 * Two touches (raw ids 41 and 42) as the host sends them: 41 presses small and flattens, 42 lands
 * while 41 is down, and while both are down Safari sends a pinch out with a clockwise turn. 41 lifts,
 * 42 is cancelled.
 */
const touch = (time: number, channel: number, width: number, height: number, extra: Record<string, unknown> = {}) =>
  ({ time, channel, x: 0.5, y: 0.5, pressure: 0.5, pointerType: 'touch', width, height, buttons: 1, ...extra }) as EngineEvent;
const gesture = (time: number, scale: number, rotation: number, extra: Record<string, unknown> = {}) =>
  ({ time, channel: 0, x: 0.5, y: 0.5, scale, rotation, shift: false, alt: false, ctrl: false, meta: false, ...extra }) as EngineEvent;
const session: Push[] = [
  { port: 'down', event: touch(0.1, 41, 20, 22) },
  { port: 'move', event: touch(0.15, 41, 30, 26) },
  { port: 'down', event: touch(0.2, 42, 12, 14) },
  { port: 'gesture', event: gesture(0.22, 1.1, 5) },
  { port: 'move', event: touch(0.25, 42, 16, 18) },
  { port: 'gesture', event: gesture(0.27, 1.5, 15) },
  { port: 'gesture', event: gesture(0.32, 2, 30) },
  { port: 'up', event: touch(0.4, 41, 30, 26, { pressure: 0, buttons: 0 }) },
  { port: 'cancel', event: touch(0.5, 42, 16, 18, { pressure: 0, buttons: 0 }) },
];

function pushedOf(list: readonly Push[]): Record<string, EngineEvent[]> {
  const out: Record<string, EngineEvent[]> = {};
  for (const { port, event } of list) (out[port] ??= []).push(event);
  return out;
}
const events = (list: readonly Push[], step = 1, end = 1) => queryTiled(touchExtras, 'gesture', end, step, { state: {}, pushed: pushedOf(list) });

/** Queries [0, end) in windows of `step` on one state, reading every signal on `channels` at `times` after the window holding each. */
function readSignals(list: readonly Push[], step: number, times: number[], channels: number[], end = 1): Record<string, number>[] {
  const state: Record<string, unknown> = {};
  const pushed = pushedOf(list);
  const ctx = context(touchExtras, { state });
  const rows: Record<string, number>[] = [];
  for (let i = 0; i * step < end - 1e-9; i++) {
    const t0 = i * step, t1 = Math.min(end, (i + 1) * step);
    query(touchExtras, t0, t1, { state, pushed });
    for (const t of times.filter((time) => time >= t0 && time < t1)) {
      for (const channel of channels) {
        const row: Record<string, number> = { t, channel };
        for (const port of SIGNALS) row[port] = touchExtras.signal!(ctx, port, t, channel);
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

describe('touch-extras', () => {
  it('has Gesture and the four signals, no All, and reads touches (no coalesced samples) and gesturechange', () => {
    expect(touchExtras.category).toBe('canvas-sources');
    expect(touchExtras.ports.map((p) => [p.name, p.type, p.direction])).toEqual([['gesture', 'event', 'out'], ...SIGNALS.map((name) => [name, 'signal', 'out'])]);
    expect(touchExtras.ports.some((p) => p.name === 'all')).toBe(false);
    expect(touchExtras.params).toEqual([]);
    expect(touchExtras.input!.rewrites).toBe(true);
    const router = inputRouter(plan());
    const types = [['pointerenter', 'enter'], ['pointerdown', 'down'], ['pointermove', 'move'], ['pointerup', 'up'], ['pointercancel', 'cancel'], ['pointerleave', 'leave']] as const;
    for (const [type, port] of types) {
      const touchFields = { channel: 3, x: 0.5, y: 0.5, pointerType: 'touch', width: 20, height: 20 };
      expect(router.route({ type, ...touchFields })).toEqual([{ node: 't', port, fields: touchFields }, { node: 'p', port, fields: touchFields }]);
      for (const pointerType of ['mouse', 'pen', undefined]) {
        const fields = { channel: 3, x: 0.5, y: 0.5, ...(pointerType ? { pointerType } : {}) };
        expect(router.route({ type, ...fields })).toEqual([{ node: 'p', port, fields }]);
      }
    }
    expect(router.route({ type: 'pointermove', channel: 3, pointerType: 'touch', coalesced: true })).toEqual([]);
    expect(router.route({ type: 'gesturechange', scale: 1.2, rotation: 3 })).toEqual([{ node: 't', port: 'gesture', fields: { channel: 0, scale: 1.2, rotation: 3 } }]);
  });

  it('emits nothing by itself, and reads 0 × 0 and Safari\'s resting gesture (1, 0) before any input', () => {
    expect(queryTiled(touchExtras, 'gesture', 2, 0.025)).toEqual([]);
    for (const [t0, t1] of [[1, 1], [2, 1], [NaN, 1], [0, Infinity]]) expect(query(touchExtras, t0!, t1!)).toEqual({});
    const ctx = context(touchExtras, { state: {} });
    for (const channel of [0, 1, 7]) expect(SIGNALS.map((port) => touchExtras.signal!(ctx, port, 0.5, channel))).toEqual([0, 0, 1, 0]);
    expect(GESTURE_DEFAULTS).toEqual({ scale: 1, rotation: 0 });
  });

  it('emits each gesturechange on Gesture with its scale, rotation in radians, position and modifiers, on channel 0', () => {
    const out = events(session);
    expect(out.map((e) => [e.time, e.channel])).toEqual([[0.22, 0], [0.27, 0], [0.32, 0]]);
    close(out[0]!, { scale: 1.1, rotation: 5 * RAD, x: 0.5, y: 0.5 });
    close(out[2]!, { scale: 2, rotation: Math.PI / 6 });
    expect(out[1]).toMatchObject({ shift: false, alt: false, ctrl: false, meta: false });
    // No touch event reaches an output.
    expect(Object.keys(query(touchExtras, 0, 1, { state: {}, pushed: pushedOf(session) }))).toEqual(['gesture']);
  });

  it('gives the same events in one, two and three windows and in 25 ms tiles', () => {
    const reference = JSON.stringify(events(session));
    for (const step of [0.5, 1 / 3, 0.025]) expect(JSON.stringify(events(session, step)), `${step}`).toBe(reference);
  });

  it('gives the same signal values in one window and in 25 and 100 ms tiles', () => {
    const times = [0, 0.12, 0.17, 0.21, 0.23, 0.26, 0.28, 0.35, 0.45, 0.55, 0.9];
    const reference = readSignals(session, 1, times, [0, 1, 2, 5]);
    for (const step of [0.1, 0.025]) expect(readSignals(session, step, times, [0, 1, 2, 5])).toEqual(reference);
  });

  it("reads each touch's size on its slot, 0 once it lifts, and the gesture the same on every channel, held after it", () => {
    close(read(session, 0.12, 1), { width: 20, height: 22, scale: 1, rotation: 0 });
    close(read(session, 0.17, 1), { width: 30, height: 26 });
    // Both down: slot 2 is 42; channel 0 and a channel no slot has had read the latest (42).
    close(read(session, 0.26, 1), { width: 30, height: 26, scale: 1.1, rotation: 5 * RAD });
    close(read(session, 0.26, 2), { width: 16, height: 18, scale: 1.1 });
    expect(read(session, 0.26, 0)).toEqual({ ...read(session, 0.26, 2), channel: 0 });
    expect(read(session, 0.26, 5)).toEqual({ ...read(session, 0.26, 2), channel: 5 });
    close(read(session, 0.3, 7), { scale: 1.5, rotation: 15 * RAD });
    // 41 lifted: slot 1 reads 0; 42 still down.
    close(read(session, 0.45, 1), { width: 0, height: 0, scale: 2, rotation: Math.PI / 6 });
    close(read(session, 0.45, 2), { width: 16, height: 18 });
    // Both gone: sizes 0; the gesture holds its last values (no gestureend in the stream).
    close(read(session, 0.9, 2), { width: 0, height: 0, scale: 2, rotation: Math.PI / 6 });
    close(read(session, 0.9, 0), { width: 0, height: 0, scale: 2 });
  });

  it("reads 0 on a slot taken by an enter alone, not the previous finger's size, until the new touch's down", () => {
    const list: Push[] = [
      { port: 'down', event: touch(0.1, 41, 20, 22) },
      { port: 'up', event: touch(0.2, 41, 20, 22, { pressure: 0, buttons: 0 }) },
      { port: 'enter', event: touch(0.3, 42, 30, 34, { buttons: 0 }) },
      { port: 'down', event: touch(0.4, 42, 30, 34) },
    ];
    // 42's enter takes slot 1, whose payload is still 41's.
    for (const channel of [0, 1]) {
      close(read(list, 0.15, channel), { width: 20, height: 22 });
      close(read(list, 0.35, channel), { width: 0, height: 0 });
      close(read(list, 0.45, channel), { width: 30, height: 34 });
    }
    for (const step of [0.1, 0.025]) expect(readSignals(list, step, [0.35, 0.45], [0, 1])).toEqual(readSignals(list, 1, [0.35, 0.45], [0, 1]));
  });

  it('keeps mice and pens out of the slots, live from the stream, with Pointer beside it numbering all of them', () => {
    const stream: InputEvent[] = [
      { time: 0.05, type: 'pointerdown', channel: 1, x: 0.1, y: 0.2, pressure: 0.5, pointerType: 'mouse', width: 1, height: 1, buttons: 1 },
      { time: 0.1, type: 'pointerdown', channel: 30, x: 0.9, y: 0.9, pressure: 0.5, pointerType: 'touch', width: 24, height: 28, buttons: 1 },
      { time: 0.12, type: 'pointerdown', channel: 2, x: 0.5, y: 0.5, pressure: 0.3, pointerType: 'pen', width: 1, height: 1, buttons: 1 },
      { time: 0.14, type: 'gesturechange', x: 0.4, y: 0.6, scale: 0.5, rotation: -90, shift: true, alt: false, ctrl: false, meta: false },
      { time: 0.2, type: 'pointerup', channel: 30, x: 0.9, y: 0.9, pressure: 0, pointerType: 'touch', width: 24, height: 28, buttons: 0 },
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
    const touchLog = log.filter((e) => e.node === 't');
    expect(touchLog.map((e) => [e.time, e.port, e.channel])).toEqual([[0.14, 'gesture', 0]]);
    close(touchLog[0]!, { scale: 0.5, rotation: -Math.PI / 2, x: 0.4, y: 0.6 });
    expect(touchLog[0]!.shift).toBe(true);
    // Pointer gave the touch slot 2.
    expect(log.filter((e) => e.node === 'p' && e.port === 'down').map((e) => [e.channel, e.pointerType])).toEqual([[1, 'mouse'], [2, 'touch'], [3, 'pen']]);
    // Touch extras gives it slot 1, and a mouse or pen pushed straight into the query (past the router) is dropped too.
    const state = {};
    const downs = stream.filter((e) => e.type === 'pointerdown').map(({ type: _type, ...e }) => e as EngineEvent);
    query(touchExtras, 0, 0.15, { state, pushed: { down: downs } });
    const ctx = context(touchExtras, { state });
    close({ w: touchExtras.signal!(ctx, 'width', 0.13, 1), h: touchExtras.signal!(ctx, 'height', 0.13, 1), w0: touchExtras.signal!(ctx, 'width', 0.13, 0) }, { w: 24, h: 28, w0: 24 });
    expect(touchExtras.signal!(ctx, 'width', 0.13, 2)).toBe(24);
  });

  it('gives defined sizes and gestures for weird and out-of-range input', () => {
    for (const [value, size] of [[0, 0], [-5, 0], [NaN, 0], [Infinity, 0], ['20', 0], [undefined, 0], [12.5, 12.5], [1e9, MAX_SIZE], [-0, 0]] as const) expect(contactSize(value), `${value}`).toBe(size);
    const weird: Push[] = [
      // A 0-width touch, one with NaN size, and junk pushes (no time, a non-integer id).
      { port: 'down', event: touch(0.1, 1, 0, NaN) },
      { port: 'down', event: touch(0.12, 2, -3, 1e9) },
      { port: 'down', event: { time: NaN, channel: 3, pointerType: 'touch', width: 40 } },
      { port: 'down', event: { time: 0.13, channel: 3.5, pointerType: 'touch', width: 40 } },
      // A gesture with no fields, a negative and a zero scale, NaN rotation, out-of-range position, a huge scale.
      { port: 'gesture', event: { time: 0.2, channel: 9 } },
      { port: 'gesture', event: gesture(0.25, 1.5, 10, { x: 2, y: NaN }) },
      { port: 'gesture', event: gesture(0.3, -2, NaN) },
      { port: 'gesture', event: gesture(0.35, 0, 20) },
      { port: 'gesture', event: gesture(0.4, 1e9, -Infinity) },
      { port: 'gesture', event: { time: NaN, channel: 0, scale: 3, rotation: 3 } },
      { port: 'gesture', event: gesture(0.45, 1e-9, 0) },
    ];
    const out = events(weird);
    expect(out.map((e) => [e.time, e.channel])).toEqual([[0.2, 0], [0.25, 0], [0.3, 0], [0.35, 0], [0.4, 0], [0.45, 0]]);
    // No fields: the defaults. A non-positive scale or a NaN rotation keeps the previous value.
    close(out[0]!, { scale: 1, rotation: 0 });
    close(out[1]!, { scale: 1.5, rotation: 10 * RAD, x: 1 });
    expect(out[1]!.y).toBeUndefined();
    close(out[2]!, { scale: 1.5, rotation: 10 * RAD });
    close(out[3]!, { scale: 1.5, rotation: 20 * RAD });
    close(out[4]!, { scale: 1 / MIN_SCALE, rotation: 20 * RAD });
    close(out[5]!, { scale: MIN_SCALE, rotation: 0 });
    expect(JSON.stringify(events(weird, 0.025))).toBe(JSON.stringify(out));
    close(read(weird, 0.15, 1), { width: 0, height: 0 });
    close(read(weird, 0.15, 2), { width: 0, height: MAX_SIZE });
    close(read(weird, 0.32, 0), { scale: 1.5, rotation: 10 * RAD });
    const ctx = context(touchExtras, { state: {} });
    query(touchExtras, 0, 1, { state: ctx.state, pushed: pushedOf(weird) });
    for (const port of SIGNALS) for (const t of [NaN, -1, 0.15, Infinity]) for (const channel of [0, 1, 3, NaN]) expect(Number.isFinite(touchExtras.signal!(ctx, port, t, channel)), `${port} ${t} ${channel}`).toBe(true);
    expect(touchExtras.signal!(ctx, 'nope', 0.5, 1)).toBe(0);
  });
});
