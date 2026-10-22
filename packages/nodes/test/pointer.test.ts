import { describe, expect, it } from 'vitest';
import { compilePatch, IMMEDIATE_OFFSET, ManualClock, Runtime, Scheduler, type EngineEvent, type LoggedEvent, type Patch } from '@flow-patcher/engine';
import { nodeRegistry, pointer } from '../src';
import { query, queryTiled } from './helpers';

const PORTS = ['down', 'move', 'up', 'cancel'] as const;
type Port = (typeof PORTS)[number];

const node = (id: string, type: string, params = {}) => ({ id, type, typeVersion: nodeRegistry.get(type)!.version, params, position: { x: 0, y: 0 } });

/** Pointer, with Down feeding a Make Note, as in examples/pointer-notes.flowpatch. */
const patch: Patch = {
  format: 'flowpatch',
  version: 1,
  seed: 1,
  nodes: [node('p', 'pointer'), node('note', 'make-note', { pitch: 64 })],
  cables: [{ from: { node: 'p', port: 'down' }, to: { node: 'note', port: 'trigger' } }],
};

function runtime(history = false): Runtime {
  const compiled = compilePatch(patch, nodeRegistry);
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
function runAhead(step: number, end = 1): LoggedEvent[] {
  const rt = runtime();
  for (const { port, event } of gestures) expect(rt.push('p', port, { ...event })).toBeNull();
  const log: LoggedEvent[] = [];
  for (let i = 0; i * step < end - 1e-9; i++) log.push(...rt.query(i * step, Math.min(end, (i + 1) * step)));
  return log;
}

/** Live: each push arrives after the runtime has already queried 120 ms past it, so it rewinds. */
function runLive(step: number, end = 1): LoggedEvent[] {
  const rt = runtime(true);
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
  it('has the four event outputs and no inputs or params (M1 basic)', () => {
    expect(pointer.category).toBe('canvas-sources');
    expect(pointer.ports.map((p) => [p.name, p.type, p.direction])).toEqual(PORTS.map((name) => [name, 'event', 'out']));
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
});
