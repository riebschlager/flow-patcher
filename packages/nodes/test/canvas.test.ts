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
import { canvas, nodeRegistry } from '../src';
import { aspectOf } from '../src/canvas';
import { context, query, queryTiled } from './helpers';

const resize = (time: number, canvasWidth: number, canvasHeight: number): EngineEvent => ({ time, channel: 0, canvasWidth, canvasHeight });
const at = (time: number, fields: Record<string, unknown> = {}): EngineEvent => ({ time, channel: 0, ...fields }) as EngineEvent;

/** A session: sized, focused, stretched, blurred, hidden and back. */
const pushed: Record<string, EngineEvent[]> = {
  resize: [resize(0.05, 400, 300), resize(0.3, 600, 300), resize(0.3, 800, 450), resize(0.72, 0, 0), resize(0.9, 320, 640)],
  focus: [at(0.1), at(0.85)],
  blur: [at(0.4)],
  visibility: [at(0.5, { visibility: 'hidden' }), at(0.8, { visibility: 'visible' })],
};

const EMPTY = { focus: [], blur: [], hidden: [], visible: [] };

describe('canvas', () => {
  it('has Focus, Blur, Hidden and Visible events and Width, Height and Aspect signals, and no All', () => {
    expect(canvas.category).toBe('canvas-sources');
    expect(canvas.ports.map((p) => [p.name, p.type, p.direction])).toEqual([
      ['focus', 'event', 'out'],
      ['blur', 'event', 'out'],
      ['hidden', 'event', 'out'],
      ['visible', 'event', 'out'],
      ['width', 'signal', 'out'],
      ['height', 'signal', 'out'],
      ['aspect', 'signal', 'out'],
    ]);
    expect(canvas.params).toEqual([]);
    expect(canvas.input).toEqual({ reads: { resize: 'resize', focus: 'focus', blur: 'blur', visibilitychange: 'visibility' }, rewrites: true });
  });

  it('emits Focus, Blur, Hidden and Visible at the pushes\' times, on channel 0, without the payload', () => {
    const out = query(canvas, 0, 1, { pushed: { ...pushed, focus: [at(0.1, { channel: 7, x: 0.5 })] } });
    expect(out.focus).toEqual([{ time: 0.1, channel: 0 }]);
    expect(out.blur).toEqual([{ time: 0.4, channel: 0 }]);
    expect(out.hidden).toEqual([{ time: 0.5, channel: 0 }]);
    expect(out.visible).toEqual([{ time: 0.8, channel: 0 }]);
    // Resizes move the signals only.
    expect(Object.keys(out).sort()).toEqual(['blur', 'focus', 'hidden', 'visible']);
  });

  it('gives the same events in 25 ms, 100 ms and one window', () => {
    for (const port of ['focus', 'blur', 'hidden', 'visible']) {
      const whole = query(canvas, 0, 1, { pushed })[port];
      expect(whole!.length, port).toBeGreaterThan(0);
      expect(queryTiled(canvas, port, 1, 0.025, { pushed }), port).toEqual(whole);
      expect(queryTiled(canvas, port, 1, 0.1, { pushed }), port).toEqual(whole);
    }
  });

  it('emits nothing without pushes, and survives weird windows and payloads', () => {
    expect(queryTiled(canvas, 'focus', 2, 0.025)).toEqual([]);
    for (const [t0, t1] of [[1, 1], [2, 1], [NaN, 1], [0, Infinity], [-Infinity, NaN]]) expect(query(canvas, t0!, t1!)).toEqual(EMPTY);
    // Visibility other than hidden or visible (prerender, missing, a boolean) is ignored.
    const weird = { visibility: [at(0.1, { visibility: 'prerender' }), at(0.2), at(0.3, { visibility: true })] };
    expect(query(canvas, 0, 1, { pushed: weird })).toEqual(EMPTY);
  });
});

/** Queries [0, 1) in windows of `step` on one state and reads `port` on `channels` at `times`, after the window holding each. */
function read(port: string, step: number, times: number[], channels: number[], events = pushed): number[][] {
  const state: Record<string, unknown> = {};
  const ctx = context(canvas, { state });
  const rows: number[][] = [];
  for (let i = 0; i * step < 1 - 1e-9; i++) {
    const t0 = i * step, t1 = Math.min(1, (i + 1) * step);
    query(canvas, t0, t1, { state, pushed: events });
    for (const t of times.filter((time) => time >= t0 && time < t1)) rows.push(channels.map((channel) => canvas.signal!(ctx, port, t, channel)));
    // Snapshots must clone: plain data only.
    expect(() => structuredClone(state)).not.toThrow();
  }
  return rows;
}

describe('canvas size', () => {
  const times = [0, 0.05, 0.2, 0.3, 0.5, 0.72, 0.8, 0.95];
  // One canvas: every channel, 0 and out-of-range ones included, reads the same.
  const channels = [0, 1, 5, -3, NaN];
  const same = (values: number[]) => values.map((v) => channels.map(() => v));

  it('holds the latest resize\'s Width and Height in CSS pixels, 0 before the first, on every channel', () => {
    expect(read('width', 1, times, channels)).toEqual(same([0, 400, 400, 800, 800, 0, 0, 320]));
    expect(read('height', 1, times, channels)).toEqual(same([0, 300, 300, 450, 450, 0, 0, 640]));
  });

  it('reads Aspect as width / height, and 1 while either is 0', () => {
    expect(read('aspect', 1, times, channels)).toEqual(same([1, 4 / 3, 4 / 3, 16 / 9, 16 / 9, 1, 1, 0.5]));
    expect(aspectOf(0, 100)).toBe(1);
    expect(aspectOf(100, 0)).toBe(1);
  });

  it('reads the same however time was split into windows', () => {
    for (const port of ['width', 'height', 'aspect']) {
      const reference = read(port, 1, times, channels);
      for (const step of [0.025, 0.1, 0.07]) expect(read(port, step, times, channels), `${port} ${step}`).toEqual(reference);
    }
  });

  it('ignores resizes with a missing, negative or non-finite dimension', () => {
    const weird = {
      resize: [
        resize(0.1, 300, 200),
        resize(0.2, NaN, 100), resize(0.3, 100, -1), resize(0.4, Infinity, 10), at(0.5, { canvasWidth: 50 }),
        at(0.6, { canvasWidth: '50', canvasHeight: 50 }), resize(NaN, 1, 1),
      ],
    };
    expect(read('width', 0.1, [0.05, 0.15, 0.95], [0], weird)).toEqual([[0], [300], [300]]);
    expect(read('height', 0.1, [0.05, 0.15, 0.95], [0], weird)).toEqual([[0], [200], [200]]);
    expect(canvas.signal!(context(canvas), 'nope', 0, 0)).toBe(0);
  });
});

const node = (id: string, type: string, params = {}) => ({ id, type, typeVersion: nodeRegistry.get(type)!.version, params, position: { x: 0, y: 0 } });

/** Canvas's Focus into Make Note, as in examples/canvas-lifecycle.flowpatch, without the audio. */
const patch: Patch = {
  format: 'flowpatch',
  version: 1,
  seed: 1,
  nodes: [node('c', 'canvas'), node('chime', 'make-note')],
  cables: [{ from: { node: 'c', port: 'focus' }, to: { node: 'chime', port: 'trigger' } }],
};

function plan() {
  const compiled = compilePatch(patch, nodeRegistry);
  if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
  return compiled.plan;
}
const pick = (log: LoggedEvent[], node: string, port: string) => log.filter((e) => e.node === node && e.port === port).map(({ node: _n, port: _p, ...e }) => e);

describe('canvas in a patch', () => {
  it('reads the stream\'s resize, focus, blur and visibilitychange events, on channel 0', () => {
    const router = inputRouter(plan());
    expect([...router.types].sort()).toEqual(['blur', 'focus', 'resize', 'visibilitychange']);
    expect(router.route({ type: 'resize', canvasWidth: 640, canvasHeight: 480 })).toEqual([{ node: 'c', port: 'resize', fields: { channel: 0, canvasWidth: 640, canvasHeight: 480 } }]);
    expect(router.route({ type: 'visibilitychange', visibility: 'hidden' })).toEqual([{ node: 'c', port: 'visibility', fields: { channel: 0, visibility: 'hidden' } }]);
    expect(router.route({ type: 'pointerdown', channel: 1, x: 0, y: 0 })).toEqual([]);
  });

  it('replays a stream: events once each, signals follow, and windows don\'t matter', () => {
    const events: InputEvent[] = [
      { time: 0.05, type: 'resize', canvasWidth: 400, canvasHeight: 300 },
      { time: 0.1, type: 'focus' },
      { time: 0.4, type: 'blur' },
      { time: 0.5, type: 'visibilitychange', visibility: 'hidden' },
      { time: 0.8, type: 'visibilitychange', visibility: 'visible' },
      { time: 0.85, type: 'focus' },
    ];
    const run = (step: number) => {
      const rt = new Runtime(plan());
      replayInput(rt, { events });
      const log: LoggedEvent[] = [];
      for (let i = 0; i * step < 1 - 1e-9; i++) log.push(...rt.query(i * step, Math.min(1, (i + 1) * step)));
      return { rt, log };
    };
    const { rt, log } = run(1);
    expect(pick(log, 'c', 'focus')).toEqual([{ time: 0.1, channel: 0 }, { time: 0.85, channel: 0 }]);
    expect(pick(log, 'c', 'blur')).toEqual([{ time: 0.4, channel: 0 }]);
    expect(pick(log, 'c', 'hidden')).toEqual([{ time: 0.5, channel: 0 }]);
    expect(pick(log, 'c', 'visible')).toEqual([{ time: 0.8, channel: 0 }]);
    expect(pick(log, 'chime', 'note').map((e) => e.time)).toEqual([0.1, 0.85]);
    expect(rt.signalAt('c', 'width', 0.9)).toBe(400);
    expect(rt.signalAt('c', 'aspect', 0.9)).toBe(4 / 3);
    expect(JSON.stringify(run(0.025).log)).toBe(JSON.stringify(log));
    expect(JSON.stringify(run(0.1).log)).toBe(JSON.stringify(log));
  });

  it('a live focus lands at currentTime + 5 ms, after windows already queried', () => {
    const clock = new ManualClock();
    const scheduler = new Scheduler(new Runtime(plan()), { clock, record: true });
    for (let k = 0; k < 40; k++) {
      clock.set(k * 0.025);
      scheduler.wake();
    }
    clock.set(1.0123);
    const [event] = scheduler.pushAll(inputRouter(plan()).route({ type: 'focus' }))!;
    expect(event).toEqual({ time: 1.0123 + IMMEDIATE_OFFSET, channel: 0 });
    expect(pick(scheduler.events(), 'c', 'focus')).toEqual([{ time: event!.time, channel: 0 }]);
    expect(pick(scheduler.events(), 'chime', 'note').map((e) => e.time)).toEqual([event!.time]);
  });
});
