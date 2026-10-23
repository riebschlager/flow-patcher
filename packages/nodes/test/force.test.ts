import { describe, expect, it } from 'vitest';
import { applyFluidWrite, compilePatch, createInProcessFluid, Fluid, Runtime, type FluidBackend, type FluidTarget, type FluidWork, type FluidWriter, type NodeState, type Patch } from '@flow-patcher/engine';
import { force, nodeRegistry } from '../src';
import { FORCE_TICK, forceTicks, MAX_FORCE_TICKS, MAX_PUSH, PUSH_GAIN } from '../src/force';
import { context, frame } from './helpers';

type Call = ['force', ...Parameters<FluidTarget['force']>] | ['pulse', ...Parameters<FluidTarget['pulse']>];
type Options = Omit<Parameters<typeof frame>[3] & object, 'state'>;

function writerOf(state: NodeState): FluidWriter {
  return force.field!(context(force, { state }), 'write') as FluidWriter;
}
function written(writer: FluidWriter): Call[] {
  const calls: Call[] = [];
  writer.write({ splat() { throw new Error('Force splatted dye'); }, force: (...a) => void calls.push(['force', ...a]), pulse: (...a) => void calls.push(['pulse', ...a]) });
  return calls;
}
/** Runs frames over [0, end) of `dt` and collects every write, frame by frame. */
function run(end: number, dt: number, options: Options = {}): Call[] {
  const state: NodeState = {};
  const writer = writerOf(state);
  const calls: Call[] = [];
  const count = Math.round(end / dt);
  for (let f = 0; f < count; f++) {
    frame(force, f * dt, (f + 1) * dt, { ...options, state, dt });
    calls.push(...written(writer));
  }
  return calls;
}
/** A pair moving right at 0.5 canvas units per second from x = 0.2, at y = 0.3. */
const moving = { x: [(t: number) => 0.2 + 0.5 * t], y: [() => 0.3] };

describe('force', () => {
  it('has X, Y, Active and Spin inputs and a Write output for Fluid', () => {
    expect(force.ports.map((p) => [p.name, p.type, p.direction])).toEqual([
      ['x', 'signal', 'in'], ['y', 'signal', 'in'], ['active', 'signal', 'in'], ['spin', 'signal', 'in'], ['write', 'field', 'out'],
    ]);
    expect(force.ports.at(-1)!.fieldKind).toBe('write');
    expect(force.params.map((p) => p.name)).toEqual(['mode', 'strength', 'radius', 'direction']);
    expect(force.query).toBeUndefined();
  });

  it('ticks on a fixed 50 ms grid of the frame clock, at most MAX_FORCE_TICKS a frame', () => {
    expect(forceTicks(0, 1 / 60)).toEqual([0]);
    expect(forceTicks(1 / 60, 2 / 60)).toEqual([]);
    expect(forceTicks(0.05, 0.1)).toEqual([0.05]);
    expect(forceTicks(0, 1).length).toBe(MAX_FORCE_TICKS);
    expect(forceTicks(0, 1).at(-1)).toBeCloseTo(0.95);
    // Every grid time in a run lands in exactly one frame.
    const frames = Array.from({ length: 60 }, (_, f) => forceTicks(f / 60, (f + 1) / 60)).flat();
    expect(frames.length).toBe(20);
    for (const bad of [[NaN, 1], [0, Infinity], [1, 0], [1, 1]]) expect(forceTicks(bad[0]!, bad[1]!)).toEqual([]);
  });

  it('pushes along the motion, scaled by Strength, at the current position', () => {
    const calls = run(0.5, 1 / 60, { signals: moving, params: { strength: 0.5, radius: 0.1 } });
    // One push per 50 ms tick from 0.05 to 0.45 s, each from the motion over the tick before it;
    // the tick at 0 has nothing before it.
    expect(calls.length).toBe(9);
    const [op, x, y, dx, dy, radius] = calls[2]!;
    expect(op).toBe('force');
    expect(x).toBeCloseTo(0.2 + 0.5 * 3 * FORCE_TICK);
    expect(y).toBe(0.3);
    expect(dx).toBeCloseTo(0.5 * PUSH_GAIN * 0.5);
    expect(dy).toBe(0);
    expect(radius).toBe(0.1);
  });

  it('caps the push like Flow’s Conduct, and gives none when the pair is still', () => {
    const fast = run(0.5, 1 / 60, { signals: { x: [(t) => t * 4], y: [() => 0.5] }, params: { strength: 1 } });
    // 4 units/s × 30 would be 120 exactly; x clamps at 1, after which it is still.
    expect(fast.length).toBe(5);
    for (const c of fast) expect(c[3]).toBeCloseTo(MAX_PUSH, 9);
    const faster = run(0.2, 1 / 60, { signals: { x: [(t) => 0.1 + t * 4.8], y: [() => 0.5] }, params: { strength: 0.5 } });
    expect(faster.map((c) => c[3])).toEqual([MAX_PUSH / 2, MAX_PUSH / 2, MAX_PUSH / 2]);
    expect(run(0.5, 1 / 60, { signals: { x: [() => 0.4], y: [() => 0.4] } })).toEqual([]);
  });

  it('gives the same writes at any frame rate', () => {
    const at = (dt: number) => run(1, dt, { signals: moving, params: { mode: 'push' } });
    const reference = at(1 / 60);
    expect(reference.length).toBeGreaterThan(10);
    for (const dt of [1 / 30, 1 / 120, 1 / 144]) {
      const calls = at(dt);
      expect(calls.length).toBe(reference.length);
      calls.forEach((c, i) => c.forEach((v, j) => (typeof v === 'number' ? expect(v).toBeCloseTo(reference[i]![j] as number, 9) : expect(v).toBe(reference[i]![j]))));
    }
  });

  it('measures motion from its own samples, so a source that answers earlier times from its latest state still pushes', () => {
    // Like Pointer read from frame(): every read answers with the latest position, whatever time it asks about.
    let latest = 0.2;
    const signals = { x: [() => latest], y: [() => 0.3] };
    const state: NodeState = {};
    const writer = writerOf(state);
    const calls: Call[] = [];
    for (let f = 0; f < 30; f++) {
      latest = 0.2 + 0.5 * ((f + 1) / 60);
      frame(force, f / 60, (f + 1) / 60, { state, signals, dt: 1 / 60 });
      calls.push(...written(writer));
    }
    // A tick every 50 ms from 0.05 s on, each pushing right at about 0.5 units/s × 30 × Strength 0.5.
    expect(calls.length).toBe(9);
    for (const c of calls) expect(c[3]).toBeCloseTo(0.5 * PUSH_GAIN * 0.5, 1);
  });

  it('treats a jump as no push: a ramp wrapping round, or a contact moving to a new spot', () => {
    const ramp = run(2, 1 / 60, { signals: { x: [(t) => (t * 0.5) % 0.5], y: [() => 0.5] } });
    // 0.5 wraps to 0 at t = 1: that tick's move is backwards by nearly 0.5, a jump.
    expect(ramp.length).toBe(38);
    expect(ramp.every((c) => (c[3] as number) > 0)).toBe(true);
  });

  it('only pushes while Active, and not on the tick a contact lands', () => {
    const active = [(t: number) => (t >= 0.2 && t < 0.4 ? 1 : 0)];
    const calls = run(1, 1 / 60, { signals: { ...moving, active } });
    // Ticks 0.20–0.35 are active; 0.20 has no active tick before it.
    expect(calls.length).toBe(3);
    expect(run(1, 1 / 60, { signals: { ...moving, active: [() => 0.49] } })).toEqual([]);
  });

  it('makes Hold’s whirlpool: a vortex ringed by four inward pushes', () => {
    const calls = run(1 / 60, 1 / 60, { params: { mode: 'whirlpool', strength: 1, radius: 0.12 } });
    expect(calls.length).toBe(5);
    expect(calls[0]).toEqual(['pulse', 0.5, 0.5, 0.35, 0.12, 1]);
    const pushes = calls.slice(1);
    for (const [, x, y, dx, dy, radius] of pushes) {
      expect(Math.hypot((x as number) - 0.5, (y as number) - 0.5)).toBeCloseTo(0.08);
      // Inward: the push points back at the center.
      expect(((x as number) - 0.5) * (dx as number) + ((y as number) - 0.5) * (dy as number)).toBeLessThan(0);
      expect(Math.hypot(dx as number, dy as number)).toBeCloseTo(30);
      expect(radius).toBeCloseTo(0.06);
    }
  });

  it('makes Orbit’s twin whirlpools, turning opposite ways, with Spin choosing the direction', () => {
    const twin = (options: Options) => run(1 / 60, 1 / 60, { ...options, params: { mode: 'twin', strength: 0.5, radius: 0.15, ...(options.params ?? {}) } });
    const calls = twin({ signals: { x: [() => 0.3], y: [() => 0.6] } });
    expect(calls[0]).toEqual(['pulse', 0.3, 0.6, 0.575, 0.15, 1]);
    expect(calls[1]![0]).toBe('pulse');
    expect(calls[1]![1]).toBeCloseTo(0.42);
    expect(calls[1]!.slice(2, 4)).toEqual([0.6, 0.25]);
    expect(calls[1]![4]).toBeCloseTo(0.12);
    expect(calls[1]![5]).toBe(-1);
    expect(twin({ params: { direction: 'counter-clockwise' } }).map((c) => c[5])).toEqual([-1, 1]);
    expect(twin({ signals: { spin: [() => -2] } }).map((c) => c[5])).toEqual([-1, 1]);
    expect(twin({ signals: { spin: [() => 0] }, params: { direction: 'counter-clockwise' } }).map((c) => c[5])).toEqual([1, -1]);
  });

  it('writes its queue once, and drops a queue no Fluid wrote', () => {
    const state: NodeState = {};
    const writer = writerOf(state);
    frame(force, 0, 1 / 60, { state, params: { mode: 'twin' } });
    expect(written(writer)).toHaveLength(2);
    expect(written(writer)).toEqual([]);
    expect(writerOf(state)).toBe(writer);
    frame(force, 0.05, 0.06, { state, params: { mode: 'twin' } });
    frame(force, 0.1, 0.11, { state, params: { mode: 'twin' } });
    expect(written(writer)).toHaveLength(2);
  });

  it('gives defined writes for hostile input', () => {
    const calls = run(0.3, 1 / 60, { signals: { x: [() => NaN], y: [(t) => (t > 0.1 ? Infinity : -5)], spin: [() => NaN] }, params: { mode: 'whirlpool', strength: 99, radius: -1, direction: 'sideways' } });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) for (const v of call.slice(1)) expect(Number.isFinite(v)).toBe(true);
    for (const [, x, y] of calls) expect((x as number) >= 0 && (x as number) <= 1 && (y as number) >= 0 && (y as number) <= 1).toBe(true);
    expect(run(0.3, 1 / 60, { params: { mode: 'gust', strength: 0 } })).toEqual([]);
    expect(run(0.3, 1 / 60, { params: { mode: 'gust' } })).toEqual([]);
  });

  it('moves the fluid in a running patch, Clock phase sweeping X', () => {
    const backend = createInProcessFluid();
    const recorded: FluidWork[] = [];
    const spy: FluidBackend = { latch: () => backend.latch(), latched: () => backend.latched(), reset: () => backend.reset(), step: (work) => { recorded.push(work); backend.step(work); } };
    const node = (id: string, type: string, params = {}) => ({ id, type, typeVersion: nodeRegistry.get(type)!.version, params, position: { x: 0, y: 0 } });
    const cable = (from: string, fromPort: string, to: string, toPort: string) => ({ from: { node: from, port: fromPort }, to: { node: to, port: toPort } });
    const patch: Patch = {
      format: 'flowpatch', version: 1, seed: 4,
      nodes: [node('c', 'clock', { bpm: 30 }), node('p', 'force', { strength: 1 }), node('f', 'fluid')],
      cables: [cable('c', 'phase', 'p', 'x'), cable('p', 'write', 'f', 'writers')],
    };
    const compiled = compilePatch(patch, nodeRegistry);
    expect(compiled.ok ? [] : compiled.errors).toEqual([]);
    if (!compiled.ok) return;
    const rt = new Runtime(compiled.plan, { services: { fluid: spy } });
    rt.query(0, 1);
    for (let f = 0; f < 30; f++) rt.frame(f / 60, (f + 1) / 60, 1 / 60);
    const forces = recorded.flatMap((w) => w.splats).filter((s) => s[0] === 'force');
    // Phase rises at 0.5 per second, so each push is +0.5 × 30 along x.
    expect(forces.length).toBe(9);
    for (const f of forces) expect(f[3]).toBeCloseTo(15);
    // Replay the recorded work through the solver, with and without the pushes: the water near the
    // last push moves right only with them.
    const replay = (withForces: boolean) => {
      const { w, h } = recorded[0]!.grid;
      const sim = new Fluid(w, h);
      for (const work of recorded) {
        Object.assign(sim, work.params);
        for (const write of work.splats) if (withForces || write[0] !== 'force') applyFluidWrite(sim, write);
        sim.step(work.dt);
      }
      const last = forces.at(-1)!;
      const k = Math.round((last[1] as number) * w) + Math.round((last[2] as number) * h) * w;
      return sim.u[k]!;
    };
    expect(replay(false)).toBe(0);
    expect(replay(true)).toBeGreaterThan(1);
  });
});
