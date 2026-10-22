import { describe, expect, it } from 'vitest';
import { compilePatch, IMMEDIATE_OFFSET, ManualClock, Runtime, Scheduler, type EngineEvent, type LoggedEvent, type Patch } from '@flow-patcher/engine';
import { nodeRegistry, pointer } from '../src';
import { MAX_LIFTED } from '../src/pointer';
import { context, query, queryTiled } from './helpers';

const PORTS = ['down', 'move', 'up', 'cancel'] as const;
type Port = (typeof PORTS)[number];
const SIGNALS = ['x', 'y', 'pressure', 'count'] as const;
type SignalPort = (typeof SIGNALS)[number];

const node = (id: string, type: string, params = {}) => ({ id, type, typeVersion: nodeRegistry.get(type)!.version, params, position: { x: 0, y: 0 } });

/** Pointer, with Down feeding a Make Note, as in examples/pointer-notes.flowpatch. */
const patch: Patch = {
  format: 'flowpatch',
  version: 1,
  seed: 1,
  nodes: [node('p', 'pointer'), node('note', 'make-note', { pitch: 64 })],
  cables: [{ from: { node: 'p', port: 'down' }, to: { node: 'note', port: 'trigger' } }],
};

/** The same, with Y modulating Make Note's pitch as in the example: 76 − 24 × Y. */
const pitchPatch: Patch = {
  ...patch,
  nodes: [node('p', 'pointer'), node('note', 'make-note', { pitch: 76 })],
  cables: [...patch.cables, { from: { node: 'p', port: 'y' }, to: { node: 'note', port: 'pitch' }, depth: -24 }],
};

function runtime(history = false, which: Patch = patch): Runtime {
  const compiled = compilePatch(which, nodeRegistry);
  if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
  return new Runtime(compiled.plan, { history });
}

/** Two contacts on channels 0 and 3 overlapping in time, and a cancelled one on 7. */
const gestures: { port: Port; event: EngineEvent }[] = [
  { port: 'down', event: { time: 0.1, channel: 0, x: 0.2, y: 0.1, pressure: 0.5 } },
  { port: 'move', event: { time: 0.13, channel: 0, x: 0.25, y: 0.15, pressure: 0.5 } },
  { port: 'down', event: { time: 0.21, channel: 3, x: 0.9, y: 0.8, pressure: 0.3 } },
  { port: 'move', event: { time: 0.26, channel: 3, x: 0.85, y: 0.7, pressure: 0.4 } },
  { port: 'up', event: { time: 0.3, channel: 0, x: 0.3, y: 0.2, pressure: 0 } },
  { port: 'down', event: { time: 0.31, channel: 7, x: 0.5, y: 0.5, pressure: 1 } },
  { port: 'cancel', event: { time: 0.42, channel: 7, x: 0.5, y: 0.5, pressure: 0 } },
  { port: 'up', event: { time: 0.5, channel: 3, x: 0.8, y: 0.6, pressure: 0 } },
];

/** Every push known in advance (past the horizon), then [0, end) queried in windows of `step`. */
function runAhead(step: number, end = 1, which: Patch = patch): LoggedEvent[] {
  const rt = runtime(false, which);
  for (const { port, event } of gestures) expect(rt.push('p', port, { ...event })).toBeNull();
  const log: LoggedEvent[] = [];
  for (let i = 0; i * step < end - 1e-9; i++) log.push(...rt.query(i * step, Math.min(end, (i + 1) * step)));
  return log;
}

/** Live: each push arrives after the runtime has already queried 120 ms past it, so it rewinds. */
function runLive(step: number, end = 1, which: Patch = patch): LoggedEvent[] {
  const rt = runtime(true, which);
  const log: LoggedEvent[] = [];
  let next = 0;
  const queryTo = (t: number) => {
    while (next * step < t - 1e-9) {
      log.push(...rt.query(next * step, Math.min(end, (next + 1) * step)));
      next++;
    }
  };
  let current = log;
  let rewinds = 0;
  for (const { port, event } of gestures) {
    queryTo(event.time + 0.12);
    const report = rt.push('p', port, { ...event });
    if (!report) continue;
    // Apply the rewind to the log as the Scheduler does: replace what the affected nodes logged from its time on.
    rewinds++;
    current = [...current.filter((e) => !(report.affected.has(e.node) && e.time >= report.time)), ...report.added];
    log.length = 0;
    log.push(...current);
  }
  queryTo(end);
  expect(rewinds).toBe(gestures.length);
  return rt.sortLog(log);
}

const pick = (log: LoggedEvent[], node: string, port: string) => log.filter((e) => e.node === node && e.port === port);

describe('pointer', () => {
  it('has the four event outputs, the X, Y, Pressure and Count signals, and no inputs or params (M1 basic)', () => {
    expect(pointer.category).toBe('canvas-sources');
    expect(pointer.ports.map((p) => [p.name, p.type, p.direction])).toEqual([
      ...PORTS.map((name) => [name, 'event', 'out']),
      ...SIGNALS.map((name) => [name, 'signal', 'out']),
    ]);
    expect(pointer.params).toEqual([]);
  });

  it('emits nothing by itself, in any window and however the windows are split', () => {
    for (const port of PORTS) {
      expect(queryTiled(pointer, port, 2, 0.025)).toEqual([]);
      expect(query(pointer, 0, 2)[port] ?? []).toEqual([]);
    }
    // Weird windows: empty, reversed, NaN and infinite.
    for (const [t0, t1] of [[1, 1], [2, 1], [NaN, 1], [0, Infinity], [-Infinity, NaN]]) expect(query(pointer, t0!, t1!)).toEqual({});
  });

  it('passes pushed events through on their own port and channel, unchanged', () => {
    const log = runAhead(1);
    for (const port of PORTS) {
      expect(pick(log, 'p', port).map(({ node: _n, port: _p, ...e }) => e)).toEqual(gestures.filter((g) => g.port === port).map((g) => g.event));
    }
    // Down drives Make Note on the pointer's channel, at the down's time, payload kept.
    expect(pick(log, 'note', 'note').map((e) => [e.time, e.channel, e.x, e.pitch])).toEqual([
      [0.1, 0, 0.2, 64],
      [0.21, 3, 0.9, 64],
      [0.31, 7, 0.5, 64],
    ]);
  });

  it('gives the same log in 25 ms, 100 ms and one window, and when every push rewinds', () => {
    const reference = JSON.stringify(runAhead(1));
    expect(JSON.stringify(runAhead(0.025))).toBe(reference);
    expect(JSON.stringify(runAhead(0.1))).toBe(reference);
    expect(JSON.stringify(runLive(0.025))).toBe(reference);
    expect(JSON.stringify(runLive(0.1))).toBe(reference);
  });

  it('lands a scheduler push on Down at currentTime + 5 ms, and Make Note follows', () => {
    const compiled = compilePatch(patch, nodeRegistry);
    if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
    const clock = new ManualClock();
    const scheduler = new Scheduler(new Runtime(compiled.plan), { clock, record: true });
    for (let k = 0; k < 40; k++) {
      clock.set(k * 0.025);
      scheduler.wake();
    }
    clock.set(1.0123);
    const event = scheduler.push('p', 'down', { channel: 5, x: 0.4, y: 0.6, pressure: 0.5, pointerType: 'touch' });
    expect(event).toEqual({ time: 1.0123 + IMMEDIATE_OFFSET, channel: 5, x: 0.4, y: 0.6, pressure: 0.5, pointerType: 'touch' });
    const log = scheduler.events();
    expect(pick(log, 'p', 'down')).toEqual([{ node: 'p', port: 'down', ...event }]);
    expect(pick(log, 'note', 'note')).toMatchObject([{ time: event!.time, channel: 5, pitch: 64 }]);
  });

  it('passes weird payloads through untouched and gives nothing without pushes', () => {
    expect(runtime().query(0, 1)).toEqual([]);
    const rt = runtime();
    const weird: EngineEvent[] = [
      { time: 0.2, channel: 1, x: NaN, y: Infinity, pressure: -3 },
      { time: 0.2, channel: 2, x: 1.5, y: -0.5 },
      { time: 0.3, channel: 0 },
    ];
    for (const event of weird) rt.push('p', 'move', event);
    expect(pick(rt.query(0, 1), 'p', 'move').map(({ node: _n, port: _p, ...e }) => e)).toEqual(weird);
    // Only the four outputs accept pushes; the runtime rejects others.
    expect(() => rt.push('p', 'x', { time: 2, channel: 0 })).toThrow(/no event output/);
  });

  it('drives Make Note pitch from Y at the down, the same ahead, tiled and live', () => {
    const notes = (log: LoggedEvent[]) => pick(log, 'note', 'note').map((e) => [e.time, e.channel, e.pitch]);
    // 76 − 24 × Y at each down: 0.1 → 73.6, 0.8 → 56.8, 0.5 → 64, rounded to the knob's step.
    expect(notes(runAhead(1, 1, pitchPatch))).toEqual([
      [0.1, 0, 74],
      [0.21, 3, 57],
      [0.31, 7, 64],
    ]);
    const reference = JSON.stringify(runAhead(1, 1, pitchPatch));
    expect(JSON.stringify(runAhead(0.025, 1, pitchPatch))).toBe(reference);
    expect(JSON.stringify(runLive(0.025, 1, pitchPatch))).toBe(reference);
    expect(JSON.stringify(runLive(0.1, 1, pitchPatch))).toBe(reference);
  });
});

/** The gestures as a `pushed` map for the helpers. */
function pushedOf(list: { port: Port; event: EngineEvent }[]): Record<string, EngineEvent[]> {
  const out: Record<string, EngineEvent[]> = {};
  for (const { port, event } of list) (out[port] ??= []).push(event);
  return out;
}

/**
 * Queries [0, end) in windows of `step` on one state, and after each window reads every
 * signal on `channels` at the sample times inside it, as the runtime's readers would.
 */
function readSignals(
  list: { port: Port; event: EngineEvent }[],
  step: number,
  times: number[],
  channels: number[],
  end = 1,
): Record<string, number>[] {
  const state: Record<string, unknown> = {};
  const pushed = pushedOf(list);
  const ctx = context(pointer, { state });
  const rows: Record<string, number>[] = [];
  for (let i = 0; i * step < end - 1e-9; i++) {
    const t0 = i * step, t1 = Math.min(end, (i + 1) * step);
    expect(query(pointer, t0, t1, { state, pushed })).toEqual({});
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

/** One read after the window that holds t. */
function readAt(list: { port: Port; event: EngineEvent }[], t: number, channel: number, port: SignalPort, step = 1): number {
  return readSignals(list, step, [t], [channel])[0]![port]!;
}

describe('pointer signals', () => {
  it('tracks X, Y and Pressure per pointer, holding X/Y and dropping Pressure to 0 after Up or Cancel', () => {
    const read = (t: number, channel: number) => {
      const { x, y, pressure } = readSignals(gestures, 1, [t], [channel])[0]!;
      return [x, y, pressure];
    };
    expect(read(0.1, 0)).toEqual([0.2, 0.1, 0.5]);
    expect(read(0.15, 0)).toEqual([0.25, 0.15, 0.5]);
    // Channel 3 is down alongside 0, with its own values.
    expect(read(0.22, 3)).toEqual([0.9, 0.8, 0.3]);
    expect(read(0.27, 3)).toEqual([0.85, 0.7, 0.4]);
    expect(read(0.27, 0)).toEqual([0.25, 0.15, 0.5]);
    // Up on 0 carries its last position; X/Y hold it, Pressure is 0.
    expect(read(0.3, 0)).toEqual([0.3, 0.2, 0]);
    expect(read(0.9, 0)).toEqual([0.3, 0.2, 0]);
    // Cancel works like Up.
    expect(read(0.35, 7)).toEqual([0.5, 0.5, 1]);
    expect(read(0.45, 7)).toEqual([0.5, 0.5, 0]);
    expect(read(0.6, 3)).toEqual([0.8, 0.6, 0]);
  });

  it('counts the pointers down, on every channel, including Cancel', () => {
    const times = [0, 0.1, 0.2, 0.21, 0.3, 0.31, 0.41, 0.42, 0.49, 0.5, 0.9];
    const rows = readSignals(gestures, 1, times, [0, 3, 99]);
    for (const t of times) expect(new Set(rows.filter((r) => r.t === t).map((r) => r.count)).size).toBe(1);
    expect(times.map((t) => rows.find((r) => r.t === t)!.count)).toEqual([0, 1, 1, 2, 1, 2, 2, 1, 1, 0, 0]);
  });

  it('reads an unseen channel, or channel 0 with no pointer 0, as the pointer that changed last', () => {
    const later = gestures.filter((g) => g.event.channel !== 0);
    expect(readAt(later, 0, 0, 'x')).toBe(0);
    expect(readAt(later, 0.22, 0, 'x')).toBe(0.9);
    expect(readAt(later, 0.27, 0, 'y')).toBe(0.7);
    // 7 went down at 0.31, after 3's last move.
    expect(readAt(later, 0.35, 0, 'x')).toBe(0.5);
    expect(readAt(later, 0.35, 42, 'pressure')).toBe(1);
    // After 3's Up at 0.5 it is the latest, lifted: its position, Pressure 0.
    expect(readAt(later, 0.6, 0, 'x')).toBe(0.8);
    expect(readAt(later, 0.6, 0, 'pressure')).toBe(0);
    // With a pointer 0, channel 0 reads that pointer, not the latest.
    expect(readAt(gestures, 0.27, 0, 'x')).toBe(0.25);
  });

  it('lets a read mid-window see only the changes at or before it', () => {
    // One window over everything: the state is folded only at the next query, so each read applies what's due.
    const rows = readSignals(gestures, 1, [0.099, 0.1, 0.129, 0.13, 0.299, 0.3], [0]);
    expect(rows.map((r) => [r.x, r.pressure, r.count])).toEqual([
      [0, 0, 0],
      [0.2, 0.5, 1],
      [0.2, 0.5, 1],
      [0.25, 0.5, 1],
      [0.25, 0.5, 2],
      [0.3, 0, 1],
    ]);
  });

  it('gives the same signal values in 25 ms tiles, 100 ms tiles and one call', () => {
    const times = Array.from({ length: 200 }, (_, k) => k * 0.005);
    const reference = JSON.stringify(readSignals(gestures, 1, times, [0, 3, 7, 5]));
    expect(JSON.stringify(readSignals(gestures, 0.025, times, [0, 3, 7, 5]))).toBe(reference);
    expect(JSON.stringify(readSignals(gestures, 0.1, times, [0, 3, 7, 5]))).toBe(reference);
    // Pushes on window edges, and a down, move and up on one channel at one time.
    const edges: { port: Port; event: EngineEvent }[] = [
      { port: 'up', event: { time: 0.075, channel: 2, x: 0.3, y: 0.3 } },
      { port: 'move', event: { time: 0.075, channel: 2, x: 0.2, y: 0.2 } },
      { port: 'down', event: { time: 0.075, channel: 2, x: 0.1, y: 0.1 } },
      { port: 'down', event: { time: 0.1, channel: 4, x: 0.6, y: 0.4 } },
      { port: 'up', event: { time: 0.2, channel: 4 } },
    ];
    const edgeReference = readSignals(edges, 1, times, [2, 4, 0]);
    expect(JSON.stringify(readSignals(edges, 0.025, times, [2, 4, 0]))).toBe(JSON.stringify(edgeReference));
    // Down, then Move, then Up at one time: lifted at the up's position.
    expect(edgeReference.find((r) => r.t === 0.075 && r.channel === 2)).toMatchObject({ x: 0.3, y: 0.3, pressure: 0, count: 0 });
    // The Up at 0.2 carries no position, so 4 holds its Down's.
    expect(edgeReference.find((r) => r.t === 0.5 && r.channel === 4)).toMatchObject({ x: 0.6, y: 0.4, pressure: 0, count: 0 });
  });

  it('never writes state from a signal read, before or after a query', () => {
    const state: Record<string, unknown> = {};
    const ctx = context(pointer, { state });
    for (const port of SIGNALS) pointer.signal!(ctx, port, 0.5, 3);
    expect(state).toEqual({});
    query(pointer, 0, 1, { state, pushed: pushedOf(gestures) });
    const before = JSON.stringify(state);
    for (const port of SIGNALS) for (const t of [0, 0.25, 0.5, 2]) pointer.signal!(ctx, port, t, 3);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('returns no pushed events from query, in any window', () => {
    const pushed = pushedOf(gestures);
    expect(query(pointer, 0, 1, { pushed })).toEqual({});
    for (const port of PORTS) expect(queryTiled(pointer, port, 1, 0.025, { pushed })).toEqual([]);
  });

  it('gives defined values for weird payloads, channels and times', () => {
    const weird: { port: Port; event: EngineEvent }[] = [
      { port: 'down', event: { time: 0.1, channel: 1, x: NaN, y: Infinity, pressure: 'hard' } },
      { port: 'move', event: { time: 0.2, channel: 1, x: 1.5, y: -0.5, pressure: 7 } },
      { port: 'down', event: { time: 0.3, channel: -1, x: 0.9 } },
      { port: 'down', event: { time: 0.3, channel: 1.5, x: 0.9 } },
      { port: 'down', event: { time: 0.3, channel: NaN, x: 0.9 } },
      { port: 'up', event: { time: 0.4, channel: 9 } },
    ];
    // Down without values: X/Y 0, Pressure the pressed default.
    expect(readSignals(weird, 1, [0.15], [1])[0]).toMatchObject({ x: 0, y: 0, pressure: 0.5, count: 1 });
    // Out of range clamps to 0–1.
    expect(readSignals(weird, 1, [0.25], [1])[0]).toMatchObject({ x: 1, y: 0, pressure: 1, count: 1 });
    // Bad channels are ignored; an Up on a channel never down just adds a lifted pointer.
    expect(readSignals(weird, 1, [0.35], [1])[0]).toMatchObject({ x: 1, count: 1 });
    expect(readSignals(weird, 1, [0.45], [9])[0]).toMatchObject({ x: 0, y: 0, pressure: 0, count: 1 });
    // No pushes, NaN and infinite times.
    const state: Record<string, unknown> = {};
    const ctx = context(pointer, { state });
    for (const port of SIGNALS) expect(pointer.signal!(ctx, port, 0.5, 0)).toBe(0);
    query(pointer, 0, 1, { state, pushed: pushedOf(weird) });
    expect(pointer.signal!(ctx, 'count', NaN, 1)).toBe(0);
    expect(pointer.signal!(ctx, 'count', Infinity, 1)).toBe(1);
    expect(pointer.signal!(ctx, 'nope', 0.5, 1)).toBe(0);
  });

  it('forgets the oldest lifted pointers past the cap, never one that is down', () => {
    const many: { port: Port; event: EngineEvent }[] = [{ port: 'down', event: { time: 0.001, channel: 1000, x: 0.9 } }];
    for (let k = 0; k < MAX_LIFTED + 10; k++) {
      many.push({ port: 'down', event: { time: 0.01 + k * 0.01, channel: k, x: k / 100 } });
      many.push({ port: 'up', event: { time: 0.015 + k * 0.01, channel: k } });
    }
    const state: Record<string, unknown> = {};
    query(pointer, 0, 1, { state, pushed: pushedOf(many) });
    query(pointer, 1, 2, { state });
    const contacts = state.contacts as { channel: number }[];
    expect(contacts).toHaveLength(MAX_LIFTED + 1);
    expect(contacts.map((c) => c.channel)).toContain(1000);
    const ctx = context(pointer, { state });
    expect(pointer.signal!(ctx, 'count', 1.5, 0)).toBe(1);
    // A forgotten pointer reads the latest one.
    expect(pointer.signal!(ctx, 'x', 1.5, 0)).toBe((MAX_LIFTED + 9) / 100);
    expect(pointer.signal!(ctx, 'x', 1.5, MAX_LIFTED + 9)).toBe((MAX_LIFTED + 9) / 100);
  });
});
