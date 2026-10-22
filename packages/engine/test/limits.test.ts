// Runtime limits (ADR 0011, M1 gate "Limits"): 256 events per node and 2,048
// per patch in each limit window, the excess dropped with a warning on the node.
import { describe, expect, it } from 'vitest';
import {
  compilePatch,
  LIMIT_WINDOW,
  limitWindowOf,
  LOOKAHEAD,
  NODE_EVENT_LIMIT,
  PATCH_EVENT_LIMIT,
  Runtime,
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
