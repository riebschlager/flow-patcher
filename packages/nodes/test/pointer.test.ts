import { describe, expect, it } from 'vitest';
import { compilePatch, IMMEDIATE_OFFSET, inputRouter, ManualClock, Runtime, Scheduler, type EngineEvent, type LoggedEvent, type Patch } from '@flow-patcher/engine';
import { nodeRegistry, pointer } from '../src';
import { MAX_SLOTS, STILL } from '../src/pointer';
import { context, query, queryTiled } from './helpers';

const PHASES = ['down', 'move', 'up', 'cancel'] as const;
const EVENT_PORTS = [...PHASES, 'all'] as const;
const SIGNALS = ['x', 'y', 'pressure', 'speed', 'count'] as const;
/** The ports a push lands on: the phases, and the push-only enter and leave. */
type Port = (typeof PHASES)[number] | 'enter' | 'leave';
type Push = { port: Port; event: EngineEvent };

const node = (id: string, type: string, params = {}) => ({ id, type, typeVersion: nodeRegistry.get(type)!.version, params, position: { x: 0, y: 0 } });

/** Pointer, with Down feeding a Make Note and Y its pitch, as in examples/pointer-notes.flowpatch: 76 − 24 × Y. */
const patch: Patch = {
  format: 'flowpatch',
  version: 1,
  seed: 1,
  nodes: [node('p', 'pointer'), node('note', 'make-note', { pitch: 76 })],
  cables: [
    { from: { node: 'p', port: 'down' }, to: { node: 'note', port: 'trigger' } },
    { from: { node: 'p', port: 'y' }, to: { node: 'note', port: 'pitch' }, depth: -24 },
  ],
};

function runtime(history = false): Runtime {
  const compiled = compilePatch(patch, nodeRegistry);
  if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
  return new Runtime(compiled.plan, { history });
}

/**
 * Raw pointerIds as a browser sends them: a mouse (1) hovering in, pressing and
 * leaving; touches 41 and 42 overlapping; 43 after 41 lifts, reusing its slot;
 * 44 cancelled. Times are on 10 ms steps so motion is easy to check.
 */
const session: Push[] = [
  { port: 'enter', event: { time: 0.05, channel: 1, x: 0, y: 0.5, pointerType: 'mouse' } },
  { port: 'move', event: { time: 0.06, channel: 1, x: 0.1, y: 0.5, pressure: 0, pointerType: 'mouse', buttons: 0 } },
  { port: 'move', event: { time: 0.08, channel: 1, x: 0.2, y: 0.5, pressure: 0, pointerType: 'mouse', buttons: 0 } },
  { port: 'down', event: { time: 0.1, channel: 41, x: 0.5, y: 0.5, pressure: 0.6, pointerType: 'touch', width: 20, height: 22 } },
  { port: 'down', event: { time: 0.12, channel: 1, x: 0.2, y: 0.5, pressure: 0.5, pointerType: 'mouse', button: 0, buttons: 1, shift: true } },
  { port: 'move', event: { time: 0.14, channel: 41, x: 0.5, y: 0.3, pressure: 0.7, pointerType: 'touch' } },
  { port: 'down', event: { time: 0.15, channel: 42, x: 0.9, y: 0.9, pressure: 0.4, pointerType: 'touch' } },
  { port: 'up', event: { time: 0.2, channel: 41, x: 0.5, y: 0.3, pressure: 0, pointerType: 'touch' } },
  { port: 'leave', event: { time: 0.2, channel: 41, x: 0.5, y: 0.3, pointerType: 'touch' } },
  { port: 'down', event: { time: 0.25, channel: 43, x: 0.3, y: 0.7, pressure: 0.5, pointerType: 'touch' } },
  { port: 'move', event: { time: 0.3, channel: 1, x: 0.4, y: 0.5, pressure: 0.5, pointerType: 'mouse', buttons: 1 } },
  { port: 'up', event: { time: 0.32, channel: 1, x: 0.4, y: 0.5, pressure: 0, pointerType: 'mouse', button: 0, buttons: 0 } },
  { port: 'move', event: { time: 0.34, channel: 1, x: 0.45, y: 0.5, pressure: 0, pointerType: 'mouse', buttons: 0 } },
  { port: 'cancel', event: { time: 0.4, channel: 42, x: 0.9, y: 0.9, pressure: 0, pointerType: 'touch' } },
  { port: 'leave', event: { time: 0.45, channel: 1, x: 0.5, y: 0.5, pointerType: 'mouse' } },
  { port: 'up', event: { time: 0.5, channel: 43, x: 0.3, y: 0.6, pressure: 0, pointerType: 'touch' } },
  { port: 'down', event: { time: 0.6, channel: 44, x: 0.6, y: 0.6, pointerType: 'touch' } },
  { port: 'cancel', event: { time: 0.7, channel: 44, x: 0.6, y: 0.6, pressure: 0, pointerType: 'touch' } },
];

function pushedOf(list: readonly Push[]): Record<string, EngineEvent[]> {
  const out: Record<string, EngineEvent[]> = {};
  for (const { port, event } of list) (out[port] ??= []).push(event);
  return out;
}

const pick = (log: LoggedEvent[], id: string, port: string) => log.filter((e) => e.node === id && e.port === port).map(({ node: _n, port: _p, ...e }) => e);

/** Every push known in advance (past the horizon), then [0, end) queried in windows of `step`. */
function runAhead(list: readonly Push[], step: number, end = 1): LoggedEvent[] {
  const rt = runtime();
  for (const { port, event } of list) expect(rt.push('p', port, { ...event })).toBeNull();
  const log: LoggedEvent[] = [];
  for (let i = 0; i * step < end - 1e-9; i++) log.push(...rt.query(i * step, Math.min(end, (i + 1) * step)));
  return rt.sortLog(log);
}

/** Live: each push arrives after the runtime has already queried 120 ms past it, so it rewinds. */
function runLive(list: readonly Push[], step: number, end = 1): LoggedEvent[] {
  const rt = runtime(true);
  let log: LoggedEvent[] = [];
  let next = 0;
  const queryTo = (t: number) => {
    for (; next * step < Math.min(end, t) - 1e-9; next++) log.push(...rt.query(next * step, Math.min(end, (next + 1) * step)));
  };
  let rewinds = 0;
  for (const { port, event } of list) {
    queryTo(event.time + 0.12);
    const report = rt.push('p', port, { ...event });
    if (!report) continue;
    // Apply the rewind to the log as the Scheduler does: replace what the affected nodes logged from its time on.
    rewinds++;
    log = [...log.filter((e) => !(report.affected.has(e.node) && e.time >= report.time)), ...report.added];
  }
  queryTo(end);
  expect(rewinds).toBe(list.length);
  return rt.sortLog(log);
}

/** One port's events from query() over [0, end) in windows of `step`, on one state. */
const events = (list: readonly Push[], port: string, step = 1, end = 1) => queryTiled(pointer, port, end, step, { state: {}, pushed: pushedOf(list) });

describe('pointer', () => {
  it('has the five event outputs, the five signals, and reads every pointer type, rewriting its pushes (M2 complete)', () => {
    expect(pointer.category).toBe('canvas-sources');
    expect(pointer.version).toBe(2);
    expect(pointer.ports.map((p) => [p.name, p.type, p.direction])).toEqual([
      ...EVENT_PORTS.map((name) => [name, 'event', 'out']),
      ...SIGNALS.map((name) => [name, 'signal', 'out']),
    ]);
    expect(pointer.params).toEqual([]);
    expect(pointer.input!.rewrites).toBe(true);
    const compiled = compilePatch(patch, nodeRegistry);
    if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
    const router = inputRouter(compiled.plan);
    expect([...router.types].sort()).toEqual(['pointercancel', 'pointerdown', 'pointerenter', 'pointerleave', 'pointermove', 'pointerup']);
    const fields = { channel: 3, x: 0.5, y: 0.5, pressure: 0.5, pointerType: 'pen' };
    for (const [type, port] of [['pointerenter', 'enter'], ['pointerdown', 'down'], ['pointermove', 'move'], ['pointerup', 'up'], ['pointercancel', 'cancel'], ['pointerleave', 'leave']] as const) {
      expect(router.route({ type, ...fields })).toEqual([{ node: 'p', port, fields }]);
    }
    // Coalesced samples are Pointer (high rate)'s.
    expect(router.route({ type: 'pointermove', ...fields, coalesced: true })).toEqual([]);
    expect(router.route({ type: 'contextmenu', ...fields })).toEqual([]);
  });

  it('emits nothing by itself, in any window and however the windows are split', () => {
    for (const port of EVENT_PORTS) {
      expect(queryTiled(pointer, port, 2, 0.025)).toEqual([]);
      expect(query(pointer, 0, 2)[port] ?? []).toEqual([]);
    }
    // Weird windows: empty, reversed, NaN and infinite.
    for (const [t0, t1] of [[1, 1], [2, 1], [NaN, 1], [0, Infinity], [-Infinity, NaN]]) expect(query(pointer, t0!, t1!)).toEqual({});
  });

  it('maps pointerIds to the lowest free slot from 1, freeing it on up, cancel or a leave', () => {
    const channels = (port: string) => events(session, port).map((e) => [e.time, e.channel]);
    // Mouse 1 hovers into slot 1 and keeps it through its press; touch 41 gets 2, 42 gets 3.
    expect(channels('down')).toEqual([[0.1, 2], [0.12, 1], [0.15, 3], [0.25, 2], [0.6, 1]]);
    // 41 lifts at 0.2 and 43 reuses slot 2. The mouse's up frees 1, and its hover at 0.34 takes 1
    // again (the lowest free). Its leave frees 1, so 44 gets it.
    expect(channels('up')).toEqual([[0.2, 2], [0.32, 1], [0.5, 2]]);
    expect(channels('move')).toEqual([[0.06, 1], [0.08, 1], [0.14, 2], [0.3, 1], [0.34, 1]]);
    expect(channels('cancel')).toEqual([[0.4, 3], [0.7, 1]]);
    // Plain data: the slot map is in state, and after everything every slot is free.
    const state: Record<string, unknown> = {};
    query(pointer, 0, 1, { state, pushed: pushedOf(session) });
    query(pointer, 1, 2, { state });
    expect((state.contacts as { slot: number; id: number | null }[]).map((c) => [c.slot, c.id]).sort()).toEqual([[1, null], [2, null], [3, null]]);
  });

  it('keeps a pointer that is down in its slot through a leave, and drops an up or cancel with no contact down', () => {
    const list: Push[] = [
      { port: 'down', event: { time: 0.1, channel: 5, x: 0.1, y: 0.1 } },
      // Without pointer capture a leave can come mid-press: the contact goes on.
      { port: 'leave', event: { time: 0.2, channel: 5 } },
      { port: 'move', event: { time: 0.3, channel: 5, x: 0.2, y: 0.1 } },
      { port: 'down', event: { time: 0.35, channel: 6, x: 0.5, y: 0.5 } },
      { port: 'up', event: { time: 0.4, channel: 5, x: 0.2, y: 0.1 } },
      // Pressed outside the canvas, dragged in and released: hover moves, then an up with no contact. It's
      // dropped; the pointer keeps hovering on its slot.
      { port: 'move', event: { time: 0.45, channel: 77, x: 0.9, y: 0.9 } },
      { port: 'up', event: { time: 0.5, channel: 77, x: 0.9, y: 0.9 } },
      // An up and a cancel on pointers never seen take no slot.
      { port: 'up', event: { time: 0.52, channel: 80, x: 0.9, y: 0.9 } },
      { port: 'cancel', event: { time: 0.53, channel: 81, x: 0.9, y: 0.9 } },
      { port: 'down', event: { time: 0.6, channel: 78, x: 0.8, y: 0.8 } },
      // A leave from a pointer never seen changes nothing.
      { port: 'leave', event: { time: 0.65, channel: 99 } },
    ];
    expect(events(list, 'all').map((e) => [e.time, e.channel, e.phase])).toEqual([
      [0.1, 1, 'down'], [0.3, 1, 'move'], [0.35, 2, 'down'], [0.4, 1, 'up'], [0.45, 1, 'move'], [0.6, 3, 'down'],
    ]);
    // With every slot held, an orphan up evicts nobody.
    const full: Push[] = Array.from({ length: MAX_SLOTS }, (_, k) => ({ port: 'down' as const, event: { time: 0.01 * (k + 1), channel: 200 + k } }));
    full.push({ port: 'up', event: { time: 0.5, channel: 999 } });
    expect(events(full, 'cancel')).toEqual([]);
    expect(events(full, 'up')).toEqual([]);
  });

  it('passes the payload through and adds the derived fields, per slot', () => {
    const all = events(session, 'all');
    const at = (time: number, channel: number) => all.find((e) => e.time === time && e.channel === channel)!;
    // A slot's first sample has no motion; the mouse's hover then moves 0.1 in 20 ms: 5 units/s to the right.
    expect(at(0.06, 1)).toMatchObject({ dx: 0, dy: 0, speed: 0, angle: 0, age: 0, phase: 'move' });
    expect(at(0.08, 1).dx).toBeCloseTo(5, 9);
    expect(at(0.08, 1)).toMatchObject({ dy: 0, angle: 0, age: 0 });
    // The press doesn't move: speed 0, angle holds the last direction. Payload fields ride along.
    expect(at(0.12, 1)).toMatchObject({ dx: 0, dy: 0, speed: 0, angle: 0, age: 0, button: 0, buttons: 1, shift: true, pressure: 0.5, pointerType: 'mouse' });
    // Touch 41 (slot 2) moves up 0.2 in 40 ms: dy −5, angle −π/2 (y = 0 at the top). Age runs from its down.
    const move = at(0.14, 2);
    expect(move.dx).toBeCloseTo(0, 9);
    expect(move.dy).toBeCloseTo(-5, 9);
    expect(move.speed).toBeCloseTo(5, 9);
    expect(move.angle).toBeCloseTo(-Math.PI / 2, 9);
    expect(move.age).toBeCloseTo(0.04, 9);
    expect(at(0.1, 2)).toMatchObject({ width: 20, height: 22, pointerType: 'touch', pressure: 0.6 });
    // Its up: still, the angle kept, aged 0.1 s.
    expect(at(0.2, 2)).toMatchObject({ speed: 0, phase: 'up' });
    expect(at(0.2, 2).angle).toBeCloseTo(-Math.PI / 2, 9);
    expect(at(0.2, 2).age).toBeCloseTo(0.1, 9);
    // Slot 2 again, for 43: a new pointer starts with no motion.
    expect(at(0.25, 2)).toMatchObject({ dx: 0, dy: 0, speed: 0, angle: 0, age: 0 });
    // The mouse's drag: 0.2 in 180 ms since its down; its up ages 0.2 s; its hover after has age 0.
    expect(at(0.3, 1).dx).toBeCloseTo(0.2 / 0.18, 9);
    expect(at(0.3, 1).age).toBeCloseTo(0.18, 9);
    expect(at(0.32, 1).age).toBeCloseTo(0.2, 9);
    expect(at(0.34, 1)).toMatchObject({ dx: 0, age: 0, phase: 'move' });
    // The per-phase ports carry the same events without `phase`.
    const { phase: _phase, ...down } = at(0.12, 1);
    expect(events(session, 'down').find((e) => e.time === 0.12)).toEqual(down);
  });

  it('keeps the motion for a sample at the same time as the previous one, and measures the next from the earlier', () => {
    const list: Push[] = [
      { port: 'down', event: { time: 0.1, channel: 9, x: 0.1, y: 0.1 } },
      { port: 'move', event: { time: 0.2, channel: 9, x: 0.2, y: 0.1 } },
      { port: 'move', event: { time: 0.2, channel: 9, x: 0.3, y: 0.1 } },
      { port: 'move', event: { time: 0.3, channel: 9, x: 0.4, y: 0.1 } },
    ];
    const dx = events(list, 'move').map((e) => e.dx as number);
    expect(dx[0]).toBeCloseTo(1, 9);
    expect(dx[1]).toBeCloseTo(1, 9);
    // From the 0.2 reference at x 0.2: 0.2 in 100 ms.
    expect(dx[2]).toBeCloseTo(2, 9);
  });

  it('puts every event on All in time order with its phase, hover moves included, and a leave only for a hovering pointer', () => {
    const all = events(session, 'all');
    expect(all.map((e) => [e.time, e.channel, e.phase])).toEqual([
      [0.06, 1, 'move'], [0.08, 1, 'move'], [0.1, 2, 'down'], [0.12, 1, 'down'], [0.14, 2, 'move'], [0.15, 3, 'down'],
      [0.2, 2, 'up'], [0.25, 2, 'down'], [0.3, 1, 'move'], [0.32, 1, 'up'], [0.34, 1, 'move'], [0.4, 3, 'cancel'],
      [0.45, 1, 'leave'], [0.5, 2, 'up'], [0.6, 1, 'down'], [0.7, 1, 'cancel'],
    ]);
    // One per down, move, up and cancel pushed, and one for the mouse's leave while hovering. Enter emits
    // nothing, and touch 41's leave after its up finds no slot left to free.
    expect(all).toHaveLength(session.filter((p) => p.port !== 'enter' && p.port !== 'leave').length + 1);
    // The leave is on All only, with the slot's last hover position (0.45, 0.5), not the leave's own.
    expect(all.find((e) => e.phase === 'leave')).toEqual({ time: 0.45, channel: 1, x: 0.45, y: 0.5, pressure: 0, pointerType: 'mouse', dx: 0, dy: 0, speed: 0, angle: 0, age: 0, phase: 'leave' });
    for (const port of PHASES) expect(events(session, port).some((e) => e.time === 0.45), port).toBe(false);
    // A pointer that enters and leaves without moving still held a slot, so its leave is marked too.
    const only = [{ port: 'enter', event: { time: 0.1, channel: 2 } }, { port: 'leave', event: { time: 0.2, channel: 2 } }] as Push[];
    expect(query(pointer, 0, 1, { pushed: pushedOf(only) })).toEqual({ all: [{ time: 0.2, channel: 1, x: 0, y: 0, pressure: 0, dx: 0, dy: 0, speed: 0, angle: 0, age: 0, phase: 'leave' }] });
    // A leave while down, or from a pointer never seen, emits nothing.
    const pressed = [{ port: 'down', event: { time: 0.1, channel: 2 } }, { port: 'leave', event: { time: 0.2, channel: 2 } }, { port: 'leave', event: { time: 0.3, channel: 9 } }] as Push[];
    expect(events(pressed, 'all').map((e) => e.phase)).toEqual(['down']);
  });

  it('orders same-time pushes Down, Move, Up, Cancel on one pointer, and new pointers by pointerId', () => {
    const list: Push[] = [
      { port: 'up', event: { time: 0.075, channel: 20, x: 0.3, y: 0.3 } },
      { port: 'move', event: { time: 0.075, channel: 20, x: 0.2, y: 0.2 } },
      { port: 'down', event: { time: 0.075, channel: 20, x: 0.1, y: 0.1 } },
      { port: 'down', event: { time: 0.075, channel: 10, x: 0.6, y: 0.4 } },
    ];
    expect(events(list, 'all').map((e) => [e.channel, e.phase])).toEqual([[1, 'down'], [2, 'down'], [2, 'move'], [2, 'up']]);
  });

  it('frees a lifting pointer\'s slot before another takes one at the same time, whatever the pointerIds', () => {
    const list: Push[] = [
      { port: 'down', event: { time: 0.1, channel: 50, x: 0.1 } },
      { port: 'down', event: { time: 0.1, channel: 60, x: 0.2 } },
      // In one quantum: 50 lifts, 49 presses. 49 takes 50's slot.
      { port: 'down', event: { time: 0.2, channel: 49, x: 0.3 } },
      { port: 'up', event: { time: 0.2, channel: 50, x: 0.1 } },
      // A leave frees first too.
      { port: 'move', event: { time: 0.3, channel: 70, x: 0.5 } },
      { port: 'up', event: { time: 0.3, channel: 60, x: 0.2 } },
      { port: 'down', event: { time: 0.4, channel: 61, x: 0.6 } },
    ];
    expect(events(list, 'all').map((e) => [e.time, e.channel, e.phase])).toEqual([
      [0.1, 1, 'down'], [0.1, 2, 'down'], [0.2, 1, 'up'], [0.2, 1, 'down'], [0.3, 2, 'up'], [0.3, 2, 'move'], [0.4, 3, 'down'],
    ]);
    // A drag whose last move and Up share a stamp frees first too.
    const drag: Push[] = [
      { port: 'down', event: { time: 0.1, channel: 50 } },
      { port: 'down', event: { time: 0.1, channel: 60 } },
      { port: 'down', event: { time: 0.2, channel: 49 } },
      { port: 'move', event: { time: 0.2, channel: 50, x: 0.4, buttons: 1 } },
      { port: 'up', event: { time: 0.2, channel: 50, x: 0.4 } },
    ];
    expect(events(drag, 'all').map((e) => [e.time, e.channel, e.phase])).toEqual([
      [0.1, 1, 'down'], [0.1, 2, 'down'], [0.2, 1, 'move'], [0.2, 1, 'up'], [0.2, 1, 'down'],
    ]);
    // A tap (down and up at one time) on one pointer still opens before it ends.
    const tap: Push[] = [{ port: 'up', event: { time: 0.1, channel: 5 } }, { port: 'down', event: { time: 0.1, channel: 5 } }, { port: 'down', event: { time: 0.1, channel: 4 } }];
    expect(events(tap, 'all').map((e) => [e.channel, e.phase])).toEqual([[1, 'down'], [2, 'down'], [2, 'up']]);
  });

  it('applies a hover move flushed with a Down at one stamp before it, and one after an Up after it', () => {
    const list: Push[] = [
      { port: 'move', event: { time: 0.1, channel: 1, x: 0.1, buttons: 0, pressure: 0 } },
      { port: 'down', event: { time: 0.2, channel: 1, x: 0.3, buttons: 1, pressure: 0.5 } },
      { port: 'move', event: { time: 0.2, channel: 1, x: 0.2, buttons: 0, pressure: 0 } },
      { port: 'move', event: { time: 0.25, channel: 1, x: 0.4, buttons: 1, pressure: 0.5 } },
      { port: 'up', event: { time: 0.3, channel: 1, x: 0.4, buttons: 0, pressure: 0 } },
      { port: 'move', event: { time: 0.3, channel: 1, x: 0.5, buttons: 0, pressure: 0 } },
    ];
    expect(events(list, 'all').map((e) => [e.time, e.phase, e.x, e.age])).toEqual([
      [0.1, 'move', 0.1, 0], [0.2, 'move', 0.2, 0], [0.2, 'down', 0.3, 0], [0.25, 'move', 0.4, expect.closeTo(0.05, 9)], [0.3, 'up', 0.4, expect.closeTo(0.1, 9)], [0.3, 'move', 0.5, 0],
    ]);
    // The pressure the signal reads at the Down is the Down's, not the hover's 0.
    expect(read(list, 0.2, 1).pressure).toBe(0.5);
  });

  it('gives the same events on every port in one, two and three windows and in 25 ms tiles', () => {
    for (const port of EVENT_PORTS) {
      const reference = JSON.stringify(events(session, port));
      for (const step of [0.5, 1 / 3, 0.025]) expect(JSON.stringify(events(session, port, step)), `${port} ${step}`).toBe(reference);
    }
  });

  it('gives the same log ahead, tiled and when every push rewinds, and Make Note follows on the slot', () => {
    const reference = JSON.stringify(runAhead(session, 1));
    for (const step of [0.5, 1 / 3, 0.1, 0.025]) expect(JSON.stringify(runAhead(session, step)), `${step}`).toBe(reference);
    expect(JSON.stringify(runLive(session, 0.025))).toBe(reference);
    expect(JSON.stringify(runLive(session, 0.1))).toBe(reference);
    // No pushed event is emitted twice: once per port it belongs on.
    const log = runAhead(session, 1);
    expect(pick(log, 'p', 'down')).toHaveLength(5);
    expect(pick(log, 'p', 'all')).toHaveLength(16);
    // 76 − 24 × Y at each down, on the down's slot.
    expect(pick(log, 'note', 'note').map((e) => [e.time, e.channel, e.pitch])).toEqual([
      [0.1, 2, 64], [0.12, 1, 64], [0.15, 3, 54], [0.25, 2, 59], [0.6, 1, 62],
    ]);
  });

  it('lands a scheduler push at currentTime + 5 ms, rewritten onto its slot, and Make Note follows', () => {
    const compiled = compilePatch(patch, nodeRegistry);
    if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
    const clock = new ManualClock();
    const scheduler = new Scheduler(new Runtime(compiled.plan), { clock, record: true });
    for (let k = 0; k < 40; k++) {
      clock.set(k * 0.025);
      scheduler.wake();
    }
    clock.set(1.0123);
    const event = scheduler.push('p', 'down', { channel: 57, x: 0.4, y: 0.5, pressure: 0.5, pointerType: 'touch' })!;
    expect(event).toEqual({ time: 1.0123 + IMMEDIATE_OFFSET, channel: 57, x: 0.4, y: 0.5, pressure: 0.5, pointerType: 'touch' });
    const log = scheduler.events();
    const rewritten = { time: event.time, channel: 1, x: 0.4, y: 0.5, pressure: 0.5, pointerType: 'touch', dx: 0, dy: 0, speed: 0, angle: 0, age: 0 };
    expect(pick(log, 'p', 'down')).toEqual([rewritten]);
    expect(pick(log, 'p', 'all')).toEqual([{ ...rewritten, phase: 'down' }]);
    expect(pick(log, 'note', 'note')).toMatchObject([{ time: event.time, channel: 1, pitch: 64 }]);
  });

  it('drops events with no pointer and gives defined fields for weird payloads', () => {
    const weird: Push[] = [
      { port: 'down', event: { time: 0.1, channel: 1, x: NaN, y: Infinity, pressure: 'hard' } },
      { port: 'move', event: { time: 0.2, channel: 1, x: 1.5, y: -0.5, pressure: 7 } },
      { port: 'down', event: { time: 0.3, channel: 1.5, x: 0.9 } },
      { port: 'down', event: { time: 0.3, channel: NaN, x: 0.9 } },
      // A negative pointerId is still a pointer.
      { port: 'down', event: { time: 0.3, channel: -1, x: 0.9 } },
    ];
    const all = events(weird, 'all');
    expect(all.map((e) => [e.time, e.channel, e.phase])).toEqual([[0.1, 1, 'down'], [0.2, 1, 'move'], [0.3, 2, 'down']]);
    // The payload passes through as pushed; the motion comes from clamped positions: (0,0) → (1,0) in 100 ms.
    expect(all[0]).toMatchObject({ x: NaN, y: Infinity, pressure: 'hard', dx: 0, dy: 0, age: 0 });
    expect(all[1]!.dx).toBeCloseTo(10, 9);
    expect(all[1]).toMatchObject({ x: 1.5, dy: 0, speed: all[1]!.dx });
    for (const e of all) for (const field of ['dx', 'dy', 'speed', 'angle', 'age']) expect(Number.isFinite(e[field]), field).toBe(true);
  });

  it('frees the stalest slot past MAX_SLOTS, cancelling it if it was down, marking its leave if it hovered', () => {
    const many: Push[] = [];
    for (let k = 0; k <= MAX_SLOTS; k++) many.push({ port: 'down', event: { time: 0.01 * (k + 1), channel: 100 + k, x: k / 100 } });
    const all = events(many, 'all');
    // The 17th pointer takes slot 1 from the first, which gets a Cancel first, at the same time.
    expect(all.slice(-2).map((e) => [e.time, e.channel, e.phase])).toEqual([[0.17, 1, 'cancel'], [0.17, 1, 'down']]);
    expect(all.slice(0, MAX_SLOTS).map((e) => e.channel)).toEqual(Array.from({ length: MAX_SLOTS }, (_, k) => k + 1));
    expect(all.at(-2)!.age).toBeCloseTo(0.16, 9);
    // The evicted contact's Cancel repeats its last payload.
    const dressed: Push[] = many.map((p, k) => (k === 0 ? { ...p, event: { ...p.event, pointerType: 'touch', width: 20, shift: true } } : p));
    expect(events(dressed, 'cancel')).toEqual([{ time: 0.17, channel: 1, x: 0, y: 0, pressure: 0, pointerType: 'touch', width: 20, shift: true, dx: 0, dy: 0, speed: 0, angle: 0, age: expect.closeTo(0.16, 9) }]);
    // A hovering pointer gives its slot up before any that's down.
    const hover: Push[] = [...many.slice(0, MAX_SLOTS - 1), { port: 'move', event: { time: 0.5, channel: 7, x: 0.5 } }, { port: 'down', event: { time: 0.6, channel: 8 } }];
    // Its hover ends there: a leave on its slot, at its last position, then the new pointer's down.
    expect(events(hover, 'all').slice(-2).map((e) => [e.time, e.channel, e.phase, e.x])).toEqual([[0.6, MAX_SLOTS, 'leave', 0.5], [0.6, MAX_SLOTS, 'down', undefined]]);
    expect(events(hover, 'cancel')).toEqual([]);
    const state: Record<string, unknown> = {};
    query(pointer, 0, 1, { state, pushed: pushedOf(many) });
    query(pointer, 1, 2, { state });
    expect(state.contacts).toHaveLength(MAX_SLOTS);
  });
});

/**
 * Queries [0, end) in windows of `step` on one state, and after each window reads every
 * signal on `channels` at the sample times inside it, as the runtime's readers would.
 */
function readSignals(list: readonly Push[], step: number, times: number[], channels: number[], end = 1): Record<string, number>[] {
  const state: Record<string, unknown> = {};
  const pushed = pushedOf(list);
  const ctx = context(pointer, { state });
  const rows: Record<string, number>[] = [];
  for (let i = 0; i * step < end - 1e-9; i++) {
    const t0 = i * step, t1 = Math.min(end, (i + 1) * step);
    query(pointer, t0, t1, { state, pushed });
    for (const t of times.filter((time) => time >= t0 && time < t1)) {
      for (const channel of channels) {
        const row: Record<string, number> = { t, channel };
        for (const port of SIGNALS) row[port] = pointer.signal!(ctx, port, t, channel);
        rows.push(row);
      }
    }
  }
  return rows;
}

const read = (list: readonly Push[], t: number, channel: number) => {
  const { x, y, pressure, speed, count } = readSignals(list, 1, [t], [channel])[0]!;
  return { x, y, pressure, speed, count };
};

describe('pointer signals', () => {
  it('tracks X, Y and Pressure per slot, holding X/Y and dropping Pressure to 0 after Up or Cancel', () => {
    expect(read(session, 0.07, 1)).toMatchObject({ x: 0.1, y: 0.5, pressure: 0 });
    expect(read(session, 0.13, 1)).toMatchObject({ x: 0.2, pressure: 0.5 });
    expect(read(session, 0.145, 2)).toMatchObject({ x: 0.5, y: 0.3, pressure: 0.7 });
    expect(read(session, 0.16, 3)).toMatchObject({ x: 0.9, y: 0.9, pressure: 0.4 });
    expect(read(session, 0.22, 2)).toMatchObject({ x: 0.5, y: 0.3, pressure: 0 });
    // Slot 2 again, now 43's.
    expect(read(session, 0.26, 2)).toMatchObject({ x: 0.3, y: 0.7, pressure: 0.5 });
    // Cancel works like Up; after the last cancel X/Y hold.
    expect(read(session, 0.45, 3)).toMatchObject({ x: 0.9, y: 0.9, pressure: 0 });
    expect(read(session, 0.9, 1)).toMatchObject({ x: 0.6, y: 0.6, pressure: 0 });
    // 44's Down carried no pressure: the pressed default.
    expect(read(session, 0.65, 1).pressure).toBe(0.5);
  });

  it('counts the pointers down, on every channel', () => {
    const times = [0, 0.1, 0.12, 0.15, 0.2, 0.25, 0.32, 0.4, 0.5, 0.6, 0.7, 0.9];
    const rows = readSignals(session, 1, times, [0, 1, 3, 99]);
    for (const t of times) expect(new Set(rows.filter((r) => r.t === t).map((r) => r.count)).size).toBe(1);
    expect(times.map((t) => rows.find((r) => r.t === t)!.count)).toEqual([0, 1, 2, 3, 2, 3, 2, 1, 0, 1, 0, 0]);
  });

  it('reads channel 0, or a channel no slot has had, as the pointer that changed last', () => {
    expect(read(session, 0, 0)).toEqual({ x: 0, y: 0, pressure: 0, speed: 0, count: 0 });
    // An enter alone isn't a change, but with no other pointer channel 0 reads the entered one: slot 1, still at 0.
    expect(read(session, 0.055, 0).x).toBe(0);
    const entered: Push[] = [
      { port: 'down', event: { time: 0.1, channel: 3, x: 0.7 } },
      { port: 'enter', event: { time: 0.2, channel: 4, x: 0.2 } },
    ];
    // Behind a pointer that has changed: channel 0 still reads that one.
    expect(read(entered, 0.25, 0).x).toBe(0.7);
    expect(read(session, 0.07, 0).x).toBe(0.1);
    expect(read(session, 0.11, 0).x).toBe(0.5);
    expect(read(session, 0.145, 42).y).toBe(0.3);
    expect(read(session, 0.16, 0).x).toBe(0.9);
    // Slot 1 exists, so channel 1 reads it, not the latest.
    expect(read(session, 0.16, 1).x).toBe(0.2);
  });

  it('reads Speed per slot while the pointer moves, and 0 once it is still or gone', () => {
    // The mouse's hover at 0.08: 5 units/s, for STILL after.
    expect(read(session, 0.09, 1).speed).toBeCloseTo(5, 9);
    expect(read(session, 0.14, 2).speed).toBeCloseTo(5, 9);
    const list: Push[] = [
      { port: 'down', event: { time: 0.1, channel: 3, x: 0.1, y: 0.1 } },
      { port: 'move', event: { time: 0.2, channel: 3, x: 0.2, y: 0.1 } },
      { port: 'up', event: { time: 0.6, channel: 3, x: 0.2, y: 0.1 } },
    ];
    expect(read(list, 0.2, 1).speed).toBeCloseTo(1, 9);
    expect(read(list, 0.2 + STILL - 1e-9, 1).speed).toBeCloseTo(1, 9);
    expect(read(list, 0.2 + STILL + 0.01, 1).speed).toBe(0);
    expect(read(list, 0.65, 1).speed).toBe(0);
  });

  it('lets a read mid-window see only the changes at or before it', () => {
    const rows = readSignals(session, 1, [0.099, 0.1, 0.199, 0.2], [2]);
    expect(rows.map((r) => [r.x, r.pressure, r.count])).toEqual([
      [0.2, 0, 0],
      [0.5, 0.6, 1],
      [0.5, 0.7, 3],
      [0.5, 0, 2],
    ]);
  });

  it('gives the same signal values in one, two and three windows and in 25 and 100 ms tiles', () => {
    const times = Array.from({ length: 200 }, (_, k) => k * 0.005);
    const channels = [0, 1, 2, 3, 9];
    const reference = JSON.stringify(readSignals(session, 1, times, channels));
    for (const step of [0.5, 1 / 3, 0.1, 0.025]) expect(JSON.stringify(readSignals(session, step, times, channels)), `${step}`).toBe(reference);
  });

  it('never writes state from a signal read, before or after a query', () => {
    const state: Record<string, unknown> = {};
    const ctx = context(pointer, { state });
    for (const port of SIGNALS) pointer.signal!(ctx, port, 0.5, 3);
    expect(state).toEqual({});
    query(pointer, 0, 1, { state, pushed: pushedOf(session) });
    const before = JSON.stringify(state);
    for (const port of SIGNALS) for (const t of [0, 0.25, 0.5, 2]) pointer.signal!(ctx, port, t, 1);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('gives defined values for weird payloads, channels and times', () => {
    const weird: Push[] = [
      { port: 'down', event: { time: 0.1, channel: 1, x: NaN, y: Infinity, pressure: 'hard' } },
      { port: 'move', event: { time: 0.2, channel: 1, x: 1.5, y: -0.5, pressure: 7 } },
      { port: 'down', event: { time: 0.3, channel: 1.5, x: 0.9 } },
      { port: 'up', event: { time: 0.4, channel: 9 } },
    ];
    // Down without values: X/Y 0, Pressure the pressed default.
    expect(read(weird, 0.15, 1)).toMatchObject({ x: 0, y: 0, pressure: 0.5, count: 1 });
    // Out of range clamps to 0–1.
    expect(read(weird, 0.25, 1)).toMatchObject({ x: 1, y: 0, pressure: 1, count: 1 });
    // A bad channel is ignored; an up on a pointer never down is dropped, so slot 2 never exists and reads the latest.
    expect(read(weird, 0.35, 1)).toMatchObject({ x: 1, count: 1 });
    expect(read(weird, 0.45, 2)).toMatchObject({ x: 1, y: 0, pressure: 1, count: 1 });
    const state: Record<string, unknown> = {};
    const ctx = context(pointer, { state });
    for (const port of SIGNALS) expect(pointer.signal!(ctx, port, 0.5, 0)).toBe(0);
    query(pointer, 0, 1, { state, pushed: pushedOf(weird) });
    expect(pointer.signal!(ctx, 'count', NaN, 1)).toBe(0);
    expect(pointer.signal!(ctx, 'count', Infinity, 1)).toBe(1);
    expect(pointer.signal!(ctx, 'speed', NaN, 1)).toBe(0);
    expect(pointer.signal!(ctx, 'nope', 0.5, 1)).toBe(0);
  });
});
