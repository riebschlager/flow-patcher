// InputSpec.rewrites: a source that rewrites its pushes (Pointer's slot channels
// and derived fields, ADR 0028/0029). The runtime doesn't pass the pushes through,
// so nothing is emitted twice, the rewritten events stay on the immediate path
// (ADR 0020), and rewinds replay them (ADR 0019).
import { describe, expect, it } from 'vitest';
import {
  compilePatch,
  FrameLoop,
  ManualClock,
  pushable,
  Runtime,
  Scheduler,
  type AudioContextLike,
  type EngineEvent,
  type EventPath,
  type LoggedEvent,
  type NodeDefinition,
  type Patch,
} from '../src';

/**
 * Rewrites each Down onto channel 100 + its pushed channel and numbers it, counting
 * every push so far in state, so a rewind that lost or doubled one would show.
 * `enter` is a push-only port: it only counts.
 */
const slotter: NodeDefinition = {
  type: 'slotter', version: 1, label: 'Slotter', category: 'canvas-sources', description: '',
  ports: [{ name: 'down', type: 'event', direction: 'out' }],
  params: [],
  input: { reads: { pointerdown: 'down', pointerenter: 'enter' }, rewrites: true },
  query: ({ pushed, state }) => {
    let seen = (state.seen as number | undefined) ?? 0;
    const order = [...(pushed.down ?? []).map((e) => ({ e, down: true })), ...(pushed.enter ?? []).map((e) => ({ e, down: false }))]
      .sort((a, b) => a.e.time - b.e.time || Number(a.down) - Number(b.down));
    const down: EngineEvent[] = [];
    for (const { e, down: isDown } of order) {
      seen++;
      if (isDown) down.push({ ...e, channel: 100 + e.channel, rewritten: true, seen });
    }
    state.seen = seen;
    return { down };
  },
};
/** The same reads without rewrites: pushes pass through. */
const plain: NodeDefinition = { ...slotter, type: 'plain', input: { reads: { pointerdown: 'down' } }, query: () => ({}) };
interface Seen { time: number; channel: number; path: EventPath }
const sink: NodeDefinition = {
  type: 'sink', version: 1, label: 'Sink', category: 'visual', description: '',
  ports: [{ name: 'in', type: 'event', direction: 'in' }],
  params: [],
  frame: ({ inputs, state, pathOf }) => {
    const seen = ((state.seen as Seen[] | undefined) ??= []);
    for (const e of inputs.in ?? []) seen.push({ time: e.time, channel: e.channel, path: pathOf(e) });
  },
};
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
const definitions = new Map([slotter, plain, sink, voice].map((d) => [d.type, d]));
const node = (id: string, type: string) => ({ id, type, typeVersion: 1, params: {}, position: { x: 0, y: 0 } });
const cable = (a: string, from: string, b: string, to: string) => ({ from: { node: a, port: from }, to: { node: b, port: to } });
const patch: Patch = {
  format: 'flowpatch', version: 1, seed: 1,
  nodes: [node('s', 'slotter'), node('p', 'plain'), node('v', 'sink'), node('a', 'voice')],
  cables: [cable('s', 'down', 'v', 'in'), cable('s', 'down', 'a', 'note')],
};
function plan() {
  const result = compilePatch(patch, definitions);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.plan;
}
const of = (log: LoggedEvent[], id: string) => log.filter((e) => e.node === id).map(({ node: _n, ...e }) => e);

const pushes: { port: string; event: EngineEvent }[] = [
  { port: 'enter', event: { time: 0.05, channel: 1 } },
  { port: 'down', event: { time: 0.1, channel: 1, x: 0.2 } },
  { port: 'down', event: { time: 0.1, channel: 2, x: 0.4 } },
  { port: 'enter', event: { time: 0.3, channel: 3 } },
  { port: 'down', event: { time: 0.31, channel: 3, x: 0.6 } },
  { port: 'down', event: { time: 0.74, channel: 1, x: 0.8 } },
];

describe('InputSpec.rewrites', () => {
  it('emits only the query\'s rewritten events, once each, and passes pushes through on a node without it', () => {
    const run = new Runtime(plan());
    for (const { port, event } of pushes) run.push('s', port, { ...event });
    run.push('p', 'down', { time: 0.2, channel: 1 });
    const log = run.query(0, 1);
    expect(of(log, 's')).toEqual([
      { port: 'down', time: 0.1, channel: 101, x: 0.2, rewritten: true, seen: 2 },
      { port: 'down', time: 0.1, channel: 102, x: 0.4, rewritten: true, seen: 3 },
      { port: 'down', time: 0.31, channel: 103, x: 0.6, rewritten: true, seen: 5 },
      { port: 'down', time: 0.74, channel: 101, x: 0.8, rewritten: true, seen: 6 },
    ]);
    expect(of(log, 'p')).toEqual([{ port: 'down', time: 0.2, channel: 1 }]);
  });

  it('takes pushes on push-only ports only when the node rewrites, and never logs them', () => {
    expect(pushable(slotter, 'enter')).toBe(true);
    expect(pushable(slotter, 'down')).toBe(true);
    expect(pushable(slotter, 'leave')).toBe(false);
    expect(pushable({ ...slotter, input: { reads: { pointerenter: 'enter' } } }, 'enter')).toBe(false);
    // A reads entry can't make a Signal port or an input pushable.
    expect(pushable({ ...slotter, ports: [...slotter.ports, { name: 'enter', type: 'signal', direction: 'out' }] }, 'enter')).toBe(false);
    const run = new Runtime(plan());
    expect(() => run.push('s', 'leave', { time: 0.1, channel: 0 })).toThrow(/no event output "leave"/);
    expect(() => run.push('p', 'enter', { time: 0.1, channel: 0 })).toThrow(/no event output "enter"/);
    run.push('s', 'enter', { time: 0.1, channel: 0 });
    expect(run.query(0, 1)).toEqual([]);
    expect(run.stateOf('s')).toEqual({ seen: 1 });
    const scheduler = new Scheduler(new Runtime(plan()), { clock: new ManualClock() });
    expect(() => scheduler.push('s', 'leave', { channel: 0 })).toThrow(/no event output/);
  });

  it('keeps a rewritten tap on the immediate path: sound at its stamp, splash on the next frame', () => {
    const runtime = new Runtime(plan());
    const clock = new ManualClock();
    const scheduler = new Scheduler(runtime, { clock });
    runtime.attachAudio({} as AudioContextLike);
    const loop = new FrameLoop(runtime, { clock: { audioTime: () => clock.audio, wallTime: () => clock.wall, outputLatency: () => 0.2 } });
    const step = (t: number) => {
      clock.set(t);
      scheduler.wake();
      return loop.tick();
    };
    step(1);
    const pushed = scheduler.push('s', 'down', { channel: 4 })!;
    const played = (runtime.stateOf('a')?.played as EngineEvent[]).map((e) => [e.time, e.channel]);
    expect(played).toEqual([[pushed.time, 104]]);
    step(1.016);
    expect(runtime.stateOf('v')?.seen).toEqual([{ time: pushed.time, channel: 104, path: 'immediate' }]);
    expect(runtime.lastFrame).toMatchObject({ immediate: 1, taps: [{ node: 'v', port: 'in', time: pushed.time, channel: 104 }] });
  });

  it('replays rewritten events through rewinds: the same log as pushes known in advance', () => {
    const ahead = new Runtime(plan());
    for (const { port, event } of pushes) ahead.push('s', port, { ...event });
    const reference = JSON.stringify(ahead.sortLog([...ahead.query(0, 0.5), ...ahead.query(0.5, 1)]));
    for (const step of [0.025, 0.1]) {
      const run = new Runtime(plan(), { history: true });
      let log: LoggedEvent[] = [];
      let at = 0;
      const until = (t: number) => {
        for (; at * step < Math.min(1, t) - 1e-9; at++) log.push(...run.query(at * step, Math.min(1, (at + 1) * step)));
      };
      let rewinds = 0;
      for (const { port, event } of pushes) {
        until(event.time + 0.12);
        const report = run.push('s', port, { ...event });
        if (!report) continue;
        rewinds++;
        log = [...log.filter((e) => !(report.affected.has(e.node) && e.time >= report.time)), ...report.added];
      }
      until(1);
      expect(rewinds).toBe(pushes.length);
      expect(JSON.stringify(run.sortLog(log)), `${step}`).toBe(reference);
    }
  });
  describe('push-only ports across a swap', () => {
    const without: Patch = { ...patch, nodes: patch.nodes.filter((n) => n.id !== 's'), cables: [] };
    /** `s` is now a Plain: the same id, another type. */
    const retyped: Patch = { ...patch, nodes: patch.nodes.map((n) => (n.id === 's' ? node('s', 'plain') : n)), cables: [] };
    const compiled = (p: Patch) => {
      const result = compilePatch(p, definitions);
      if (!result.ok) throw new Error(result.errors.join('\n'));
      return result.plan;
    };

    it('drops a held enter whose node a swap removed or retyped before audio resumed, and applies one whose node stayed', () => {
      for (const [name, next, applied] of [['removed', without, false], ['retyped', retyped, false], ['kept', patch, true]] as const) {
        const runtime = new Runtime(plan());
        const clock = new ManualClock();
        const scheduler = new Scheduler(runtime, { clock });
        clock.set(0.5);
        scheduler.wake();
        clock.isRunning = false;
        expect(scheduler.push('s', 'enter', { channel: 1 }), name).toBeNull();
        expect(scheduler.stats.deferredPushes, name).toBe(1);
        scheduler.swap(compiled(next));
        clock.isRunning = true;
        clock.set(0.6);
        expect(() => scheduler.wake(), name).not.toThrow();
        expect(scheduler.stats.pushes, name).toBe(applied ? 1 : 0);
        if (applied) expect(runtime.stateOf('s'), name).toEqual({ seen: 1 });
        else expect(runtime.stateOf('s') ?? {}, name).not.toHaveProperty('seen');
      }
    });

    it('drops a live enter past the swap time from the injected events when its node is removed or retyped', () => {
      for (const [name, next] of [['removed', without], ['retyped', retyped]] as const) {
        const run = new Runtime(plan(), { history: true });
        run.query(0, 0.5);
        // Past the horizon: injected, waiting for the window that covers it.
        expect(run.push('s', 'enter', { time: 0.8, channel: 1 }), name).toBeNull();
        run.swap(compiled(next));
        // A Plain doesn't rewrite, so a kept enter would pass through onto a port it doesn't have.
        const log = run.query(0.5, 1);
        expect(log.filter((e) => e.node === 's'), name).toEqual([]);
        expect(run.stateOf('s') ?? {}, name).not.toHaveProperty('seen');
      }
    });
  });
});
