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

describe('rewind with a stateful Signal source upstream', () => {
  /** Stateful Signal source: counts its `set` events, and only knows the current window's
   *  changes, so a read is right only if its state matches the window being run. It also
   *  emits an event per `set` (up to two hops, so a loop through a delay ends). */
  const tally: NodeDefinition = {
    type: 'tally', version: 1, label: 'Tally', category: 'control-logic', description: '',
    ports: [{ name: 'set', type: 'event', direction: 'in' }, { name: 'out', type: 'signal', direction: 'out' }, { name: 'ev', type: 'event', direction: 'out' }],
    params: [],
    query: ({ inputs, state }) => {
      state.base = (state.base as number | undefined ?? 0) + ((state.times as number[] | undefined)?.length ?? 0);
      state.times = (inputs.set ?? []).map((e) => e.time);
      const base = state.base as number;
      return {
        ev: (inputs.set ?? [])
          .map((e, i) => ({ time: e.time, channel: e.channel, n: base + i + 1, hops: ((e.hops as number | undefined) ?? 0) + 1 }))
          .filter((e) => e.hops <= 2),
      };
    },
    signal: (ctx, _port, t) => ((ctx.state.base as number | undefined) ?? 0) + ((ctx.state.times as number[] | undefined) ?? []).filter((x) => x <= t).length,
  };
  /** Reads the tally at every input. */
  const reader: NodeDefinition = {
    type: 'reader', version: 1, label: 'Reader', category: 'control-logic', description: '',
    ports: [{ name: 'in', type: 'event', direction: 'in' }, { name: 'sig', type: 'signal', direction: 'in' }, { name: 'out', type: 'event', direction: 'out' }],
    params: [],
    query: ({ inputs, signal }) => ({ out: (inputs.in ?? []).map((e) => ({ time: e.time, channel: e.channel, tally: signal('sig', e.time, e.channel) })) }),
  };
  const link = (a: string, from: string, b: string, to: string) => ({ from: { node: a, port: from }, to: { node: b, port: to } });
  /** The source's events go to a second recorder, `r2`, outside the re-run. With `loop`, they also
   *  come back into the source through a delay. */
  const build = (loop: boolean) => patch(
    [node('m1', 'metro', { period: 0.031 }), node('h', 'tally'), node('m2', 'metro', { period: 0.05 }), node('t', 'tap'), node('x', 'reader'), node('r', 'recorder'), node('r2', 'recorder2'), node('d', 'delay', { time: 0.07 })],
    [
      link('m1', 'out', 'h', 'set'), link('h', 'out', 'x', 'sig'), cable('m2', 'x'), cable('t', 'x'), cable('x', 'r'), link('h', 'ev', 'r2', 'in'),
      ...(loop ? [link('h', 'ev', 'd', 'in'), link('d', 'out', 'h', 'set')] : []),
    ],
  );
  const pushes = [0.3123, 0.71, 1.0004, 1.5];
  function perform(wakes: number[], options: Partial<SchedulerOptions> = {}, hidden = false, loop = false) {
    const clock = new ManualClock();
    const deliveries: Delivery[] = [];
    const outside: Delivery[] = [];
    const compiled = compilePatch(build(loop), new Map([metro, tap, tally, reader, delay, recorderType(clock, deliveries), { ...recorderType(clock, outside), type: 'recorder2' }].map((d) => [d.type, d])));
    if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
    const runtime = new Runtime(compiled.plan);
    runtime.attachAudio({} as AudioContextLike);
    const scheduler = new Scheduler(runtime, { clock, record: true, ...options });
    clock.isHidden = hidden;
    const timeline = [...pushes.map((at) => ({ at, push: true })), ...wakes.map((at) => ({ at, push: false }))].sort((a, b) => a.at - b.at || Number(b.push) - Number(a.push));
    for (const { at, push } of timeline) {
      clock.set(at);
      if (push) scheduler.push('t', 'out', { channel: 0 });
      else scheduler.wake();
    }
    const before = (e: { time: number }) => e.time < 2.5;
    return { scheduler, outside, log: json(scheduler.events().filter(before)), sourceLog: json(scheduler.events().filter((e) => before(e) && (e.node === 'h' || e.node === 'd'))) };
  }
  const grid = (step: number) => Array.from({ length: Math.ceil(2.6 / step) }, (_, k) => k * step);

  it('steps the source through the re-run, so reads match the advance-knowledge run', () => {
    const costs: PushCost[] = [];
    const reference = perform(grid(0.002), { lookahead: 0.004 });
    const hidden = perform(grid(0.3), { onPush: (c) => costs.push(c) }, true);
    const regular = perform(grid(0.025));
    expect(reference.scheduler.stats.rewinds).toBe(0);
    expect(hidden.scheduler.stats.rewinds).toBe(pushes.length);
    expect([...costs[0]!.rewind!.followed]).toEqual(['h']);
    expect(costs[0]!.rewind!.affected.has('h')).toBe(false);
    expect(hidden.log).toBe(reference.log);
    expect(regular.log).toBe(reference.log);
  });

  for (const loop of [false, true]) {
    it(`never re-logs or re-delivers the followed source's own events${loop ? ', fed back through a delay' : ''}`, () => {
      const reference = perform(grid(0.002), { lookahead: 0.004 }, false, loop);
      for (const run of [perform(grid(0.3), {}, true, loop), perform(grid(0.025), {}, false, loop)]) {
        expect(run.scheduler.stats.rewinds).toBe(pushes.length);
        expect(run.scheduler.stats.cancelled).toBe(0);
        expect(run.sourceLog).toBe(reference.sourceLog);
        expect(run.log).toBe(reference.log);
        // Each of the source's events reached r2 once, as in the reference run.
        const keys = run.outside.map((d) => json(d.event));
        expect(new Set(keys).size).toBe(keys.length);
        expect(run.outside.every((d) => !d.cancelled)).toBe(true);
        expect(json(keys.filter((_, i) => run.outside[i]!.event.time < 2.5).sort())).toBe(json(reference.outside.map((d) => json(d.event)).filter((_, i) => reference.outside[i]!.event.time < 2.5).sort()));
      }
      expect(reference.outside.some((d) => d.event.hops === 2)).toBe(loop);
    });
  }
});

describe('push rules', () => {
  /** Emits one event per tick whose fields the test can change between the first run and a re-run. */
  const shape = { fields: (k: number): Record<string, number | string | boolean> => ({ k }) };
  const shaper: NodeDefinition = {
    type: 'shaper', version: 1, label: 'Shaper', category: 'control-logic', description: '',
    ports: [{ name: 'in', type: 'event', direction: 'in' }, { name: 'out', type: 'event', direction: 'out' }],
    params: [],
    query: ({ inputs }) => ({ out: (inputs.in ?? []).map((e) => ({ time: e.time, channel: e.channel, ...shape.fields(e.index as number ?? -1) })) }),
  };
  function rerun(first: typeof shape.fields, second: typeof shape.fields, cancel = true) {
    const clock = new ManualClock();
    const deliveries: Delivery[] = [];
    const recorder = recorderType(clock, deliveries);
    const audio = cancel ? recorder.audio : (ctx: Parameters<NonNullable<NodeDefinition['audio']>>[0]) => ({ schedule: recorder.audio!(ctx).schedule });
    const compiled = compilePatch(
      patch([node('m', 'metro', { period: 0.02 }), node('t', 'tap'), node('s', 'shaper'), node('r', 'recorder')], [cable('m', 's'), cable('t', 's'), cable('s', 'r')]),
      new Map([metro, tap, shaper, { ...recorder, audio }].map((d) => [d.type, d])),
    );
    if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
    const runtime = new Runtime(compiled.plan);
    const warnings: string[] = [];
    runtime.onWarning = (message) => warnings.push(message);
    runtime.attachAudio({} as AudioContextLike);
    const scheduler = new Scheduler(runtime, { clock });
    shape.fields = first;
    scheduler.wake();
    shape.fields = second;
    clock.set(0.01);
    scheduler.push('t', 'out', { channel: 5 });
    scheduler.push('t', 'out', { channel: 6 });
    return { stats: scheduler.stats, warnings };
  }

  it('keeps deliveries whose fields only changed order', () => {
    const { stats } = rerun((k) => ({ a: k, b: 'x' }), (k) => ({ b: 'x', a: k }));
    expect(stats).toMatchObject({ cancelled: 0, uncancelled: 0 });
  });

  it('tells NaN from null, and replaces the delivery', () => {
    const { stats } = rerun(() => ({ v: NaN }), () => ({ v: null as unknown as number }));
    expect(stats.cancelled).toBeGreaterThan(0);
    expect(rerun(() => ({ v: NaN }), () => ({ v: NaN })).stats.cancelled).toBe(0);
  });

  it('warns once about an audio node with no cancel()', () => {
    const { stats, warnings } = rerun((k) => ({ v: k }), (k) => ({ v: -k }), false);
    expect(stats.uncancelled).toBeGreaterThan(0);
    expect(warnings).toEqual([expect.stringMatching(/audio node "r" has schedule\(\) but no cancel\(\)/)]);
  });

  it('refuses a live event before currentTime', () => {
    const { runtime, wakeAt } = setup(metroPatch());
    wakeAt(0, 0.025);
    expect(() => runtime.push('m', 'out', { time: 0.03, channel: 0 }, { now: 0.04 })).toThrow(/before currentTime/);
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

  /** Records every window the runtime is asked for. */
  const recordWindows = (runtime: Runtime) => {
    const windows: [number, number][] = [];
    const query = runtime.query.bind(runtime);
    runtime.query = (t0, t1, timing) => (windows.push([t0, t1]), query(t0, t1, timing));
    return windows;
  };
  const expectNoOverlap = (windows: [number, number][]) => {
    for (let i = 1; i < windows.length; i++) expect(windows[i]![0]).toBeGreaterThanOrEqual(windows[i - 1]![1]);
  };
  const expectNoDuplicates = (deliveries: Delivery[]) => {
    const indices = deliveries.map((d) => d.event.index);
    expect(new Set(indices).size).toBe(indices.length);
  };

  it('waits while the audio clock is suspended, then resumes past the gap without a stall', () => {
    const { scheduler, clock, deliveries, runtime, wakeAt } = setup(metroPatch());
    const windows = recordWindows(runtime);
    wakeAt(0, 0.025);
    clock.isRunning = false;
    wakeAt(0.05, 2);
    expect(scheduler.horizon).toBeCloseTo(0.025 + LOOKAHEAD, 12);
    clock.isRunning = true;
    wakeAt(5);
    expectNoOverlap(windows);
    expect(scheduler.stats).toMatchObject({ stalls: 0, skipped: 0, catchUps: 0, windows: 3 });
    expect(deliveries.at(-1)!.event.time).toBeLessThan(5 + LOOKAHEAD);
    expect(deliveries.filter((d) => d.event.time >= 0.145 && d.event.time < 5)).toEqual([]);
  });

  it('resumes from the horizon when the audio clock did not move while suspended', () => {
    const { scheduler, clock, deliveries, runtime, wakeAt } = setup(metroPatch());
    const windows = recordWindows(runtime);
    wakeAt(0, 0.025, 0.05);
    clock.isRunning = false;
    wakeAt(0.05, 0.05);
    clock.isRunning = true;
    wakeAt(0.05, 0.075, 0.1);
    expectNoOverlap(windows);
    expectNoDuplicates(deliveries);
    expect(windows.at(-1)![1]).toBeCloseTo(0.1 + LOOKAHEAD, 12);
    expect(scheduler.stats).toMatchObject({ stalls: 0, catchUps: 0 });
    // And the same through halt() and start().
    scheduler.halt();
    const timer = { every: () => () => {} };
    const again = setup(metroPatch(), { timer });
    const againWindows = recordWindows(again.runtime);
    again.wakeAt(0, 0.025);
    again.scheduler.halt();
    again.scheduler.start();
    again.wakeAt(0.05);
    expectNoOverlap(againWindows);
    expectNoDuplicates(again.deliveries);
  });

  it('holds a push made while suspended and stamps it at the resume', () => {
    const { scheduler, clock, deliveries, wakeAt } = setup(patch([node('t', 'tap'), node('r', 'recorder')], [cable('t', 'r')]));
    wakeAt(0, 0.025);
    clock.isRunning = false;
    clock.set(0.03);
    expect(scheduler.push('t', 'out', { channel: 1 })).toBeNull();
    expect(() => scheduler.push('r', 'in', { channel: 0 })).toThrow(/no event output/);
    expect(deliveries).toEqual([]);
    clock.set(0.9);
    clock.isRunning = true;
    wakeAt(0.9);
    expect(deliveries.map((d) => [d.at, d.event.time, d.event.channel])).toEqual([[0.9, 0.9 + IMMEDIATE_OFFSET, 1]]);
    expect(scheduler.stats).toMatchObject({ deferredPushes: 1, pushes: 1 });
  });

  it('keeps rewinding a held push whose resume wake queries nothing', () => {
    const p = patch([node('m', 'metro', { period: 0.05 }), node('t', 'tap'), node('c', 'counter'), node('r', 'recorder')], [cable('m', 'c'), cable('t', 'c'), cable('c', 'r')]);
    // Hidden: the window reaches 1.275 s, so the visible resume at 0.05 finds nothing to query.
    const run = setup(p);
    run.wakeAt(0);
    run.clock.isHidden = true;
    run.wakeAt(0.025);
    run.clock.isRunning = false;
    run.clock.set(0.03);
    expect(run.scheduler.push('t', 'out', { channel: 0 })).toBeNull();
    run.clock.isHidden = false;
    run.clock.isRunning = true;
    const windows = run.scheduler.stats.windows;
    run.wakeAt(0.05);
    expect(run.scheduler.stats.windows).toBe(windows);
    expect(run.scheduler.stats).toMatchObject({ rewinds: 1, deferredPushes: 1 });
    expect(run.live().filter((d) => d.at === 0.05).map((d) => d.event.time)[0]).toBeCloseTo(0.05 + IMMEDIATE_OFFSET, 12);
    // The same as a push at 0.05 known in advance.
    const reference = setup(p, { lookahead: 0.004 });
    const timeline = Array.from({ length: 700 }, (_, k) => k * 0.002);
    for (const at of timeline) {
      reference.wakeAt(at);
      if (at === 0.05) reference.scheduler.push('t', 'out', { channel: 0 });
    }
    const upTo = (events: LoggedEvent[]) => json(events.filter((e) => e.time < 1.2));
    expect(upTo(run.scheduler.events())).toBe(upTo(reference.scheduler.events()));
  });

  it('keeps later held pushes when one throws', () => {
    // onPush runs after each push completes; a throw there must not lose the pushes behind it.
    let fail = true;
    const { scheduler, clock, deliveries, wakeAt } = setup(patch([node('t', 'tap'), node('r', 'recorder')], [cable('t', 'r')]), {
      onPush: () => {
        if (fail) {
          fail = false;
          throw new Error('listener');
        }
      },
    });
    wakeAt(0);
    clock.isRunning = false;
    scheduler.push('t', 'out', { channel: 1 });
    scheduler.push('t', 'out', { channel: 2 });
    clock.isRunning = true;
    clock.set(0.01);
    expect(() => scheduler.wake()).toThrow('listener');
    expect(deliveries.map((d) => d.event.channel)).toEqual([1]);
    wakeAt(0.02);
    expect(deliveries.map((d) => [d.event.channel, d.event.time])).toEqual([[1, 0.01 + IMMEDIATE_OFFSET], [2, 0.02 + IMMEDIATE_OFFSET]]);
  });

  it('catches up only what is still missed after the runtime horizon', () => {
    // Someone else queried part of the missed stretch: the catch-up shift shrinks to what's left.
    const part = setup(patch([node('m', 'metro', { period: 0.005 }), node('r', 'recorder')], [cable('m', 'r')]));
    part.wakeAt(0);
    part.runtime.query(0.12, 0.13);
    part.wakeAt(0.15);
    expect(part.scheduler.stats.catchUps).toBe(1);
    expect(part.scheduler.stats.catchUpMaxMs).toBeCloseTo(20, 6);
    const shifted = part.deliveries.filter((d) => d.at === 0.15 && (d.event.index as number) * 0.005 < 0.15);
    expect(shifted.length).toBeGreaterThan(0);
    for (const d of shifted) expect(d.event.time).toBeCloseTo((d.event.index as number) * 0.005 + 0.02, 9);
    // All of it queried already: no catch-up at all.
    const all = setup(metroPatch());
    all.wakeAt(0);
    all.runtime.query(0.12, 0.2);
    all.wakeAt(0.15);
    expect(all.scheduler.stats).toMatchObject({ catchUps: 0, caughtUp: 0, lateScheduled: 0 });
  });

  it('counts snapshots, and skips empty state', () => {
    const empty = setup(metroPatch());
    empty.wakeEvery(0, 0.5);
    expect(empty.scheduler.stats.snapshots).toBe(0);
    const stateful = setup(patch([node('m', 'metro'), node('c', 'counter'), node('r', 'recorder')], [cable('m', 'c'), cable('c', 'r')]));
    stateful.wakeEvery(0, 0.5);
    // The counter has state from its first window on: one copy per later window.
    expect(stateful.scheduler.stats.snapshots).toBe(19);
    expect(stateful.scheduler.stats.snapshotMs).toBe(0);
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
    expect(scheduler.horizon).toBeCloseTo(1.025 + LOOKAHEAD, 12);
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
