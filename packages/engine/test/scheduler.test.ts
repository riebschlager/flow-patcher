// The scheduler on a simulated clock: wakes, catch-up, stalls, the immediate
// path and rewind (ADRs 0008, 0017, 0019). M1 gate checks Stalls, Catch-up and
// Immediate path are the first three describe blocks.
import { describe, expect, it } from 'vitest';
import {
  compilePatch,
  HIDDEN_LOOKAHEAD,
  IMMEDIATE_OFFSET,
  LOOKAHEAD,
  ManualClock,
  Runtime,
  Scheduler,
  type AudioContextLike,
  type EngineEvent,
  type LoggedEvent,
  type NodeDefinition,
  type Patch,
  type PushCost,
  type SchedulerOptions,
} from '../src';

/** Ticks every `period` seconds, from absolute time. */
const metro: NodeDefinition = {
  type: 'metro', version: 1, label: 'Metro', category: 'time-rhythm', description: '',
  ports: [{ name: 'out', type: 'event', direction: 'out' }],
  params: [{ name: 'period', kind: 'number', min: 0.001, max: 1, default: 0.025 }],
  query: ({ t0, t1, params }) => {
    const period = params.period as number;
    const out: EngineEvent[] = [];
    for (let k = Math.max(0, Math.ceil(t0 / period) - 1); k * period < t1; k++) if (k * period >= t0) out.push({ time: k * period, channel: 0, index: k });
    return { out };
  },
};
/** A canvas source stand-in: no query, events only arrive through push. */
const tap: NodeDefinition = {
  type: 'tap', version: 1, label: 'Tap', category: 'canvas-sources', description: '',
  ports: [{ name: 'out', type: 'event', direction: 'out' }],
  params: [],
};
/** Stateful: numbers every event it sees, per channel. */
const counter: NodeDefinition = {
  type: 'counter', version: 1, label: 'Counter', category: 'control-logic', description: '',
  ports: [{ name: 'in', type: 'event', direction: 'in' }, { name: 'out', type: 'event', direction: 'out' }],
  params: [],
  query: ({ inputs, state }) => {
    const counts = ((state.counts as Record<string, number> | undefined) ??= {});
    return {
      out: (inputs.in ?? []).map((e) => {
        counts[e.channel] = (counts[e.channel] ?? 0) + 1;
        return { time: e.time, channel: e.channel, count: counts[e.channel]! };
      }),
    };
  },
};
/** Delay Edge's contract: the runtime hands it the previous chunk's inputs. */
const delay: NodeDefinition = {
  type: 'delay', version: 1, label: 'Delay', category: 'control-logic', description: '',
  ports: [{ name: 'in', type: 'event', direction: 'in' }, { name: 'out', type: 'event', direction: 'out' }],
  params: [{ name: 'time', kind: 'number', min: 0.01, max: 2, default: 0.03, modulatable: false }],
  delay: (params) => params.time as number,
  query: ({ inputs, params, state, t0, t1 }) => {
    const pending = [...((state.pending as EngineEvent[] | undefined) ?? []), ...(inputs.in ?? []).map((e) => ({ ...e, time: e.time + (params.time as number), delayed: true }))];
    state.pending = pending.filter((e) => e.time >= t1);
    return { out: pending.filter((e) => e.time >= t0 && e.time < t1) };
  },
};

/** An audio node that records what it is handed, and when on the audio clock. */
interface Delivery {
  event: EngineEvent;
  /** currentTime when it was handed over. */
  at: number;
  cancelled: boolean;
}
function recorderType(clock: ManualClock, deliveries: Delivery[]): NodeDefinition {
  return {
    type: 'recorder', version: 1, label: 'Recorder', category: 'instruments', description: '',
    ports: [{ name: 'in', type: 'event', direction: 'in' }],
    params: [],
    audio: () => ({
      schedule: (_port, events) => deliveries.push(...events.map((event) => ({ event, at: clock.audio, cancelled: false }))),
      cancel: (_port, events) => {
        for (const event of events) {
          const delivery = deliveries.find((d) => d.event === event && !d.cancelled);
          if (!delivery) throw new Error('cancelled an event that was never scheduled');
          expect(delivery.event.time).toBeGreaterThanOrEqual(clock.audio);
          delivery.cancelled = true;
        }
      },
    }),
  };
}

const node = (id: string, type: string, params = {}) => ({ id, type, typeVersion: 1, params, position: { x: 0, y: 0 } });
const cable = (a: string, b: string) => ({ from: { node: a, port: 'out' }, to: { node: b, port: 'in' } });
const patch = (nodes: Patch['nodes'], cables: Patch['cables']): Patch => ({ format: 'flowpatch', version: 1, seed: 1, nodes, cables });

function setup(p: Patch, options: Partial<SchedulerOptions> = {}) {
  const clock = new ManualClock();
  const deliveries: Delivery[] = [];
  const definitions = new Map([metro, tap, counter, delay, recorderType(clock, deliveries)].map((d) => [d.type, d]));
  const compiled = compilePatch(p, definitions);
  if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
  const runtime = new Runtime(compiled.plan);
  runtime.attachAudio({} as AudioContextLike);
  const scheduler = new Scheduler(runtime, { clock, record: true, ...options });
  /** Sets the clock and wakes at each time, in order. */
  const wakeAt = (...times: number[]) => {
    for (const time of times) {
      clock.set(time);
      scheduler.wake();
    }
  };
  /** Wakes every 25 ms on the grid, [from, to). */
  const wakeEvery = (from: number, to: number, step = 0.025) => {
    for (let k = Math.round(from / step); k * step < to - 1e-9; k++) wakeAt(k * step);
  };
  const live = () => deliveries.filter((d) => !d.cancelled);
  return { clock, scheduler, runtime, deliveries, live, wakeAt, wakeEvery };
}

const metroPatch = (period = 0.025) => patch([node('m', 'metro', { period }), node('r', 'recorder')], [cable('m', 'r')]);
const json = (events: unknown) => JSON.stringify(events);

describe('Stalls: a 500 ms stall skips its windows, with no burst after', () => {
  it('skips, counts and never plays the missed stretch', () => {
    const { scheduler, deliveries, wakeEvery, wakeAt } = setup(metroPatch());
    wakeEvery(0, 1);
    const horizon = scheduler.horizon!;
    const before = deliveries.length;
    // Off the tick grid, so the first window after it holds exactly one tick per 25 ms.
    const stallEnd = 0.975 + 0.5051;
    wakeAt(stallEnd);
    wakeEvery(stallEnd + 0.025, 2.5);

    const stats = scheduler.stats;
    expect(stats.stalls).toBe(1);
    expect(stats.skipped).toBe(Math.ceil((stallEnd - horizon) / 0.025 - 1e-9));
    expect(stats.skipped).toBeGreaterThanOrEqual(15);
    expect(stats.caughtUp).toBe(0);
    expect(stats.lateScheduled).toBe(0);
    // Nothing from the skipped stretch, ever.
    expect(deliveries.filter((d) => d.event.time >= horizon && d.event.time < stallEnd)).toEqual([]);
    // No burst: the wake after the stall hands over its window at the events' own
    // times, one tick per 25 ms like any other window, none before currentTime.
    const after = deliveries.slice(before);
    expect(after.every((d) => d.event.time >= d.at)).toBe(true);
    for (let i = 1; i < after.length; i++) expect(after[i]!.event.time - after[i - 1]!.event.time).toBeCloseTo(0.025, 9);
    const firstWindow = after.filter((d) => d.at === stallEnd);
    expect(firstWindow.filter((d) => d.event.time < stallEnd + 0.025)).toHaveLength(1);
    // The log matches what the audio node got.
    expect(json(scheduler.events().map(({ time }) => time))).toBe(json(deliveries.map((d) => d.event.time)));
  });

  it('reports both clocks for the stall', () => {
    const stalls: unknown[] = [];
    const { wakeAt } = setup(metroPatch(), { onStall: (s) => stalls.push(s) });
    wakeAt(0, 0.025, 0.65);
    expect(stalls).toEqual([expect.objectContaining({ at: 0.65, skipped: Math.ceil((0.65 - 0.145) / 0.025), wallMs: expect.closeTo(625, 6), audioMs: expect.closeTo(625, 6) })]);
  });
});

describe('Catch-up: a 150 ms stall loses nothing and stacks nothing', () => {
  // A 10 ms tick, so several fall in the missed stretch.
  const p = metroPatch(0.01);
  const reference = () => {
    const run = setup(p);
    run.wakeEvery(0, 1.5);
    return run;
  };

  it('plays the missed stretch late, keeping its spacing', () => {
    const { scheduler, deliveries, wakeEvery, wakeAt } = setup(p);
    wakeEvery(0, 0.5);
    const horizon = scheduler.horizon!;
    // The main thread blocks for 150 ms after the wake at 0.475.
    const resume = 0.475 + 0.15;
    wakeAt(resume);
    wakeEvery(0.65, 1.5);

    const stats = scheduler.stats;
    expect(stats.stalls).toBe(0);
    expect(stats.skipped).toBe(0);
    expect(stats.catchUps).toBe(1);
    expect(stats.catchUpMaxMs).toBeCloseTo((resume - horizon) * 1000, 6);
    // Loses nothing: the same events as a run without the stall, each handed over once.
    const ref = reference();
    expect(json(scheduler.events())).toBe(json(ref.scheduler.events()));
    expect(json(deliveries.map((d) => d.event.index))).toBe(json(ref.deliveries.map((d) => d.event.index)));
    // The caught-up ticks moved by the same amount, so their spacing holds and none share a time.
    const caught = deliveries.filter((d) => d.at === resume && (d.event.index as number) * 0.01 < resume);
    expect(caught.length).toBe(stats.caughtUp);
    expect(caught.length).toBeGreaterThanOrEqual(3);
    for (const d of caught) expect(d.event.time).toBeCloseTo((d.event.index as number) * 0.01 + (resume - horizon), 9);
    expect(new Set(caught.map((d) => d.event.time)).size).toBe(caught.length);
    expect(deliveries.every((d) => d.event.time >= d.at)).toBe(true);
    expect(stats.lateScheduled).toBe(0);
  });

  it('catches up to 100 ms past the horizon, and skips beyond that', () => {
    const exact = setup(p);
    exact.wakeAt(0, 0.12 + 0.1);
    expect(exact.scheduler.stats).toMatchObject({ catchUps: 1, stalls: 0 });
    const over = setup(p);
    over.wakeAt(0, 0.12 + 0.1 + 0.001);
    expect(over.scheduler.stats).toMatchObject({ catchUps: 0, stalls: 1, skipped: Math.ceil(0.101 / 0.025) });
  });
});

describe('Immediate path: a pushed note lands at currentTime + 5 ms, without a wake', () => {
  const p = patch([node('t', 'tap'), node('r', 'recorder')], [cable('t', 'r')]);

  it('hands the note to the audio node during the push', () => {
    const { scheduler, clock, deliveries, wakeEvery } = setup(p);
    wakeEvery(0, 1);
    const windows = scheduler.stats.windows;
    clock.set(1.0123);
    const event = scheduler.push('t', 'out', { channel: 3, x: 0.5 });
    expect(event).toEqual({ time: 1.0123 + IMMEDIATE_OFFSET, channel: 3, x: 0.5 });
    expect(scheduler.stats.windows).toBe(windows);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.at).toBe(1.0123);
    expect(Math.abs(deliveries[0]!.event.time - (1.0123 + 0.005))).toBeLessThanOrEqual(0.002);
    expect(scheduler.events()).toEqual([{ node: 't', port: 'out', ...event }]);
    expect(scheduler.stats).toMatchObject({ pushes: 1, rewinds: 1, lateImmediate: 0 });
  });

  it('wakes at once when nothing has been queried yet', () => {
    const { scheduler, clock, deliveries } = setup(p);
    clock.set(3);
    scheduler.push('t', 'out', { channel: 0 });
    expect(scheduler.horizon).toBeCloseTo(3 + LOOKAHEAD, 12);
    expect(deliveries.map((d) => [d.at, d.event.time])).toEqual([[3, 3 + IMMEDIATE_OFFSET]]);
    expect(scheduler.stats.rewinds).toBe(0);
  });

  it('logs the re-query cost of every push', () => {
    const costs: PushCost[] = [];
    const { scheduler, clock, wakeEvery } = setup(
      patch([node('m', 'metro', { period: 0.05 }), node('t', 'tap'), node('c', 'counter'), node('d', 'delay'), node('r', 'recorder')],
        [cable('m', 'c'), cable('t', 'c'), cable('c', 'd'), cable('d', 'r'), cable('c', 'r')]),
      { onPush: (cost) => costs.push(cost) },
    );
    wakeEvery(0, 0.5);
    clock.set(0.4901);
    scheduler.push('t', 'out', { channel: 0 });
    expect(costs).toHaveLength(1);
    const { rewind, queries } = costs[0]!;
    expect([...rewind!.affected].sort()).toEqual(['c', 'd', 'r', 't']);
    expect(rewind!.from).toBeLessThanOrEqual(0.4951);
    expect(rewind!.to).toBe(scheduler.horizon);
    // The metro isn't downstream of the tap, so it isn't queried again.
    expect(queries).toBe(rewind!.queries);
    expect(queries).toBeGreaterThan(0);
    expect(scheduler.stats.pushQueries).toBe(queries);
  });

  it('rejects a push from a port that is not an event output', () => {
    const { scheduler } = setup(p);
    expect(() => scheduler.push('r', 'in', { channel: 0 })).toThrow(/no event output/);
    expect(() => scheduler.push('nope', 'out', { channel: 0 })).toThrow(/no node/);
  });
});

describe('rewind and re-query', () => {
  // A stateful node fed by both a Clock and live input, then a delay, into an audio node.
  const p = patch(
    [node('m', 'metro', { period: 0.05 }), node('t', 'tap'), node('c', 'counter'), node('d', 'delay', { time: 0.03 }), node('r', 'recorder')],
    [cable('m', 'c'), cable('t', 'c'), cable('c', 'd'), cable('d', 'r'), cable('c', 'r')],
  );
  const END = 2;
  const pushes: [number, number][] = [[0.3123, 0], [0.3125, 0], [0.3125, 1], [0.71, 0], [1.0004, 0], [1.25, 2], [1.5, 0]];

  /** Wakes and pushes in time order; pushes win ties. */
  function perform(wakes: number[], options: Partial<SchedulerOptions> = {}, hidden = false) {
    const run = setup(p, options);
    run.clock.isHidden = hidden;
    const timeline = [...pushes.map(([at, channel]) => ({ at, channel })), ...wakes.map((at) => ({ at, channel: -1 }))]
      .sort((a, b) => a.at - b.at || b.channel - a.channel);
    for (const { at, channel } of timeline) {
      run.clock.set(at);
      if (channel >= 0) run.scheduler.push('t', 'out', { channel });
      else run.scheduler.wake();
    }
    while (run.scheduler.horizon! < END) {
      run.clock.set(run.clock.audio + 0.025);
      run.scheduler.wake();
    }
    expect(run.scheduler.stats).toMatchObject({ stalls: 0, catchUps: 0, lateScheduled: 0, lateImmediate: 0, uncancelled: 0, outOfWindow: 0 });
    const log = run.scheduler.events().filter((e) => e.time < END);
    // What the audio node will play: everything it was handed, minus what was withdrawn.
    const playing = run.live().map((d) => d.event).filter((e) => e.time < END);
    return { ...run, log, playing };
  }
  const grid = (step: number, end = END) => Array.from({ length: Math.ceil(end / step) }, (_, k) => k * step);
  const irregular = () => {
    const out: number[] = [];
    const steps = [0.011, 0.037, 0.019, 0.029, 0.004];
    for (let t = 0, i = 0; t < END; t += steps[i++ % steps.length]!) out.push(t);
    return out;
  };

  it('gives the same log whatever the wake timing', () => {
    const regular = perform(grid(0.025));
    const jittery = perform(irregular());
    const hidden = perform(grid(0.3), {}, true);
    // Lookahead shorter than the offset: every push lands past the horizon, so
    // nothing ever rewinds. This is the log as if every tap were known in advance.
    const advance = perform(grid(0.002), { lookahead: 0.004 });

    expect(regular.scheduler.stats.rewinds).toBe(pushes.length);
    expect(jittery.scheduler.stats.rewinds).toBe(pushes.length);
    expect(hidden.scheduler.stats.rewinds).toBe(pushes.length);
    expect(advance.scheduler.stats.rewinds).toBe(0);
    expect(regular.scheduler.stats.cancelled).toBeGreaterThan(0);

    const reference = json(advance.log);
    expect(json(regular.log)).toBe(reference);
    expect(json(jittery.log)).toBe(reference);
    expect(json(hidden.log)).toBe(reference);

    // Taps shift the count of every later tick on their channel.
    const counts = advance.log.filter((e) => e.node === 'c' && e.channel === 0 && !e.delayed);
    expect(counts.map((e) => e.count)).toEqual(counts.map((_, i) => i + 1));
    const offGrid = (time: number) => Math.abs(time / 0.05 - Math.round(time / 0.05)) > 1e-6;
    expect(counts.filter((e) => offGrid(e.time))).toHaveLength(5);
  });

  it('cancels and replaces what audio nodes were handed, so they play the log', () => {
    for (const run of [perform(grid(0.025)), perform(irregular()), perform(grid(0.3), {}, true)]) {
      const intoRecorder = run.log.filter((e) => e.node === 'c' || e.node === 'd').map(({ node: _n, port: _p, ...event }) => event);
      const key = (events: EngineEvent[]) => events.map((e) => json(e)).sort();
      expect(key(run.playing)).toEqual(key(intoRecorder));
    }
  });

  it('only rewinds the nodes downstream of the push', () => {
    const run = setup(p);
    run.wakeEvery(0, 0.5);
    const metroLog = run.scheduler.events().filter((e) => e.node === 'm');
    run.clock.set(0.4901);
    const report = run.runtime.push('t', 'out', { time: 0.4951, channel: 0 }, { now: 0.4901 })!;
    expect(report.affected.has('m')).toBe(false);
    expect(report.added.some((e) => e.node === 'm')).toBe(false);
    expect(report.added.every((e) => e.time >= 0.4951)).toBe(true);
    expect(report.removed).toBeGreaterThan(0);
    expect(run.scheduler.events().filter((e) => e.node === 'm')).toEqual(metroLog);
  });
});

describe('scheduler', () => {
  it('queries contiguous windows from now to the lookahead', () => {
    const { scheduler, runtime, wakeAt } = setup(metroPatch());
    const windows: [number, number][] = [];
    const query = runtime.query.bind(runtime);
    runtime.query = (t0, t1, timing) => (windows.push([t0, t1]), query(t0, t1, timing));
    wakeAt(0, 0.025, 0.05);
    expect(windows).toEqual([[0, LOOKAHEAD], [LOOKAHEAD, 0.025 + LOOKAHEAD], [0.025 + LOOKAHEAD, 0.05 + LOOKAHEAD]]);
    // An extra wake at the same time queries nothing.
    wakeAt(0.05);
    expect(windows).toHaveLength(3);
    expect(scheduler.stats.windows).toBe(3);
  });

  it('looks 1.25 s ahead while hidden', () => {
    const { scheduler, clock, wakeAt } = setup(metroPatch());
    wakeAt(0);
    clock.isHidden = true;
    wakeAt(0.025);
    expect(scheduler.horizon).toBeCloseTo(0.025 + HIDDEN_LOOKAHEAD, 12);
  });

  it('waits while the audio clock is suspended, then starts fresh without a stall', () => {
    const { scheduler, clock, deliveries, wakeAt } = setup(metroPatch());
    wakeAt(0, 0.025);
    clock.isRunning = false;
    wakeAt(0.05, 2);
    expect(scheduler.horizon).toBeNull();
    clock.isRunning = true;
    wakeAt(5);
    expect(scheduler.stats).toMatchObject({ stalls: 0, skipped: 0, catchUps: 0, windows: 3 });
    expect(deliveries.at(-1)!.event.time).toBeLessThan(5 + LOOKAHEAD);
    expect(deliveries.filter((d) => d.event.time >= 0.145 && d.event.time < 5)).toEqual([]);
  });

  it('runs on the injected timer', () => {
    const timer = { tick: () => {}, stopped: false };
    const { scheduler, clock } = setup(metroPatch(), {
      timer: {
        every: (ms, fn) => {
          expect(ms).toBe(25);
          timer.tick = fn;
          return () => (timer.stopped = true);
        },
      },
    });
    clock.set(1);
    scheduler.start();
    expect(scheduler.horizon).toBeCloseTo(1 + LOOKAHEAD, 12);
    clock.set(1.025);
    timer.tick();
    expect(scheduler.stats.windows).toBe(2);
    scheduler.halt();
    expect(timer.stopped).toBe(true);
    expect(scheduler.horizon).toBeNull();
  });

  it('gives the same log whatever the wake interval, with no live input', () => {
    const log = (wakes: number[]) => {
      const run = setup(patch([node('m', 'metro', { period: 0.0173 }), node('c', 'counter'), node('d', 'delay'), node('r', 'recorder')], [cable('m', 'c'), cable('c', 'd'), cable('d', 'r')]));
      run.wakeAt(...wakes);
      return json(run.scheduler.events().filter((e: LoggedEvent) => e.time < 1.5));
    };
    const step = (s: number) => Array.from({ length: Math.ceil(1.6 / s) }, (_, k) => k * s);
    expect(log(step(0.01))).toBe(log(step(0.025)));
    expect(log(step(0.1))).toBe(log(step(0.025)));
  });
});
