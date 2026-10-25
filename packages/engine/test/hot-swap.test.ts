// Hot patching (design.md "Hot patching", ADR 0023): a new plan swaps in at the
// next window boundary at least SWAP_MARGIN past currentTime and re-runs the windows already
// queried from there; state carries over by node id; what removed or changed
// nodes had scheduled from then on is withdrawn; a rewind replays each window
// under the plan it ran under. The gate check itself (Clock → Euclidean →
// Probability → Make Note → Simple Synth, 100 edits) is tools/hot-swap.test.ts.
import { describe, expect, it } from 'vitest';
import {
  applyPatchEdits,
  compilePatch,
  limitWindowOf,
  ManualClock,
  NODE_EVENT_LIMIT,
  Runtime,
  Scheduler,
  type AudioContextLike,
  type AudioNodeLike,
  type EngineEvent,
  type LoggedEvent,
  type NodeDefinition,
  type Patch,
  type PatchEdit,
  type Plan,
  SWAP_MARGIN,
} from '../src';

/** Ticks every `period` seconds, from absolute time. */
const metro: NodeDefinition = {
  type: 'metro', version: 1, label: 'Metro', category: 'time-rhythm', description: '',
  ports: [{ name: 'out', type: 'event', direction: 'out' }],
  params: [{ name: 'period', kind: 'number', min: 0.001, max: 1, default: 0.025 }],
  query: ({ t0, t1, params }) => {
    const period = params.period as number;
    const out: EngineEvent[] = [];
    for (let k = Math.max(0, Math.ceil(t0 / period) - 1); k * period < t1; k++) if (k * period >= t0) out.push({ time: k * period, channel: 0 });
    return { out };
  },
};
/** Too many events for the cap: one every `period`. */
const dense: NodeDefinition = { ...metro, type: 'dense', params: [{ name: 'period', kind: 'number', min: 0.0001, max: 1, default: 0.0004 }] };
/** A canvas source stand-in: events only arrive through push. */
const tap: NodeDefinition = {
  type: 'tap', version: 1, label: 'Tap', category: 'canvas-sources', description: '',
  ports: [{ name: 'out', type: 'event', direction: 'out' }],
  params: [],
};
/** Stateful: adds `step` to a running count at every event, and emits the count. */
const counter: NodeDefinition = {
  type: 'counter', version: 1, label: 'Counter', category: 'control-logic', description: '',
  ports: [{ name: 'in', type: 'event', direction: 'in' }, { name: 'out', type: 'event', direction: 'out' }],
  params: [{ name: 'step', kind: 'number', min: 1, max: 100, default: 1 }],
  query: ({ inputs, state, params }) => {
    const step = params.step as number;
    return { out: (inputs.in ?? []).map((e) => ({ time: e.time, channel: e.channel, count: (state.count = ((state.count as number | undefined) ?? 0) + step) })) };
  },
};
/** A counter whose count means nothing under new params, so it starts over. */
const resetter: NodeDefinition = { ...counter, type: 'resetter', keepState: () => false };
const delay: NodeDefinition = {
  type: 'delay', version: 1, label: 'Delay', category: 'control-logic', description: '',
  ports: [{ name: 'in', type: 'event', direction: 'in' }, { name: 'out', type: 'event', direction: 'out' }],
  params: [{ name: 'time', kind: 'number', min: 0.01, max: 2, default: 0.03, modulatable: false }],
  delay: (params) => params.time as number,
  query: ({ inputs, params, state, t0, t1 }) => {
    const pending = [...((state.pending as EngineEvent[] | undefined) ?? []), ...(inputs.in ?? []).map((e) => ({ ...e, time: e.time + (params.time as number) }))];
    state.pending = pending.filter((e) => e.time >= t1);
    return { out: pending.filter((e) => e.time >= t0 && e.time < t1) };
  },
};

/** Everything the fake audio side saw: connections, deliveries and instance lifetimes. */
interface AudioLog {
  wires: string[];
  deliveries: { instance: number; event: EngineEvent; at: number; cancelledAt: number | null }[];
  disposed: { instance: number; at: number }[];
  built: number;
}
/** A voice that "sounds" each event for RING seconds after its time; `tone` only matters for rebuilds. */
const RING = 0.1;
function audioTypes(clock: ManualClock, log: AudioLog): NodeDefinition[] {
  const fake = (name: string): AudioNodeLike & { name: string } => ({
    name,
    connect(to) {
      log.wires.push(`${name}→${(to as unknown as { name: string }).name}`);
    },
    disconnect() {
      log.wires.push(`${name}×`);
    },
  });
  const voice: NodeDefinition = {
    type: 'voice', version: 1, label: 'Voice', category: 'instruments', description: '',
    ports: [{ name: 'in', type: 'event', direction: 'in' }, { name: 'out', type: 'audio', direction: 'out' }],
    params: [{ name: 'tone', kind: 'number', min: 0, max: 1, default: 0.5 }],
    audio: () => {
      const instance = ++log.built;
      const mine = () => log.deliveries.filter((d) => d.instance === instance && d.cancelledAt === null);
      return {
        outputs: { out: fake(`v${instance}`) },
        schedule: (_port, events) => void log.deliveries.push(...events.map((event) => ({ instance, event, at: clock.audio, cancelledAt: null }))),
        cancel: (_port, events) => {
          for (const event of events) {
            const d = log.deliveries.find((x) => x.instance === instance && x.event === event && x.cancelledAt === null);
            if (!d) throw new Error('cancelled an event that was never scheduled');
            if (event.time < clock.audio) throw new Error('cancelled an event that had already started');
            d.cancelledAt = clock.audio;
          }
        },
        idleAt: () => Math.max(0, ...mine().map((d) => d.event.time + RING)),
        dispose: () => void log.disposed.push({ instance, at: clock.audio }),
      };
    },
  };
  const sink: NodeDefinition = {
    type: 'sink', version: 1, label: 'Sink', category: 'effects-mix', description: '',
    ports: [{ name: 'in', type: 'audio', direction: 'in' }],
    params: [{ name: 'level', kind: 'number', min: 0, max: 1, default: 1 }],
    audio: () => {
      const instance = ++log.built;
      return { inputs: { in: fake(`s${instance}`) }, dispose: () => void log.disposed.push({ instance, at: clock.audio }) };
    },
  };
  return [voice, sink];
}

const node = (id: string, type: string, params = {}) => ({ id, type, typeVersion: 1, params, position: { x: 0, y: 0 } });
const cable = (a: string, b: string, from = 'out', to = 'in') => ({ from: { node: a, port: from }, to: { node: b, port: to } });
const patch = (nodes: Patch['nodes'], cables: Patch['cables']): Patch => ({ format: 'flowpatch', version: 1, seed: 1, nodes, cables });

function setup(initial: Patch) {
  const clock = new ManualClock();
  const audio: AudioLog = { wires: [], deliveries: [], disposed: [], built: 0 };
  const definitions = new Map([metro, dense, tap, counter, resetter, delay, ...audioTypes(clock, audio)].map((d) => [d.type, d]));
  const compile = (p: Patch): Plan => {
    const compiled = compilePatch(p, definitions);
    if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
    return compiled.plan;
  };
  const runtime = new Runtime(compile(initial));
  runtime.attachAudio({} as AudioContextLike);
  const scheduler = new Scheduler(runtime, { clock, record: true });
  let current = initial;
  /** Wakes every 25 ms on the grid, [from, to). */
  const wakeEvery = (from: number, to: number) => {
    for (let k = Math.round(from / 0.025); k * 0.025 < to - 1e-9; k++) {
      clock.set(k * 0.025);
      scheduler.wake();
    }
  };
  /** Applies edits at clock time `at` and swaps the result in. */
  const edit = (at: number, ...edits: PatchEdit[]) => {
    clock.set(at);
    current = applyPatchEdits(current, edits);
    return scheduler.swap(compile(current));
  };
  const push = (at: number, nodeId: string) => {
    clock.set(at);
    return scheduler.push(nodeId, 'out', { channel: 0 })!;
  };
  const of = (id: string, events = scheduler.events()) => events.filter((e) => e.node === id);
  return { clock, runtime, scheduler, audio, wakeEvery, edit, push, of };
}

const times = (events: readonly LoggedEvent[]) => events.map((e) => Math.round(e.time * 1e9) / 1e9);
const grid = (period: number, from: number, to: number) => {
  const out: number[] = [];
  for (let k = Math.ceil(from / period - 1e-9); k * period < to - 1e-12; k++) out.push(Math.round(k * period * 1e9) / 1e9 + 0);
  return out;
};

describe('hot swap', () => {
  it('takes effect at the first window boundary at or after now + SWAP_MARGIN, re-running the windows queried from there', () => {
    const run = setup(patch([node('m', 'metro', { period: 0.025 }), node('c', 'counter')], [cable('m', 'c')]));
    run.wakeEvery(0, 0.5);
    const report = run.edit(0.49, { op: 'set-param', node: 'm', param: 'period', value: 0.04 });
    run.wakeEvery(0.5, 1.2);

    // Windows end at wake + 120 ms: 0.47, 0.495, 0.52, …; the first at or after 0.49 + 15 ms starts at 0.52.
    // 0.495 is ahead of the clock, but not by the render lead (#97).
    expect(SWAP_MARGIN).toBe(0.015);
    expect(report.time).toBeCloseTo(0.52, 9);
    expect(report.windows).toBe(3);
    expect(report.changed).toEqual(['m']);
    expect([...report.affected].sort()).toEqual(['c', 'm']);
    const T = report.time, end = 1.175 + 0.12 - 0.025;
    const metroTimes = times(run.of('m')).filter((t) => t < end);
    expect(metroTimes).toEqual([...grid(0.025, 0, T), ...grid(0.04, T, end)]);
    // The counter kept its count across the swap: one more per event, none counted twice.
    expect(run.of('c').map((e) => e.count)).toEqual(run.of('c').map((_, i) => i + 1));
    expect(run.scheduler.stats.swaps).toBe(1);
  });

  it('drops a removed node from the swap on and withdraws what it had handed audio nodes', () => {
    const run = setup(patch([node('m', 'metro'), node('c', 'counter'), node('v', 'voice'), node('s', 'sink')], [cable('m', 'c'), cable('c', 'v'), cable('v', 's', 'out', 'in')]));
    run.wakeEvery(0, 0.5);
    const report = run.edit(0.487, { op: 'remove-node', node: 'c' });
    run.wakeEvery(0.5, 1);

    const T = report.time;
    expect(report.removed).toEqual(['c']);
    expect(report.replaced.has('c')).toBe(true);
    expect(report.withdrawn).toBeGreaterThan(0);
    const logged = run.of('c');
    expect(logged.length).toBeGreaterThan(10);
    expect(logged.every((e) => e.time < T)).toBe(true);
    // What the voice still plays is exactly what the log says the counter sent it.
    const playing = run.audio.deliveries.filter((d) => d.cancelledAt === null).map((d) => d.event.time);
    expect(playing).toEqual(logged.map((e) => e.time));
    const withdrawn = run.audio.deliveries.filter((d) => d.cancelledAt !== null);
    expect(withdrawn.length).toBe(report.withdrawn);
    expect(withdrawn.every((d) => d.event.time >= T)).toBe(true);
    // The voice lost its input cable, not its instance: still wired, never rebuilt.
    expect(run.audio.built).toBe(2);
    expect(run.audio.wires).toEqual(['v1→s2']);
  });

  it('keeps state for surviving ids, and starts added nodes and those whose definition says so afresh', () => {
    const run = setup(patch([node('m', 'metro', { period: 0.05 }), node('c', 'counter'), node('r', 'resetter'), node('x', 'counter')], [cable('m', 'c'), cable('m', 'r'), cable('m', 'x')]));
    run.wakeEvery(0, 0.5);
    const report = run.edit(0.49,
      { op: 'set-param', node: 'c', param: 'step', value: 10 },
      { op: 'set-param', node: 'r', param: 'step', value: 10 },
      { op: 'remove-node', node: 'x' },
      { op: 'add-node', node: node('x', 'resetter') },
      { op: 'add-cable', cable: cable('m', 'x') },
      { op: 'add-node', node: node('n', 'counter') },
      { op: 'add-cable', cable: cable('m', 'n') },
    );
    run.wakeEvery(0.5, 1);

    expect(report.added).toEqual(['n']);
    expect(report.removed).toEqual([]);
    expect(report.changed).toEqual(['c', 'r', 'x']);
    // x changed type under the same id; r's definition doesn't keep state on new params.
    expect(report.reset).toEqual(['r', 'x']);
    const T = report.time;
    const counts = (id: string, after: boolean) => run.of(id).filter((e) => (e.time >= T) === after).map((e) => e.count);
    const before = counts('c', false).length;
    expect(before).toBeGreaterThan(5);
    expect(counts('c', true)).toEqual(counts('c', true).map((_, i) => before + 10 * (i + 1)));
    expect(counts('r', true)).toEqual(counts('r', true).map((_, i) => 10 * (i + 1)));
    expect(counts('x', true)).toEqual(counts('x', true).map((_, i) => i + 1));
    expect(counts('n', false)).toEqual([]);
    expect(counts('n', true)).toEqual(counts('n', true).map((_, i) => i + 1));
    expect(run.runtime.stateOf('c')!.count).toBe(before + 10 * counts('c', true).length);
  });

  it('replays the old plan up to the swap and the new one from it when a live event rewinds to before it', () => {
    // c keeps its count across the swap; r's definition starts it over.
    const base = patch([node('m', 'metro', { period: 0.02 }), node('t', 'tap'), node('c', 'counter'), node('r', 'resetter')], [cable('m', 'c'), cable('t', 'c'), cable('m', 'r'), cable('t', 'r')]);
    const step = [{ op: 'set-param', node: 'c', param: 'step', value: 10 }, { op: 'set-param', node: 'r', param: 'step', value: 10 }] as const;
    // The swap first, then a tap whose time (now + 5 ms) is before the swap's boundary.
    const a = setup(base);
    a.wakeEvery(0, 0.47);
    const swap = a.edit(0.471, ...step);
    const tapped = a.push(0.472, 't');
    a.wakeEvery(0.475, 1);
    expect(tapped.time).toBeLessThan(swap.time);
    // The same edit and tap made the other way round, at the tap's moment: the same boundary.
    const b = setup(base);
    b.wakeEvery(0, 0.47);
    b.push(0.472, 't');
    expect(b.edit(0.472, ...step).time).toBe(swap.time);
    b.wakeEvery(0.475, 1);

    expect(JSON.stringify(a.scheduler.events())).toBe(JSON.stringify(b.scheduler.events()));
    // One per event before the boundary, the tap included; ten per event from it on.
    const counts = a.of('c').map((e) => e.count as number);
    const steps = counts.map((n, i) => n - (counts[i - 1] ?? 0));
    const firstNew = a.of('c').findIndex((e) => e.time >= swap.time);
    expect(steps.slice(0, firstNew).every((s) => s === 1)).toBe(true);
    expect(steps.slice(firstNew).every((s) => s === 10)).toBe(true);
    expect(a.of('c').some((e) => e.time === tapped.time)).toBe(true);
    // The resetter's count restarted at the boundary, though the re-run began before it.
    const reset = a.of('r').filter((e) => e.time >= swap.time).map((e) => e.count);
    expect(reset).toEqual(reset.map((_, i) => 10 * (i + 1)));
  });

  it('applies both swaps\' state changes when two land on one boundary and a rewind crosses it', () => {
    const run = setup(patch([node('m', 'metro', { period: 0.02 }), node('t', 'tap'), node('r', 'resetter')], [cable('m', 'r'), cable('t', 'r')]));
    run.wakeEvery(0, 0.47);
    // In one wake: add a counter, then change its step; change the resetter twice.
    const first = run.edit(0.471,
      { op: 'add-node', node: node('n', 'counter') }, { op: 'add-cable', cable: cable('m', 'n') }, { op: 'add-cable', cable: cable('t', 'n') },
      { op: 'set-param', node: 'r', param: 'step', value: 5 });
    const second = run.edit(0.4712, { op: 'set-param', node: 'n', param: 'step', value: 10 }, { op: 'set-param', node: 'r', param: 'step', value: 10 });
    expect(second.time).toBe(first.time);
    expect(second.reset).toEqual(['r']);
    // A tap before the boundary rewinds across both swaps.
    const tapped = run.push(0.472, 't');
    run.wakeEvery(0.475, 1);
    const T = first.time;
    expect(tapped.time).toBeLessThan(T);
    const from = (id: string) => run.of(id).filter((e) => e.time >= T).map((e) => e.count);
    // n didn't exist before T, so it starts empty there; r started over at the first swap.
    expect(from('n')).toEqual(from('n').map((_, i) => 10 * (i + 1)));
    expect(from('r')).toEqual(from('r').map((_, i) => 10 * (i + 1)));
    expect(run.of('n').every((e) => e.time >= T)).toBe(true);
  });

  it('applies both swaps\' state changes when two take effect at the horizon before the next query', () => {
    const definitions = new Map([metro, tap, counter, resetter].map((d) => [d.type, d]));
    const compile = (p: Patch) => {
      const compiled = compilePatch(p, definitions);
      if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
      return compiled.plan;
    };
    const nodes = (step: number, withN: boolean) => [node('m', 'metro', { period: 0.05 }), node('t', 'tap'), node('r', 'resetter', { step }), ...(withN ? [node('n', 'counter', { step })] : [])];
    const cables = (withN: boolean) => [cable('m', 'r'), cable('t', 'r'), ...(withN ? [cable('m', 'n'), cable('t', 'n')] : [])];
    const runtime = new Runtime(compile(patch(nodes(1, false), cables(false))), { history: true });
    runtime.query(0, 0.5);
    runtime.swap(compile(patch(nodes(5, true), cables(true))));
    runtime.swap(compile(patch(nodes(10, true), cables(true))));
    runtime.query(0.5, 1);
    const rewind = runtime.push('t', 'out', { time: 0.3, channel: 0 }, { now: 0.3 });
    const log = rewind!.added;
    const counts = (id: string) => log.filter((e) => e.node === id && e.time >= 0.5).map((e) => e.count);
    expect(counts('r')).toEqual(counts('r').map((_, i) => 10 * (i + 1)));
    expect(counts('n')).toEqual(counts('n').map((_, i) => 10 * (i + 1)));
    expect(counts('n').length).toBe(10);
  });

  it('carries a delay node and the inputs it holds across a swap, and drops them when it goes', () => {
    const run = setup(patch([node('m', 'metro', { period: 0.05 }), node('d', 'delay', { time: 0.03 }), node('c', 'counter')], [cable('m', 'd'), cable('d', 'c')]));
    run.wakeEvery(0, 0.5);
    const changed = run.edit(0.49, { op: 'set-param', node: 'm', param: 'period', value: 0.04 });
    run.wakeEvery(0.5, 1);
    const removed = run.edit(1.003, { op: 'remove-node', node: 'd' });
    run.wakeEvery(1.025, 1.5);

    expect(changed.affected.has('d')).toBe(true);
    // Every tick the metro logged before d went, delayed 30 ms, exactly once.
    const delayed = times(run.of('m').filter((e) => e.time + 0.03 < removed.time)).map((t) => Math.round((t + 0.03) * 1e9) / 1e9);
    expect(times(run.of('d'))).toEqual(delayed);
    expect(run.of('c').map((e) => e.count)).toEqual(delayed.map((_, i) => i + 1));
  });

  it('rebuilds an audio node whose params change and lets the old instance finish before disposing it', () => {
    const run = setup(patch([node('m', 'metro', { period: 0.05 }), node('v', 'voice'), node('s', 'sink')], [cable('m', 'v'), cable('v', 's', 'out', 'in')]));
    run.wakeEvery(0, 0.5);
    // An upstream change re-runs the voice but keeps its instance and wiring.
    const kept = run.edit(0.49, { op: 'set-param', node: 'm', param: 'period', value: 0.04 });
    expect(kept.cancelled).toBe(0);
    expect(run.audio.built).toBe(2);
    run.wakeEvery(0.5, 1);
    const rebuilt = run.edit(0.99, { op: 'set-param', node: 'v', param: 'tone', value: 0.9 });
    run.wakeEvery(1, 1.6);

    const T = rebuilt.time;
    expect(run.audio.built).toBe(3);
    const old = run.audio.deliveries.filter((d) => d.instance === 1), fresh = run.audio.deliveries.filter((d) => d.instance === 3);
    // The old voice keeps what it had before the swap and loses the rest; the new one plays from the swap on.
    const lost = old.filter((d) => d.cancelledAt === 0.99);
    expect(lost.every((d) => d.event.time >= T)).toBe(true);
    expect(old.filter((d) => d.cancelledAt === null).every((d) => d.event.time < T)).toBe(true);
    expect(rebuilt.cancelled).toBe(lost.length);
    expect(rebuilt.cancelled).toBeGreaterThan(0);
    const live = [...old, ...fresh].filter((d) => d.cancelledAt === null).map((d) => d.event.time);
    expect(live).toEqual(run.of('m').map((e) => e.time));
    expect(fresh.every((d) => d.event.time >= T)).toBe(true);
    // Disposed at the first wake past its last note's ring, still wired until then.
    const lastOld = Math.max(...old.filter((d) => d.cancelledAt === null).map((d) => d.event.time));
    const disposed = run.audio.disposed.find((d) => d.instance === 1)!;
    expect(disposed.at).toBeGreaterThanOrEqual(lastOld + RING);
    expect(disposed.at).toBeLessThan(lastOld + RING + 0.025 + 1e-9);
    expect(run.audio.wires).toEqual(['v1→s2', 'v3→s2']);
  });

  it('rewires audio cables: a new cable only connects, a removed one disconnects that output', () => {
    const run = setup(patch([node('m', 'metro'), node('v', 'voice'), node('s', 'sink'), node('s2', 'sink')], [cable('m', 'v'), cable('v', 's', 'out', 'in')]));
    run.wakeEvery(0, 0.2);
    run.edit(0.2, { op: 'add-cable', cable: cable('v', 's2', 'out', 'in') });
    run.edit(0.3, { op: 'remove-cable', from: { node: 'v', port: 'out' }, to: { node: 's', port: 'in' } });
    expect(run.audio.wires).toEqual(['v1→s2', 'v1→s3', 'v1×', 'v1→s3']);
  });

  it('counts a re-run node against the event cap from where the swap starts, mid limit window', () => {
    const run = setup(patch([node('d', 'dense')], []));
    run.wakeEvery(0, 0.5);
    // 0.495 is inside the limit window [0.48, 0.6).
    const report = run.edit(0.49, { op: 'set-param', node: 'd', param: 'period', value: 0.00041 });
    run.wakeEvery(0.5, 1);
    expect(report.time).toBeGreaterThan(0.48);
    const perSlice = new Map<number, number>();
    for (const e of run.of('d')) perSlice.set(limitWindowOf(e.time), (perSlice.get(limitWindowOf(e.time)) ?? 0) + 1);
    // Every whole limit window keeps exactly NODE_EVENT_LIMIT, the one the swap cuts included.
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((k) => perSlice.get(k))).toEqual(Array(8).fill(NODE_EVENT_LIMIT));
  });

  it('orders ties by the plan in force at their time, before and after a rewind', () => {
    // Plan 1 runs m, r, d, u; plan 2 drops r and adds u → d, so it runs m, u, d.
    // A tick every 10 ms, so one lands exactly on the swap's boundary, 0.47.
    const run = setup(patch([node('m', 'metro', { period: 0.01 }), node('r', 'counter'), node('d', 'counter'), node('u', 'counter')], [cable('m', 'r'), cable('m', 'd'), cable('m', 'u')]));
    run.wakeEvery(0, 0.46);
    // 0.455 + SWAP_MARGIN = 0.47.
    const report = run.edit(0.455, { op: 'remove-node', node: 'r' }, { op: 'add-cable', cable: cable('u', 'd') });
    const T = report.time;
    expect(T).toBeCloseTo(0.47, 12);
    expect(run.of('m').some((e) => e.time === T)).toBe(true);
    run.wakeEvery(0.5, 0.6);
    const at = (t: number) => run.scheduler.events().filter((e) => Math.abs(e.time - t) < 1e-9 && e.node !== 'm').map((e) => e.node);
    const before = 0.46, after = T;
    expect(at(before)).toEqual(['r', 'd', 'u']);
    // Out-of-scope u and re-run d both rank by plan 2 at that time.
    expect(at(after)).toEqual(['u', 'd', 'd']);
    expect(at(0.65)).toEqual(['u', 'd', 'd']);
    // A live event on u at 0.605 re-runs u and d from there, m not: the order at 0.65 stays.
    const rewind = run.push(0.6, 'u');
    expect(rewind.time).toBeLessThan(0.65);
    expect(at(0.65)).toEqual(['u', 'd', 'd']);
    run.wakeEvery(0.625, 1);
    expect(at(before)).toEqual(['r', 'd', 'u']);
    expect(at(after)).toEqual(['u', 'd', 'd']);
    expect(at(0.65)).toEqual(['u', 'd', 'd']);
  });

  it('never swaps before the plan it replaces, so swap times stay in order', () => {
    const definitions = new Map([metro, counter].map((d) => [d.type, d]));
    const compile = (p: Patch) => {
      const compiled = compilePatch(p, definitions);
      if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
      return compiled.plan;
    };
    const base = [node('m', 'metro', { period: 0.05 }), node('a', 'counter'), node('b', 'counter')];
    const runtime = new Runtime(compile(patch(base, [cable('m', 'a'), cable('m', 'b')])), { history: true });
    const log: LoggedEvent[] = [];
    for (let k = 0; k < 10; k++) log.push(...runtime.query(k / 10, (k + 1) / 10));
    // Without timing: at the horizon, 1.0. b → a puts b first, and n is added.
    const r1 = runtime.swap(compile(patch([...base, node('n', 'counter')], [cable('m', 'a'), cable('m', 'b'), cable('b', 'a'), cable('m', 'n')])));
    // With an earlier now: clamped to 1.0, so it replaces r1 there, keeps n new and restores a, b.
    const r2 = runtime.swap(compile(patch([...base, node('n', 'counter', { step: 10 })], [cable('m', 'a'), cable('m', 'b'), cable('m', 'n')])), { now: 0.55 });
    expect([r1.time, r2.time]).toEqual([1, 1]);
    expect(r2.windows).toBe(0);
    for (let k = 10; k < 12; k++) log.push(...runtime.query(k / 10, (k + 1) / 10));
    const nodesAt = (t: number) => runtime.sortLog([...log]).filter((e) => Math.abs(e.time - t) < 1e-9 && e.node !== 'm').map((e) => e.node);
    expect(nodesAt(0.65)).toEqual(['a', 'b']);
    expect(nodesAt(1.05)).toEqual(['a', 'b', 'n']);
    const n = log.filter((e) => e.node === 'n');
    expect(n[0]!.time).toBeCloseTo(1, 9);
    expect(n.map((e) => e.count)).toEqual(n.map((_, i) => 10 * (i + 1)));
  });

  it('keeps a node an earlier swap added when a later swap at a later horizon has nothing to do with it (no history)', () => {
    const definitions = new Map([metro, counter].map((d) => [d.type, d]));
    const compile = (p: Patch) => {
      const compiled = compilePatch(p, definitions);
      if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
      return compiled.plan;
    };
    const runtime = new Runtime(compile(patch([node('m', 'metro', { period: 0.05 })], [])));
    const log: LoggedEvent[] = [...runtime.query(0, 0.5)];
    runtime.swap(compile(patch([node('m', 'metro', { period: 0.05 }), node('n', 'counter')], [cable('m', 'n')])));
    log.push(...runtime.query(0.5, 1));
    // Unrelated: a second node, nothing to do with n.
    runtime.swap(compile(patch([node('m', 'metro', { period: 0.05 }), node('n', 'counter'), node('x', 'counter')], [cable('m', 'n'), cable('m', 'x')])));
    log.push(...runtime.query(1, 1.5));
    const counts = log.filter((e) => e.node === 'n').map((e) => e.count);
    expect(counts).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('does not take a swap at the oldest retained boundary for a second swap to the same boundary', () => {
    const definitions = new Map([metro, counter].map((d) => [d.type, d]));
    const compile = (p: Patch) => {
      const compiled = compilePatch(p, definitions);
      if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
      return compiled.plan;
    };
    const runtime = new Runtime(compile(patch([node('m', 'metro', { period: 0.05 })], [])), { history: true });
    for (let k = 0; k < 5; k++) runtime.query(k / 10, (k + 1) / 10);
    // n is added at the horizon, 0.5, and runs from there.
    runtime.swap(compile(patch([node('m', 'metro', { period: 0.05 }), node('n', 'counter')], [cable('m', 'n')])));
    for (let k = 5; k < 8; k++) runtime.query(k / 10, (k + 1) / 10);
    // Now 0.6 is both the swap's boundary (now + SWAP_MARGIN) and the oldest retained one.
    runtime.retain(0.6);
    const report = runtime.swap(compile(patch([node('m', 'metro', { period: 0.05 }), node('n', 'counter', { step: 10 })], [cable('m', 'n')])), { now: 0.6 - SWAP_MARGIN });
    expect(report.time).toBe(0.6);
    expect(report.reset).toEqual([]);
    // n counted 0.5 and 0.55 before the swap, then goes on in tens.
    expect(report.events.filter((e) => e.node === 'n').map((e) => e.count)).toEqual([12, 22, 32, 42]);
  });

  it('drops a removed delay node\'s held inputs when a rewind crosses two swaps on its boundary', () => {
    const run = setup(patch([node('m', 'metro', { period: 0.05 }), node('t', 'tap'), node('d', 'delay', { time: 0.03 }), node('c', 'counter')], [cable('t', 'd'), cable('d', 'c'), cable('m', 'c')]));
    run.wakeEvery(0, 0.47);
    const first = run.edit(0.471, { op: 'remove-node', node: 'd' });
    expect(run.edit(0.4712, { op: 'set-param', node: 'c', param: 'step', value: 10 }).time).toBe(first.time);
    // The tap reaches d in the window before the boundary; the replay then crosses into the plan without d.
    run.push(0.472, 't');
    run.wakeEvery(0.475, 0.7);
    const held = (run.runtime as unknown as { delayInputs: Map<string, unknown> }).delayInputs;
    expect(held.has('d')).toBe(false);
    expect(run.of('d')).toEqual([]);
  });

  it('swaps at the horizon without a clock, and at once before the first query', () => {
    const definitions = new Map([metro, counter].map((d) => [d.type, d]));
    const plan = (period: number) => {
      const compiled = compilePatch(patch([node('m', 'metro', { period })], []), definitions);
      if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
      return compiled.plan;
    };
    const fresh = new Runtime(plan(0.1));
    expect(fresh.swap(plan(0.2)).time).toBe(-Infinity);
    expect(times(fresh.query(0, 1))).toEqual(grid(0.2, 0, 1));

    const runtime = new Runtime(plan(0.1));
    expect(times(runtime.query(0, 0.5))).toEqual(grid(0.1, 0, 0.5));
    const report = runtime.swap(plan(0.25), { now: 0.1 });
    expect(report).toMatchObject({ time: 0.5, windows: 0, changed: ['m'] });
    expect(times(runtime.query(0.5, 1))).toEqual(grid(0.25, 0.5, 1));
  });

  it('drops live events on a removed node from the swap on', () => {
    const run = setup(patch([node('t', 'tap'), node('c', 'counter')], [cable('t', 'c')]));
    run.wakeEvery(0, 0.1);
    const kept = run.push(0.1, 't');
    // Past the horizon: held for the query that covers it.
    run.runtime.push('t', 'out', { time: 0.5, channel: 0 });
    run.wakeEvery(0.1, 0.2);
    run.edit(0.2, { op: 'remove-node', node: 't' }, { op: 'add-node', node: node('t', 'metro', { period: 1 }) }, { op: 'add-cable', cable: cable('t', 'c') });
    run.wakeEvery(0.2, 0.7);
    // The tap before the swap stays, the one at 0.5 went with its node; the metro that took the id
    // starts at the swap, so its first tick is at 1.
    expect(run.of('t').map((e) => e.time)).toEqual([kept.time]);
  });
});

// #118: an audio node's setup reads (value, signal, param in audio()) resolve their cables in
// the plan being swapped in, where a source the running plan lacks already exists. Once the
// swap is done, a kept instance reads the plan running the chunk, as before.
describe('audio setup reads across a swap', () => {
  /** A Clock stand-in: a Transport Value and a Signal, both from its bpm. */
  const tempo: NodeDefinition = {
    type: 'tempo', version: 1, label: 'Tempo', category: 'time-rhythm', description: '',
    ports: [{ name: 'transport', type: 'value', direction: 'out' }, { name: 'lfo', type: 'signal', direction: 'out' }],
    params: [{ name: 'bpm', kind: 'number', min: 20, max: 300, default: 120 }],
    query: () => ({}),
    value: ({ params }) => ({ bpm: params.bpm }),
    signal: ({ params }) => (params.bpm as number) / 1000,
  };
  type Reads = { transport: unknown; mod: number; time: number };
  /** A Delay stand-in that reads its Transport, a Signal input and a modulated param at setup and per chunk. */
  function echoType(log: { setup: Reads[]; chunks: [number, unknown][] }): NodeDefinition {
    return {
      type: 'echo', version: 1, label: 'Echo', category: 'effects-mix', description: '',
      ports: [
        { name: 'transport', type: 'value', direction: 'in' },
        { name: 'mod', type: 'signal', direction: 'in' },
        { name: 'out', type: 'audio', direction: 'out' },
      ],
      params: [{ name: 'time', kind: 'number', min: 0, max: 1, default: 0.25 }],
      audio: ({ value, signal, param }) => {
        log.setup.push({ transport: value('transport', 0), mod: signal('mod', 0), time: param('time', 0) });
        const out = { connect() {}, disconnect() {} };
        return { outputs: { out }, automate: (t0) => void log.chunks.push([t0, value('transport', t0)]) };
      },
    };
  }
  const wired = (bpm: number) => patch(
    [node('clock', 'tempo', { bpm }), node('echo', 'echo')],
    [cable('clock', 'echo', 'transport', 'transport'), cable('clock', 'echo', 'lfo', 'mod'), cable('clock', 'echo', 'lfo', 'time')],
  );
  function make() {
    const log = { setup: [] as Reads[], chunks: [] as [number, unknown][] };
    const definitions = new Map([tempo, echoType(log)].map((d) => [d.type, d]));
    const compile = (p: Patch): Plan => {
      const compiled = compilePatch(p, definitions);
      if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
      return compiled.plan;
    };
    return { log, compile };
  }

  // The real crash path: Delay audio() → transportTempo → value('transport'), cabled from a Clock.
  it('reads a source only the incoming plan has, as a fresh run of that plan does', () => {
    const { log, compile } = make();
    const runtime = new Runtime(compile(patch([node('echo', 'echo')], [])));
    runtime.attachAudio({} as AudioContextLike);
    runtime.query(0, 0.1);
    expect(() => runtime.swap(compile(wired(140)))).not.toThrow();
    runtime.query(0.1, 0.2);

    const reference = make();
    const fresh = new Runtime(reference.compile(wired(140)));
    fresh.attachAudio({} as AudioContextLike);
    expect(log.setup).toHaveLength(2);
    expect(log.setup[1]).toEqual(reference.log.setup[0]);
    expect(log.setup[1]).toMatchObject({ transport: { bpm: 140 }, mod: 0.14 });
    expect(log.setup[1]!.time).not.toBe(0.25);
    // The new instance reads the new clock once it runs, too.
    expect(log.chunks.filter(([t]) => t >= 0.1).every(([, v]) => (v as { bpm: number }).bpm === 140)).toBe(true);
  });

  it('keeps an instance whose cables did not change, and it reads the plan running each chunk', () => {
    const { log, compile } = make();
    const runtime = new Runtime(compile(wired(120)));
    runtime.attachAudio({} as AudioContextLike);
    runtime.query(0, 0.1);
    runtime.swap(compile(wired(150)));
    runtime.query(0.1, 0.2);
    expect(log.setup).toHaveLength(1);
    const before = log.chunks.filter(([t]) => t < 0.1), after = log.chunks.filter(([t]) => t >= 0.1);
    expect(before.length).toBeGreaterThan(0);
    expect(after.length).toBeGreaterThan(0);
    expect(before.every(([, v]) => (v as { bpm: number }).bpm === 120)).toBe(true);
    expect(after.every(([, v]) => (v as { bpm: number }).bpm === 150)).toBe(true);
  });
});
