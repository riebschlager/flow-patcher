import { describe, expect, it } from 'vitest';
import { compilePatch, inputRouter, replayInput, Runtime, type EngineEvent, type InputEvent, type LoggedEvent, type Patch } from '@flow-patcher/engine';
import { nodeRegistry, pointer, pointerHighRate } from '../src';
import { query, queryTiled } from './helpers';

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
 * samples for high rate, the last at ago 0 with the plain move's position), a touch dragged with
 * four samples a frame, and a second touch while the first is down. Samples of one browser event
 * share its time.
 */
function stream(): InputEvent[] {
  const events: InputEvent[] = [];
  const frame = (time: number, channel: number, xs: number[], y: number, extra: Record<string, number | string | boolean> = {}) => {
    xs.forEach((x, i) => events.push({ time, type: 'pointermove', channel, x, y, coalesced: true, ago: Math.round((xs.length - 1 - i) * 4) / 1000, ...extra }));
    events.push({ time, type: 'pointermove', channel, x: xs.at(-1)!, y, ...extra });
  };
  events.push({ time: 0.05, type: 'pointerenter', channel: 1, x: 0, y: 0.2, pointerType: 'mouse' });
  frame(0.066, 1, [0.01, 0.02], 0.2, { pointerType: 'mouse', buttons: 0 });
  frame(0.083, 1, [0.03, 0.04], 0.2, { pointerType: 'mouse', buttons: 0 });
  events.push({ time: 0.1, type: 'pointerdown', channel: 30, x: 0.5, y: 0.5, pressure: 0.5, pointerType: 'touch' });
  frame(0.116, 30, [0.504, 0.508, 0.512, 0.516], 0.5, { pressure: 0.5, pointerType: 'touch' });
  frame(0.132, 30, [0.52, 0.524, 0.528, 0.532], 0.5, { pressure: 0.5, pointerType: 'touch' });
  events.push({ time: 0.14, type: 'pointerdown', channel: 31, x: 0.2, y: 0.8, pressure: 0.5, pointerType: 'touch' });
  frame(0.148, 30, [0.536, 0.54, 0.544, 0.548], 0.5, { pressure: 0.5, pointerType: 'touch' });
  events.push({ time: 0.16, type: 'pointerup', channel: 30, x: 0.548, y: 0.5, pressure: 0, pointerType: 'touch' });
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
    expect(nodes({ type: 'pointermove', ...fields, coalesced: true, ago: 0.004 })).toEqual([['h', 'move']]);
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

  it("measures motion from the samples' own spacing (time − ago), not their shared stamp", () => {
    const log = runAhead(1);
    const touch = pick(log, 'h', 'move').filter((e) => e.channel === 2);
    // 0.004 per 4 ms: 1 unit/s to the right, from the first sample on (the down at 0.1 is 4 ms before
    // the first sample's 0.116 − 0.012 = 0.104 and 0.004 to its left).
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

  it('keeps the previous motion for a sample taken no later than the previous one, as Pointer does', () => {
    const pushed: Record<string, EngineEvent[]> = {
      down: [{ time: 0.1, channel: 4, x: 0.1, y: 0.1 }],
      move: [
        { time: 0.2, channel: 4, x: 0.2, y: 0.1, coalesced: true, ago: 0.05 },
        { time: 0.2, channel: 4, x: 0.25, y: 0.1, coalesced: true },
        // A bad ago is no ago.
        { time: 0.2, channel: 4, x: 0.3, y: 0.1, coalesced: true, ago: NaN },
        { time: 0.3, channel: 4, x: 0.4, y: 0.1, coalesced: true, ago: -1 },
      ],
    };
    const dx = query(pointerHighRate, 0, 1, { pushed }).move!.map((e) => e.dx as number);
    // 0.1 in 50 ms (taken at 0.15), then 0.05 in 50 ms (at 0.2); the NaN ago is also at 0.2, so it
    // keeps that motion and the 0.2 reference; then 0.15 in the 100 ms from it.
    expect(dx[0]).toBeCloseTo(2, 9);
    expect(dx[1]).toBeCloseTo(1, 9);
    expect(dx[2]).toBeCloseTo(1, 9);
    expect(dx[3]).toBeCloseTo(1.5, 9);
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
