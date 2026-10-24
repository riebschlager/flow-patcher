import { describe, expect, it } from 'vitest';
import {
  compilePatch,
  IMMEDIATE_OFFSET,
  inputRouter,
  ManualClock,
  replayInput,
  Runtime,
  Scheduler,
  type EngineEvent,
  type InputEvent,
  type LoggedEvent,
  type Patch,
} from '@flow-patcher/engine';
import { nodeRegistry, wheel } from '../src';
import { LINE_PIXELS, MAX_DELTA, MAX_SUM, PAGE_PIXELS, WHEEL_STEP, wheelPixels } from '../src/wheel';
import { context, pushedIn, query, queryTiled } from './helpers';

const mods = { shift: false, alt: false, ctrl: false, meta: false };
const at = (time: number, deltaX: number, deltaY: number, more: Partial<EngineEvent> = {}): EngineEvent => ({ time, channel: 0, x: 0.5, y: 0.5, deltaX, deltaY, deltaMode: 0, ...mods, ...more });

/** A vertical notch, a diagonal swipe, a pinch out, a line-mode notch (Firefox), a pinch in, a page scroll left. */
const pushed: Record<string, EngineEvent[]> = {
  wheel: [
    at(0.1, 0, 100),
    at(0.2, 30, -20, { x: 0.25, y: 0.75 }),
    at(0.3, 0, -5, { ctrl: true }),
    at(0.45, 0, 3, { deltaMode: 1, channel: 2 }),
    at(0.6, 2, 10, { ctrl: true }),
    at(0.8, -0.5, 0, { deltaMode: 2 }),
  ],
};

/**
 * Runs the node over [0, end) in windows of `step`, as the runtime does (each window sees its own
 * pushes; signals are read after the window's query, for times inside it), and samples a signal at `times`.
 */
function sample(port: string, times: number[], step: number, { decay = 2, channel = 0, events = pushed } = {}): number[] {
  const state = {};
  const ctx = context(wheel, { params: { decay }, state });
  const values: number[] = [];
  const end = Math.max(...times) + 1e-6;
  for (let t0 = 0; t0 < end; t0 += step) {
    const t1 = t0 + step;
    wheel.query!({ ...ctx, inputs: {}, pushed: pushedIn(events, t0, t1), t0, t1 });
    for (const t of times) if (t >= t0 && t < t1) values.push(wheel.signal!(ctx, port, t, channel));
  }
  return values;
}

const grid = Array.from({ length: 50 }, (_, i) => i * 0.02 + 0.005);

describe('wheel', () => {
  it('has DeltaX, DeltaY and Zoom events and three accumulated signals, reads wheel, and has no All', () => {
    expect(wheel.category).toBe('canvas-sources');
    expect(wheel.ports.map((p) => [p.name, p.type, p.direction])).toEqual([
      ['deltaX', 'event', 'out'],
      ['deltaY', 'event', 'out'],
      ['zoom', 'event', 'out'],
      ['scrollX', 'signal', 'out'],
      ['scrollY', 'signal', 'out'],
      ['zoomLevel', 'signal', 'out'],
    ]);
    expect(wheel.ports.some((p) => p.name === 'all')).toBe(false);
    expect(wheel.params.map((p) => p.name)).toEqual(['decay']);
    expect(wheel.input).toEqual({ reads: { wheel: 'wheel' }, rewrites: true });
  });

  it('normalises deltaMode to CSS pixels and clamps wild deltas', () => {
    expect(wheelPixels(100, 0)).toBe(100);
    expect(wheelPixels(3, 1)).toBe(3 * LINE_PIXELS);
    expect(wheelPixels(-1, 2)).toBe(-PAGE_PIXELS);
    expect(wheelPixels(1e9, 0)).toBe(MAX_DELTA);
    expect(wheelPixels(-1e9, 2)).toBe(-MAX_DELTA);
    for (const bad of [NaN, Infinity, undefined, 'up']) expect(wheelPixels(bad, 0)).toBe(0);
    expect(Object.is(wheelPixels(-0, 0), 0)).toBe(true);
  });

  it('sends plain wheels to DeltaX and DeltaY in pixels, and Ctrl wheels (pinch) to Zoom only', () => {
    const out = query(wheel, 0, 1, { pushed });
    // deltaMode is gone and the deltas are pixels.
    expect(out.deltaY!.map((e) => [e.time, e.deltaY])).toEqual([[0.1, 100], [0.2, -20], [0.45, 3 * LINE_PIXELS]]);
    expect(out.deltaX!.map((e) => [e.time, e.deltaX])).toEqual([[0.2, 30], [0.8, -0.5 * PAGE_PIXELS]]);
    expect(out.deltaX![0]).toEqual({ time: 0.2, channel: 0, x: 0.25, y: 0.75, deltaX: 30, deltaY: -20, ...mods });
    // Pinch out (deltaY < 0) zooms in: zoom = −deltaY / 100. Never on DeltaY, even with a deltaX.
    expect(out.zoom).toEqual([
      { time: 0.3, channel: 0, x: 0.5, y: 0.5, deltaX: 0, deltaY: -5, ...mods, ctrl: true, zoom: 0.05 },
      { time: 0.6, channel: 0, x: 0.5, y: 0.5, deltaX: 2, deltaY: 10, ...mods, ctrl: true, zoom: -0.1 },
    ]);
    expect([...out.deltaX!, ...out.deltaY!].some((e) => e.ctrl)).toBe(false);
  });

  it('keeps each event\'s channel, and its signals are the same on every channel', () => {
    const out = query(wheel, 0, 1, { pushed });
    expect(out.deltaY!.map((e) => e.channel)).toEqual([0, 0, 2]);
    for (const port of ['scrollX', 'scrollY', 'zoomLevel']) expect(sample(port, grid, 0.1, { channel: 2 })).toEqual(sample(port, grid, 0.1, { channel: 0 }));
  });

  it('gives the same events however time was split into windows', () => {
    for (const port of ['deltaX', 'deltaY', 'zoom']) {
      const reference = query(wheel, 0, 1, { pushed })[port] ?? [];
      expect(reference.length).toBeGreaterThan(0);
      for (const step of [0.025, 0.1, 0.07, 0.45]) expect(queryTiled(wheel, port, 1, step, { pushed }), `${port} @ ${step}`).toEqual(reference);
    }
  });

  it('gives the same signals however time was split into windows (the decay is analytic)', () => {
    for (const port of ['scrollX', 'scrollY', 'zoomLevel']) {
      const reference = sample(port, grid, 1.5);
      for (const step of [0.025, 0.1, 0.07]) expect(sample(port, grid, step), `${port} @ ${step}`).toEqual(reference);
    }
  });

  it('sums the deltas in notches (100 px) and decays them exponentially from each event', () => {
    const decay = 2;
    const y = (t: number) => sample('scrollY', [t], 0.025, { decay })[0]!;
    expect(y(0.05)).toBe(0);
    expect(y(0.1)).toBeCloseTo(1, 12);
    expect(y(0.15)).toBeCloseTo(Math.exp(-decay * 0.05), 12);
    // At 0.2 the swipe adds −0.2.
    const at02 = Math.exp(-decay * 0.1) - 0.2;
    expect(y(0.2)).toBeCloseTo(at02, 12);
    // The pinch at 0.3 doesn't touch Scroll Y; Firefox's 3 lines at 0.45 add 1.2.
    expect(y(0.4)).toBeCloseTo(at02 * Math.exp(-decay * 0.2), 12);
    expect(y(0.45)).toBeCloseTo(at02 * Math.exp(-decay * 0.25) + (3 * LINE_PIXELS) / WHEEL_STEP, 12);
    const zoom = sample('zoomLevel', [0.29, 0.3, 0.5, 0.6], 0.025, { decay });
    expect(zoom[0]).toBe(0);
    expect(zoom[1]).toBeCloseTo(0.05, 12);
    expect(zoom[2]).toBeCloseTo(0.05 * Math.exp(-decay * 0.2), 12);
    expect(zoom[3]).toBeCloseTo(0.05 * Math.exp(-decay * 0.3) - 0.1, 12);
    expect(sample('scrollX', [0.8], 0.1, { decay })[0]).toBeCloseTo(0.3 * Math.exp(-decay * 0.6) - 4, 12);
  });

  it('holds the sums with decay 0', () => {
    expect(sample('scrollY', [0.5, 0.99], 0.1, { decay: 0 })).toEqual([0.8 + 1.2, 0.8 + 1.2].map((v) => expect.closeTo(v, 12)) as unknown as number[]);
    expect(sample('zoomLevel', [0.99], 0.1, { decay: 0 })[0]).toBeCloseTo(-0.05, 12);
  });

  it('gives weird input a defined result', () => {
    expect(query(wheel, 0, 1)).toEqual({});
    expect(query(wheel, 0, 1, { pushed: { wheel: [] } })).toEqual({});
    expect(sample('scrollY', [0.5], 0.1, { events: {} })).toEqual([0]);
    const weird: Record<string, EngineEvent[]> = {
      wheel: [
        at(0.1, NaN, Infinity),
        { time: NaN, channel: 0, deltaY: 50 },
        at(0.2, 0, 1e12, { x: -3, y: NaN, channel: 1.5, deltaMode: 7 }),
        { time: 0.3, channel: 0, deltaY: 'down' as unknown as number },
        at(0.4, 0, -1e12, { ctrl: true }),
        at(0.5, 0, 1e12),
      ],
    };
    const out = query(wheel, 0, 1, { pushed: weird });
    // NaN and Infinity deltas are 0: no event. A huge delta clamps; an unknown deltaMode is pixels.
    expect(out.deltaY!.map((e) => [e.time, e.channel, e.deltaY, e.x, e.y])).toEqual([[0.2, 0, MAX_DELTA, 0, undefined], [0.5, 0, MAX_DELTA, 0.5, 0.5]]);
    expect('y' in out.deltaY![0]!).toBe(false);
    expect(out.deltaX).toBeUndefined();
    expect(out.zoom!.map((e) => e.zoom)).toEqual([MAX_DELTA / WHEEL_STEP]);
    // The sums stay finite and clamp, with no decay.
    expect(sample('scrollY', [0.6], 0.1, { decay: 0, events: weird })).toEqual([200]);
    const flood = { wheel: Array.from({ length: 300 }, (_, i) => at(i * 0.001, 0, MAX_DELTA)) };
    expect(sample('scrollY', [0.5], 0.1, { decay: 0, events: flood })).toEqual([MAX_SUM]);
    for (const v of sample('zoomLevel', grid, 0.1, { events: weird })) expect(Number.isFinite(v)).toBe(true);
    // Unknown ports read 0.
    expect(sample('nope', [0.5], 0.1)).toEqual([0]);
  });
});

const node = (id: string, type: string, params = {}) => ({ id, type, typeVersion: nodeRegistry.get(type)!.version, params, position: { x: 0, y: 0 } });

/** Wheel's DeltaY and Zoom into two Make Notes. */
const patch: Patch = {
  format: 'flowpatch',
  version: 1,
  seed: 1,
  nodes: [node('w', 'wheel'), node('a', 'make-note', { pitch: 60 }), node('z', 'make-note', { pitch: 72 })],
  cables: [
    { from: { node: 'w', port: 'deltaY' }, to: { node: 'a', port: 'trigger' } },
    { from: { node: 'w', port: 'zoom' }, to: { node: 'z', port: 'trigger' } },
  ],
};

function plan() {
  const compiled = compilePatch(patch, nodeRegistry);
  if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
  return compiled.plan;
}
const pick = (log: LoggedEvent[], node: string, port: string) => log.filter((e) => e.node === node && e.port === port).map(({ node: _n, port: _p, ...e }) => e);

const stream: { events: InputEvent[] } = {
  events: [
    { time: 0.1, type: 'wheel', x: 0.5, y: 0.5, deltaX: 0, deltaY: 100, deltaMode: 0, ...mods },
    { time: 0.3, type: 'wheel', x: 0.5, y: 0.5, deltaX: 0, deltaY: 3, deltaMode: 1, ...mods },
    { time: 0.5, type: 'wheel', x: 0.4, y: 0.6, deltaX: 0, deltaY: -8, deltaMode: 0, ...mods, ctrl: true },
  ],
};

describe('wheel in a patch', () => {
  it('routes wheel onto its push-only port, on channel 0', () => {
    const router = inputRouter(plan());
    expect([...router.types]).toEqual(['wheel']);
    expect(router.route({ type: 'wheel', deltaY: 4 })).toEqual([{ node: 'w', port: 'wheel', fields: { channel: 0, deltaY: 4 } }]);
  });

  it('replays a stream onto DeltaY and Zoom, and windows don\'t matter', () => {
    const run = (step: number) => {
      const rt = new Runtime(plan());
      replayInput(rt, stream);
      const log: LoggedEvent[] = [];
      for (let i = 0; i * step < 1 - 1e-9; i++) log.push(...rt.query(i * step, Math.min(1, (i + 1) * step)));
      return log;
    };
    const log = run(1);
    expect(pick(log, 'w', 'deltaY').map((e) => [e.time, e.deltaY])).toEqual([[0.1, 100], [0.3, 3 * LINE_PIXELS]]);
    expect(pick(log, 'w', 'zoom').map((e) => [e.time, e.zoom])).toEqual([[0.5, 0.08]]);
    expect(pick(log, 'z', 'note').map((e) => e.time)).toEqual([0.5]);
    expect(JSON.stringify(run(0.025))).toBe(JSON.stringify(log));
    expect(JSON.stringify(run(0.1))).toBe(JSON.stringify(log));
  });

  it('a live wheel lands at currentTime + 5 ms with its note', () => {
    const clock = new ManualClock();
    const scheduler = new Scheduler(new Runtime(plan()), { clock, record: true });
    for (let k = 0; k < 40; k++) {
      clock.set(k * 0.025);
      scheduler.wake();
    }
    clock.set(1.0123);
    const [event] = scheduler.pushAll(inputRouter(plan()).route({ type: 'wheel', x: 0.4, y: 0.6, deltaX: 0, deltaY: 2, deltaMode: 1, ...mods }))!;
    expect(event!.time).toBe(1.0123 + IMMEDIATE_OFFSET);
    expect(pick(scheduler.events(), 'w', 'deltaY')).toEqual([{ time: event!.time, channel: 0, x: 0.4, y: 0.6, deltaX: 0, deltaY: 2 * LINE_PIXELS, ...mods }]);
    expect(pick(scheduler.events(), 'a', 'note').map((e) => e.time)).toEqual([event!.time]);
  });
});
