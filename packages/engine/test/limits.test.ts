// Runtime limits (ADR 0011, M1 gate "Limits"): 256 events per node and 2,048
// per patch in each limit window, the excess dropped with a warning on the node.
import { describe, expect, it } from 'vitest';
import {
  compilePatch,
  LIMIT_WINDOW,
  limitWindowOf,
  LOOKAHEAD,
  ManualClock,
  NODE_EVENT_LIMIT,
  PATCH_EVENT_LIMIT,
  Runtime,
  Scheduler,
  type AudioContextLike,
  type EngineEvent,
  type LoggedEvent,
  type NodeDefinition,
  type NodeWarning,
  type Patch,
} from '../src';

/** `rate` events per limit window, evenly spaced, on channel 0; `split` sends every other one to `odd`. */
const flood: NodeDefinition = {
  type: 'flood', version: 1, label: 'Flood', category: 'control-logic', description: '',
  ports: [{ name: 'out', type: 'event', direction: 'out' }, { name: 'odd', type: 'event', direction: 'out' }],
  params: [
    { name: 'rate', kind: 'number', min: 0, max: 5000, default: 1000 },
    { name: 'split', kind: 'toggle', default: false },
  ],
  query: ({ t0, t1, params }) => {
    const perSecond = (params.rate as number) / LIMIT_WINDOW;
    const out: EngineEvent[] = [], odd: EngineEvent[] = [];
    for (let k = Math.max(0, Math.floor(t0 * perSecond) - 1); (k + 0.5) / perSecond < t1; k++) {
      const time = (k + 0.5) / perSecond;
      if (time >= t0) (params.split && k % 2 ? odd : out).push({ time, channel: 0, k });
    }
    return { out, odd };
  },
};
const pass: NodeDefinition = {
  type: 'pass', version: 1, label: 'Pass', category: 'control-logic', description: '',
  ports: [{ name: 'in', type: 'event', direction: 'in' }, { name: 'out', type: 'event', direction: 'out' }],
  params: [],
  query: ({ inputs }) => ({ out: [...(inputs.in ?? [])] }),
};
/** Counts what it has passed in its state, so a rewind has state to restore. */
const counter: NodeDefinition = {
  type: 'counter', version: 1, label: 'Counter', category: 'control-logic', description: '',
  ports: [{ name: 'in', type: 'event', direction: 'in' }, { name: 'out', type: 'event', direction: 'out' }],
  params: [],
  query: ({ inputs, state }) => ({
    out: (inputs.in ?? []).map((e) => ({ ...e, n: (state.n = ((state.n as number | undefined) ?? 0) + 1) })),
  }),
};
const tap: NodeDefinition = {
  type: 'tap', version: 1, label: 'Tap', category: 'canvas-sources', description: '',
  ports: [{ name: 'out', type: 'event', direction: 'out' }],
  params: [],
};
const definitions = new Map([flood, pass, counter, tap].map((d) => [d.type, d]));

const node = (id: string, type: string, params = {}) => ({ id, type, typeVersion: 1, params, position: { x: 0, y: 0 } });
const cable = (a: string, b: string, from = 'out', to = 'in') => ({ from: { node: a, port: from }, to: { node: b, port: to } });
const patch = (nodes: Patch['nodes'], cables: Patch['cables'] = []): Patch => ({ format: 'flowpatch', version: 1, seed: 1, nodes, cables });

function runtimeFor(p: Patch, history = false) {
  const result = compilePatch(p, definitions);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  const runtime = new Runtime(result.plan, { history });
  const raised: NodeWarning[] = [];
  runtime.onWarning = (_message, warning) => raised.push(warning);
  return { runtime, raised };
}

/** Queries [0, seconds) in `step`-second windows, computed by index so every run tiles time alike. */
function queryAll(runtime: Runtime, seconds: number, step: number): LoggedEvent[] {
  const log: LoggedEvent[] = [];
  const n = Math.ceil(seconds / step - 1e-9);
  for (let i = 0; i < n; i++) log.push(...runtime.query(i * step, i === n - 1 ? seconds : (i + 1) * step));
  return runtime.sortLog(log);
}

const perWindow = (log: LoggedEvent[], id: string) => {
  const counts: Record<number, number> = {};
  for (const e of log) if (e.node === id) counts[limitWindowOf(e.time)] = (counts[limitWindowOf(e.time)] ?? 0) + 1;
  return counts;
};

describe('event limits', () => {
  it('uses the scheduler lookahead as its window', () => {
    expect(LIMIT_WINDOW).toBe(LOOKAHEAD);
    expect([NODE_EVENT_LIMIT, PATCH_EVENT_LIMIT]).toEqual([256, 2048]);
  });

  // M1 gate: Limits (node).
  it('caps a node emitting 1,000 events per window at 256, keeping the earliest, with a warning on the node', () => {
    const { runtime, raised } = runtimeFor(patch([node('f', 'flood', { rate: 1000 })]));
    const log = runtime.query(0, LIMIT_WINDOW);
    expect(log).toHaveLength(NODE_EVENT_LIMIT);
    expect(log.map((e) => e.k)).toEqual([...Array(NODE_EVENT_LIMIT).keys()]);
    expect(runtime.counters).toMatchObject({ droppedNodeLimit: 1000 - NODE_EVENT_LIMIT, droppedPatchLimit: 0 });
    const [warning] = runtime.warnings('f');
    expect(warning).toMatchObject({ node: 'f', kind: 'node-event-limit', count: 1000 - NODE_EVENT_LIMIT });
    expect(warning!.message).toMatch(/node "f" emitted more than 256 events in a 120 ms window/);
    expect(warning!.time).toBeCloseTo(999.5 * LIMIT_WINDOW / 1000, 9);
    // The host hears about it once, however many events drop.
    expect(raised.map((w) => w.kind)).toEqual(['node-event-limit']);
    runtime.query(LIMIT_WINDOW, 2 * LIMIT_WINDOW);
    expect(raised).toHaveLength(1);
    expect(runtime.warnings('f')[0]!.count).toBe(2 * (1000 - NODE_EVENT_LIMIT));
  });

  it('leaves a node under the cap alone, and raises no warning', () => {
    const { runtime, raised } = runtimeFor(patch([node('f', 'flood', { rate: NODE_EVENT_LIMIT })]));
    expect(queryAll(runtime, 1.2, 0.025)).toHaveLength(10 * NODE_EVENT_LIMIT);
    expect(runtime.warnings()).toEqual([]);
    expect(raised).toEqual([]);
    expect(runtime.counters.droppedNodeLimit).toBe(0);
  });

  it('counts every output port of a node together, earliest first', () => {
    const { runtime } = runtimeFor(patch([node('f', 'flood', { rate: 400, split: true })]));
    const log = runtime.query(0, LIMIT_WINDOW);
    expect(log).toHaveLength(NODE_EVENT_LIMIT);
    expect(log.map((e) => e.k)).toEqual([...Array(NODE_EVENT_LIMIT).keys()]);
    expect(log.filter((e) => e.port === 'odd')).toHaveLength(NODE_EVENT_LIMIT / 2);
  });

  it('drops the same events in 25 ms, 100 ms, 17.3 ms windows and one call, downstream too', () => {
    const p = patch([node('f', 'flood', { rate: 1000 }), node('g', 'flood', { rate: 180 }), node('c', 'counter')], [cable('f', 'c'), cable('g', 'c')]);
    const logs = [0.025, 0.1, 0.0173, 3].map((step) => {
      const { runtime } = runtimeFor(p);
      return { log: JSON.stringify(queryAll(runtime, 3, step)), counters: runtime.counters, warnings: runtime.warnings() };
    });
    for (const { log, counters, warnings } of logs.slice(1)) {
      expect(log).toBe(logs[0]!.log);
      expect(counters.droppedNodeLimit).toBe(logs[0]!.counters.droppedNodeLimit);
      expect(warnings).toEqual(logs[0]!.warnings);
    }
    const log = JSON.parse(logs[0]!.log) as LoggedEvent[];
    // f is capped to 256 per window; c gets those plus g's 180, and is capped to 256 again.
    expect(Object.values(perWindow(log, 'f'))).toEqual(Array(25).fill(NODE_EVENT_LIMIT));
    expect(Object.values(perWindow(log, 'c'))).toEqual(Array(25).fill(NODE_EVENT_LIMIT));
    expect(logs[0]!.warnings.map((w) => [w.node, w.kind])).toEqual([['f', 'node-event-limit'], ['c', 'node-event-limit']]);
  });

  // M1 gate: Limits (patch).
  it('caps the patch at 2,048 per window, in plan order, with a warning on each node that lost events', () => {
    const ids = [...Array(10).keys()].map((i) => `f${i}`);
    const { runtime, raised } = runtimeFor(patch(ids.map((id) => node(id, 'flood', { rate: 300 }))));
    const log = runtime.query(0, LIMIT_WINDOW);
    expect(log).toHaveLength(PATCH_EVENT_LIMIT);
    const counts = ids.map((id) => log.filter((e) => e.node === id).length);
    expect(counts).toEqual([256, 256, 256, 256, 256, 256, 256, 256, 0, 0]);
    expect(runtime.counters).toMatchObject({ droppedNodeLimit: 10 * (300 - 256), droppedPatchLimit: 2 * 256 });
    expect(runtime.warnings('f8').map((w) => [w.kind, w.count])).toEqual([['node-event-limit', 44], ['patch-event-limit', 256]]);
    expect(runtime.warnings('f8')[1]!.message).toMatch(/the patch emitted more than 2048 events in a 120 ms window; node "f8" lost events/);
    expect(raised.filter((w) => w.kind === 'patch-event-limit').map((w) => w.node)).toEqual(['f8', 'f9']);
  });

  it('never keeps more than 2,048 per window, whatever the windowing', () => {
    const ids = [...Array(12).keys()].map((i) => `f${i}`);
    const p = patch(ids.map((id, i) => node(id, 'flood', { rate: 150 + 20 * i })));
    for (const step of [0.025, 0.1, 1]) {
      const { runtime } = runtimeFor(p);
      const log = queryAll(runtime, 1.2, step);
      const all: Record<number, number> = {};
      for (const e of log) all[limitWindowOf(e.time)] = (all[limitWindowOf(e.time)] ?? 0) + 1;
      expect(Object.values(all), `${step} s windows`).toEqual(Array(10).fill(PATCH_EVENT_LIMIT));
      expect(runtime.counters.droppedPatchLimit).toBeGreaterThan(0);
    }
  });

  it('clears warnings on request and raises them again if the node keeps flooding', () => {
    const { runtime, raised } = runtimeFor(patch([node('f', 'flood', { rate: 1000 }), node('q', 'flood', { rate: 10 })]));
    const v0 = runtime.warningsVersion;
    runtime.query(0, LIMIT_WINDOW);
    const v1 = runtime.warningsVersion;
    expect(v1).toBeGreaterThan(v0);
    expect(runtime.warnings().map((w) => w.node)).toEqual(['f']);
    expect(runtime.warnings('q')).toEqual([]);
    // Copies: changing one changes nothing in the runtime.
    runtime.warnings('f')[0]!.count = -1;
    expect(runtime.warnings('f')[0]!.count).toBe(744);
    runtime.clearWarnings('q');
    expect(runtime.warningsVersion).toBe(v1);
    runtime.clearWarnings('f');
    expect(runtime.warningsVersion).toBeGreaterThan(v1);
    expect(runtime.warnings()).toEqual([]);
    runtime.query(LIMIT_WINDOW, 2 * LIMIT_WINDOW);
    expect(runtime.warnings('f')[0]!.count).toBe(744);
    expect(raised).toHaveLength(2);
    runtime.clearWarnings();
    expect(runtime.warnings()).toEqual([]);
  });
});

describe('event limits under rewind', () => {
  // A flood under the cap and a tap merged into a counter: live taps push the counter over 256.
  const p = patch(
    [node('f', 'flood', { rate: 250 }), node('t', 'tap'), node('c', 'counter')],
    [cable('f', 'c'), cable('t', 'c')],
  );
  const taps = [0.013, 0.031, 0.0312, 0.05, 0.051, 0.052, 0.07, 0.15, 0.16, 0.17, 0.18, 0.19, 0.2, 0.21];

  /** Every tap known before any query, so nothing rewinds. */
  function reference(step: number) {
    const { runtime } = runtimeFor(p, true);
    for (const [i, time] of taps.entries()) runtime.push('t', 'out', { time, channel: 1, tap: i });
    return { log: JSON.stringify(queryAll(runtime, 0.48, step)), runtime };
  }

  /** Taps pushed while the windows run, each into a window already queried, with lookahead `ahead`. */
  function live(step: number, ahead: number) {
    const { runtime } = runtimeFor(p, true);
    const log: LoggedEvent[] = [];
    let rewinds = 0, next = 0;
    const n = Math.round(0.48 / step);
    for (let i = 0; i < n; i++) {
      const now = i * step;
      // Taps stamped just after now, into the stretch already queried ahead.
      while (next < taps.length && taps[next]! < now + step) {
        const report = runtime.push('t', 'out', { time: taps[next]!, channel: 1, tap: next });
        if (report) {
          rewinds++;
          const kept = log.filter((e) => !(report.affected.has(e.node) && e.time >= report.time));
          log.length = 0;
          log.push(...kept, ...report.added);
        }
        next++;
      }
      const t0 = runtime.horizon ?? 0, t1 = Math.min(0.48, now + ahead);
      if (t1 > t0) log.push(...runtime.query(t0, t1));
    }
    return { log: JSON.stringify(runtime.sortLog(log)), runtime, rewinds };
  }

  it('drops the same events as when the live events were known in advance, and counts each drop once', () => {
    const ref = reference(0.025);
    const refLog = JSON.parse(ref.log) as LoggedEvent[];
    // The taps push c over the cap: its latest events in those windows drop.
    expect(Object.values(perWindow(refLog, 'c'))).toEqual([256, 256, 250, 250]);
    expect(ref.runtime.counters.droppedNodeLimit).toBe(taps.length - 12);
    for (const [step, ahead] of [[0.025, 0.12], [0.01, 0.06], [0.04, 0.2]] as const) {
      const run = live(step, ahead);
      expect(run.rewinds, `${step}/${ahead}`).toBeGreaterThan(0);
      expect(run.log, `${step}/${ahead}`).toBe(ref.log);
      expect(run.runtime.counters.droppedNodeLimit, `${step}/${ahead}`).toBe(ref.runtime.counters.droppedNodeLimit);
      expect(run.runtime.warnings(), `${step}/${ahead}`).toEqual(ref.runtime.warnings());
    }
  });

  it('counts a drop a re-run makes again only once, and the host hears about it once', () => {
    const { runtime, raised } = runtimeFor(p, true);
    runtime.query(0, 0.1);
    // c has 250 of f's events in [0, 0.12) and a tap per push: the 7th tap is one too many, the 8th two.
    for (let i = 0; i < 8; i++) runtime.push('t', 'out', { time: 0.01 + i * 0.001, channel: 1, tap: i });
    runtime.query(0.1, 0.12);
    expect(runtime.counters.droppedNodeLimit).toBe(2);
    expect(runtime.warnings('c').map((w) => [w.kind, w.count])).toEqual([['node-event-limit', 2]]);
    expect(raised).toHaveLength(1);
  });

  it('takes a warning back when a re-run no longer drops anything', () => {
    /** Passes its input until a `mute` event, then nothing. */
    const mute: NodeDefinition = {
      type: 'mute', version: 1, label: 'Mute', category: 'control-logic', description: '',
      ports: [{ name: 'in', type: 'event', direction: 'in' }, { name: 'mute', type: 'event', direction: 'in' }, { name: 'out', type: 'event', direction: 'out' }],
      params: [],
      query: ({ inputs, state }) => {
        const at = Math.min((state.at as number | undefined) ?? Infinity, ...(inputs.mute ?? []).map((e) => e.time));
        if (Number.isFinite(at)) state.at = at;
        return { out: (inputs.in ?? []).filter((e) => e.time < at) };
      },
    };
    const result = compilePatch(
      patch([node('a', 'flood', { rate: 200 }), node('b', 'flood', { rate: 200 }), node('t', 'tap'), node('m', 'mute')], [cable('a', 'm'), cable('b', 'm'), cable('t', 'm', 'out', 'mute')]),
      new Map([...definitions, [mute.type, mute]]),
    );
    if (!result.ok) throw new Error(result.errors.join('\n'));
    const runtime = new Runtime(result.plan, { history: true });
    runtime.query(0, LIMIT_WINDOW);
    expect(runtime.warnings('m').map((w) => [w.kind, w.count])).toEqual([['node-event-limit', 400 - 256]]);
    const version = runtime.warningsVersion;
    const report = runtime.push('t', 'out', { time: 0.01, channel: 0 })!;
    expect(report.added.filter((e) => e.node === 'm').length).toBe(0);
    expect(runtime.warnings()).toEqual([]);
    expect(runtime.counters.droppedNodeLimit).toBe(0);
    expect(runtime.warningsVersion).toBeGreaterThan(version);
  });
});

describe('limit windows', () => {
  it('puts an event exactly on an edge in the window it starts, at every edge', () => {
    expect(limitWindowOf(11 * LIMIT_WINDOW)).toBe(11);
    for (let k = 0; k < 100_000; k++) {
      expect(limitWindowOf(k * LIMIT_WINDOW)).toBe(k);
      expect(limitWindowOf((k + 1) * LIMIT_WINDOW - 1e-9)).toBe(k);
    }
    expect(limitWindowOf(-LIMIT_WINDOW / 2)).toBe(-1);
  });
});

/** Passes `in` through and ignores `ctl`: a live event into `ctl` rewinds it without changing what it emits. */
const ignore: NodeDefinition = {
  type: 'ignore', version: 1, label: 'Ignore', category: 'control-logic', description: '',
  ports: [{ name: 'in', type: 'event', direction: 'in' }, { name: 'ctl', type: 'event', direction: 'in' }, { name: 'out', type: 'event', direction: 'out' }],
  params: [],
  query: ({ inputs }) => ({ out: [...(inputs.in ?? [])] }),
};
/** Passes its input until a `mute` event, then nothing. */
const mute: NodeDefinition = {
  type: 'mute', version: 1, label: 'Mute', category: 'control-logic', description: '',
  ports: [{ name: 'in', type: 'event', direction: 'in' }, { name: 'mute', type: 'event', direction: 'in' }, { name: 'out', type: 'event', direction: 'out' }],
  params: [],
  query: ({ inputs, state }) => {
    const at = Math.min((state.at as number | undefined) ?? Infinity, ...(inputs.mute ?? []).map((e) => e.time));
    if (Number.isFinite(at)) state.at = at;
    return { out: (inputs.in ?? []).filter((e) => e.time < at) };
  },
};
/** Records what audio is handed, net of cancels. */
function recorder(heard: EngineEvent[]): NodeDefinition {
  return {
    type: 'recorder', version: 1, label: 'Recorder', category: 'instruments', description: '',
    ports: [{ name: 'in', type: 'event', direction: 'in' }],
    params: [],
    audio: () => ({
      schedule: (_port, events) => void heard.push(...events),
      cancel: (_port, events) => {
        for (const event of events) heard.splice(heard.indexOf(event), 1);
      },
    }),
  };
}

function build(p: Patch, extra: NodeDefinition[] = []) {
  const result = compilePatch(p, new Map([...definitions, ...[ignore, mute, ...extra].map((d) => [d.type, d] as const)]));
  if (!result.ok) throw new Error(result.errors.join('\n'));
  const runtime = new Runtime(result.plan, { history: true });
  const raised: NodeWarning[] = [];
  runtime.onWarning = (_message, warning) => raised.push(warning);
  return { runtime, raised };
}

describe('warnings across dismiss and rewind', () => {
  const floods = [node('a', 'flood', { rate: 200 }), node('b', 'flood', { rate: 200 }), node('t', 'tap')];

  it('never goes negative when a rewind takes back drops counted on a dismissed warning', () => {
    const { runtime, raised } = build(patch([...floods, node('m', 'mute')], [cable('a', 'm'), cable('b', 'm'), cable('t', 'm', 'out', 'mute')]));
    runtime.query(0, LIMIT_WINDOW);
    expect(runtime.warnings('m')[0]!.count).toBe(144);
    runtime.clearWarnings('m');
    runtime.query(LIMIT_WINDOW, 2 * LIMIT_WINDOW);
    expect(runtime.warnings('m').map((w) => w.count)).toEqual([144]);
    // A mute before every drop: the re-run drops nothing, in either window.
    runtime.push('t', 'out', { time: 0.01, channel: 0 });
    expect(runtime.warnings()).toEqual([]);
    expect(runtime.counters.droppedNodeLimit).toBe(0);
    expect(raised).toHaveLength(2);
  });

  it('does not raise a dismissed warning again when a re-run makes the same drops', () => {
    const { runtime, raised } = build(patch([...floods, node('i', 'ignore')], [cable('a', 'i'), cable('b', 'i'), cable('t', 'i', 'out', 'ctl')]));
    runtime.query(0, LIMIT_WINDOW);
    expect(raised).toHaveLength(1);
    runtime.clearWarnings();
    runtime.push('t', 'out', { time: 0.01, channel: 0 });
    expect(runtime.warnings()).toEqual([]);
    expect(raised).toHaveLength(1);
    expect(runtime.counters.droppedNodeLimit).toBe(144);
    // New drops still raise it.
    runtime.query(LIMIT_WINDOW, 2 * LIMIT_WINDOW);
    expect(runtime.warnings('i').map((w) => w.count)).toEqual([144]);
    expect(raised).toHaveLength(2);
  });

  it('moves the warning time back when a rewind takes the latest drops back', () => {
    const { runtime } = build(patch([...floods, node('m', 'mute')], [cable('a', 'm'), cable('b', 'm'), cable('t', 'm', 'out', 'mute')]));
    runtime.query(0, 0.24);
    const before = runtime.warnings('m')[0]!;
    expect(limitWindowOf(before.time)).toBe(1);
    // Muting in the second window takes back its drops; the first window's stay, and the time is theirs.
    runtime.push('t', 'out', { time: 0.125, channel: 0 });
    const after = runtime.warnings('m')[0]!;
    expect(after.count).toBe(144);
    expect(limitWindowOf(after.time)).toBe(0);
    expect(after.time).toBeLessThan(LIMIT_WINDOW);
  });
});

describe('event limits with audio, retain and catch-up', () => {
  const capped = (rate: number) => patch([node('f', 'flood', { rate }), node('t', 'tap'), node('c', 'counter'), node('r', 'recorder')], [cable('f', 'c'), cable('t', 'c'), cable('c', 'r')]);
  const taps = [0.26, 0.27, 0.28, 0.29, 0.305, 0.31, 0.315, 0.32];

  it('rewinds into a window starting mid-slice after retain(), with counts restored from it', () => {
    const run = (live: boolean) => {
      const heard: EngineEvent[] = [];
      const { runtime } = build(capped(250), [recorder(heard)]);
      runtime.attachAudio({} as AudioContextLike);
      const early = live ? taps.slice(0, 4) : taps;
      for (const [i, time] of early.entries()) runtime.push('t', 'out', { time, channel: 1, tap: i });
      const log: LoggedEvent[] = [];
      for (let i = 0; i < 10; i++) log.push(...runtime.query(i * 0.05, (i + 1) * 0.05));
      if (live) {
        // Keep from the window at 0.3, mid-way through the slice [0.24, 0.36); the next query prunes older counts.
        runtime.retain(0.31);
        log.push(...runtime.query(0.5, 0.55));
        expect(() => runtime.push('t', 'out', { time: 0.29, channel: 1 })).toThrow(/oldest retained window/);
        for (const [i, time] of taps.slice(4).entries()) {
          const report = runtime.push('t', 'out', { time, channel: 1, tap: i + 4 })!;
          expect(report.from).toBe(6 * 0.05);
          const kept = log.filter((e) => !(report.affected.has(e.node) && e.time >= report.time));
          log.length = 0;
          log.push(...kept, ...report.added);
        }
      } else log.push(...runtime.query(0.5, 0.55));
      return { log: JSON.stringify(runtime.sortLog(log)), runtime, heard };
    };
    const reference = run(false), live = run(true);
    expect(live.log).toBe(reference.log);
    expect(live.runtime.counters.droppedNodeLimit).toBe(taps.length - 6);
    expect(live.runtime.counters.droppedNodeLimit).toBe(reference.runtime.counters.droppedNodeLimit);
    expect(live.runtime.warnings()).toEqual(reference.runtime.warnings());
  });

  it('never hands a dropped event to audio, in a rewind\'s re-run too', () => {
    const heard: EngineEvent[] = [];
    const { runtime } = build(capped(250), [recorder(heard)]);
    runtime.attachAudio({} as AudioContextLike);
    const log: LoggedEvent[] = [];
    for (let i = 0; i < 4; i++) log.push(...runtime.query(i * LIMIT_WINDOW, (i + 1) * LIMIT_WINDOW));
    for (const [i, time] of taps.entries()) {
      const report = runtime.push('t', 'out', { time, channel: 1, tap: i })!;
      const kept = log.filter((e) => !(report.affected.has(e.node) && e.time >= report.time));
      log.length = 0;
      log.push(...kept, ...report.added);
    }
    expect(runtime.counters.droppedNodeLimit).toBe(taps.length - 6);
    const fromC = runtime.sortLog(log).filter((e) => e.node === 'c');
    expect(Object.values(perWindow(fromC, 'c'))).toEqual([250, 250, 256, 250]);
    // Audio heard exactly what c kept: same events, nothing dropped slipped through.
    const key = (e: EngineEvent) => `${e.time}/${e.channel}/${e.n}`;
    expect(heard.map(key).sort()).toEqual(fromC.map(key).sort());
  });

  it('drops the same events when a late wake catches up', () => {
    const run = (late: boolean) => {
      const heard: EngineEvent[] = [];
      const result = compilePatch(patch([node('f', 'flood', { rate: 1000 }), node('r', 'recorder')], [cable('f', 'r')]), new Map([flood, recorder(heard)].map((d) => [d.type, d])));
      if (!result.ok) throw new Error(result.errors.join('\n'));
      const runtime = new Runtime(result.plan);
      runtime.attachAudio({} as AudioContextLike);
      const clock = new ManualClock();
      const scheduler = new Scheduler(runtime, { clock, record: true });
      for (let i = 0; i < 40; i++) {
        // Six wakes missed: the next is 55 ms past the horizon, within the catch-up limit, so its missed stretch plays late.
        if (late && i >= 10 && i < 16) continue;
        clock.set(i * 0.025);
        scheduler.wake();
      }
      return { log: JSON.stringify(scheduler.events()), stats: scheduler.stats, heard };
    };
    const onTime = run(false), late = run(true);
    expect(late.stats.catchUps).toBeGreaterThan(0);
    expect(late.stats.caughtUp).toBeGreaterThan(0);
    expect(late.log).toBe(onTime.log);
    expect(late.stats.droppedNodeLimit).toBe(onTime.stats.droppedNodeLimit);
    expect(late.heard).toHaveLength(onTime.heard.length);
    expect(late.heard.map((e) => e.k)).toEqual(onTime.heard.map((e) => e.k));
  });
});
