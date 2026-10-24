// Audio param automation and in-place knob edits (ADR 0031): `AudioInstance.automate`
// runs per chunk for every audio node, idempotently across rewinds, swaps and window
// splits; `AudioSetupContext.connected`; `liveParams` + `AudioInstance.update` keep
// the instance on a knob edit, while any other change still rebuilds (ADR 0023).
import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_MEMORY,
  automationTimes,
  EDIT_RAMP,
  AUTOMATION_RATE,
  compilePatch,
  ManualClock,
  editRamp,
  paramAutomation,
  Runtime,
  Scheduler,
  type AudioContextLike,
  type AudioParamLike,
  type DeliveryTiming,
  type EngineEvent,
  type NodeDefinition,
  type Patch,
  type Plan,
} from '../src';

/** An AudioParam's automation timeline, as Web Audio keeps it: cancelScheduledValues(t) drops every event at or after t. */
class FakeParam implements AudioParamLike {
  value = 0;
  events: { kind: string; value: number; time: number; tc?: number }[] = [];
  private add(event: { kind: string; value: number; time: number; tc?: number }) {
    // After any event at the same time, as Web Audio inserts them.
    let at = this.events.length;
    while (at > 0 && this.events[at - 1]!.time > event.time) at--;
    this.events.splice(at, 0, event);
  }
  setValueAtTime(value: number, time: number) {
    this.add({ kind: 'set', value, time });
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.add({ kind: 'linear', value, time });
  }
  exponentialRampToValueAtTime(value: number, time: number) {
    this.add({ kind: 'exp', value, time });
  }
  setTargetAtTime(value: number, time: number, tc: number) {
    this.add({ kind: 'target', value, time, tc });
  }
  cancelScheduledValues(time: number) {
    this.events = this.events.filter((e) => e.time < time);
  }
  /** The value at `t` from `value` and the set and linear events (enough for editRamp and paramAutomation). */
  at(t: number): number {
    let prev = { time: -Infinity, value: this.value };
    for (const e of this.events) {
      if (e.kind === 'linear' && e.time > t) return prev.time === -Infinity ? e.value : prev.value + ((e.value - prev.value) * (t - prev.time)) / (e.time - prev.time);
      if (e.time > t) return prev.value;
      prev = e;
    }
    return prev.value;
  }
}

/** A sine plus whatever value was last pushed onto `set`; stateful, so a rewind must restore it. */
const source: NodeDefinition = {
  type: 'source', version: 1, label: 'Source', category: 'control-logic', description: '',
  ports: [{ name: 'set', type: 'event', direction: 'out' }, { name: 'out', type: 'signal', direction: 'out' }],
  params: [],
  query: ({ pushed, state, t0, t1 }) => {
    const changes = ((state.changes as [number, number][] | undefined) ??= []);
    for (const e of pushed.set ?? []) changes.push([e.time, e.value as number]);
    state.t0 = t0;
    state.t1 = t1;
    return {};
  },
  signal: ({ state }, _port, t) => {
    // param() is only valid for the chunk just queried (NodeState contract); count reads outside it.
    if (!(t >= (state.t0 as number) && t < (state.t1 as number))) outside++;
    let held = 0;
    for (const [time, value] of (state.changes as [number, number][] | undefined) ?? []) if (time <= t) held = value;
    return 0.25 * Math.sin(2 * Math.PI * t) + held;
  },
};
let outside = 0;

/** A Filter stand-in with only an Audio input: `cutoff` follows its cable, `gain` takes knob edits in place. */
interface Built { id: number; cutoff: FakeParam; gain: FakeParam; calls: [number, number][]; updates: [number, number][]; connected: Record<string, boolean> }
function filterType(built: Built[], opts: { update?: boolean; keepState?: boolean } = {}): NodeDefinition {
  return {
    ...(opts.keepState === false ? { keepState: () => false } : {}),
    type: 'filter', version: 1, label: 'Filter', category: 'effects-mix', description: '',
    ports: [{ name: 'in', type: 'audio', direction: 'in' }, { name: 'out', type: 'audio', direction: 'out' }],
    params: [
      { name: 'cutoff', kind: 'number', min: -10, max: 10, default: 1 },
      { name: 'gain', kind: 'number', min: 0, max: 1, default: 0.5 },
      { name: 'mode', kind: 'enum', options: ['lowpass', 'highpass'], default: 'lowpass' },
    ],
    liveParams: ['gain', 'cutoff'],
    audio: ({ param, connected, params }) => {
      const b: Built = { id: built.length + 1, cutoff: new FakeParam(), gain: new FakeParam(), calls: [], updates: [], connected: { cutoff: connected('cutoff'), gain: connected('gain'), in: connected('in') } };
      b.gain.value = params.gain as number;
      const gain = editRamp(b.gain, b.gain.value);
      const cutoff = paramAutomation(b.cutoff);
      built.push(b);
      const node = { connect() {}, disconnect() {} };
      return {
        inputs: { in: node }, outputs: { out: node },
        automate(t0, t1) {
          b.calls.push([t0, t1]);
          if (connected('cutoff')) cutoff.follow(t0, t1, (t) => param('cutoff', t));
        },
        ...(opts.update === false ? {} : {
          update(next: Record<string, unknown>, time: number) {
            b.updates.push([next.gain as number, time]);
            if (!connected('gain')) gain.set(next.gain as number, time);
          },
        }),
      };
    },
  };
}
/** Bounds windows to 30 ms chunks once something feeds it. */
const delayEdge: NodeDefinition = {
  type: 'delay', version: 1, label: 'Delay', category: 'control-logic', description: '',
  ports: [{ name: 'in', type: 'event', direction: 'in' }, { name: 'out', type: 'event', direction: 'out' }],
  params: [], delay: () => 0.03, query: () => ({}),
};

const node = (id: string, type: string, params = {}) => ({ id, type, typeVersion: 1, params, position: { x: 0, y: 0 } });
function patchOf({ cabled = true, chunked = false, filter = {} as Record<string, unknown> } = {}): Patch {
  const nodes = [node('src', 'source'), node('f', 'filter', filter)];
  const cables: Patch['cables'] = cabled ? [{ from: { node: 'src', port: 'out' }, to: { node: 'f', port: 'cutoff' } }] : [];
  if (chunked) {
    nodes.push(node('d', 'delay'));
    cables.push({ from: { node: 'src', port: 'set' }, to: { node: 'd', port: 'in' } });
  }
  return { format: 'flowpatch', version: 1, seed: 1, nodes, cables };
}
function setup(patch: Patch, opts: { update?: boolean; keepState?: boolean } = {}) {
  const built: Built[] = [];
  const definitions = new Map([source, filterType(built, opts), delayEdge].map((d) => [d.type, d]));
  const compile = (p: Patch): Plan => {
    const compiled = compilePatch(p, definitions);
    if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
    return compiled.plan;
  };
  const runtime = new Runtime(compile(patch));
  runtime.keepHistory();
  runtime.attachAudio({} as AudioContextLike);
  return { runtime, built, compile };
}
const set = (time: number, value: number): EngineEvent => ({ time, channel: 0, value });
const grid = new Set(automationTimes(0, 10));
const onGrid = (events: FakeParam['events']) => events.filter((e) => grid.has(e.time));
const offGrid = (events: FakeParam['events']) => events.filter((e) => !grid.has(e.time));
/** The largest change between samples 0.1 ms apart in [from, to). */
function steepest(p: FakeParam, from: number, to: number): number {
  let worst = 0;
  for (let t = from; t < to; t += 1e-4) worst = Math.max(worst, Math.abs(p.at(t + 1e-4) - p.at(t)));
  return worst;
}

/** The cutoff timeline after querying [0, 1) in the given windows. */
function timeline(bounds: number[], push?: { event: EngineEvent; after: number }) {
  const { runtime, built } = setup(patchOf());
  if (push && push.after <= bounds[0]!) runtime.push('src', 'set', push.event);
  for (let i = 0; i + 1 < bounds.length; i++) {
    runtime.query(bounds[i]!, bounds[i + 1]!);
    if (push && push.after > bounds[i]! && push.after <= bounds[i + 1]!) runtime.push('src', 'set', push.event);
  }
  return built[0]!;
}

describe('automationTimes', () => {
  it('puts every grid point in exactly one of two adjacent intervals', () => {
    const whole = automationTimes(0.0123, 0.9);
    for (const split of [0.1, 1 / 60, 0.5 + 1e-12, 0.77]) {
      expect([...automationTimes(0.0123, split), ...automationTimes(split, 0.9)]).toEqual(whole);
    }
    expect(whole[0]).toBe(1 / AUTOMATION_RATE);
    expect(automationTimes(0.5, 0.5)).toEqual([]);
    expect(automationTimes(NaN, 1)).toEqual([]);
  });
});

describe('AudioInstance.automate', () => {
  it('runs once per chunk, in plan order after its Signal sources, with param() valid for the chunk', () => {
    outside = 0;
    const { runtime, built } = setup(patchOf({ chunked: true }));
    runtime.query(0, 0.1);
    const { calls } = built[0]!;
    // 0.1 s in chunks no wider than the delay's 30 ms: four of them, edge to edge.
    expect(calls.length).toBe(4);
    expect(calls[0]![0]).toBe(0);
    expect(calls.at(-1)![1]).toBe(0.1);
    for (let i = 1; i < calls.length; i++) expect(calls[i]![0]).toBe(calls[i - 1]![1]);
    for (const [t0, t1] of calls) expect(t1 - t0).toBeLessThanOrEqual(0.03);
    expect(outside).toBe(0);
    expect(built[0]!.cutoff.events.map((e) => e.time)).toEqual(automationTimes(0, 0.1));
  });

  it('clamps t0 to the clock at hand-over and moves a caught-up chunk by its shift', () => {
    const { runtime, built } = setup(patchOf());
    runtime.query(0, 0.1);
    const late: DeliveryTiming = { now: 0.1, currentTime: () => 0.13 };
    runtime.query(0.1, 0.22, late);
    expect(built[0]!.calls.at(-1)).toEqual([0.13, 0.22]);
    // A late wake at 0.3 catching up from 0.22: the stretch moves 80 ms later.
    runtime.query(0.22, 0.42, { now: 0.3, catchUp: { until: 0.3, shift: 0.08 } });
    const [t0, t1] = built[0]!.calls.at(-1)!;
    expect(t0).toBeCloseTo(0.3, 12);
    expect(t1).toBeCloseTo(0.5, 12);
    // A chunk wholly behind the clock isn't automated.
    const before = built[0]!.calls.length;
    runtime.query(0.42, 0.45, { now: 0.46 });
    expect(built[0]!.calls.length).toBe(before);
  });

  it('gives the same timeline however [0, 1) is split into windows', () => {
    const one = timeline([0, 1]).cutoff.events;
    expect(one.length).toBe(60);
    expect(one.every((e) => e.kind === 'linear')).toBe(true);
    expect(timeline([0, 0.37, 1]).cutoff.events).toEqual(one);
    expect(timeline([0, 0.1234, 0.5, 1]).cutoff.events).toEqual(one);
  });

  it('is idempotent across a rewind: the grid points of when the live event was known from the start, the ramp in progress kept up to it', () => {
    const event = set(0.4321, 2);
    const known = timeline([0, 0.25, 0.5, 0.75, 1], { event, after: 0 });
    expect(offGrid(known.cutoff.events)).toEqual([]);
    // Pushed after [0.25, 0.5) was queried: rewinds into it.
    for (const [bounds, after] of [[[0, 0.25, 0.5, 0.75, 1], 0.5], [[0, 0.1, 0.45, 1], 0.45]] as const) {
      const rewound = timeline([...bounds], { event: set(0.4321, 2), after });
      expect(onGrid(rewound.cutoff.events)).toEqual(known.cutoff.events);
      expect(rewound.cutoff.events.some((e) => e.value > 1.5)).toBe(true);
      // The rewind starts at the event, inside the ramp to 26/60: that ramp keeps its course up to the event.
      const before = timeline([...bounds]).cutoff;
      expect(offGrid(rewound.cutoff.events)).toEqual([{ kind: 'linear', value: before.at(0.4321), time: 0.4321 }]);
      for (let t = 25 / 60; t <= 0.4321; t += 1e-4) expect(rewound.cutoff.at(t)).toBeCloseTo(before.at(t), 12);
    }
  });

  it('is not called for the replay before a rewound event, only from it', () => {
    const { runtime, built } = setup(patchOf());
    runtime.query(0, 0.25);
    runtime.query(0.25, 0.5);
    const calls = built[0]!.calls;
    calls.length = 0;
    runtime.push('src', 'set', set(0.4, 1));
    // The window [0.25, 0.5) replays [0.25, 0.4) for state only, then emits [0.4, 0.5).
    expect(calls).toEqual([[0.4, 0.5]]);
  });
});

describe('AudioSetupContext.connected', () => {
  it('tells cabled params from the rest', () => {
    expect(setup(patchOf()).built[0]!.connected).toEqual({ cutoff: true, gain: false, in: false });
    expect(setup(patchOf({ cabled: false })).built[0]!.connected).toEqual({ cutoff: false, gain: false, in: false });
  });
});

describe('paramAutomation', () => {
  const wave = (t: number) => Math.sin(7 * t) + 2;

  it('a re-run with an unchanged value leaves the param\'s course as it was, wherever it starts', () => {
    const once = new FakeParam();
    paramAutomation(once).follow(0, 1, wave);
    for (const starts of [[0.3], [0.31, 0.2], [0.4, 0.4], [21 / 60, 0.35, 0.61], [0.5 + 1e-9]]) {
      const p = new FakeParam();
      const automation = paramAutomation(p);
      automation.follow(0, 0.7, wave);
      automation.follow(0.7, 1, wave);
      for (const t0 of starts) automation.follow(t0, 1, wave);
      for (let t = 0; t < 1.02; t += 1e-3) expect(p.at(t)).toBeCloseTo(once.at(t), 12);
    }
  });

  it('a re-run with a new value keeps the ramp in progress up to its start, then ramps to the next grid point', () => {
    const p = new FakeParam();
    const automation = paramAutomation(p);
    automation.follow(0, 1, wave);
    const before = new FakeParam();
    paramAutomation(before).follow(0, 1, wave);
    const lifted = (t: number) => wave(t) + 5;
    for (const t0 of [0.31, 0.6]) {
      automation.follow(t0, 1, lifted);
      for (let t = 0; t <= t0; t += 1e-4) expect(p.at(t)).toBeCloseTo(before.at(t), 12);
      const next = Math.ceil(t0 * 60) / 60;
      expect(p.at(next)).toBeCloseTo(lifted(next), 12);
      expect(steepest(p, t0 - 0.02, next + 0.02)).toBeLessThanOrEqual((6 / (next - t0)) * 1e-4);
      // From the next grid point on, the new values.
      for (const e of p.events.filter((e) => e.time > next)) expect(e.value).toBe(lifted(e.time));
      before.events = p.events.slice();
    }
  });

  it('never changes the course up to t0 between its calls, so a render between them sees the old one', () => {
    const p = new FakeParam();
    const automation = paramAutomation(p);
    automation.follow(0, 1, wave);
    const t0 = 0.3123, from = 18 / 60;
    const course = () => Array.from({ length: 50 }, (_, i) => p.at(from + ((t0 - from) * i) / 49));
    const played = course();
    // After each call the re-run makes, the param runs as before up to t0.
    const seen: number[][] = [];
    for (const name of ['linearRampToValueAtTime', 'cancelScheduledValues'] as const) {
      const call = p[name].bind(p) as (...args: number[]) => void;
      p[name] = ((...args: number[]) => {
        call(...args);
        seen.push(course());
      }) as never;
    }
    automation.follow(t0, 1, (t) => wave(t) + 5);
    expect(seen.length).toBeGreaterThan(2);
    for (const c of seen) for (let i = 0; i < c.length; i++) expect(c[i]).toBeCloseTo(played[i]!, 12);
  });

  it('a re-run starting on a grid point keeps the old value there and starts the new ones after it', () => {
    const p = new FakeParam();
    const automation = paramAutomation(p);
    automation.follow(0, 1, wave);
    const t0 = 30 / 60;
    automation.follow(t0, 1, (t) => wave(t) + 5);
    expect(p.events.filter((e) => e.time === t0)).toEqual([{ kind: 'linear', value: wave(t0), time: t0 }]);
    expect(p.at(31 / 60)).toBe(wave(31 / 60) + 5);
  });

  it('still keeps the ramp in progress for a re-run AUTOMATION_MEMORY back after a long run, which prunes older points', () => {
    const p = new FakeParam();
    const automation = paramAutomation(p);
    for (let k = 0; k < 600; k++) automation.follow(k * 0.025, (k + 1) * 0.025, wave);
    const t0 = 600 * 0.025 - AUTOMATION_MEMORY + 0.001;
    const course = p.at(t0);
    automation.follow(t0, 15, (t) => wave(t) + 5);
    expect(p.at(t0)).toBeCloseTo(course, 12);
  });
});

describe('in-place knob edits', () => {
  function live(opts: { update?: boolean; keepState?: boolean } = {}) {
    const clock = new ManualClock();
    let patch = patchOf();
    const { runtime, built, compile } = setup(patch, opts);
    const scheduler = new Scheduler(runtime, { clock });
    const wakeTo = (to: number) => {
      for (let k = Math.round(clock.audio / 0.025); k * 0.025 < to - 1e-9; k++) {
        clock.set(k * 0.025);
        scheduler.wake();
      }
    };
    const edit = (at: number, params: Record<string, unknown>) => {
      clock.set(at);
      patch = { ...patch, nodes: patch.nodes.map((n) => (n.id === 'f' ? { ...n, params: { ...n.params, ...params } } as typeof n : n)) };
      return scheduler.swap(compile(patch));
    };
    return { runtime, built, wakeTo, edit, clock };
  }

  it('ramps an opted-in param from the swap time without a new instance', () => {
    const run = live();
    run.wakeTo(0.5);
    const report = run.edit(0.49, { gain: 0.9 });
    expect(run.built.length).toBe(1);
    expect(report.updated).toEqual(['f']);
    expect(report.changed).toEqual(['f']);
    expect(report.cancelled).toBe(0);
    expect(report.time).toBeGreaterThanOrEqual(0.49);
    expect(run.built[0]!.updates).toEqual([[0.9, report.time]]);
    expect(run.built[0]!.gain.events).toEqual([{ kind: 'set', value: 0.5, time: report.time }, { kind: 'linear', value: 0.9, time: report.time + EDIT_RAMP }]);
  });

  it('re-automates a modulated param on the new base from the swap time, also when a rewind crosses the swap', () => {
    const run = live();
    run.wakeTo(0.5);
    const report = run.edit(0.49, { cutoff: 3 });
    // A live event between the edit and the swap time: its re-run replays the old plan, then the new one.
    const lift = 0.4925;
    expect(lift).toBeLessThan(report.time);
    run.runtime.push('src', 'set', set(lift, 1), { now: 0.49 });
    run.wakeTo(0.8);
    const b = run.built[0]!;
    expect(run.built.length).toBe(1);
    expect(report.updated).toEqual(['f']);
    const sine = (t: number) => 0.25 * Math.sin(2 * Math.PI * t);
    for (const e of onGrid(b.cutoff.events)) expect(e.value).toBeCloseTo(sine(e.time) + (e.time < report.time ? 1 : 3) + (e.time >= lift ? 1 : 0), 12);
    expect(onGrid(b.cutoff.events).map((e) => e.time)).toEqual(automationTimes(0, 0.8 + 0.12 - 0.025));
    // The re-runs began inside a ramp, which each kept up to its start (#103).
    for (const e of offGrid(b.cutoff.events)) expect([lift, report.time]).toContain(e.time);
  });

  it('keeps the ramp in progress up to the swap time when a knob turn changes a modulated param\'s base, so it never steps (#103)', () => {
    const run = live();
    run.wakeTo(0.5);
    const b = run.built[0]!;
    const course = (from: number, to: number) => Array.from({ length: Math.round((to - from) / 1e-4) }, (_, i) => b.cutoff.at(from + i * 1e-4));
    const played = course(0.45, 0.5);
    const report = run.edit(0.49, { cutoff: 3 });
    // Inside the ramp from 29/60 to 30/60, which the swap's re-run cancels.
    expect(report.time).toBeGreaterThan(29 / 60);
    expect(report.time).toBeLessThan(30 / 60);
    run.wakeTo(0.8);
    expect(run.built.length).toBe(1);
    // Up to the swap time the param runs as it did before the edit...
    const kept = course(0.45, 0.5);
    for (let i = 0; 0.45 + i * 1e-4 <= report.time; i++) expect(kept[i]).toBeCloseTo(played[i]!, 12);
    // ...then ramps to the new base by the next grid point, with no step on the way.
    expect(b.cutoff.at(0.5)).toBeCloseTo(0.25 * Math.sin(Math.PI) + 3, 12);
    const slope = 2 / (0.5 - report.time) + 2 * Math.PI * 0.25;
    expect(steepest(b.cutoff, 0.45, 0.6)).toBeLessThanOrEqual(slope * 1e-4 + 1e-9);

  });

  it('still rebuilds for a param it did not opt in, or without update()', () => {
    const run = live();
    run.wakeTo(0.5);
    const report = run.edit(0.49, { mode: 'highpass' });
    expect(run.built.length).toBe(2);
    expect(report.updated).toEqual([]);
    // A live param together with another one rebuilds too.
    expect(run.edit(0.6, { gain: 0.1, mode: 'lowpass' }).updated).toEqual([]);
    expect(run.built.length).toBe(3);

    const bare = live({ update: false });
    bare.wakeTo(0.5);
    expect(bare.edit(0.49, { gain: 0.9 }).updated).toEqual([]);
    expect(bare.built.length).toBe(2);

    // A live param whose edit resets the node's state: the instance holds the old state object, so it goes too.
    const reset = live({ keepState: false });
    reset.wakeTo(0.5);
    const resetReport = reset.edit(0.49, { gain: 0.9 });
    expect(resetReport.reset).toEqual(['f']);
    expect(resetReport.updated).toEqual([]);
    expect(reset.built.length).toBe(2);
  });
});

describe('editRamp', () => {
  it('holds, then ramps over EDIT_RAMP from the edit time', () => {
    const p = new FakeParam();
    p.value = 0.5;
    const ramp = editRamp(p, 0.5);
    ramp.set(1, 0.3);
    expect(p.at(0.29)).toBe(0.5);
    expect(p.at(0.3 + EDIT_RAMP / 2)).toBeCloseTo(0.75, 12);
    expect(p.at(0.5)).toBe(1);
    expect(ramp.valueAt(0.3 + EDIT_RAMP / 2)).toBeCloseTo(0.75, 12);
  });

  it('a second edit 10 ms into the first ramp continues from where the ramp got, with no step', () => {
    const p = new FakeParam();
    p.value = 0;
    const ramp = editRamp(p, 0);
    const T1 = 0.3, T2 = T1 + 0.01;
    ramp.set(1, T1);
    ramp.set(0.2, T2);
    // Halfway up the first ramp at T2, then on to 0.2 by T2 + EDIT_RAMP.
    expect(p.at(T2)).toBeCloseTo(0.5, 12);
    expect(p.at(T2 + EDIT_RAMP)).toBeCloseTo(0.2, 12);
    // Sampled every 0.1 ms across both ramps, the value never moves more than a ramp's slope allows.
    let worst = 0;
    for (let t = T1 - 0.005; t < T2 + EDIT_RAMP + 0.005; t += 1e-4) worst = Math.max(worst, Math.abs(p.at(t + 1e-4) - p.at(t)));
    expect(worst).toBeLessThanOrEqual((1 / EDIT_RAMP) * 1e-4 + 1e-9);
  });

  it('a second edit exactly as the first ramp ends restores its end, with no step', () => {
    const p = new FakeParam();
    p.value = 0;
    const ramp = editRamp(p, 0);
    const T1 = 0.3, T2 = 0.3 + EDIT_RAMP;
    ramp.set(1, T1);
    ramp.set(0.5, T2);
    expect(p.at(T2)).toBeCloseTo(1, 12);
    expect(p.at(T2 + EDIT_RAMP)).toBeCloseTo(0.5, 12);
    let worst = 0;
    for (let t = T1 - 0.005; t < T2 + EDIT_RAMP + 0.005; t += 1e-4) worst = Math.max(worst, Math.abs(p.at(t + 1e-4) - p.at(t)));
    expect(worst).toBeLessThanOrEqual((1 / EDIT_RAMP) * 1e-4 + 1e-9);
  });

  it('an edit before the previous one is taken at the previous one\'s time', () => {
    const p = new FakeParam();
    const ramp = editRamp(p, 0);
    ramp.set(1, 0.3);
    ramp.set(0.5, 0.25);
    expect(p.events).toEqual([{ kind: 'set', value: 0, time: 0.3 }, { kind: 'linear', value: 0.5, time: 0.3 + EDIT_RAMP }]);
  });

  it('two edits at the same time: the second replaces the first, which never started', () => {
    const p = new FakeParam();
    const ramp = editRamp(p, 0.4);
    ramp.set(1, 0.3);
    ramp.set(0.8, 0.3);
    expect(p.events).toEqual([{ kind: 'set', value: 0.4, time: 0.3 }, { kind: 'linear', value: 0.8, time: 0.3 + EDIT_RAMP }]);
  });
});
