import { describe, expect, it } from 'vitest';
import {
  advanceTransport,
  beatAt,
  compilePatch,
  createNodeContext,
  createTransport,
  phaseAt,
  retune,
  Runtime,
  stepAt,
  tempoAt,
  ticksIn,
  TRANSPORT_HISTORY,
  transportBeat,
  type NodeDefinition,
  type Patch,
  type Transport,
  type TransportTempo,
  type TransportTick,
} from '../src';

const tempo = (bpm: number, stepBeats = 1, swing = 0): TransportTempo => ({ beatsPerSecond: bpm / 60, stepBeats, swing });

/** Window edges from 0 to end in steps of `width` (index × width, so no drift), plus `extra` edges. */
function edges(end: number, width: number, extra: number[] = []): number[] {
  const out = new Set<number>([end, ...extra]);
  for (let i = 0; i * width < end; i++) out.add(i * width);
  return [...out].sort((a, b) => a - b);
}

/**
 * Runs a Clock-like transport over windows. A plan change takes effect at the
 * window that starts at its time, as hot patching swaps plans at a window
 * boundary; `sample` is the modulated tempo, sampled at ticks.
 */
function run(
  bounds: number[],
  start: TransportTempo,
  changes: { at: number; tempo: TransportTempo }[] = [],
  sample?: (t: number) => TransportTempo,
): { ticks: TransportTick[]; transport: Transport } {
  const transport = createTransport(start, 0);
  const ticks: TransportTick[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const t0 = bounds[i]!, t1 = bounds[i + 1]!;
    for (const change of changes) if (change.at === t0) retune(transport, t0, change.tempo);
    ticks.push(...advanceTransport(transport, t0, t1, sample));
  }
  return { ticks, transport };
}

/** What readers can see after a run ending at `end`: the last TRANSPORT_HISTORY seconds and beyond. */
function observe(transport: Transport, end: number) {
  const out: number[][] = [];
  for (let i = 0; i <= 400; i++) {
    const t = end - TRANSPORT_HISTORY + i * 0.01;
    out.push([beatAt(transport, t), stepAt(transport, t), tempoAt(transport, t).beatsPerSecond]);
  }
  return { reads: out, newest: transport.anchors.at(-1), next: ticksIn(transport, end, end + 2) };
}

function expectEveryStepOnce(ticks: TransportTick[]): void {
  expect(ticks.map((t) => t.step)).toEqual(ticks.map((_, i) => i));
  for (let i = 1; i < ticks.length; i++) expect(ticks[i]!.time).toBeGreaterThanOrEqual(ticks[i - 1]!.time);
}

describe('transport', () => {
  it('ticks every step from its start at a steady tempo', () => {
    const transport = createTransport(tempo(120), 0);
    const ticks = ticksIn(transport, 0, 2);
    expect(ticks).toEqual([0, 1, 2, 3].map((k) => ({ time: k * 0.5, step: k, beat: k })));
    expect(ticksIn(transport, 0.5, 1)).toEqual([{ time: 0.5, step: 1, beat: 1 }]);
    expect(ticksIn(transport, 0.5, 0.5)).toEqual([]);
    expect(ticksIn(transport, -1, 0)).toEqual([]);
    expect(beatAt(transport, 1.25)).toBe(2.5);
    expect(phaseAt(transport, 1.25)).toBe(0.5);
  });

  it('keeps the beat, step and Phase continuous across a tempo change, and counts every step once', () => {
    const change = 1.1;
    const { ticks, transport } = run(edges(4, 0.025, [change]), tempo(120), [{ at: change, tempo: tempo(90) }]);
    expectEveryStepOnce(ticks);
    // One step per beat: the beat count at the ticks never repeats or skips.
    for (const tick of ticks) expect(tick.beat).toBeCloseTo(tick.step, 9);
    expect(ticks.filter((t) => t.time < change).map((t) => t.time)).toEqual([0, 0.5, 1]);
    // Step 3 is 0.8 beats after the change at 1.5 beats per second.
    expect(ticks[3]!.time).toBeCloseTo(change + 0.8 / 1.5, 12);

    expect(beatAt(transport, change)).toBeCloseTo(2.2, 12);
    expect(beatAt(transport, change - 1e-9)).toBeCloseTo(2.2, 6);
    // Phase only ever moves forward by its rate, or wraps from near 1 to near 0.
    const dt = 0.001;
    for (let t = dt; t < 4; t += dt) {
      const step = phaseAt(transport, t) - phaseAt(transport, t - dt);
      const wrapped = step < 0 ? step + 1 : step;
      expect(wrapped).toBeLessThan(2 * dt + 1e-9);
      expect(wrapped).toBeGreaterThan(0);
    }
  });

  it('keeps the old anchor for reads before a change', () => {
    const transport = createTransport(tempo(120), 0);
    advanceTransport(transport, 0, 1);
    const before = [0.2, 0.7, 0.99].map((t) => [beatAt(transport, t), stepAt(transport, t), phaseAt(transport, t)]);
    retune(transport, 1, tempo(200, 0.5));
    expect([0.2, 0.7, 0.99].map((t) => [beatAt(transport, t), stepAt(transport, t), phaseAt(transport, t)])).toEqual(before);
    expect(tempoAt(transport, 0.5)).toEqual(tempo(120));
    expect(tempoAt(transport, 1)).toEqual(tempo(200, 0.5));
    expect(retune(transport, 1.5, tempo(200, 0.5))).toBe(false);
    expect(() => retune(transport, 0.9, tempo(100))).toThrow(RangeError);
    expect(() => retune(transport, 2, tempo(0))).toThrow(RangeError);
    expect(() => retune(transport, 2, tempo(100, 1, 1))).toThrow(RangeError);
    expect(() => createTransport(tempo(NaN))).toThrow(RangeError);
  });

  it('gives the same ticks and state in 25 ms windows, 17.3 ms windows and one call per plan', () => {
    const changes = [
      { at: 2.5, tempo: tempo(97, 0.25, 0.3) },
      { at: 6, tempo: tempo(140, 1 / 3, 0) },
      { at: 8, tempo: tempo(60, 0.5, 0.6) },
    ];
    const at = changes.map((c) => c.at);
    const whole = run([0, ...at, 10], tempo(120, 0.5, 0.2), changes);
    expectEveryStepOnce(whole.ticks);
    for (const width of [0.025, 0.1, 0.0173]) {
      const tiled = run(edges(10, width, at), tempo(120, 0.5, 0.2), changes);
      expect(tiled.ticks).toEqual(whole.ticks);
      expect(observe(tiled.transport, 10)).toEqual(observe(whole.transport, 10));
    }
  });

  it('follows a modulated tempo at tick times, whatever the windowing', () => {
    // BPM and swing swept by a slow wave, division switched halfway.
    const sample = (t: number) => tempo(120 + 60 * Math.sin(t), t < 5 ? 0.25 : 1 / 6, 0.3 + 0.2 * Math.sin(3 * t));
    const whole = run([0, 10], sample(0), [], sample);
    expectEveryStepOnce(whole.ticks);
    expect(whole.ticks.length).toBeGreaterThan(100);
    for (const width of [0.025, 0.1, 0.0173]) {
      const tiled = run(edges(10, width), sample(0), [], sample);
      expect(tiled.ticks).toEqual(whole.ticks);
      expect(observe(tiled.transport, 10)).toEqual(observe(whole.transport, 10));
    }
    // The beat at each tick is where the tempo in effect put it: increasing, no jumps.
    for (let i = 1; i < whole.ticks.length; i++) {
      const a = whole.ticks[i - 1]!, b = whole.ticks[i]!;
      expect(b.beat).toBeGreaterThan(a.beat);
      expect(b.beat - a.beat).toBeLessThan(0.5);
    }
  });

  it('fires an odd step once when swing changes around it', () => {
    // 120 bpm, a step per beat: unswung steps every 0.5 s.
    // Less swing: step 1 was due at 0.75 (swing 0.5), the change at 0.6 already
    // passed its new time (0.5), so it fires at the change.
    const less = run(edges(2, 0.025, [0.6]), tempo(120, 1, 0.5), [{ at: 0.6, tempo: tempo(120, 1, 0) }]).ticks;
    expectEveryStepOnce(less);
    expect(less.slice(0, 3).map((t) => t.time)).toEqual([0, 0.6, 1]);
    // More swing: step 1 fired at 0.5, before the change; it doesn't fire again at 0.75.
    const more = run(edges(2, 0.025, [0.6]), tempo(120, 1, 0), [{ at: 0.6, tempo: tempo(120, 1, 0.5) }]).ticks;
    expectEveryStepOnce(more);
    expect(more.slice(0, 4).map((t) => t.time)).toEqual([0, 0.5, 1, 1.75]);
  });

  it('carries the step index on through a division change, without re-counting from the beat', () => {
    const { ticks } = run(edges(3, 0.025, [1.1]), tempo(120, 1), [{ at: 1.1, tempo: tempo(120, 0.25) }]);
    expectEveryStepOnce(ticks);
    // Step position 2.2 at 1.1 s; 16ths from there: step 3 at 0.8 × 0.125 s later.
    expect(ticks[3]!.time).toBeCloseTo(1.2, 12);
    expect(ticks[4]!.time).toBeCloseTo(1.325, 12);
  });

  it('keeps a bounded history under constant modulation, exact for recent reads', () => {
    const maxBpm = 140;
    const sample = (t: number) => tempo(100 + 40 * Math.sin(t), 0.25, 0);
    const transport = createTransport(sample(0), 0);
    const reads: [number, number][] = [];
    // At most maxBpm / 60 / 0.25 ticks a second (9.3), each a new anchor; the
    // window start keeps TRANSPORT_HISTORY seconds of them, plus this window's.
    const bound = Math.ceil((TRANSPORT_HISTORY + 0.025) * (maxBpm / 60 / 0.25)) + 2;
    for (let i = 0; i < 1200; i++) {
      const t0 = i * 0.025, t1 = (i + 1) * 0.025;
      advanceTransport(transport, t0, t1, sample);
      for (let t = t0; t < t1; t += 0.005) reads.push([t, beatAt(transport, t)]);
      expect(transport.anchors.length).toBeLessThanOrEqual(bound);
      // Reads up to TRANSPORT_HISTORY behind the window start don't change.
      for (const [t, beat] of reads.slice(-500)) if (t >= t0 - TRANSPORT_HISTORY) expect(beatAt(transport, t)).toBe(beat);
    }
    expect(reads.length).toBeGreaterThan(5000);
  });
});

describe('transport queried backwards', () => {
  it('gives the ticks the anchors have, without re-anchoring in the past or throwing', () => {
    const sample = (t: number) => tempo(120 + 60 * Math.sin(3 * t), 0.25, 0.2);
    const transport = createTransport(sample(0), 0);
    const forward = advanceTransport(transport, 0, 2, sample);
    const anchors = structuredClone(transport.anchors);
    const again = advanceTransport(transport, 1, 1.5, sample);
    expect(again.length).toBeGreaterThan(0);
    expect(again).toEqual(forward.filter((t) => t.time >= 1 && t.time < 1.5));
    expect(transport.anchors).toEqual(anchors);
  });
});

describe('transport on a cable', () => {
  // A minimal Clock and a beat reader, so engine tests don't depend on packages/nodes.
  const clock: NodeDefinition = {
    type: 'clock', version: 1, label: 'Clock', category: 'time-rhythm', description: '',
    ports: [{ name: 'tick', type: 'event', direction: 'out' }, { name: 'transport', type: 'value', direction: 'out' }],
    params: [{ name: 'bpm', kind: 'number', min: 20, max: 300, default: 120 }],
    query(ctx) {
      const sample = (t: number) => tempo(ctx.param('bpm', t), 0.5, 0);
      const transport = (ctx.state.transport ??= createTransport(sample(0), 0)) as Transport;
      return { tick: advanceTransport(transport, ctx.t0, ctx.t1, sample).map(({ time, step }) => ({ time, channel: 0, step })) };
    },
    value: (ctx, _port, t) => (ctx.state.transport ? beatAt(ctx.state.transport as Transport, t) : 0),
  };
  const wave: NodeDefinition = {
    type: 'wave', version: 1, label: 'Wave', category: 'control-logic', description: '',
    ports: [{ name: 'out', type: 'signal', direction: 'out' }],
    params: [],
    signal: (_ctx, _port, t) => 50 * Math.sin(2 * t),
  };
  const reader: NodeDefinition = {
    type: 'reader', version: 1, label: 'Reader', category: 'harmony-pitch', description: '',
    ports: [
      { name: 'in', type: 'event', direction: 'in' },
      { name: 'transport', type: 'value', direction: 'in' },
      { name: 'out', type: 'event', direction: 'out' },
    ],
    params: [],
    query: (ctx) => ({ out: (ctx.inputs.in ?? []).map((e) => ({ time: e.time, channel: e.channel, beat: transportBeat(ctx, 'transport', e.time) })) }),
  };
  const definitions = new Map([clock, wave, reader].map((d) => [d.type, d]));
  const node = (id: string, type: string) => ({ id, type, typeVersion: 1, params: {}, position: { x: 0, y: 0 } });
  const cable = (a: string, from: string, b: string, to: string) => ({ from: { node: a, port: from }, to: { node: b, port: to } });
  const patch: Patch = {
    format: 'flowpatch', version: 1, seed: 1,
    nodes: [node('wave', 'wave'), node('clock', 'clock'), node('wired', 'reader'), node('loose', 'reader')],
    cables: [
      cable('wave', 'out', 'clock', 'bpm'),
      cable('clock', 'tick', 'wired', 'in'),
      cable('clock', 'transport', 'wired', 'transport'),
      cable('clock', 'tick', 'loose', 'in'),
    ],
  };
  const runWindows = (width: number) => {
    const compiled = compilePatch(patch, definitions);
    if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
    const runtime = new Runtime(compiled.plan);
    const bounds = edges(10, width);
    return bounds.slice(1).flatMap((t1, i) => runtime.query(bounds[i]!, t1));
  };

  it('gives readers the same beats in 25 ms windows and in one call; an unwired reader stays at beat 0', () => {
    const whole = runWindows(10);
    expect(runWindows(0.025)).toEqual(whole);
    expect(runWindows(0.0173)).toEqual(whole);
    const wired = whole.filter((e) => e.node === 'wired');
    const ticks = whole.filter((e) => e.node === 'clock');
    expect(wired.length).toBe(ticks.length);
    expect(wired.length).toBeGreaterThan(20);
    // Two steps per beat: the beat a reader sees at each tick is half its step.
    for (const [i, e] of wired.entries()) expect(e.beat).toBeCloseTo((ticks[i]!.step as number) / 2, 9);
    expect(whole.filter((e) => e.node === 'loose').every((e) => e.beat === 0)).toBe(true);
  });

  it('survives a rewind: a live event re-runs the Clock from its snapshot without changing its ticks', () => {
    const compiled = compilePatch(patch, definitions);
    if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
    const plain = new Runtime(compiled.plan);
    const live = new Runtime(compiled.plan, { history: true });
    const bounds = edges(4, 0.025);
    const log = (runtime: Runtime, from: number, to: number) => bounds.slice(1).flatMap((t1, i) => (bounds[i]! >= from && t1 <= to ? runtime.query(bounds[i]!, t1) : []));
    const before = log(plain, 0, 4);
    const early = log(live, 0, 2);
    const report = live.push('clock', 'tick', { time: 1.9, channel: 5, step: -1 })!;
    const after = [...early.filter((e) => e.time < 1.9), ...report.added, ...log(live, 2, 4)];
    const strip = (events: typeof after) => events.filter((e) => e.channel !== 5);
    expect(strip(after)).toEqual(before);
    expect(after.filter((e) => e.channel === 5).map((e) => e.node)).toEqual(['clock', 'wired', 'loose']);
  });

  it('reads 0 from no cable or a cable carrying no number', () => {
    const base = { nodeId: 'r', seed: 1, definition: reader, params: {}, state: {} };
    expect(transportBeat(createNodeContext(base), 'transport', 3)).toBe(0);
    expect(transportBeat(createNodeContext(base, { values: { transport: (t) => t * 2 } }), 'transport', 3)).toBe(6);
    expect(transportBeat(createNodeContext(base, { values: { transport: () => 'x' } }), 'transport', 3)).toBe(0);
    expect(transportBeat(createNodeContext(base, { values: { transport: () => NaN } }), 'transport', 3)).toBe(0);
  });
});
