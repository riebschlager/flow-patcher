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
  SWAP_MARGIN,
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

function setup(p: Patch, options: Partial<SchedulerOptions> = {}, extra: NodeDefinition[] = []) {
  const clock = new ManualClock();
  const deliveries: Delivery[] = [];
  const definitions = new Map([metro, tap, counter, delay, recorderType(clock, deliveries), ...extra].map((d) => [d.type, d]));
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
  /** Compiles another patch over the same definitions, for swaps. */
  const compile = (next: Patch) => {
    const result = compilePatch(next, definitions);
    if (!result.ok) throw new Error(result.errors.join('\n'));
    return result.plan;
  };
  return { clock, scheduler, runtime, deliveries, live, wakeAt, wakeEvery, compile };
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
    // The caught-up ticks moved by the same amount, to start at the wake plus the immediate offset (ADR 0033),
    // so their spacing holds and none share a time.
    const caught = deliveries.filter((d) => d.at === resume && (d.event.index as number) * 0.01 < resume);
    expect(caught.length).toBe(stats.caughtUp);
    expect(caught.length).toBeGreaterThanOrEqual(3);
    for (const d of caught) expect(d.event.time).toBeCloseTo((d.event.index as number) * 0.01 + (resume - horizon) + IMMEDIATE_OFFSET, 9);
    expect(new Set(caught.map((d) => d.event.time)).size).toBe(caught.length);
    expect(deliveries.every((d) => d.event.time >= d.at)).toBe(true);
    expect(stats.lateScheduled).toBe(0);
  });

  it('keeps caught-up events window-independent with the lead: the same log for any wake grid, each catch-up shifted as a block', () => {
    const ref = reference();
    for (const step of [0.01, 0.025, 0.05]) {
      const run = setup(p);
      run.wakeEvery(0, 0.5, step);
      const horizon = run.scheduler.horizon!;
      const resume = 0.5 - step + 0.15;
      run.wakeAt(resume);
      run.wakeEvery(Math.ceil(resume / step) * step, 1.5, step);
      expect(run.scheduler.stats).toMatchObject({ catchUps: 1, stalls: 0, skipped: 0, lateScheduled: 0, lateCaughtUp: 0 });
      // The log keeps generated times, whatever the windows and the catch-up (up to where both runs queried).
      const upTo = (events: LoggedEvent[]) => json(events.filter((e) => e.time < 1.5));
      expect(upTo(run.scheduler.events())).toBe(upTo(ref.scheduler.events()));
      // Every caught-up tick moved by one shift, the wake's lateness plus the lead: spacing kept.
      const caught = run.deliveries.filter((d) => d.at === resume && (d.event.index as number) * 0.01 < resume);
      expect(caught.length).toBeGreaterThanOrEqual(3);
      for (const d of caught) expect(d.event.time).toBeCloseTo((d.event.index as number) * 0.01 + (resume - horizon) + IMMEDIATE_OFFSET, 9);
    }
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
    expect(scheduler.stats).toMatchObject({ pushes: 1, rewinds: 1, lateImmediate: 0, pushFallbacks: 0 });
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

describe('late counters read the audio clock at hand-over', () => {
  /** Passes events through; while armed, its first query moves the audio clock to `to`, as a long query would. */
  const stall = { clock: null as ManualClock | null, to: null as number | null };
  const slow: NodeDefinition = {
    type: 'slow', version: 1, label: 'Slow', category: 'control-logic', description: '',
    ports: [{ name: 'in', type: 'event', direction: 'in' }, { name: 'out', type: 'event', direction: 'out' }],
    params: [],
    query: ({ inputs }) => {
      if (stall.clock && stall.to !== null) {
        stall.clock.set(Math.max(stall.clock.audio, stall.to));
        stall.to = null;
      }
      return { out: [...(inputs.in ?? [])] };
    },
  };
  const arm = (clock: ManualClock, to: number) => Object.assign(stall, { clock, to });

  it('clamps and counts a wake\'s event the clock passed while the window ran, by its lead', () => {
    const { scheduler, clock, deliveries, wakeAt } = setup(
      patch([node('m', 'metro'), node('s', 'slow'), node('r', 'recorder')], [cable('m', 's'), cable('s', 'r')]), {}, [slow]);
    // The wake reads 0; the query moves the clock to 30 ms, past the ticks at 0 and 25 ms.
    arm(clock, 0.03);
    wakeAt(0);
    expect(clock.audio).toBe(0.03);
    expect(deliveries.slice(0, 2).map((d) => [d.event.index, d.event.time])).toEqual([[0, 0.03], [1, 0.03]]);
    expect(deliveries[2]!.event.time).toBe(0.05);
    expect(deliveries.every((d) => d.event.time >= d.at)).toBe(true);
    // The tick at 0 had no lead (it is at the wake's now): lateCaughtUp (ADR 0033). The one at 25 ms was
    // queried ahead of the clock: lateScheduled.
    expect(scheduler.stats).toMatchObject({ lateScheduled: 1, lateCaughtUp: 1, lateImmediate: 0 });
    expect(scheduler.stats.lateCaughtUpMaxMs).toBeCloseTo(30, 9);
    // The log keeps the generated times: only the hand-over moves.
    expect(scheduler.events().filter((e) => e.node === 's').slice(0, 2).map((e) => e.time)).toEqual([0, 0.025]);
  });

  it('clamps and counts a pushed event the clock passed during its rewind', () => {
    const { scheduler, clock, deliveries, wakeEvery } = setup(
      patch([node('t', 'tap'), node('s', 'slow'), node('r', 'recorder')], [cable('t', 's'), cable('s', 'r')]), {}, [slow]);
    wakeEvery(0, 1);
    clock.set(1.0123);
    // The re-run moves the clock 10 ms on, past the stamp at +5 ms.
    arm(clock, 1.0223);
    const event = scheduler.push('t', 'out', { channel: 3 });
    expect(event!.time).toBe(1.0123 + IMMEDIATE_OFFSET);
    expect(deliveries.map((d) => [d.at, d.event.time])).toEqual([[1.0223, 1.0223]]);
    expect(scheduler.stats).toMatchObject({ pushes: 1, rewinds: 1, pushFallbacks: 0, lateImmediate: 1, lateScheduled: 0 });
    // Stamped at +5 ms, handed over at +10 ms: 5 ms late.
    expect(scheduler.stats.lateImmediateMaxMs).toBeCloseTo(5, 9);
    expect(scheduler.events().map((e) => [e.node, e.time])).toEqual([['t', event!.time], ['s', event!.time]]);
  });

  // #97: an audio node calls start() inside schedule(), after the runtime read the clock for the
  // hand-over. A clock step there reaches Web Audio as lateness the floor read can't see.
  describe('a clock step inside schedule(), between the floor read and start()', () => {
    /** Like the recorder, but while armed its first schedule() steps the clock to `to` before "calling start()". */
    function jumpy(clock: ManualClock, starts: { when: number; at: number }[], jump: { to: number | null }): NodeDefinition {
      return {
        type: 'jumpy', version: 1, label: 'Jumpy', category: 'instruments', description: '',
        ports: [{ name: 'in', type: 'event', direction: 'in' }],
        params: [],
        audio: () => ({
          schedule: (_port, events) => {
            if (jump.to !== null) {
              clock.set(Math.max(clock.audio, jump.to));
              jump.to = null;
            }
            starts.push(...events.map((event) => ({ when: event.time, at: clock.audio })));
          },
          cancel: () => {},
        }),
      };
    }
    const build = (p: Patch) => {
      const clock = new ManualClock();
      const starts: { when: number; at: number }[] = [], jump = { to: null as number | null };
      const compiled = compilePatch(p, new Map([metro, tap, jumpy(clock, starts, jump)].map((d) => [d.type, d])));
      if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
      const runtime = new Runtime(compiled.plan);
      runtime.attachAudio({} as AudioContextLike);
      return { clock, scheduler: new Scheduler(runtime, { clock, record: true }), starts, jump };
    };
    const lateness = (starts: { when: number; at: number }[]) => Math.max(...starts.map((s) => s.at - s.when));

    it('counts a pushed note whose start() came after the step in lateImmediate, by how far start() was behind', () => {
      const { clock, scheduler, starts, jump } = build(patch([node('t', 'tap'), node('j', 'jumpy')], [cable('t', 'j')]));
      for (let k = 0; k * 0.025 < 1; k++) {
        clock.set(k * 0.025);
        scheduler.wake();
      }
      clock.set(1.0123);
      // The floor read sees 1.0123, the note is stamped +5 ms and handed over on time; the clock
      // then steps 11.6 ms (one 512-frame callback at 44.1 kHz) before start().
      jump.to = 1.0123 + 0.0116;
      const event = scheduler.push('t', 'out', { channel: 0 });
      expect(starts).toEqual([{ when: event!.time, at: 1.0123 + 0.0116 }]);
      expect(scheduler.stats).toMatchObject({ lateImmediate: 1, lateScheduled: 0, lateCaughtUp: 0 });
      expect(scheduler.stats.lateImmediateMaxMs).toBeCloseTo(lateness(starts) * 1000, 9);
      expect(scheduler.stats.lateImmediateMaxMs).toBeCloseTo(6.6, 9);
    });

    it('counts a caught-up t=0 note whose start() came after the step in lateCaughtUp', () => {
      const { clock, scheduler, starts, jump } = build(patch([node('m', 'metro', { period: 0.5 }), node('j', 'jumpy')], [cable('m', 'j')]));
      clock.isRunning = false;
      scheduler.wake();
      clock.isRunning = true;
      clock.set(0.003);
      jump.to = 0.003 + 0.0116;
      scheduler.wake();
      // Handed over at the wake's now plus the 5 ms lead, 0.008, which the floor read agreed with; start() came
      // 11.6 ms after the wake, a 512-frame burst, so 6.6 ms after its time.
      expect(starts[0]).toEqual({ when: 0.003 + IMMEDIATE_OFFSET, at: 0.003 + 0.0116 });
      expect(scheduler.stats).toMatchObject({ caughtUp: 1, lateCaughtUp: 1, lateScheduled: 0, lateImmediate: 0 });
      expect(scheduler.stats.lateCaughtUpMaxMs).toBeCloseTo(lateness(starts) * 1000, 9);
      expect(scheduler.stats.lateCaughtUpMaxMs).toBeCloseTo(6.6, 9);
    });

    it('does not count a caught-up note late when the clock steps less than the lead before its start()', () => {
      const { clock, scheduler, starts, jump } = build(patch([node('m', 'metro', { period: 0.5 }), node('j', 'jumpy')], [cable('m', 'j')]));
      clock.isRunning = false;
      scheduler.wake();
      clock.isRunning = true;
      clock.set(0.003);
      // One 128-frame quantum at 44.1 kHz, 2.9 ms, between the floor read and start(): inside the 5 ms lead.
      jump.to = 0.003 + 0.0029;
      scheduler.wake();
      expect(starts[0]).toEqual({ when: 0.003 + IMMEDIATE_OFFSET, at: 0.003 + 0.0029 });
      expect(scheduler.stats).toMatchObject({ caughtUp: 1, lateCaughtUp: 0, lateCaughtUpMaxMs: 0, lateScheduled: 0 });
    });

    it('gives a t=0 note the lead at a resume that reads exactly 0: a step within it isn\'t late, a longer one is late by less', () => {
      for (const [step, late] of [[0.0029, 0], [0.0116, 6.6]] as const) {
        const { clock, scheduler, starts, jump } = build(patch([node('m', 'metro', { period: 0.5 }), node('j', 'jumpy')], [cable('m', 'j')]));
        clock.isRunning = false;
        scheduler.wake();
        clock.isRunning = true;
        // The first running wake reads exactly 0: [0, 0] is caught up, moved to 0 + 5 ms.
        jump.to = step;
        scheduler.wake();
        expect(starts[0]).toEqual({ when: IMMEDIATE_OFFSET, at: step });
        expect(scheduler.stats).toMatchObject({ caughtUp: 1, catchUps: 0, lateCaughtUp: late ? 1 : 0, lateScheduled: 0 });
        expect(scheduler.stats.lateCaughtUpMaxMs).toBeCloseTo(late, 9);
      }
    });

    it('counts a first-wake t=0 event the step left behind start() in lateCaughtUp when the clock ran from the start: it had no lead', () => {
      const { clock, scheduler, starts, jump } = build(patch([node('m', 'metro', { period: 0.025 }), node('j', 'jumpy')], [cable('m', 'j')]));
      // A clock that runs from the start (headless, no resume) and a first wake at exactly 0: nothing is caught
      // up, so the tick at 0 is on time at the floor read, with no lead, then the clock steps 3 ms before start().
      jump.to = 0.003;
      scheduler.wake();
      expect(starts[0]).toEqual({ when: 0, at: 0.003 });
      expect(scheduler.stats).toMatchObject({ caughtUp: 0, lateCaughtUp: 1, lateScheduled: 0, lateImmediate: 0 });
      expect(scheduler.stats.lateCaughtUpMaxMs).toBeCloseTo(3, 9);
      // A step during a later wake can't reach events queried 120 ms ahead.
      clock.set(0.025);
      jump.to = 0.025 + 0.0116;
      scheduler.wake();
      expect(scheduler.stats).toMatchObject({ lateCaughtUp: 1, lateScheduled: 0 });
    });

    it('counts a scheduled event queried ahead that the step left behind start() in lateScheduled', () => {
      const { scheduler, starts, jump } = build(patch([node('m', 'metro', { period: 0.025 }), node('j', 'jumpy')], [cable('m', 'j')]));
      // The first wake reads 0; its ticks at 0 and 25 ms go over in one schedule(), which steps the clock 30 ms.
      jump.to = 0.03;
      scheduler.wake();
      expect(starts.slice(0, 2)).toEqual([{ when: 0, at: 0.03 }, { when: 0.025, at: 0.03 }]);
      // The tick at 25 ms was 25 ms ahead of the wake's now: lateScheduled. The one at 0 had no lead.
      expect(scheduler.stats).toMatchObject({ lateScheduled: 1, lateCaughtUp: 1 });
    });

    it('a swap whose instance build takes 20 ms picks a boundary past the clock after it, so nothing it re-runs is late (#97)', () => {
      // A recorder whose build moves the clock on by `build.time` (a Reverb rendering its impulse).
      const build = { clock: null as ManualClock | null, time: 0 };
      const deliveries: Delivery[] = [];
      const slowBuild: NodeDefinition = {
        type: 'slow-build', version: 1, label: 'Slow build', category: 'instruments', description: '',
        ports: [{ name: 'in', type: 'event', direction: 'in' }],
        params: [{ name: 'tone', kind: 'number', min: 0, max: 1, default: 0 }],
        audio: () => {
          build.clock?.set(build.clock.audio + build.time);
          // Set once setup has made the clock, before the first wake hands anything over.
          const clock = () => build.clock!;
          return {
            schedule: (_port, events) => deliveries.push(...events.map((event) => ({ event, at: clock().audio, cancelled: false }))),
            cancel: (_port, events) => {
              for (const event of events) {
                const delivery = deliveries.find((d) => d.event === event && !d.cancelled)!;
                // Never withdraws what may already be playing.
                expect(delivery.event.time).toBeGreaterThanOrEqual(clock().audio);
                delivery.cancelled = true;
              }
            },
          };
        },
      };
      const p = (tone: number) => patch([node('m', 'metro', { period: 0.005 }), node('r', 'slow-build', { tone })], [cable('m', 'r')]);
      const run = setup(p(0), {}, [slowBuild]);
      build.clock = run.clock;
      run.wakeEvery(0, 0.5);
      // The edit at 0.49: windows start at 0.495, 0.52, …. The build moves the clock to 0.51, past 0.495.
      run.clock.set(0.49);
      build.time = 0.02;
      const report = run.scheduler.swap(run.compile(p(1)));
      build.time = 0;
      expect(run.clock.audio).toBeCloseTo(0.51, 12);
      // The first boundary at or after 0.51 + SWAP_MARGIN.
      expect(SWAP_MARGIN).toBe(0.015);
      expect(report.time).toBeCloseTo(0.545, 9);
      expect(report.time).toBeGreaterThanOrEqual(run.clock.audio + SWAP_MARGIN - 1e-12);
      run.wakeEvery(0.525, 0.8);
      const stats = run.scheduler.stats;
      expect(stats).toMatchObject({ lateScheduled: 0, lateImmediate: 0, lateCaughtUp: 0, skipped: 0, stalls: 0 });
      // Every tick was handed over once, on time: none skipped, none twice (the old instance's from the swap on withdrawn).
      const live = deliveries.filter((d) => !d.cancelled);
      expect(live.map((d) => Math.round(d.event.time * 1000))).toEqual(Array.from({ length: Math.round((0.8 + LOOKAHEAD - 0.025) / 0.005) }, (_, k) => k * 5));
      expect(live.every((d) => d.event.time >= d.at)).toBe(true);
      expect(deliveries.filter((d) => d.cancelled).every((d) => d.event.time >= report.time)).toBe(true);
    });

    it('keeps a push\'s event at its own now in lateImmediate, though it has no lead', () => {
      // Lead classifies scheduled events only (ADR 0033): a push's whole re-run stays on the immediate path.
      const run = setup(patch([node('m', 'metro', { period: 0.025 }), node('t', 'tap'), node('c', 'counter'), node('r', 'recorder')], [cable('m', 'c'), cable('t', 'c'), cable('c', 'r')]));
      run.wakeEvery(0, 0.1);
      // A live event at the push's own now, 0.05 (a push can't be stamped before now). The clock has moved to
      // 0.06 by the hand-over. The counter's re-run re-delivers the metro's tick at 0.075 with a new count,
      // ahead of the clock, so not late.
      run.clock.set(0.06);
      run.runtime.push('t', 'out', { time: 0.05, channel: 0 }, { now: 0.05, currentTime: () => run.clock.audio, path: 'immediate' });
      const handed = run.live().filter((d) => d.at === 0.06 && d.event.time < 0.08).map((d) => [d.event.count, Math.round(d.event.time * 1e9) / 1e9]);
      expect(handed).toEqual([[4, 0.06], [5, 0.075]]);
      expect(run.scheduler.stats).toMatchObject({ lateImmediate: 1, lateCaughtUp: 0, lateScheduled: 0 });
      expect(run.scheduler.stats.lateImmediateMaxMs).toBeCloseTo(10, 9);
    });

    it('counts nothing when the clock holds still through schedule()', () => {
      const { clock, scheduler } = build(patch([node('t', 'tap'), node('j', 'jumpy')], [cable('t', 'j')]));
      scheduler.wake();
      clock.set(0.5);
      scheduler.push('t', 'out', { channel: 0 });
      expect(scheduler.stats).toMatchObject({ delivered: 1, lateImmediate: 0, lateImmediateMaxMs: 0, lateScheduled: 0, lateCaughtUp: 0 });
    });
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
    return { stats: scheduler.stats, warnings, nodeWarnings: runtime.warnings() };
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

  it('warns once about an audio node with no cancel(), and keeps the warning on the node', () => {
    const { stats, warnings, nodeWarnings } = rerun((k) => ({ v: k }), (k) => ({ v: -k }), false);
    expect(stats.uncancelled).toBeGreaterThan(0);
    expect(warnings).toEqual([expect.stringMatching(/audio node "r" has schedule\(\) but no cancel\(\)/)]);
    // The editor reads it on the node, with every event it couldn't withdraw counted.
    expect(nodeWarnings).toEqual([expect.objectContaining({ node: 'r', kind: 'no-cancel', count: stats.uncancelled })]);
  });

  it('refuses a live event before currentTime', () => {
    const { runtime, wakeAt } = setup(metroPatch());
    wakeAt(0, 0.025);
    expect(() => runtime.push('m', 'out', { time: 0.03, channel: 0 }, { now: 0.04 })).toThrow(/before currentTime/);
  });
});

describe('a node that throws during a rewind', () => {
  /** Passes events through. A live event marked `boom` arms it, and from 60 ms after that event
   *  every query throws: mid-way through the re-run, after earlier windows were already re-sent.
   *  With `broken.always`, every query throws; `broken.after` moves the 60 ms. */
  const broken = { always: false, after: 0.06 };
  const fragile: NodeDefinition = {
    type: 'fragile', version: 1, label: 'Fragile', category: 'control-logic', description: '',
    ports: [{ name: 'in', type: 'event', direction: 'in' }, { name: 'out', type: 'event', direction: 'out' }],
    params: [],
    query: ({ inputs, state, t1 }) => {
      if (broken.always) throw new Error('fragile broke');
      for (const e of inputs.in ?? []) if (e.boom) state.armedAt = e.time;
      if (typeof state.armedAt === 'number' && t1 > state.armedAt + broken.after) throw new Error('fragile broke');
      return { out: (inputs.in ?? []).map(({ boom: _boom, ...e }) => e) };
    },
  };
  // A tap and a metro into the fragile node, then a counter (stateful) and a delay, into the recorder.
  const p = patch(
    [node('m', 'metro', { period: 0.02 }), node('t', 'tap'), node('f', 'fragile'), node('c', 'counter'), node('d', 'delay', { time: 0.03 }), node('r', 'recorder')],
    [cable('m', 'f'), cable('t', 'f'), cable('f', 'c'), cable('c', 'd'), cable('d', 'r'), cable('c', 'r')],
  );
  /** Wakes every 25 ms to 1 s; at 0.4012 s runs `before` and pushes the `boom` event when asked, and a plain one at 0.6 s. */
  function perform(boom: boolean, costs: PushCost[] = [], { at = p, extra = [fragile], before }: { at?: Patch; extra?: NodeDefinition[]; before?: (run: ReturnType<typeof setup>) => void } = {}) {
    const run = setup(at, { onPush: (cost) => costs.push(cost) }, extra);
    const heard: unknown[] = [];
    run.runtime.onWarning = (message, warning) => heard.push({ ...warning, heard: message });
    for (let k = 0; k * 0.025 < 1; k++) {
      run.wakeAt(k * 0.025);
      if (k === 16) {
        run.clock.set(0.4012);
        before?.(run);
        if (boom) run.scheduler.push('t', 'out', { channel: 0, boom: true });
      }
      if (k === 24) {
        run.clock.set(0.6012);
        run.scheduler.push('t', 'out', { channel: 0 });
      }
    }
    const playing = run.live().map((d) => json(d.event)).sort();
    return { ...run, heard, playing, log: json(run.scheduler.events()) };
  }

  it('drops the live event and re-runs without it, so later queries and pushes work', () => {
    const costs: PushCost[] = [];
    const run = perform(true, costs);
    const reference = perform(false);
    // Same log and the same notes playing as a run that never had the event.
    expect(run.log).toBe(reference.log);
    expect(run.playing).toEqual(reference.playing);
    expect(run.scheduler.stats).toMatchObject({ pushes: 2, rewinds: 2, droppedPushes: 1, lateImmediate: 0, lateScheduled: 0, uncancelled: 0 });
    // The scheduler still measured the push and told onPush, with the drop on its report.
    expect(costs).toHaveLength(2);
    expect(costs[0]!.rewind!.dropped).toEqual({ node: 'f', message: 'fragile broke' });
    expect(costs[0]!.queries).toBe(costs[0]!.rewind!.queries);
    expect(costs[1]!.rewind!.dropped).toBeNull();
  });

  it('warns on the node that threw, once, and counts every drop', () => {
    const run = perform(true);
    const warning = { node: 'f', kind: 'rewind-error', count: 1, time: 0.4062 };
    expect(run.runtime.warnings()).toEqual([expect.objectContaining({ ...warning, message: expect.stringMatching(/^Node "f" failed while re-running for a live event from "t", so that event was dropped: fragile broke$/) })]);
    expect(run.heard).toEqual([expect.objectContaining(warning)]);
    run.clock.set(1.0012);
    run.scheduler.push('t', 'out', { channel: 0, boom: true });
    expect(run.runtime.warnings('f')[0]).toMatchObject({ count: 2, time: 1.0062 });
    expect(run.heard).toHaveLength(1);
    expect(run.scheduler.stats.droppedPushes).toBe(2);
  });

  it('rolls back a re-run that crosses a swap, under each window\'s plan', () => {
    // The swap takes effect at the next boundary, 0.42; the event is at 0.4062, and the node throws from 0.4662.
    const swapped = patch(p.nodes.map((n) => (n.id === 'd' ? { ...n, params: { time: 0.04 } } : n)), p.cables);
    let swapAt = NaN;
    const before = (run: ReturnType<typeof setup>) => void (swapAt = run.scheduler.swap(run.compile(swapped)).time);
    const costs: PushCost[] = [];
    const run = perform(true, costs, { before });
    expect(swapAt).toBeCloseTo(0.42, 9);
    expect(costs[0]!.rewind!.dropped).toMatchObject({ node: 'f' });
    // The reference pushes the same event, so its rewind splits the windows at the same time
    // (where a delay change at a swap applies depends on the chunks, ADR 0023), but its
    // fragile node ignores the event instead of throwing.
    const ignoring: NodeDefinition = { ...fragile, query: ({ inputs }) => ({ out: (inputs.in ?? []).filter((e) => !e.boom) }) };
    const reference = perform(true, [], { before, extra: [ignoring] });
    expect(reference.scheduler.stats.droppedPushes).toBe(0);
    const withoutTap = (log: string) => json((JSON.parse(log) as LoggedEvent[]).filter((e) => e.node !== 't'));
    expect(withoutTap(run.log)).toBe(withoutTap(reference.log));
    expect(run.playing).toEqual(reference.playing);
    expect(run.runtime.stateOf('c')).toEqual(reference.runtime.stateOf('c'));
  });

  it('rolls back across a swap that chunking can\'t affect, as if the event never came', () => {
    // The metro's period changes at the swap, 0.42; the delay keeps its time, so where the rewind splits doesn't matter.
    const swapped = patch(p.nodes.map((n) => (n.id === 'm' ? { ...n, params: { period: 0.03 } } : n)), p.cables);
    let swapAt = NaN;
    const before = (run: ReturnType<typeof setup>) => void (swapAt = run.scheduler.swap(run.compile(swapped)).time);
    const costs: PushCost[] = [];
    const run = perform(true, costs, { before });
    expect(swapAt).toBeCloseTo(0.42, 9);
    expect(costs[0]!.rewind!.dropped).toMatchObject({ node: 'f' });
    const reference = perform(false, [], { before });
    expect(run.log).toBe(reference.log);
    expect(run.playing).toEqual(reference.playing);
    expect(run.runtime.stateOf('c')).toEqual(reference.runtime.stateOf('c'));
  });

  it('warns on the pushing node when the node that threw is gone from the latest plan', () => {
    // A swap at 0.42 removes the fragile node; the push at 0.4062 makes it throw in the window before.
    const without = patch(
      p.nodes.filter((n) => n.id !== 'f'),
      [cable('m', 'c'), cable('t', 'c'), cable('c', 'd'), cable('d', 'r'), cable('c', 'r')],
    );
    let swapAt = NaN;
    const before = (run: ReturnType<typeof setup>) => void (swapAt = run.scheduler.swap(run.compile(without)).time);
    const costs: PushCost[] = [];
    broken.after = 0.005;
    let run;
    try {
      run = perform(true, costs, { before });
    } finally {
      broken.after = 0.06;
    }
    expect(swapAt).toBeCloseTo(0.42, 9);
    expect(costs[0]!.rewind!.dropped).toEqual({ node: 'f', message: 'fragile broke' });
    expect(run.runtime.warnings()).toEqual([expect.objectContaining({ node: 't', kind: 'rewind-error', count: 1, message: expect.stringMatching(/^Node "f" failed while re-running for a live event from "t"/) })]);
    expect(run.runtime.warnings('f')).toEqual([]);
    expect(run.scheduler.stats.droppedPushes).toBe(1);
  });

  it('rolls back when a snapshot fails, and blames the node whose state it was', () => {
    // Takes on state that can't be copied when it sees the live event: the next window's snapshot throws.
    const unclonable: NodeDefinition = {
      type: 'unclonable', version: 1, label: 'Unclonable', category: 'control-logic', description: '',
      ports: [{ name: 'in', type: 'event', direction: 'in' }, { name: 'out', type: 'event', direction: 'out' }],
      params: [],
      query: ({ inputs, state }) => {
        if ((inputs.in ?? []).some((e) => e.boom)) state.handle = () => 0;
        state.seen = ((state.seen as number | undefined) ?? 0) + (inputs.in?.length ?? 0);
        return { out: (inputs.in ?? []).map(({ boom: _boom, ...e }) => e) };
      },
    };
    const at = patch(
      [node('m', 'metro', { period: 0.02 }), node('t', 'tap'), node('u', 'unclonable'), node('c', 'counter'), node('r', 'recorder')],
      [cable('m', 'u'), cable('t', 'u'), cable('u', 'c'), cable('c', 'r')],
    );
    const costs: PushCost[] = [];
    const run = perform(true, costs, { at, extra: [unclonable] });
    const reference = perform(false, [], { at, extra: [unclonable] });
    expect(costs[0]!.rewind!.dropped).toEqual({ node: 'u', message: expect.stringMatching(/plain data/) });
    expect(run.runtime.warnings()).toEqual([expect.objectContaining({ node: 'u', kind: 'rewind-error', count: 1 })]);
    expect(run.log).toBe(reference.log);
    expect(run.playing).toEqual(reference.playing);
    expect(run.runtime.stateOf('u')).toEqual(reference.runtime.stateOf('u'));
  });

  it('keeps dismissed cap drops dismissed through the rollback', () => {
    // Three 1 ms metros: 360 events per limit window into the fragile node, over its 256 cap.
    const at = patch(
      [node('m', 'metro', { period: 0.001 }), node('n', 'metro', { period: 0.001 }), node('o', 'metro', { period: 0.001 }), node('t', 'tap'), node('f', 'fragile'), node('r', 'recorder')],
      [cable('m', 'f'), cable('n', 'f'), cable('o', 'f'), cable('t', 'f'), cable('f', 'r')],
    );
    const before = (run: ReturnType<typeof setup>) => run.runtime.clearWarnings();
    const run = perform(true, [], { at, before });
    const reference = perform(false, [], { at, before });
    expect(reference.scheduler.stats.droppedNodeLimit).toBeGreaterThan(0);
    expect(run.scheduler.stats.droppedPushes).toBe(1);
    expect(run.log).toBe(reference.log);
    expect(run.scheduler.stats.droppedNodeLimit).toBe(reference.scheduler.stats.droppedNodeLimit);
    // The cap warning is raised again only for new drops, as in the run without the event.
    const capHeard = (r: typeof run) => r.heard.filter((w) => (w as { kind: string }).kind !== 'rewind-error');
    expect(capHeard(run)).toEqual(capHeard(reference));
    expect(run.runtime.warnings().filter((w) => w.kind !== 'rewind-error')).toEqual(reference.runtime.warnings());
    expect(run.runtime.warnings('f').map((w) => w.kind)).toEqual(['node-event-limit', 'rewind-error']);
  });

  it('lets the error through when the node fails without the event too', () => {
    const run = setup(p, {}, [fragile]);
    run.wakeEvery(0, 0.5);
    run.clock.set(0.49);
    broken.always = true;
    try {
      expect(() => run.scheduler.push('t', 'out', { channel: 0 })).toThrow('fragile broke');
    } finally {
      broken.always = false;
    }
    expect(run.scheduler.stats.droppedPushes).toBe(0);
    expect(run.runtime.warnings()).toEqual([]);
  });
});

describe('hidden push fallback (ADR 0026)', () => {
  // The rewind patch: a stateful counter fed by a metro and the tap, into the recorder.
  const p = patch(
    [node('m', 'metro', { period: 0.05 }), node('t', 'tap'), node('c', 'counter'), node('r', 'recorder')],
    [cable('m', 'c'), cable('t', 'c'), cable('c', 'r')],
  );
  /** A wall clock where every node query costs `perQuery` ms, so push costs are known. */
  function costed(options: Partial<SchedulerOptions>, perQuery = 1) {
    const run = setup(p, options);
    run.clock.wallTime = () => run.clock.wall + run.runtime.counters.queries * perQuery;
    const heard: string[] = [];
    run.runtime.onWarning = (message) => heard.push(message);
    return { ...run, heard };
  }

  it('applies a hidden push over budget from the horizon, counts it and warns', () => {
    const costs: PushCost[] = [];
    const run = costed({ hiddenPushBudgetMs: 1, onPush: (cost) => costs.push(cost) });
    run.clock.isHidden = true;
    run.wakeAt(0);
    // The first hidden push has no measured cost to go by, so it rewinds, and seeds the average.
    run.clock.set(0.3);
    run.scheduler.push('t', 'out', { channel: 0 });
    expect(run.scheduler.stats).toMatchObject({ rewinds: 1, pushFallbacks: 0 });
    expect(run.scheduler.stats.msPerQuery.hidden).toBeCloseTo(1, 9);
    // The next one would re-run the rest of a 1.25 s window: over 1 ms at 1 ms a query.
    run.clock.set(0.6);
    const horizon = run.scheduler.horizon!;
    const predicted = run.runtime.rewindCost('t', 0.6 + IMMEDIATE_OFFSET)!;
    expect(predicted * 1).toBeGreaterThan(1);
    const before = run.deliveries.length, cancelled = run.scheduler.stats.cancelled;
    const event = run.scheduler.push('t', 'out', { channel: 0 })!;
    expect(event.time).toBe(horizon);
    expect(run.scheduler.stats).toMatchObject({ pushes: 2, rewinds: 1, pushFallbacks: 1, cancelled });
    expect(costs[1]!.fallback!.stamped).toBe(0.6 + IMMEDIATE_OFFSET);
    expect(costs[1]!.fallback!.estimatedMs).toBeCloseTo(predicted * 1, 9);
    expect(costs[1]!).toMatchObject({ time: horizon, rewind: null });
    // Nothing already sent was withdrawn: the wake that queried past the horizon delivered it.
    expect(run.deliveries.slice(before).some((d) => d.event.time === horizon && d.event.channel === 0)).toBe(true);
    expect(run.scheduler.events().filter((e) => e.node === 't').map((e) => e.time)).toEqual([0.3 + IMMEDIATE_OFFSET, horizon]);
    // On the pushed node, raised once, counted every time.
    run.clock.set(0.9);
    run.scheduler.push('t', 'out', { channel: 0 });
    expect(run.scheduler.stats.pushFallbacks).toBe(2);
    expect(run.heard).toEqual(['Live input came in while the page was hidden and would have cost too much to apply at once, so it played up to about a second late.']);
    expect(run.runtime.warnings()).toEqual([expect.objectContaining({ node: 't', kind: 'push-fallback', count: 2, time: run.scheduler.events().filter((e) => e.node === 't').at(-1)!.time })]);
  });

  it('always rewinds a visible push, whatever its cost', () => {
    const run = costed({ hiddenPushBudgetMs: 1 });
    // Measure hidden costs first, then go visible with a rewind that costs more than the budget.
    run.clock.isHidden = true;
    run.wakeAt(0);
    run.clock.set(0.3);
    run.scheduler.push('t', 'out', { channel: 0 });
    run.clock.isHidden = false;
    run.clock.set(0.35);
    const predicted = run.runtime.rewindCost('t', 0.35 + IMMEDIATE_OFFSET)!;
    expect(predicted * run.scheduler.stats.msPerQuery.hidden!).toBeGreaterThan(1);
    const event = run.scheduler.push('t', 'out', { channel: 0 })!;
    expect(event.time).toBe(0.35 + IMMEDIATE_OFFSET);
    expect(run.scheduler.stats).toMatchObject({ rewinds: 2, pushFallbacks: 0 });
    expect(run.scheduler.stats.msPerQuery.visible).toBeCloseTo(1, 9);
    expect(run.runtime.warnings()).toEqual([]);
  });

  it('lands pushes held while suspended at the horizon, and the next wake delivers them', () => {
    const costs: PushCost[] = [];
    const run = costed({ hiddenPushBudgetMs: 1, onPush: (cost) => costs.push(cost) });
    run.clock.isHidden = true;
    run.wakeAt(0);
    run.clock.set(0.3);
    run.scheduler.push('t', 'out', { channel: 0 });
    // Suspended: two pushes are held, and stamped at the resume wake.
    run.clock.isRunning = false;
    run.clock.set(0.5);
    expect(run.scheduler.push('t', 'out', { channel: 1 })).toBeNull();
    expect(run.scheduler.push('t', 'out', { channel: 2 })).toBeNull();
    run.clock.isRunning = true;
    run.wakeAt(2);
    // Each would rewind the window the resume just queried, over budget: both go to its end, now + 1.25 s.
    const horizon = 2 + HIDDEN_LOOKAHEAD;
    expect(run.scheduler.horizon).toBe(horizon);
    const held = costs.slice(1);
    expect(held.map((c) => [c.time, c.fallback?.stamped]).sort()).toEqual([[horizon, 2 + IMMEDIATE_OFFSET], [horizon, 2 + IMMEDIATE_OFFSET]]);
    expect(run.scheduler.stats).toMatchObject({ deferredPushes: 2, pushFallbacks: 2 });
    // Nothing is queried at the horizon yet, so nothing is delivered until the next wake.
    const atHorizon = () => run.deliveries.filter((d) => d.event.time === horizon && d.event.channel > 0).map((d) => [d.at, d.event.channel]);
    expect(atHorizon()).toEqual([]);
    run.wakeAt(3);
    expect(atHorizon()).toEqual([[3, 1], [3, 2]]);
  });

  it('logs the applied time, so replaying the recorded pushes gives the same events', () => {
    const run = costed({ hiddenPushBudgetMs: 1 });
    run.clock.isHidden = true;
    const recorded: EngineEvent[] = [];
    for (let k = 0; k < 4; k++) {
      run.wakeAt(k);
      run.clock.set(k + 0.4);
      recorded.push(run.scheduler.push('t', 'out', { channel: 0 })!);
    }
    expect(run.scheduler.stats.pushFallbacks).toBeGreaterThan(0);
    // Replay: the recorded events pushed at their recorded times, known in advance.
    const replay = setup(p, { lookahead: 0.004 });
    for (let k = 0; k * 0.002 < 5; k++) {
      replay.wakeAt(k * 0.002);
      for (const event of recorded) if (event.time >= replay.scheduler.horizon! && event.time < replay.scheduler.horizon! + 0.002) replay.runtime.push('t', 'out', event);
    }
    const upTo = (events: LoggedEvent[]) => json(events.filter((e) => e.time < 4.5));
    expect(upTo(replay.scheduler.events())).toBe(upTo(run.scheduler.events()));
  });
});

describe('rewind cost', () => {
  it('predicts the queries a push makes, before it makes them', () => {
    const p = patch(
      [node('m', 'metro', { period: 0.05 }), node('t', 'tap'), node('c', 'counter'), node('d', 'delay', { time: 0.011 }), node('r', 'recorder')],
      [cable('m', 'c'), cable('t', 'c'), cable('c', 'd'), cable('d', 'r'), cable('c', 'r')],
    );
    for (const hidden of [false, true]) {
      const run = setup(p);
      run.clock.isHidden = hidden;
      let checked = 0;
      for (let k = 0; k < 40; k++) {
        run.wakeAt(k * 0.025);
        run.clock.set(k * 0.025 + 0.0031 * (k % 8));
        const t = run.clock.audio + IMMEDIATE_OFFSET;
        const predicted = run.runtime.rewindCost('t', t);
        const before = run.scheduler.stats.pushQueries;
        const event = run.scheduler.push('t', 'out', { channel: 0 })!;
        expect(event.time).toBe(t);
        if (predicted === null) continue;
        expect(run.scheduler.stats.pushQueries - before).toBe(predicted);
        checked++;
      }
      expect(checked).toBeGreaterThan(30);
    }
  });

  it('predicts it across a swap that inserts a 10 ms Delay Edge', () => {
    const before = patch(
      [node('m', 'metro', { period: 0.05 }), node('t', 'tap'), node('c', 'counter'), node('r', 'recorder')],
      [cable('m', 'c'), cable('t', 'c'), cable('c', 'r')],
    );
    const after = patch([...before.nodes, node('d', 'delay', { time: 0.01 })], [cable('m', 'c'), cable('t', 'c'), cable('c', 'd'), cable('d', 'r')]);
    const run = setup(before);
    run.wakeEvery(0, 0.425);
    run.clock.set(0.4012);
    // Windows before the boundary run whole, those after it in 10 ms chunks.
    expect(run.scheduler.swap(run.compile(after)).time).toBeCloseTo(0.42, 9);
    let checked = 0;
    for (let k = 0; k < 8; k++) {
      if (k) run.wakeAt(0.4 + k * 0.025);
      run.clock.set(0.4012 + k * 0.025);
      const predicted = run.runtime.rewindCost('t', run.clock.audio + IMMEDIATE_OFFSET);
      const queries = run.scheduler.stats.pushQueries;
      run.scheduler.push('t', 'out', { channel: 0 });
      expect(run.scheduler.stats.pushQueries - queries).toBe(predicted);
      checked++;
    }
    expect(checked).toBe(8);
  });

  it('is null when the push would not rewind', () => {
    const { runtime, wakeAt } = setup(metroPatch());
    expect(runtime.rewindCost('m', 0)).toBeNull();
    wakeAt(0);
    expect(runtime.rewindCost('m', 0.05)).not.toBeNull();
    expect(runtime.rewindCost('m', LOOKAHEAD)).toBeNull();
    expect(runtime.rewindCost('nope', 0.05)).toBeNull();
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
    for (const d of shifted) expect(d.event.time).toBeCloseTo((d.event.index as number) * 0.005 + 0.02 + IMMEDIATE_OFFSET, 9);
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

describe('First wake: the patch starts at 0, even when the clock is a little past it (#105, ADR 0033)', () => {
  /** The editor's cold start: the AudioContext is suspended at 0 until the first tap resumes it, and its clock has
   *  moved on to `resume` by the first running wake. */
  const coldStart = (run: ReturnType<typeof setup>, resume: number, beforeResume: () => void = () => {}) => {
    run.clock.isRunning = false;
    run.wakeAt(0, 0);
    beforeResume();
    run.clock.isRunning = true;
    run.wakeAt(resume);
  };
  const deliveredAt = (run: ReturnType<typeof setup>) => run.live().map((d) => [d.at, d.event.time, d.event.index ?? d.event.count]);

  it('catches up [0, now) at a resume a few ms past 0, so the t=0 event sounds at the resume', () => {
    const run = setup(metroPatch(0.05));
    const windows: [number, number][] = [];
    const query = run.runtime.query.bind(run.runtime);
    run.runtime.query = (t0, t1, timing) => (windows.push([t0, t1]), query(t0, t1, timing));
    coldStart(run, 0.003);
    expect(windows).toEqual([[0, 0.003 + LOOKAHEAD]]);
    // The t=0 tick, moved by the 3 ms catch-up plus the immediate offset's lead; the rest at their own times.
    expect(deliveredAt(run)).toEqual([[0.003, 0.003 + IMMEDIATE_OFFSET, 0], [0.003, 0.05, 1], [0.003, 0.1, 2]]);
    expect(run.scheduler.stats).toMatchObject({ catchUps: 1, caughtUp: 1, stalls: 0, skipped: 0, lateScheduled: 0 });
    expect(run.scheduler.stats.catchUpMaxMs).toBeCloseTo(3, 9);
    expect(run.scheduler.stats.firstWake).toBe(0.003);
    // The log keeps the patch's own times: the same as a run whose clock started at 0.
    run.wakeEvery(0.025, 1);
    const reference = setup(metroPatch(0.05));
    reference.wakeEvery(0, 1);
    const upTo = (events: LoggedEvent[]) => json(events.filter((e) => e.time < 1));
    expect(upTo(run.scheduler.events())).toBe(upTo(reference.scheduler.events()));
  });

  it('catches up [0, 0] at a resume that reads exactly 0, so the t=0 event has the lead there too', () => {
    const run = setup(metroPatch(0.05));
    coldStart(run, 0);
    expect(deliveredAt(run)).toEqual([[0, IMMEDIATE_OFFSET, 0], [0, 0.05, 1], [0, 0.1, 2]]);
    // Not a late wake, so not a catch-up in catchUps; its event counts in caughtUp.
    expect(run.scheduler.stats).toMatchObject({ catchUps: 0, caughtUp: 1, stalls: 0, lateScheduled: 0, lateCaughtUp: 0, firstWake: 0 });
    // The log keeps the patch's own times.
    run.wakeEvery(0.025, 1);
    const reference = setup(metroPatch(0.05));
    reference.wakeEvery(0, 1);
    const upTo = (events: LoggedEvent[]) => json(events.filter((e) => e.time < 1));
    expect(upTo(run.scheduler.events())).toBe(upTo(reference.scheduler.events()));
    // A clock that runs from the start has no resume: its t=0 event stays at 0.
    expect(deliveredAt(reference)[0]).toEqual([0, 0, 0]);
  });

  it('catches up from 0 up to the catch-up limit; past it, starts at now without a stall', () => {
    // At the limit: [0, 0.1) moved to start at 0.1 + the offset, spacing kept.
    const atLimit = setup(metroPatch(0.025));
    coldStart(atLimit, 0.1);
    const caught = atLimit.live().filter((d) => (d.event.index as number) * 0.025 < 0.1);
    expect(caught.map((d) => d.event.index)).toEqual([0, 1, 2, 3]);
    for (const d of caught) expect(d.event.time).toBeCloseTo((d.event.index as number) * 0.025 + 0.1 + IMMEDIATE_OFFSET, 9);
    expect(atLimit.scheduler.stats).toMatchObject({ catchUps: 1, caughtUp: 4, stalls: 0, skipped: 0, lateScheduled: 0 });
    expect(atLimit.scheduler.stats.catchUpMaxMs).toBeCloseTo(100, 9);

    // Past it (a startup slower than 100 ms): the patch starts at now, so the t=0 tick is lost, and
    // nothing is caught up or counted as a stall.
    const run = setup(metroPatch(0.05));
    const windows: [number, number][] = [];
    const query = run.runtime.query.bind(run.runtime);
    run.runtime.query = (t0, t1, timing) => (windows.push([t0, t1]), query(t0, t1, timing));
    coldStart(run, 0.5);
    expect(windows).toEqual([[0.5, 0.5 + LOOKAHEAD]]);
    expect(run.live().map((d) => [d.at, d.event.index])).toEqual([[0.5, 10], [0.5, 11], [0.5, 12]]);
    expect(run.live()[0]!.event.time).toBe(0.5);
    expect(run.scheduler.stats).toMatchObject({ catchUps: 0, caughtUp: 0, stalls: 0, skipped: 0, lateScheduled: 0, firstWake: 0.5 });
    // Only the first running wake counts: later wakes leave it.
    run.wakeAt(0.525);
    expect(run.scheduler.stats.firstWake).toBe(0.5);
  });

  it('never catches up more than the limit at the first wake, even if someone else queried part of [0, now)', () => {
    const run = setup(metroPatch(0.01));
    run.runtime.query(0, 0.05);
    run.wakeAt(0.12);
    expect(run.scheduler.stats).toMatchObject({ catchUps: 0, stalls: 0 });
    const part = setup(metroPatch(0.01));
    part.runtime.query(0, 0.05);
    part.wakeAt(0.08);
    // [0.05, 0.08) caught up, moved 30 ms.
    expect(part.scheduler.stats).toMatchObject({ catchUps: 1, caughtUp: 3, stalls: 0 });
    expect(part.scheduler.stats.catchUpMaxMs).toBeCloseTo(30, 9);
  });

  it('catches up from 0 while hidden, and after a halt before any window', () => {
    const hidden = setup(metroPatch(0.05));
    hidden.clock.isHidden = true;
    coldStart(hidden, 0.003);
    expect(hidden.scheduler.horizon).toBeCloseTo(0.003 + HIDDEN_LOOKAHEAD, 12);
    expect(deliveredAt(hidden)[0]).toEqual([0.003, 0.003 + IMMEDIATE_OFFSET, 0]);
    expect(hidden.scheduler.stats).toMatchObject({ catchUps: 1, stalls: 0 });

    const halted = setup(metroPatch(0.05), { timer: { every: () => () => {} } });
    halted.clock.isRunning = false;
    halted.scheduler.start();
    halted.scheduler.halt();
    halted.clock.isRunning = true;
    halted.wakeAt(0.003);
    expect(deliveredAt(halted)[0]).toEqual([0.003, 0.003 + IMMEDIATE_OFFSET, 0]);
  });

  it('does not catch up at a resume after a suspend or a halt, once a window was queried', () => {
    const run = setup(metroPatch(0.05), { timer: { every: () => () => {} } });
    coldStart(run, 0.003);
    const first = run.scheduler.horizon!;
    run.clock.isRunning = false;
    run.wakeAt(0.05);
    run.clock.isRunning = true;
    run.wakeAt(0.4);
    // From now, not from the horizon: [first, 0.4) is never queried or played.
    expect(run.live().filter((d) => d.event.time >= first && d.event.time < 0.4)).toEqual([]);
    expect(run.scheduler.stats).toMatchObject({ catchUps: 1, stalls: 0, skipped: 0 });
    run.scheduler.halt();
    run.wakeAt(0.9);
    expect(run.live().filter((d) => d.event.time >= 0.4 + LOOKAHEAD && d.event.time < 0.9)).toEqual([]);
    expect(run.scheduler.stats).toMatchObject({ catchUps: 1, stalls: 0, skipped: 0 });
  });

  it('plays the t=0 event, then the first tap held for the resume, in that order and as if the clock had started at 0', () => {
    const p = patch(
      [node('m', 'metro', { period: 0.5 }), node('t', 'tap'), node('c', 'counter'), node('r', 'recorder')],
      [cable('m', 'c'), cable('t', 'c'), cable('c', 'r')],
    );
    const run = setup(p);
    coldStart(run, 0.003, () => {
      // The first tap: held while suspended.
      expect(run.scheduler.push('t', 'out', { channel: 0 })).toBeNull();
    });
    // Both with the immediate offset's lead, so at one time: the caught-up tick first, then the tap.
    expect(deliveredAt(run)).toEqual([[0.003, 0.003 + IMMEDIATE_OFFSET, 1], [0.003, 0.003 + IMMEDIATE_OFFSET, 2]]);
    expect(run.scheduler.stats).toMatchObject({ deferredPushes: 1, pushes: 1, catchUps: 1, stalls: 0, lateScheduled: 0, lateImmediate: 0 });
    // The log is the same as a clock that started at 0 and a tap pushed at 0.003.
    run.wakeEvery(0.025, 1.2);
    const reference = setup(p);
    reference.wakeAt(0);
    reference.clock.set(0.003);
    reference.scheduler.push('t', 'out', { channel: 0 });
    reference.wakeEvery(0.025, 1.2);
    const upTo = (events: LoggedEvent[]) => json(events.filter((e) => e.time < 1.2));
    expect(upTo(run.scheduler.events())).toBe(upTo(reference.scheduler.events()));
    // Ticks at 0, 0.5 and 1, and the tap, counted once each.
    expect(run.live().map((d) => d.event.count)).toEqual([1, 2, 3, 4]);
  });

  it('counts a caught-up event the clock passed during the query in lateCaughtUp, not lateScheduled', () => {
    // A slow first query: the audio clock steps 8 ms while it runs, after the wake read now, past the 5 ms lead.
    let clock: ManualClock | null = null;
    const slow: NodeDefinition = { ...metro, type: 'slow', query: (ctx) => (clock && (clock.audio = 0.011), metro.query!(ctx)) };
    const run = setup(patch([node('m', 'slow', { period: 0.05 }), node('r', 'recorder')], [cable('m', 'r')]), {}, [slow]);
    run.clock.isRunning = false;
    run.wakeAt(0);
    run.clock.isRunning = true;
    clock = run.clock;
    run.wakeAt(0.003);
    // The t=0 tick, moved by the catch-up to 0.008 and then to the clock at hand-over.
    expect(deliveredAt(run)[0]).toEqual([0.011, 0.011, 0]);
    expect(run.scheduler.stats).toMatchObject({ caughtUp: 1, lateCaughtUp: 1, lateScheduled: 0, lateImmediate: 0, lateImmediateMaxMs: 0 });
    // 3 ms late: the 8 ms step during the query, less the 5 ms lead.
    expect(run.scheduler.stats.lateCaughtUpMaxMs).toBeCloseTo(8 - IMMEDIATE_OFFSET * 1000, 9);
  });

  it('counts late caught-up events of every catch-up in lateCaughtUp, mid-session too, with the worst in lateCaughtUpMaxMs', () => {
    // Emits one event at the start of each window, and moves the clock by `move` while it runs when set.
    let clock: ManualClock | null = null, move = 0;
    const edge: NodeDefinition = {
      ...metro, type: 'edge', params: [],
      query: ({ t0 }) => {
        if (clock && move) {
          clock.audio += move;
          move = 0;
        }
        return { out: [{ time: t0, channel: 0 }] };
      },
    };
    const run = setup(patch([node('e', 'edge'), node('r', 'recorder')], [cable('e', 'r')]), {}, [edge]);
    clock = run.clock;
    run.wakeAt(0, 0.025);
    expect(run.scheduler.stats).toMatchObject({ catchUps: 0, firstWake: 0 });
    // Two late wakes within the limit, 50 and 70 ms past the horizon, with the clock stepping 9 and 14 ms during
    // their queries: each window's first event, caught up to now + 5 ms, is behind the clock at hand-over by that
    // step less the lead.
    run.clock.set(run.scheduler.horizon! + 0.05);
    move = 0.009;
    run.scheduler.wake();
    run.clock.set(run.scheduler.horizon! + 0.07);
    move = 0.014;
    run.scheduler.wake();
    expect(run.scheduler.stats).toMatchObject({ catchUps: 2, stalls: 0, lateCaughtUp: 2, lateScheduled: 0, lateImmediate: 0 });
    expect(run.scheduler.stats.lateCaughtUpMaxMs).toBeCloseTo(9, 6);
  });

  it('plays the t=0 event of a patch swapped in before the first tap', () => {
    const run = setup(patch([node('t', 'tap'), node('r', 'recorder')], [cable('t', 'r')]));
    coldStart(run, 0.003, () => {
      expect(run.scheduler.swap(run.compile(metroPatch(0.05))).windows).toBe(0);
    });
    expect(deliveredAt(run)[0]).toEqual([0.003, 0.003 + IMMEDIATE_OFFSET, 0]);
    expect(run.scheduler.stats).toMatchObject({ catchUps: 1, stalls: 0, lateScheduled: 0 });
  });
});

describe('pushAll: one browser event onto several sources (ADR 0029)', () => {
  // Two taps, each into its own counter, both into the recorder, with a metro so windows have work.
  const two = patch(
    [node('m', 'metro', { period: 0.05 }), node('a', 'tap'), node('b', 'tap'), node('ca', 'counter'), node('cb', 'counter'), node('r', 'recorder')],
    [cable('m', 'ca'), cable('a', 'ca'), cable('b', 'cb'), cable('ca', 'r'), cable('cb', 'r')],
  );
  const both = (channel: number) => [{ node: 'a', port: 'out', fields: { channel } }, { node: 'b', port: 'out', fields: { channel } }];
  const tapTimes = (run: ReturnType<typeof setup>) => run.scheduler.events().filter((e) => e.node === 'a' || e.node === 'b').map((e) => [e.node, e.time]);

  it('stamps every target once, rewinds once and counts one push', () => {
    const costs: PushCost[] = [];
    const run = setup(two, { onPush: (cost) => costs.push(cost) });
    run.wakeEvery(0, 0.3);
    run.clock.set(0.3012);
    // A clock that moves on every read: a second read for the second target would give it a later stamp.
    const reads: number[] = [];
    run.clock.audioTime = () => {
      reads.push((run.clock.audio += 0.0001));
      return run.clock.audio;
    };
    const events = run.scheduler.pushAll(both(4))!;
    run.clock.audioTime = ManualClock.prototype.audioTime;
    const stamp = 0.3012 + 0.0001 + IMMEDIATE_OFFSET;
    expect(events.map((e) => e.time)).toEqual([stamp, stamp]);
    // The stamp is the first read's. The other reads are the rewind's hand-overs checking currentTime
    // (DeliveryTiming.currentTime), which is a live read by design; none of them moved a stamp.
    expect(reads[0]! + IMMEDIATE_OFFSET).toBe(stamp);
    expect(events[0]).not.toBe(events[1]);
    expect(run.scheduler.stats).toMatchObject({ pushes: 1, rewinds: 1 });
    expect([...costs[0]!.rewind!.affected].sort()).toEqual(['a', 'b', 'ca', 'cb', 'r']);
    run.wakeEvery(0.325, 0.6);
    expect(tapTimes(run)).toEqual([['a', stamp], ['b', stamp]]);
    // The same log as the two events pushed before any window: one rewind gives what one query would.
    const reference = setup(two);
    reference.runtime.pushAll([{ node: 'a', port: 'out', event: { ...events[0]! } }, { node: 'b', port: 'out', event: { ...events[1]! } }]);
    reference.wakeEvery(0, 0.6);
    expect(json(run.scheduler.events())).toBe(json(reference.scheduler.events()));
  });

  it("doesn't split a hidden push over budget: every target lands at the horizon", () => {
    /** Hidden, every query 1 ms; a first push seeds the hidden average, then the clock moves to 0.6 s. */
    const hidden = (hiddenPushBudgetMs: number) => {
      const run = setup(two, { hiddenPushBudgetMs });
      run.clock.wallTime = () => run.clock.wall + run.runtime.counters.queries;
      run.clock.isHidden = true;
      run.wakeAt(0);
      run.clock.set(0.3);
      run.scheduler.pushAll(both(0));
      expect(run.scheduler.stats.pushFallbacks).toBe(0);
      expect(run.scheduler.stats.msPerQuery.hidden).toBe(1);
      run.clock.set(0.6);
      return run;
    };
    const t = 0.6 + IMMEDIATE_OFFSET;
    const probe = hidden(Infinity);
    const [a, b, sum] = [probe.runtime.rewindCost('a', t)!, probe.runtime.rewindCost('b', t)!, probe.runtime.rewindCost(['a', 'b'], t)!];
    // A budget each target alone is under and the two together are over, so a per-target decision would rewind both.
    const budget = (Math.max(a, b) + sum) / 2;
    expect(a).toBeLessThan(budget);
    expect(b).toBeLessThan(budget);
    expect(sum).toBeGreaterThan(budget);
    const run = hidden(budget);
    const horizon = run.scheduler.horizon!;
    const events = run.scheduler.pushAll(both(1))!;
    expect(events.map((e) => e.time)).toEqual([horizon, horizon]);
    expect(run.scheduler.stats.pushFallbacks).toBe(1);
    expect(run.runtime.warnings().map((w) => [w.node, w.kind, w.count])).toEqual([['a', 'push-fallback', 1], ['b', 'push-fallback', 1]]);
  });

  it('holds the targets together while suspended and stamps them together at the resume', () => {
    const run = setup(two);
    run.wakeEvery(0, 0.2);
    run.clock.isRunning = false;
    run.clock.set(0.3);
    expect(run.scheduler.pushAll(both(2))).toBeNull();
    expect(() => run.scheduler.pushAll([...both(2), { node: 'r', port: 'in', fields: { channel: 0 } }])).toThrow(/no event output/);
    expect(run.scheduler.stats.deferredPushes).toBe(1);
    run.clock.isRunning = true;
    run.wakeAt(1);
    expect(tapTimes(run)).toEqual([['a', 1 + IMMEDIATE_OFFSET], ['b', 1 + IMMEDIATE_OFFSET]]);
  });

  it('still pushes a held group onto the targets a swap left while suspended, at one stamp', () => {
    // A cold tap reaching two sources; one is deleted before the context starts. The other must still sound.
    const run = setup(two);
    run.wakeEvery(0, 0.2);
    run.clock.isRunning = false;
    run.clock.set(0.3);
    expect(run.scheduler.pushAll([...both(2), { node: 'a', port: 'out', fields: { channel: 3 } }])).toBeNull();
    run.scheduler.swap(run.compile(patch(two.nodes.filter((n) => n.id !== 'b' && n.id !== 'cb'), two.cables.filter((c) => c.from.node !== 'b' && c.from.node !== 'cb'))));
    run.clock.isRunning = true;
    expect(() => run.wakeAt(1)).not.toThrow();
    expect(run.scheduler.events().filter((e) => e.node === 'a').map((e) => [e.time, e.channel])).toEqual([[1 + IMMEDIATE_OFFSET, 2], [1 + IMMEDIATE_OFFSET, 3]]);
    expect(run.live().filter((d) => d.event.time === 1 + IMMEDIATE_OFFSET).map((d) => d.event.channel)).toEqual([2, 3]);
    // A held group with no target left is dropped quietly.
    run.clock.isRunning = false;
    expect(run.scheduler.pushAll([{ node: 'a', port: 'out', fields: { channel: 4 } }])).toBeNull();
    run.scheduler.swap(run.compile(patch([node('m', 'metro', { period: 0.05 }), node('r', 'recorder')], [])));
    run.clock.isRunning = true;
    expect(() => run.wakeAt(2)).not.toThrow();
  });

  it('pushes nothing when one target is wrong, and nothing at all for no targets', () => {
    const run = setup(two);
    run.wakeEvery(0, 0.2);
    run.clock.set(0.2);
    expect(() => run.scheduler.pushAll([...both(0), { node: 'nope', port: 'out', fields: { channel: 0 } }])).toThrow(/no node/);
    expect(run.scheduler.pushAll([])).toEqual([]);
    run.wakeEvery(0.2, 0.5);
    expect(tapTimes(run)).toEqual([]);
    expect(run.scheduler.stats.pushes).toBe(0);
  });

  it('drops every target of a push whose re-run throws, counted once', () => {
    const fragile: NodeDefinition = {
      type: 'fragile', version: 1, label: 'Fragile', category: 'control-logic', description: '',
      ports: [{ name: 'in', type: 'event', direction: 'in' }, { name: 'out', type: 'event', direction: 'out' }],
      params: [],
      query: ({ inputs }) => {
        if ((inputs.in ?? []).some((e) => e.boom)) throw new Error('fragile broke');
        return { out: [...(inputs.in ?? [])] };
      },
    };
    const p = patch(
      [node('m', 'metro', { period: 0.05 }), node('a', 'tap'), node('b', 'tap'), node('f', 'fragile'), node('c', 'counter'), node('r', 'recorder')],
      [cable('m', 'c'), cable('a', 'f'), cable('b', 'c'), cable('f', 'r'), cable('c', 'r')],
    );
    const perform = (push: boolean) => {
      const run = setup(p, {}, [fragile]);
      run.wakeEvery(0, 0.3);
      run.clock.set(0.3012);
      if (push) run.scheduler.pushAll([{ node: 'a', port: 'out', fields: { channel: 0, boom: true } }, { node: 'b', port: 'out', fields: { channel: 0 } }]);
      run.wakeEvery(0.325, 0.6);
      return run;
    };
    const run = perform(true);
    expect(run.scheduler.stats.droppedPushes).toBe(1);
    // Not even the target whose re-run was fine (b into the counter) keeps its event.
    expect(json(run.scheduler.events())).toBe(json(perform(false).scheduler.events()));
    expect(run.runtime.warnings().map((w) => [w.node, w.kind])).toEqual([['f', 'rewind-error']]);
    expect(run.runtime.warnings()[0]!.message).toBe('Node "f" failed while re-running for a live event from "a", "b", so that event was dropped: fragile broke');
  });
});
