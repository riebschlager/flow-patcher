// Visual nodes on the frame clock (design.md, "Visual nodes run on the frame
// clock"; ADR 0020): scheduled events land when their sound is heard, a tap's
// own events land on the next frame, and no rewind or swap hands a frame an
// event twice or out of order.
import { describe, expect, it } from 'vitest';
import {
  compilePatch,
  FRAME_BACKLOG,
  FRAME_QUEUE_LIMIT,
  FrameLoop,
  ManualClock,
  MAX_FRAME_SPAN,
  Runtime,
  Scheduler,
  type AudioContextLike,
  type EngineEvent,
  type EventPath,
  type NodeDefinition,
  type Patch,
} from '../src';

/** No query: events only arrive through push. */
const tap: NodeDefinition = {
  type: 'tap', version: 1, label: 'Tap', category: 'canvas-sources', description: '',
  ports: [{ name: 'out', type: 'event', direction: 'out' }],
  params: [],
};
/** Ticks every `period` seconds, from absolute time. */
const metro: NodeDefinition = {
  type: 'metro', version: 1, label: 'Metro', category: 'time-rhythm', description: '',
  ports: [{ name: 'out', type: 'event', direction: 'out' }],
  params: [{ name: 'period', kind: 'number', min: 0.001, max: 1, default: 0.05 }, { name: 'channel', kind: 'number', min: 0, max: 15, default: 9, step: 1 }],
  query: ({ t0, t1, params }) => {
    const period = params.period as number;
    const out: EngineEvent[] = [];
    for (let k = Math.max(0, Math.ceil(t0 / period - 1e-9)); k * period < t1; k++) if (k * period >= t0) out.push({ time: k * period, channel: params.channel as number });
    return { out };
  },
};
/** Copies events into new objects, as most nodes do. */
const pass: NodeDefinition = {
  type: 'pass', version: 1, label: 'Pass', category: 'control-logic', description: '',
  ports: [{ name: 'in', type: 'event', direction: 'in' }, { name: 'out', type: 'event', direction: 'out' }],
  params: [],
  query: ({ inputs }) => ({ out: (inputs.in ?? []).map((e) => ({ ...e, passed: true })) }),
};
/** Shifts events by params.time (a Delay Edge stand-in): what a tap causes later. */
const delay: NodeDefinition = {
  type: 'delay', version: 1, label: 'Delay', category: 'control-logic', description: '',
  ports: [{ name: 'in', type: 'event', direction: 'in' }, { name: 'out', type: 'event', direction: 'out' }],
  params: [{ name: 'time', kind: 'number', min: 0.01, max: 2, default: 0.05, modulatable: false }],
  delay: (params) => params.time as number,
  query: ({ inputs, params, state, t1 }) => {
    const pending = [...((state.pending as EngineEvent[] | undefined) ?? []), ...(inputs.in ?? []).map((e) => ({ ...e, time: e.time + (params.time as number), echo: true }))];
    state.pending = pending.filter((e) => e.time >= t1);
    return { out: pending.filter((e) => e.time < t1) };
  },
};
interface Seen { time: number; channel: number; path: EventPath; t1: number; echo?: boolean }
/** Records every event each frame hands it, with its path and the frame's t1. */
const sink: NodeDefinition = {
  type: 'sink', version: 1, label: 'Sink', category: 'visual', description: '',
  ports: [{ name: 'in', type: 'event', direction: 'in' }],
  params: [],
  frame: ({ inputs, state, pathOf, t1 }) => {
    const seen = ((state.seen as Seen[] | undefined) ??= []);
    const batches = ((state.batches as number[][] | undefined) ??= []);
    const batch = inputs.in ?? [];
    for (const e of batch) seen.push({ time: e.time, channel: e.channel, path: pathOf(e), t1, ...(e.echo ? { echo: true } : {}) });
    if (batch.length) batches.push(batch.map((e) => e.time));
  },
};
/** An audio node that records the times it's handed. */
const voice: NodeDefinition = {
  type: 'voice', version: 1, label: 'Voice', category: 'instruments', description: '',
  ports: [{ name: 'note', type: 'event', direction: 'in' }],
  params: [],
  audio: ({ state }) => {
    const played = ((state.played as EngineEvent[] | undefined) ??= []);
    return {
      schedule: (_port, events) => void played.push(...events),
      cancel: (_port, events) => {
        for (const e of events) played.splice(played.indexOf(e), 1);
      },
    };
  },
};
const definitions = new Map([tap, metro, pass, delay, sink, voice].map((d) => [d.type, d]));

const node = (id: string, type: string, params = {}) => ({ id, type, typeVersion: 1, params, position: { x: 0, y: 0 } });
const cable = (a: string, b: string, from = 'out', to = 'in') => ({ from: { node: a, port: from }, to: { node: b, port: to } });
const patch = (nodes: Patch['nodes'], cables: Patch['cables']): Patch => ({ format: 'flowpatch', version: 1, seed: 1, nodes, cables });
function compile(p: Patch) {
  const result = compilePatch(p, definitions);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.plan;
}
const seen = (runtime: Runtime, id = 'v') => ((runtime.stateOf(id)?.seen as Seen[] | undefined) ?? []);
const batches = (runtime: Runtime, id = 'v') => ((runtime.stateOf(id)?.batches as number[][] | undefined) ?? []);
const ms = (t: number) => Math.round(t * 1e6) / 1e3;

describe('frames and the immediate path (ADR 0020)', () => {
  /** Tap → Splat-like sink and → Voice; Tap → Pass → Delay → sink; Metro → sink. Live scheduler, 200 ms output latency. */
  function live() {
    const runtime = new Runtime(compile(patch(
      [node('t', 'tap'), node('m', 'metro', { period: 0.05 }), node('p', 'pass'), node('d', 'delay'), node('v', 'sink'), node('s', 'voice')],
      [cable('t', 'v'), cable('t', 's', 'out', 'note'), cable('m', 'v'), cable('t', 'p'), cable('p', 'd'), cable('d', 'v')],
    )));
    const clock = new ManualClock();
    const scheduler = new Scheduler(runtime, { clock });
    runtime.attachAudio({} as AudioContextLike);
    const loop = new FrameLoop(runtime, { clock: { audioTime: () => clock.audio, wallTime: () => clock.wall, outputLatency: () => 0.2 } });
    /** Moves the clock to `t`, wakes the scheduler and runs a frame. */
    const step = (t: number) => {
      clock.set(t);
      scheduler.wake();
      return loop.tick();
    };
    const played = () => ((runtime.stateOf('s')?.played as EngineEvent[] | undefined) ?? []).map((e) => e.time);
    return { runtime, scheduler, clock, loop, step, played };
  }

  it("shows a tap's splash on the next frame while its sound stays at currentTime + 5 ms", () => {
    const { runtime, scheduler, step, played } = live();
    step(1);
    const event = scheduler.push('t', 'out', { channel: 3 })!;
    expect(event.time).toBeCloseTo(1.005, 12);
    expect(played()).toEqual([event.time]);
    const frame = step(1.016);
    // The frame clock is at 0.816, yet the splash at 1.005 is here, by arrival.
    expect(frame.t1).toBeCloseTo(0.816, 12);
    expect(seen(runtime)).toEqual([{ time: event.time, channel: 3, path: 'immediate', t1: frame.t1 }]);
    expect(played()).toEqual([event.time]);
    // The host learns which frame handed the tap over (the browser's splash log, #40).
    expect(runtime.lastFrame).toMatchObject({ t1: frame.t1, immediate: 1, taps: [{ node: 'v', port: 'in', time: event.time, channel: 3 }] });
    step(1.032);
    expect(runtime.lastFrame).toMatchObject({ immediate: 0, taps: [] });
  });

  it('keeps scheduled events and what the tap causes later on the shifted clock, and shows each once', () => {
    const { runtime, scheduler, step } = live();
    step(1);
    const event = scheduler.push('t', 'out', { channel: 3 })!;
    for (let k = 1; k <= 30; k++) step(1 + k / 60);
    const log = seen(runtime);
    expect(log[0]).toMatchObject({ time: event.time, path: 'immediate' });
    // Everything else, the Delay's echo of the tap included, lands once the shifted clock passes it.
    for (const e of log.slice(1)) {
      expect(e.path).toBe('scheduled');
      expect(e.t1).toBeGreaterThan(e.time);
      expect(e.t1 - e.time).toBeLessThanOrEqual(1 / 60 + 1e-9);
    }
    const echo = log.filter((e) => e.echo);
    expect(echo.map((e) => ms(e.time))).toEqual([ms(event.time + 0.05)]);
    expect(log.filter((e) => e.channel === 9).map((e) => ms(e.time))).toEqual([1000, 1050, 1100, 1150, 1200, 1250]);
    expect(log.filter((e) => e.time === event.time)).toHaveLength(1);
  });

  it('a second tap stamped at the same time rewinds over the first without showing it again', () => {
    const { runtime, scheduler, loop, step, played } = live();
    step(1);
    const first = scheduler.push('t', 'out', { channel: 1 })!;
    // A frame takes the first splash before the audio clock moves on.
    loop.tick();
    // A second pointer within the same render quantum: the same currentTime, the same stamp,
    // so its rewind re-runs the first tap too.
    const second = scheduler.push('t', 'out', { channel: 2 })!;
    expect(second.time).toBe(first.time);
    step(1.016);
    step(1.032);
    const taps = seen(runtime).filter((e) => e.path === 'immediate');
    expect(taps.map((e) => e.channel)).toEqual([1, 2]);
    expect(seen(runtime).filter((e) => e.time === first.time)).toHaveLength(2);
    expect(played()).toEqual([first.time, second.time]);
  });

  it('a swap re-running a tap that was already shown does not show it again', () => {
    const p = (period: number) => patch([node('t', 'tap'), node('m', 'metro', { period }), node('v', 'sink')], [cable('t', 'v'), cable('m', 'v')]);
    const runtime = new Runtime(compile(p(0.05)), { history: true });
    for (let k = 0; k < 4; k++) runtime.query(k * 0.025, (k + 1) * 0.025);
    // A tap on a window boundary, so the swap below re-runs from its time.
    runtime.push('t', 'out', { time: 0.025, channel: 5 }, { now: 0.005, path: 'immediate' });
    runtime.frame(-0.1, -0.08, 0.02);
    expect(seen(runtime).map((e) => [e.time, e.path])).toEqual([[0.025, 'immediate']]);
    // 0.005 + SWAP_MARGIN: the boundary at the tap's time.
    const report = runtime.swap(compile(p(0.04)), { now: 0.005, path: 'scheduled' });
    expect(report.time).toBe(0.025);
    expect(report.affected.has('v')).toBe(true);
    runtime.frame(-0.08, 0.1, 0.02);
    const log = seen(runtime);
    expect(log.filter((e) => e.channel === 5)).toHaveLength(1);
    // The new plan's metro from the swap on, the old one before it.
    expect(log.filter((e) => e.channel === 9).map((e) => ms(e.time))).toEqual([0, 40, 80]);
  });
});

describe('frames and rewinds', () => {
  it('a rewind behind frames that ran ahead re-queues nothing they took, and keeps order', () => {
    // Headless, frames can run ahead of the scheduler's clock.
    const runtime = new Runtime(compile(patch(
      [node('t', 'tap'), node('a', 'metro', { period: 0.01 }), node('b', 'metro', { period: 0.015, channel: 8 }), node('v', 'sink')],
      [cable('a', 'v'), cable('t', 'v'), cable('b', 'v')],
    )), { history: true });
    for (let k = 0; k < 4; k++) runtime.query(k * 0.025, (k + 1) * 0.025);
    runtime.frame(0, 0.05, 0.05);
    const before = seen(runtime).length;
    // A scheduled push behind the frames: the frames already passed it.
    runtime.push('t', 'out', { time: 0.03, channel: 0 });
    // And one ahead of them, between events already queued.
    runtime.push('t', 'out', { time: 0.062, channel: 0 });
    runtime.frame(0.05, 0.1, 0.05);
    const log = seen(runtime);
    const times = log.map((e) => ms(e.time));
    expect(new Set(log.map((e) => `${e.time}/${e.channel}`)).size).toBe(log.length);
    expect(log.slice(before).every((e) => e.time >= 0.05)).toBe(true);
    for (const batch of batches(runtime)) expect(batch).toEqual([...batch].sort((x, y) => x - y));
    // The tap behind the frames is past showing; the one ahead of them shows, in its place.
    expect(log.filter((e) => e.channel === 0).map((e) => ms(e.time))).toEqual([62]);
    expect(times).toEqual([...times].sort((x, y) => x - y));
  });

  it('an immediate tap and scheduled events in one frame arrive in time order', () => {
    const runtime = new Runtime(compile(patch([node('m', 'metro', { period: 0.02 }), node('t', 'tap'), node('v', 'sink')], [cable('m', 'v'), cable('t', 'v')])), { history: true });
    for (let k = 0; k < 4; k++) runtime.query(k * 0.025, (k + 1) * 0.025);
    runtime.push('t', 'out', { time: 0.05, channel: 0 }, { now: 0.045, path: 'immediate' });
    runtime.frame(0, 0.07, 0.016);
    expect(batches(runtime)).toEqual([[0, 0.02, 0.04, 0.05, 0.06]]);
    expect(seen(runtime).map((e) => e.path)).toEqual(['scheduled', 'scheduled', 'scheduled', 'immediate', 'scheduled']);
    runtime.frame(0.07, 0.1, 0.016);
    expect(batches(runtime)[1]).toEqual([0.08]);
  });

  it('without history, a push past the horizon is still immediate when its window is queried', () => {
    const runtime = new Runtime(compile(patch([node('t', 'tap'), node('p', 'pass'), node('v', 'sink')], [cable('t', 'p'), cable('p', 'v')])));
    runtime.push('t', 'out', { time: 1, channel: 0 }, { now: 0.995, path: 'immediate' });
    runtime.query(0.99, 1.1);
    runtime.frame(0.7, 0.72, 0.016);
    // Through Pass, as a new object: still the tap's own time, so still immediate.
    expect(seen(runtime).map((e) => [e.time, e.path])).toEqual([[1, 'immediate']]);
    runtime.frame(0.72, 1.2, 0.016);
    expect(seen(runtime)).toHaveLength(1);
  });

  it('two identical taps where a frame showed only the first: a re-run still shows the second', () => {
    const runtime = new Runtime(compile(patch([node('t', 'tap'), node('v', 'sink')], [cable('t', 'v')])), { history: true });
    runtime.query(0, 0.12);
    runtime.push('t', 'out', { time: 0.05, channel: 0 }, { now: 0.045, path: 'immediate' });
    runtime.frame(-0.2, -0.18, 0.016);
    // The same fields, the same stamp: a second tap the frame hasn't seen.
    runtime.push('t', 'out', { time: 0.05, channel: 0 }, { now: 0.045, path: 'immediate' });
    runtime.frame(-0.18, -0.16, 0.016);
    runtime.frame(-0.16, 0.2, 0.016);
    expect(seen(runtime).map((e) => [e.time, e.path, e.t1])).toEqual([[0.05, 'immediate', -0.18], [0.05, 'immediate', -0.16]]);
  });
});

describe('frames after a hidden tab', () => {
  it('drops scheduled events more than FRAME_BACKLOG behind the frame, and reports them', () => {
    const runtime = new Runtime(compile(patch([node('m', 'metro', { period: 0.05 }), node('v', 'sink')], [cable('m', 'v')])));
    // No frames for ten seconds while the windows keep coming.
    for (let k = 0; k < 400; k++) runtime.query(k * 0.025, (k + 1) * 0.025);
    runtime.frame(9.75, 10, 0.033);
    const times = seen(runtime).map((e) => ms(e.time));
    // The first frame back: only what's within the backlog of its t0 (9.75 − 0.25).
    expect(FRAME_BACKLOG).toBe(0.25);
    expect(times).toEqual([9500, 9550, 9600, 9650, 9700, 9750, 9800, 9850, 9900, 9950]);
    expect(runtime.lastFrame!.dropped).toBe(190);
  });

  it('a frame loop after a long gap covers only MAX_FRAME_SPAN, so the first frame back hands over a bounded batch', () => {
    const runtime = new Runtime(compile(patch([node('m', 'metro', { period: 0.05 }), node('v', 'sink')], [cable('m', 'v')])));
    const clock = { audio: 0, wall: 0 };
    const loop = new FrameLoop(runtime, { clock: { audioTime: () => clock.audio, wallTime: () => clock.wall } });
    loop.tick();
    runtime.query(0, 30);
    clock.audio = clock.wall / 1000 + 30;
    clock.wall += 30_000;
    const frame = loop.tick();
    expect(frame.t1 - frame.t0).toBeCloseTo(MAX_FRAME_SPAN, 12);
    expect(batches(runtime).at(-1)!.length).toBeLessThanOrEqual(Math.ceil((MAX_FRAME_SPAN + FRAME_BACKLOG) / 0.05) + 1);
  });

  it('holds at most FRAME_QUEUE_LIMIT scheduled events per input while no frame runs, dropping the oldest', () => {
    const runtime = new Runtime(compile(patch([node('m', 'metro', { period: 0.001 }), node('v', 'sink')], [cable('m', 'v')])));
    // 6 s at 1 ms: 6,000 events, in windows small enough for the event caps.
    for (let k = 0; k < 600; k++) runtime.query(k * 0.01, (k + 1) * 0.01);
    runtime.frame(-1, 10, 0.016);
    const times = seen(runtime).map((e) => e.time);
    expect(times).toHaveLength(FRAME_QUEUE_LIMIT);
    expect(ms(times.at(-1)!)).toBe(5999);
  });
});
