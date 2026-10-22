// M1 gate check "Window independence": querying 0–10 s in 25 ms steps, in
// 100 ms steps and in one call gives identical events. `windowLogs` runs one
// node type through the real Runtime that way. Event and Note inputs are fed
// an irregular two-channel stream and Signal inputs a smooth per-channel
// signal, so transformers and adapters are covered as well as generators.
// Signal and Value outputs are read by a probe at irregular event times.
// History is on, so every window boundary also snapshots the node's state:
// state that isn't plain data (ADR 0019) throws here.
//
// `rewindLogs` checks rewind and re-query: it pushes live events into the
// node's Event inputs through the real Scheduler under several wake timings,
// and compares with a run where every push lands past the horizon, as if the
// events were known in advance.
//
// Neither feeds Value inputs or param modulation: those stay unconnected, so
// nodes see their knob values and `value()` returns undefined.
import { compilePatch, ManualClock, Runtime, Scheduler, type EngineEvent, type NodeDefinition, type Patch, type SchedulerOptions } from '@flow-patcher/engine';

export const WINDOW_STEPS = [0.025, 0.1] as const;
export const WINDOW_SECONDS = 10;

/** Pure: notes on two channels at irregular times, a few sharing a time. */
const feed: NodeDefinition = {
  type: 'window-test-feed', version: 1, label: 'Feed', category: 'control-logic', description: '',
  ports: [{ name: 'out', type: 'note', direction: 'out' }],
  params: [],
  query: ({ t0, t1 }) => {
    const out: EngineEvent[] = [];
    // 13 per second, nudged off any regular grid, plus a channel-1 echo on every third.
    for (let k = Math.max(0, Math.floor(t0 * 13) - 1); k / 13 < t1 + 1; k++) {
      const time = k / 13 + 0.004 * ((k * 7) % 5);
      const note = { pitch: 48 + ((k * 5) % 24), velocity: 0.2 + ((k * 3) % 7) / 10, duration: 0.05 + (k % 4) * 0.1 };
      if (time >= t0 && time < t1) out.push({ time, channel: 0, index: k, ...note });
      if (k % 3 === 0 && time >= t0 && time < t1) out.push({ time, channel: 1, index: k, ...note });
    }
    return { out };
  },
};

/** Pure: a slow wave per channel, crossing 0.5 now and then. */
const wave: NodeDefinition = {
  type: 'window-test-wave', version: 1, label: 'Wave', category: 'control-logic', description: '',
  ports: [{ name: 'out', type: 'signal', direction: 'out' }],
  params: [],
  signal: (_ctx, _port, t, channel) => 0.5 + 0.5 * Math.sin(2 * Math.PI * (0.7 + 0.3 * channel) * t),
};

/** Reads a Signal or Value output at every feed event, so state behind it (Sample & Hold) is checked too. */
const probe: NodeDefinition = {
  type: 'window-test-probe', version: 1, label: 'Probe', category: 'control-logic', description: '',
  ports: [
    { name: 'trig', type: 'event', direction: 'in' },
    { name: 'sig', type: 'signal', direction: 'in' },
    { name: 'val', type: 'value', direction: 'in' },
    { name: 'out', type: 'event', direction: 'out' },
  ],
  params: [],
  query: (ctx) => ({
    out: (ctx.inputs.trig ?? []).map((e) => ({
      time: e.time,
      channel: e.channel,
      read: ctx.connected('sig') ? ctx.signal('sig', e.time, e.channel) : JSON.stringify(ctx.value('val', e.time)) ?? 'undefined',
    })),
  }),
};

/** Live input stand-in: no query, events arrive only through push. */
const tap: NodeDefinition = {
  type: 'window-test-tap', version: 1, label: 'Tap', category: 'canvas-sources', description: '',
  ports: [{ name: 'out', type: 'note', direction: 'out' }],
  params: [],
};

const isOutput = (types: string[]) => (definition: NodeDefinition) => definition.ports.some((p) => p.direction === 'out' && types.includes(p.type));

/** Can this node be checked: it has a query, and an Event, Note, Signal or Value output to compare. */
export const windowCheckable = (definition: NodeDefinition): boolean => !!definition.query && isOutput(['event', 'note', 'signal', 'value'])(definition);

/**
 * The node's logged events (and its probes' reads) over [0, seconds) for each way of splitting time:
 * every step in `steps`, then one call. They should all be equal.
 */
export function windowLogs(definition: NodeDefinition, { seconds = WINDOW_SECONDS, steps = WINDOW_STEPS as readonly number[], seed = 1 } = {}): string[] {
  const plan = buildPlan(definition, seed, false);
  const run = (step: number) => {
    const runtime = new Runtime(plan, { history: true });
    const log = [];
    const windows = Math.ceil(seconds / step - 1e-9);
    // Window edges by index, never by accumulation.
    for (let i = 0; i < windows; i++) log.push(...runtime.query(i * step, Math.min(seconds, (i + 1) * step)));
    return format(log);
  };
  return [...steps.map(run), run(seconds)];
}

/** The node's events and its probes' reads, one JSON line each. */
const format = (log: { node: string }[]) =>
  log.filter((e) => e.node === 'n' || (e.node.startsWith('probe-') && !e.node.endsWith('-feed'))).map((e) => JSON.stringify(e)).join('\n');

/** Does this node have an Event or Note input to push into? */
export const rewindCheckable = (definition: NodeDefinition): boolean =>
  windowCheckable(definition) && definition.ports.some((p) => p.direction === 'in' && (p.type === 'event' || p.type === 'note'));

export const REWIND_SECONDS = 3;
/** Audio times of the pushes, a few close together, one per tap in turn. */
const PUSHES = [0.2113, 0.5, 0.5002, 0.98, 1.37, 2.04, 2.6];

/**
 * Logs of the node with live events pushed into each Event input, under
 * several wake timings. The first is the reference, where every push lands
 * past the horizon and nothing rewinds; the others rewind and must equal it.
 */
export function rewindLogs(definition: NodeDefinition, { seconds = REWIND_SECONDS, seed = 1 } = {}): { reference: string; rewound: { name: string; log: string; rewinds: number }[] } {
  const plan = buildPlan(definition, seed, true);
  const taps = plan.order.filter((n) => n.definition === tap).map((n) => n.id);
  const perform = (wakes: number[], options: Partial<SchedulerOptions> = {}, hidden = false) => {
    const clock = new ManualClock();
    clock.isHidden = hidden;
    const scheduler = new Scheduler(new Runtime(plan), { clock, record: true, ...options });
    const timeline = [...PUSHES.map((at, i) => ({ at, push: i })), ...wakes.map((at) => ({ at, push: -1 }))].sort((a, b) => a.at - b.at || b.push - a.push);
    for (const { at, push } of timeline) {
      clock.set(at);
      if (push < 0) scheduler.wake();
      else scheduler.push(taps[push % taps.length]!, 'out', { channel: push % 2, index: 1000 + push, pitch: 60 + push, velocity: 0.7, duration: 0.2 });
    }
    for (let k = 1; (scheduler.horizon ?? -Infinity) < seconds; k++) {
      clock.set(seconds + k * 0.025);
      scheduler.wake();
    }
    return { log: format(scheduler.events().filter((e) => e.time < seconds)), rewinds: scheduler.stats.rewinds };
  };
  const grid = (step: number) => Array.from({ length: Math.ceil(seconds / step) }, (_, k) => k * step);
  const jitter: number[] = [];
  for (let t = 0, i = 0; t < seconds; t += [0.011, 0.037, 0.019, 0.029, 0.004][i++ % 5]!) jitter.push(t);
  return {
    reference: perform(grid(0.002), { lookahead: 0.004 }).log,
    rewound: [
      { name: '25 ms wakes', ...perform(grid(0.025)) },
      { name: 'jittery wakes', ...perform(jitter) },
      { name: 'hidden, 300 ms wakes', ...perform(grid(0.3), {}, true) },
    ],
  };
}

/** The node as `n`, its inputs fed, its Signal/Value outputs probed, and with `taps`, a tap into each Event input. */
function buildPlan(definition: NodeDefinition, seed: number, taps: boolean) {
  const definitions = new Map([definition, feed, wave, probe, tap].map((d) => [d.type, d]));
  const nodes: Patch['nodes'] = [{ id: 'n', type: definition.type, typeVersion: definition.version, params: {}, position: { x: 0, y: 0 } }];
  const cables: Patch['cables'] = [];
  const add = (id: string, type: string) => nodes.push({ id, type, typeVersion: 1, params: {}, position: { x: 0, y: 0 } });
  for (const port of definition.ports.filter((p) => p.direction === 'in')) {
    const events = port.type === 'event' || port.type === 'note';
    const source = events ? feed : port.type === 'signal' ? wave : null;
    if (!source) continue;
    add(`src-${port.name}`, source.type);
    cables.push({ from: { node: `src-${port.name}`, port: 'out' }, to: { node: 'n', port: port.name } });
    if (events && taps) {
      add(`tap-${port.name}`, tap.type);
      cables.push({ from: { node: `tap-${port.name}`, port: 'out' }, to: { node: 'n', port: port.name } });
    }
  }
  for (const port of definition.ports.filter((p) => p.direction === 'out' && (p.type === 'signal' || p.type === 'value'))) {
    const id = `probe-${port.name}`;
    add(id, probe.type);
    add(`${id}-feed`, feed.type);
    cables.push({ from: { node: `${id}-feed`, port: 'out' }, to: { node: id, port: 'trig' } });
    cables.push({ from: { node: 'n', port: port.name }, to: { node: id, port: port.type === 'signal' ? 'sig' : 'val' } });
  }
  const compiled = compilePatch({ format: 'flowpatch', version: 1, seed, nodes, cables }, definitions);
  if (!compiled.ok) throw new Error(`${definition.type}: ${compiled.errors.join('; ')}`);
  return compiled.plan;
}
