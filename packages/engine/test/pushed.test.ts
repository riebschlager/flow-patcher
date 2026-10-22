// QueryContext.pushed: a node's query sees the live events pushed onto its own
// outputs, so it can keep state from them (Pointer's X/Y/Count), and rewinds
// (ADR 0019) replay them, also when the node is only followed as a Signal source.
import { describe, expect, it } from 'vitest';
import { compilePatch, Runtime, type EngineEvent, type LoggedEvent, type NodeDefinition, type Patch, type QueryContext } from '../src';

/** Every query call, with what it was handed as `pushed`. */
const calls: { node: string; t0: number; t1: number; pushed: QueryContext['pushed'] }[] = [];

/** Ticks every `period` seconds, from absolute time. */
const metro: NodeDefinition = {
  type: 'metro', version: 1, label: 'Metro', category: 'time-rhythm', description: '',
  ports: [{ name: 'out', type: 'event', direction: 'out' }],
  params: [{ name: 'period', kind: 'number', min: 0.001, max: 1, default: 0.05 }],
  query: ({ nodeId, t0, t1, params, pushed }) => {
    calls.push({ node: nodeId, t0, t1, pushed });
    const period = params.period as number;
    const out: EngineEvent[] = [];
    for (let k = Math.max(0, Math.ceil(t0 / period) - 1); k * period < t1; k++) if (k * period >= t0) out.push({ time: k * period, channel: 0 });
    return { out };
  },
};
/** No query: events only arrive through push. */
const tap: NodeDefinition = {
  type: 'tap', version: 1, label: 'Tap', category: 'canvas-sources', description: '',
  ports: [{ name: 'out', type: 'event', direction: 'out' }],
  params: [],
};
/**
 * A Pointer stand-in: Down and Up only come from push, and Count is how many
 * channels are down. State is the count as the current window began plus the
 * window's changes, so a read at any t in the window is right.
 */
const pad: NodeDefinition = {
  type: 'pad', version: 1, label: 'Pad', category: 'canvas-sources', description: '',
  ports: [{ name: 'down', type: 'event', direction: 'out' }, { name: 'up', type: 'event', direction: 'out' }, { name: 'count', type: 'signal', direction: 'out' }],
  params: [],
  query: ({ nodeId, t0, t1, pushed, state }) => {
    calls.push({ node: nodeId, t0, t1, pushed });
    // Fold the previous window's changes in, then keep this window's for signal().
    const held = ((state.held as number[] | undefined) ??= []);
    for (const change of (state.changes as Change[] | undefined) ?? []) apply(held, change);
    state.changes = [
      ...(pushed.down ?? []).map((e) => ({ time: e.time, channel: e.channel, down: true })),
      ...(pushed.up ?? []).map((e) => ({ time: e.time, channel: e.channel, down: false })),
    ].sort((a, b) => a.time - b.time || Number(a.down) - Number(b.down));
    return {};
  },
  signal: (ctx, _port, t) => {
    const held = [...((ctx.state.held as number[] | undefined) ?? [])];
    for (const change of (ctx.state.changes as Change[] | undefined) ?? []) if (change.time <= t) apply(held, change);
    return held.length;
  },
};
interface Change { time: number; channel: number; down: boolean }
function apply(held: number[], { channel, down }: Change): void {
  const i = held.indexOf(channel);
  if (down && i < 0) held.push(channel);
  if (!down && i >= 0) held.splice(i, 1);
}
/** Reads the pad's Count at every input event. */
const reader: NodeDefinition = {
  type: 'reader', version: 1, label: 'Reader', category: 'control-logic', description: '',
  ports: [{ name: 'in', type: 'event', direction: 'in' }, { name: 'count', type: 'signal', direction: 'in' }, { name: 'out', type: 'event', direction: 'out' }],
  params: [],
  query: ({ nodeId, t0, t1, inputs, pushed, signal }) => {
    calls.push({ node: nodeId, t0, t1, pushed });
    return { out: (inputs.in ?? []).map((e) => ({ time: e.time, channel: e.channel, count: signal('count', e.time) })) };
  },
};
const definitions = new Map([metro, tap, pad, reader].map((d) => [d.type, d]));

const node = (id: string, type: string, params = {}) => ({ id, type, typeVersion: 1, params, position: { x: 0, y: 0 } });
const link = (a: string, from: string, b: string, to: string) => ({ from: { node: a, port: from }, to: { node: b, port: to } });
const p: Patch = {
  format: 'flowpatch', version: 1, seed: 1,
  nodes: [node('m', 'metro'), node('t', 'tap'), node('pad', 'pad'), node('x', 'reader')],
  cables: [link('m', 'out', 'x', 'in'), link('t', 'out', 'x', 'in'), link('pad', 'count', 'x', 'count')],
};
function runtime(history = true): Runtime {
  const result = compilePatch(p, definitions);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return new Runtime(result.plan, { history });
}

const END = 1;
/** Pointer-like pushes on the pad: two channels down and up, out of order across ports. */
const padPushes: { port: 'down' | 'up'; event: EngineEvent }[] = [
  { port: 'down', event: { time: 0.1625, channel: 0 } },
  { port: 'down', event: { time: 0.31, channel: 1 } },
  { port: 'up', event: { time: 0.4875, channel: 0 } },
  { port: 'down', event: { time: 0.6, channel: 0 } },
  { port: 'up', event: { time: 0.7, channel: 1 } },
  { port: 'up', event: { time: 0.8125, channel: 0 } },
];
const json = (events: LoggedEvent[]) => JSON.stringify(events);
/** All pushes known before anything is queried, then [0, END) in windows of `step`. */
function advance(step: number): LoggedEvent[] {
  const run = runtime();
  for (const { port, event } of padPushes) run.push('pad', port, event);
  const log: LoggedEvent[] = [];
  const count = Math.ceil(END / step - 1e-9);
  for (let i = 0; i < count; i++) log.push(...run.query(i * step, Math.min(END, (i + 1) * step)));
  return run.sortLog(log);
}

describe('QueryContext.pushed', () => {
  it("hands a node its own pushes in time order, once, and passes them through to the outputs", () => {
    calls.length = 0;
    const run = runtime(false);
    run.push('pad', 'down', { time: 0.3, channel: 1 });
    run.push('pad', 'down', { time: 0.3, channel: 0, first: true });
    run.push('pad', 'down', { time: 0.3, channel: 0, first: false });
    run.push('pad', 'up', { time: 0.1, channel: 1 });
    run.push('pad', 'up', { time: 1.5, channel: 1 });
    const log = run.query(0, 1);
    const [call] = calls.filter((c) => c.node === 'pad');
    expect(call!.pushed).toEqual({
      down: [{ time: 0.3, channel: 0, first: true }, { time: 0.3, channel: 0, first: false }, { time: 0.3, channel: 1 }],
      up: [{ time: 0.1, channel: 1 }],
    });
    expect(Object.isFrozen(call!.pushed) && Object.isFrozen(call!.pushed.down)).toBe(true);
    // In the same order on the outputs, each once.
    const out = (port: string) => log.filter((e) => e.node === 'pad' && e.port === port).map(({ node: _n, port: _p, ...e }) => e);
    expect(out('down')).toEqual(call!.pushed.down);
    expect(out('up')).toEqual(call!.pushed.up);
    // The push at 1.5 waits for the window that covers it.
    calls.length = 0;
    run.query(1, 2);
    expect(calls.find((c) => c.node === 'pad')!.pushed).toEqual({ up: [{ time: 1.5, channel: 1 }] });
  });

  it('is one shared empty object for nodes with no pushes, and never shows another node\'s pushes', () => {
    calls.length = 0;
    const run = runtime(false);
    run.push('t', 'out', { time: 0.2, channel: 0 });
    run.push('pad', 'down', { time: 0.6, channel: 0 });
    for (let i = 0; i < 4; i++) run.query(i * 0.25, (i + 1) * 0.25);
    const empty = calls.find((c) => c.node === 'm')!.pushed;
    expect(Object.keys(empty)).toHaveLength(0);
    expect(Object.isFrozen(empty)).toBe(true);
    for (const call of calls) {
      if (call.node === 'pad' && call.t0 === 0.5) expect(call.pushed).toEqual({ down: [{ time: 0.6, channel: 0 }] });
      else expect(call.pushed).toBe(empty);
    }
  });

  it('gives the same log in 25 ms windows as in one call', () => {
    const reference = advance(END);
    // Count at the 50 ms ticks.
    const counts = reference.filter((e) => e.node === 'x').map((e) => e.count);
    expect(counts).toEqual([0, 0, 0, 0, 1, 1, 1, 2, 2, 2, 1, 1, 2, 2, 1, 1, 1, 0, 0, 0]);
    expect(json(advance(0.025))).toBe(json(reference));
    expect(json(advance(0.1))).toBe(json(reference));
  });

  it('replays the pushes when a push rewinds the node that received them', () => {
    const reference = json(advance(END));
    for (const step of [0.025, 0.1]) {
      const run = runtime();
      const log: LoggedEvent[] = [];
      let at = 0;
      const until = (time: number) => {
        // Query 120 ms past `time`, so each push lands in already queried windows.
        for (; at * step < Math.min(END, time + 0.12) - 1e-9; at++) log.push(...run.query(at * step, Math.min(END, (at + 1) * step)));
      };
      for (const { port, event } of padPushes) {
        until(event.time);
        const report = run.push('pad', port, event)!;
        expect(report.affected.has('pad')).toBe(true);
        // What the re-run emitted from the push on replaces the earlier log there.
        log.splice(0, log.length, ...log.filter((e) => !report.affected.has(e.node) || e.time < report.time), ...report.added);
      }
      until(END);
      expect(json(run.sortLog(log))).toBe(reference);
    }
  });

  it('replays the pushes when the node is only followed as a Signal source of a rewind', () => {
    const reference = advance(END);
    const run = runtime();
    for (const { port, event } of padPushes) run.push('pad', port, event);
    const log: LoggedEvent[] = [];
    for (let i = 0; i < 10; i++) log.push(...run.query(i * 0.1, (i + 1) * 0.1));
    calls.length = 0;
    // A tap into the reader, early: the reader re-runs to the horizon and the pad is only stepped
    // for its state, from the 0.1 snapshot through all of its own later pushes.
    const report = run.push('t', 'out', { time: 0.15, channel: 0 })!;
    expect([...report.followed]).toEqual(['pad']);
    expect(report.affected.has('pad')).toBe(false);
    const followedCalls = calls.filter((c) => c.node === 'pad');
    expect(followedCalls.length).toBeGreaterThan(0);
    expect(followedCalls.flatMap((c) => [...(c.pushed.down ?? []), ...(c.pushed.up ?? [])]).length).toBe(padPushes.length);
    // The tap reads Count 0 (the pad's down at 0.1625 is later); every later tick reads as before.
    const tapRead = report.added.find((e) => e.node === 'x' && e.time === 0.15)!;
    expect(tapRead.count).toBe(0);
    const ticks = report.added.filter((e) => e.node === 'x' && e.time !== 0.15);
    expect(json(ticks)).toBe(json(reference.filter((e) => e.node === 'x' && e.time >= 0.15)));
    // The pad's own events are not re-logged: the re-run only reports the affected nodes.
    expect(report.added.some((e) => e.node === 'pad')).toBe(false);
  });
});
