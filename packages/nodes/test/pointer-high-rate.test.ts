import { describe, expect, it } from 'vitest';
import { compilePatch, inputRouter, NODE_EVENT_LIMIT, replayInput, Runtime, type EngineEvent, type InputEvent, type LoggedEvent, type Patch } from '@flow-patcher/engine';
import { nodeRegistry, pointer, pointerHighRate } from '../src';
import { RESERVE } from '../src/pointer';
import { context, query, queryTiled } from './helpers';

const EVENT_PORTS = ['down', 'move', 'up', 'cancel', 'all'] as const;
const node = (id: string, type: string, params = {}) => ({ id, type, typeVersion: nodeRegistry.get(type)!.version, params, position: { x: 0, y: 0 } });

/** Both pointer sources side by side, each with Down into a Make Note. */
const patch: Patch = {
  format: 'flowpatch',
  version: 1,
  seed: 1,
  nodes: [node('p', 'pointer'), node('h', 'pointer-high-rate'), node('note', 'make-note')],
  cables: [{ from: { node: 'h', port: 'move' }, to: { node: 'note', port: 'trigger' } }],
};
function plan() {
  const compiled = compilePatch(patch, nodeRegistry);
  if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
  return compiled.plan;
}

/**
 * A stream as the host records it: a mouse hovering (its plain moves for Pointer, each frame's
 * samples for high rate, the last at the plain move's position), a touch dragged with four
 * samples 4 ms apart a frame, and a second touch while the first is down. Samples of one browser
 * event share its time; each event carries its `interval` since the pointer's previous sample.
 */
function stream(): InputEvent[] {
  const events: InputEvent[] = [];
  const frame = (time: number, channel: number, xs: number[], y: number, extra: Record<string, number | string | boolean> = {}, first = false) => {
    xs.forEach((x, i) => events.push({ time, type: 'pointermove', channel, x, y, coalesced: true, ...(first && i === 0 ? {} : { interval: 0.004 }), ...extra }));
    events.push({ time, type: 'pointermove', channel, x: xs.at(-1)!, y, ...(first ? {} : { interval: 0.004 * xs.length }), ...extra });
  };
  events.push({ time: 0.05, type: 'pointerenter', channel: 1, x: 0, y: 0.2, pointerType: 'mouse' });
  frame(0.066, 1, [0.01, 0.02], 0.2, { pointerType: 'mouse', buttons: 0 }, true);
  frame(0.083, 1, [0.03, 0.04], 0.2, { pointerType: 'mouse', buttons: 0 });
  events.push({ time: 0.1, type: 'pointerdown', channel: 30, x: 0.5, y: 0.5, pressure: 0.5, pointerType: 'touch' });
  frame(0.116, 30, [0.504, 0.508, 0.512, 0.516], 0.5, { pressure: 0.5, pointerType: 'touch' });
  frame(0.132, 30, [0.52, 0.524, 0.528, 0.532], 0.5, { pressure: 0.5, pointerType: 'touch' });
  events.push({ time: 0.14, type: 'pointerdown', channel: 31, x: 0.2, y: 0.8, pressure: 0.5, pointerType: 'touch' });
  frame(0.148, 30, [0.536, 0.54, 0.544, 0.548], 0.5, { pressure: 0.5, pointerType: 'touch' });
  events.push({ time: 0.16, type: 'pointerup', channel: 30, x: 0.548, y: 0.5, pressure: 0, pointerType: 'touch', interval: 0.012 });
  events.push({ time: 0.17, type: 'pointerleave', channel: 1, x: 0.05, y: 0.2, pointerType: 'mouse' });
  events.push({ time: 0.2, type: 'pointerup', channel: 31, x: 0.2, y: 0.8, pressure: 0, pointerType: 'touch' });
  return events;
}

/** The stream replayed through the host's router before the first window, then [0, end) in windows of `step`. */
function runAhead(step: number, end = 0.5): LoggedEvent[] {
  const rt = new Runtime(plan());
  replayInput(rt, { events: stream() });
  const log: LoggedEvent[] = [];
  for (let i = 0; i * step < end - 1e-9; i++) log.push(...rt.query(i * step, Math.min(end, (i + 1) * step)));
  return rt.sortLog(log);
}

/** Live: each browser event's push arrives after the runtime has queried 120 ms past it, so it rewinds. */
function runLive(step: number, end = 0.5): LoggedEvent[] {
  const rt = new Runtime(plan(), { history: true });
  const router = inputRouter(rt.plan);
  let log: LoggedEvent[] = [];
  let next = 0;
  const queryTo = (t: number) => {
    for (; next * step < Math.min(end, t) - 1e-9; next++) log.push(...rt.query(next * step, Math.min(end, (next + 1) * step)));
  };
  // One push per browser event: a frame's samples and plain move go together, as the host sends them.
  const groups: InputEvent[][] = [];
  for (const event of stream()) {
    const last = groups.at(-1);
    if (last && event.type === 'pointermove' && last[0]!.type === 'pointermove' && last[0]!.time === event.time && last[0]!.channel === event.channel) last.push(event);
    else groups.push([event]);
  }
  for (const group of groups) {
    const time = group[0]!.time;
    queryTo(time + 0.12);
    const report = rt.pushAll(group.flatMap((e) => router.route(e).map(({ node: id, port, fields }) => ({ node: id, port, event: { time, ...fields } as EngineEvent }))));
    if (!report) continue;
    log = [...log.filter((e) => !(report.affected.has(e.node) && e.time >= report.time)), ...report.added];
  }
  queryTo(end);
  return rt.sortLog(log);
}

const pick = (log: LoggedEvent[], id: string, port: string) => log.filter((e) => e.node === id && e.port === port).map(({ node: _n, port: _p, ...e }) => e);

describe('pointer-high-rate', () => {
  it("has Pointer's ports and reads, rewriting its pushes, and reads coalesced moves only", () => {
    expect(pointerHighRate.category).toBe('canvas-sources');
    expect(pointerHighRate.ports).toEqual(pointer.ports);
    expect(pointerHighRate.params).toEqual([]);
    expect(pointerHighRate.input!.reads).toEqual(pointer.input!.reads);
    expect(pointerHighRate.input!.rewrites).toBe(true);
    const router = inputRouter(plan());
    const fields = { channel: 3, x: 0.5, y: 0.5, pressure: 0.5, pointerType: 'pen' };
    const nodes = (event: Parameters<typeof router.route>[0]) => router.route(event).map((t) => [t.node, t.port]);
    // A coalesced sample is high rate's; the plain move is Pointer's. Neither gets the other.
    expect(nodes({ type: 'pointermove', ...fields, coalesced: true, interval: 0.004 })).toEqual([['h', 'move']]);
    expect(nodes({ type: 'pointermove', ...fields })).toEqual([['p', 'move']]);
    for (const [type, port] of [['pointerenter', 'enter'], ['pointerdown', 'down'], ['pointerup', 'up'], ['pointercancel', 'cancel'], ['pointerleave', 'leave']] as const) {
      expect(nodes({ type, ...fields })).toEqual([['p', port], ['h', port]]);
    }
  });

  it('emits nothing by itself, in any window', () => {
    for (const port of EVENT_PORTS) expect(queryTiled(pointerHighRate, port, 2, 0.025)).toEqual([]);
    for (const [t0, t1] of [[1, 1], [2, 1], [NaN, 1], [0, Infinity]]) expect(query(pointerHighRate, t0!, t1!)).toEqual({});
  });

  it('emits every sample where Pointer emits one move a frame, on the same slots, in order', () => {
    const log = runAhead(1);
    const moves = (id: string) => pick(log, id, 'move').map((e) => [e.time, e.channel, e.x]);
    expect(moves('p')).toEqual([
      [0.066, 1, 0.02], [0.083, 1, 0.04], [0.116, 2, 0.516], [0.132, 2, 0.532], [0.148, 2, 0.548],
    ]);
    expect(moves('h')).toEqual([
      [0.066, 1, 0.01], [0.066, 1, 0.02], [0.083, 1, 0.03], [0.083, 1, 0.04],
      ...[0.116, 0.132, 0.148].flatMap((t, f) => [0, 1, 2, 3].map((i) => [t, 2, Math.round((0.504 + 0.016 * f + 0.004 * i) * 1000) / 1000])),
    ]);
    // The same downs, ups and phases on All, apart from the extra moves.
    for (const port of ['down', 'up'] as const) expect(pick(log, 'h', port)).toEqual(pick(log, 'p', port));
    expect(pick(log, 'h', 'all').filter((e) => e.phase !== 'move')).toEqual(pick(log, 'p', 'all').filter((e) => e.phase !== 'move'));
    // Make Note on high rate's Move: one note per sample.
    expect(pick(log, 'note', 'note')).toHaveLength(16);
  });

  it("measures motion over the samples' own intervals, not their shared stamp", () => {
    const log = runAhead(1);
    const touch = pick(log, 'h', 'move').filter((e) => e.channel === 2);
    // 0.004 per 4 ms: 1 unit/s to the right, from the first sample on (4 ms and 0.004 after the down).
    for (const e of touch) {
      expect(e.dx).toBeCloseTo(1, 6);
      expect(e.dy).toBeCloseTo(0, 9);
      expect(e.speed).toBeCloseTo(1, 6);
    }
    // Age runs on the stamps: every sample of a frame has its frame's age.
    expect(touch.map((e) => Math.round((e.age as number) * 1000))).toEqual([16, 16, 16, 16, 32, 32, 32, 32, 48, 48, 48, 48]);
    // Pointer, one move a frame, gets the same speed here from frame to frame, with a quarter of the samples.
    const plain = pick(log, 'p', 'move').filter((e) => e.channel === 2);
    expect(plain.map((e) => e.dx as number)).toEqual([expect.closeTo(0.016 / 0.016, 6), expect.closeTo(1, 6), expect.closeTo(1, 6)]);
  });

  it('adds up intervals under MIN_INTERVAL before measuring, and falls back to stamps without one', () => {
    const pushed: Record<string, EngineEvent[]> = {
      down: [{ time: 0.1, channel: 4, x: 0.1, y: 0.1 }],
      move: [
        { time: 0.2, channel: 4, x: 0.2, y: 0.1, coalesced: true, interval: 0.05 },
        // Two samples 0.5 ms apart: the first keeps the motion, the second measures over both.
        { time: 0.2, channel: 4, x: 0.2005, y: 0.1, coalesced: true, interval: 0.0005 },
        { time: 0.2, channel: 4, x: 0.201, y: 0.1, coalesced: true, interval: 0.0005 },
        // A bad interval is none: the stamps then, 0.1 from the 0.2 reference.
        { time: 0.3, channel: 4, x: 0.301, y: 0.1, coalesced: true, interval: NaN },
        { time: 0.4, channel: 4, x: 0.401, y: 0.1, coalesced: true, interval: -1 },
      ],
    };
    const dx = query(pointerHighRate, 0, 1, { pushed }).move!.map((e) => e.dx as number);
    expect(dx[0]).toBeCloseTo(2, 9);
    expect(dx[1]).toBeCloseTo(2, 9);
    expect(dx[2]).toBeCloseTo(1, 9);
    expect(dx[3]).toBeCloseTo(1, 9);
    expect(dx[4]).toBeCloseTo(1, 9);
  });

  it('keeps speed bounded when a late handler squeezes two frames into stamps closer than their samples', () => {
    // Frame 1 handled 10 ms late, frame 2 on time: stamps 6 ms apart, samples 16 ms apart.
    const pushed: Record<string, EngineEvent[]> = {
      down: [{ time: 0.1, channel: 4, x: 0.1, y: 0.5 }],
      move: [
        ...[1, 2, 3, 4].map((i) => ({ time: 0.126, channel: 4, x: 0.1 + 0.004 * i, y: 0.5, coalesced: true, interval: 0.004 })),
        ...[5, 6, 7, 8].map((i) => ({ time: 0.132, channel: 4, x: 0.1 + 0.004 * i, y: 0.5, coalesced: true, interval: 0.004 })),
      ],
    };
    const moves = query(pointerHighRate, 0, 1, { pushed }).move!;
    for (const e of moves) expect(e.speed).toBeCloseTo(1, 6);
    // The plain Pointer gets the same from its plain moves' intervals.
    const plain = query(pointer, 0, 1, { pushed: { down: pushed.down!, move: [
      { time: 0.126, channel: 4, x: 0.116, y: 0.5, interval: 0.016 },
      { time: 0.132, channel: 4, x: 0.132, y: 0.5, interval: 0.016 },
    ] } }).move!;
    for (const e of plain) expect(e.speed).toBeCloseTo(1, 6);
  });

  it('puts hover samples flushed with a Down at one stamp before it, not as a drag', () => {
    const pushed: Record<string, EngineEvent[]> = {
      down: [{ time: 0.2, channel: 1, x: 0.3, y: 0.5, buttons: 1, pressure: 0.5 }],
      move: [
        { time: 0.1, channel: 1, x: 0.1, y: 0.5, buttons: 0, coalesced: true },
        { time: 0.2, channel: 1, x: 0.2, y: 0.5, buttons: 0, coalesced: true, interval: 0.01 },
        { time: 0.2, channel: 1, x: 0.25, y: 0.5, buttons: 0, coalesced: true, interval: 0.01 },
      ],
      up: [{ time: 0.3, channel: 1, x: 0.3, y: 0.5, buttons: 0 }],
    };
    // And after an Up at one stamp, hover samples come after it.
    pushed.move!.push({ time: 0.3, channel: 1, x: 0.35, y: 0.5, buttons: 0, coalesced: true, interval: 0.01 });
    const all = query(pointerHighRate, 0, 1, { pushed }).all!;
    expect(all.map((e) => [e.time, e.phase, e.x, e.age])).toEqual([
      [0.1, 'move', 0.1, 0], [0.2, 'move', 0.2, 0], [0.2, 'move', 0.25, 0], [0.2, 'down', 0.3, 0], [0.3, 'up', 0.3, expect.closeTo(0.1, 9)], [0.3, 'move', 0.35, 0],
    ]);
  });

  it('thins moves in a full limit window and keeps every Down, Up, Cancel and leave', () => {
    // Three fingers at 1 kHz for 120 ms in one limit window [0.24, 0.36): 360 samples, 720 events.
    const pushed: Record<string, EngineEvent[]> = { down: [], move: [], up: [] };
    for (const id of [1, 2, 3]) pushed.down!.push({ time: 0.24, channel: id, x: 0.1 * id, y: 0.5 });
    // 1 unit/s, then from k = 100 on 3 units/s, so the thinned tail moves differently from what's emitted.
    const xAt = (id: number, k: number) => 0.1 * id + Math.min(k, 100) * 0.001 + Math.max(0, k - 100) * 0.003;
    for (let k = 1; k < 119; k++) for (const id of [1, 2, 3]) pushed.move!.push({ time: 0.24 + k * 0.001, channel: id, x: xAt(id, k), y: 0.5, coalesced: true, interval: 0.001 });
    for (const id of [1, 2, 3]) pushed.up!.push({ time: 0.359, channel: id, x: xAt(id, 118), y: 0.5, interval: 0.001 });
    // A mouse hovering in from the window's start, which leaves once the window is full: the leave isn't thinned.
    pushed.move!.unshift({ time: 0.2405, channel: 9, x: 0.9, y: 0.1, buttons: 0, coalesced: true });
    pushed.leave = [{ time: 0.35, channel: 9, x: 1, y: 0.1 }];
    const run = (step: number) => {
      const state = {};
      const out: Record<string, EngineEvent[]> = {};
      for (let i = 0; i * step < 1 - 1e-9; i++) for (const [port, events] of Object.entries(query(pointerHighRate, i * step, Math.min(1, (i + 1) * step), { state, pushed }))) (out[port] ??= []).push(...events!);
      return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
    };
    const out = run(1);
    const total = Object.values(out).reduce((n, events) => n + events.length, 0);
    expect(total).toBeLessThanOrEqual(NODE_EVENT_LIMIT);
    expect(out.down).toHaveLength(3);
    expect(out.up).toHaveLength(3);
    expect(out.all!.filter((e) => e.phase === 'leave').map((e) => [e.time, e.channel, e.x])).toEqual([[0.35, 4, 0.9]]);
    expect(out.move!.length).toBe((NODE_EVENT_LIMIT - RESERVE) / 2 - 3);
    // The moves that went are the window's latest: the last emitted is early, at 1 unit/s.
    expect(out.move!.at(-1)!.time).toBeLessThan(0.3);
    expect(out.move!.at(-1)!.speed).toBeCloseTo(1, 6);
    // The thinned ones still moved the state: X and Speed at the last move read its values, not the
    // last emitted one's, and the Up measures its motion from the last thinned move.
    const state = {};
    query(pointerHighRate, 0, 1, { state, pushed });
    const ctx = context(pointerHighRate, { state });
    expect(pointerHighRate.signal!(ctx, 'x', 0.3585, 1)).toBeCloseTo(xAt(1, 118), 9);
    expect(pointerHighRate.signal!(ctx, 'speed', 0.3585, 1)).toBeCloseTo(3, 6);
    expect(out.up!.map((e) => e.dx)).toEqual([0, 0, 0]);
    // The same however the windows are split.
    expect(JSON.stringify(run(0.025))).toBe(JSON.stringify(out));
    expect(JSON.stringify(run(0.05))).toBe(JSON.stringify(out));
    // The next limit window starts afresh.
    const later = { ...pushed, move: [...pushed.move!, { time: 0.37, channel: 9, x: 0.5, y: 0.5, coalesced: true }] };
    expect(query(pointerHighRate, 0, 1, { pushed: later }).move!.at(-1)!.time).toBe(0.37);
  });

  it('keeps a full window under the runtime cap, ahead and when every push rewinds', () => {
    const pushes: { port: string; event: EngineEvent }[] = [];
    for (const id of [1, 2, 3]) pushes.push({ port: 'down', event: { time: 0.24, channel: id, x: 0.1 * id, y: 0.5 } });
    for (let k = 1; k < 119; k++) for (const id of [1, 2, 3]) pushes.push({ port: 'move', event: { time: 0.24 + k * 0.001, channel: id, x: 0.1 * id + k * 0.001, y: 0.5, coalesced: true, interval: 0.001 } });
    for (const id of [1, 2, 3]) pushes.push({ port: 'up', event: { time: 0.359, channel: id, x: 0.1 * id + 0.118, y: 0.5, interval: 0.001 } });
    const step = 0.025, end = 0.6;
    const ahead = new Runtime(plan());
    for (const { port, event } of pushes) ahead.push('h', port, { ...event });
    const reference: LoggedEvent[] = [];
    for (let i = 0; i * step < end - 1e-9; i++) reference.push(...ahead.query(i * step, Math.min(end, (i + 1) * step)));
    expect(ahead.counters.droppedNodeLimit).toBe(0);
    expect(ahead.warnings('h').map((w) => w.kind)).not.toContain('node-event-limit');
    expect(pick(reference, 'h', 'up')).toHaveLength(3);
    expect(pick(reference, 'h', 'all').filter((e) => e.phase === 'up')).toHaveLength(3);
    // Live: each push rewinds into windows already queried, restoring `state.cell` from snapshots.
    const live = new Runtime(plan(), { history: true });
    let log: LoggedEvent[] = [];
    let next = 0;
    const queryTo = (t: number) => {
      for (; next * step < Math.min(end, t) - 1e-9; next++) log.push(...live.query(next * step, Math.min(end, (next + 1) * step)));
    };
    let rewinds = 0;
    for (const { port, event } of pushes) {
      queryTo(event.time + 0.12);
      const report = live.push('h', port, { ...event });
      if (!report) continue;
      rewinds++;
      log = [...log.filter((e) => !(report.affected.has(e.node) && e.time >= report.time)), ...report.added];
    }
    queryTo(end);
    expect(rewinds).toBe(pushes.length);
    expect(JSON.stringify(live.sortLog(log))).toBe(JSON.stringify(ahead.sortLog(reference)));
    expect(live.counters.droppedNodeLimit).toBe(0);
  });

  it('keeps its own slot map: a pointer only high rate saw takes a slot there and not on Pointer', () => {
    const rt = new Runtime(plan());
    replayInput(rt, { events: [
      // A pen hovers with samples only (say Pointer's plain moves were lost); then a touch goes down.
      { time: 0.1, type: 'pointermove', channel: 9, x: 0.1, y: 0.1, coalesced: true },
      { time: 0.2, type: 'pointerdown', channel: 40, x: 0.5, y: 0.5 },
    ] });
    const log = rt.query(0, 1);
    expect(pick(log, 'h', 'down').map((e) => e.channel)).toEqual([2]);
    expect(pick(log, 'p', 'down').map((e) => e.channel)).toEqual([1]);
    expect(rt.stateOf('p')).not.toEqual(rt.stateOf('h'));
  });

  it('gives the same log in one, two and three windows, 25 ms tiles, and when every push rewinds', () => {
    const reference = JSON.stringify(runAhead(0.5));
    for (const step of [0.25, 0.5 / 3, 0.025]) expect(JSON.stringify(runAhead(step)), `${step}`).toBe(reference);
    expect(JSON.stringify(runLive(0.025))).toBe(reference);
    expect(JSON.stringify(runLive(0.1))).toBe(reference);
  });

  it('gives the same signals however the windows are split', () => {
    const rows = (step: number) => {
      const rt = new Runtime(plan());
      replayInput(rt, { events: stream() });
      const out: number[] = [];
      for (let i = 0; i * step < 0.5 - 1e-9; i++) {
        const t0 = i * step, t1 = Math.min(0.5, (i + 1) * step);
        rt.query(t0, t1);
        const ctx = { state: rt.stateOf('h') ?? {} };
        for (let k = 0; k < 100; k++) {
          const t = k * 0.005;
          if (t >= t0 && t < t1) for (const port of ['x', 'speed', 'count']) out.push(pointerHighRate.signal!(ctx as never, port, t, 2));
        }
      }
      return JSON.stringify(out);
    };
    const reference = rows(0.5);
    for (const step of [0.25, 0.5 / 3, 0.025]) expect(rows(step), `${step}`).toBe(reference);
  });
});
