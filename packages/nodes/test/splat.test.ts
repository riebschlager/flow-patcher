import { describe, expect, it } from 'vitest';
import {
  canonicalDyes,
  compilePatch,
  createInProcessFluid,
  isFluidWriter,
  randomAt,
  Runtime,
  timeKey,
  type EngineEvent,
  type FluidBackend,
  type FluidTarget,
  type FluidWork,
  type FluidWriter,
  type NodeState,
  type Patch,
} from '@flow-patcher/engine';
import { nodeRegistry, splat } from '../src';
import { context, frame } from './helpers';

type Call = Parameters<FluidTarget['splat']>;

/** The node's writer, over the given state. */
function writerOf(state: NodeState, options: Parameters<typeof context>[1] = {}): FluidWriter {
  const writer = splat.field!(context(splat, { ...options, state }), 'write');
  if (!isFluidWriter(writer)) throw new Error('Splat.write is not a FluidWriter');
  return writer;
}

/** Calls `write` once and returns what it splatted. */
function written(writer: FluidWriter): Call[] {
  const calls: Call[] = [];
  writer.write({ splat: (...call) => void calls.push(call) });
  return calls;
}

/** Runs one frame over `events` and returns what the writer then splats. */
function splatsFor(events: EngineEvent[], options: Omit<Parameters<typeof frame>[3] & object, 'inputs' | 'state'> = {}): Call[] {
  const state: NodeState = {};
  frame(splat, 0, 1 / 60, { ...options, state, inputs: { at: events } });
  return written(writerOf(state));
}

const seeded = (seed: number, nodeId: string, time: number, channel: number, axis: 'x' | 'y') => 0.15 + 0.7 * randomAt(seed, nodeId, timeKey(time), channel, axis);

/** A backend that records the work Fluid hands it and steps nothing. */
function spy(): FluidBackend & { work: FluidWork[] } {
  return { work: [], latch() {}, latched: () => null, step(work) { this.work.push(work); }, reset() {} };
}

const node = (id: string, type: string, params = {}) => ({ id, type, typeVersion: nodeRegistry.get(type)!.version, params, position: { x: 0, y: 0 } });
const cable = (from: string, fromPort: string, to: string, toPort: string) => ({ from: { node: from, port: fromPort }, to: { node: to, port: toPort } });
/** Pointer.down → Splat.at → Splat.write → Fluid.writers. */
function runtime(fluid: FluidBackend, params = {}): Runtime {
  const patch: Patch = {
    format: 'flowpatch', version: 1, seed: 3,
    nodes: [node('p', 'pointer'), node('s', 'splat', params), node('f', 'fluid')],
    cables: [cable('p', 'down', 's', 'at'), cable('s', 'write', 'f', 'writers')],
  };
  const compiled = compilePatch(patch, nodeRegistry);
  if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
  return new Runtime(compiled.plan, { services: { fluid } });
}

describe('splat', () => {
  it('has an At event input, a Write output for Fluid, and Size and Color', () => {
    expect(splat.ports).toEqual([
      { name: 'at', type: 'event', direction: 'in', label: 'At' },
      { name: 'write', type: 'field', direction: 'out', label: 'Write', fieldKind: 'write' },
    ]);
    expect(splat.params.map((p) => p.name)).toEqual(['size', 'color']);
    expect(splat.query).toBeUndefined();
    expect(splat.frame).toBeTypeOf('function');
  });

  it('splats at the event position with its size, in event order', () => {
    const calls = splatsFor([{ time: 0, channel: 0, x: 0.25, y: 0.75 }, { time: 0.01, channel: 0, x: 0.9, y: 0.1 }], { params: { size: 0.06 } });
    expect(calls).toEqual([
      [0.25, 0.75, [...canonicalDyes[0]!], 0.06],
      [0.9, 0.1, [...canonicalDyes[0]!], 0.06],
    ]);
  });

  it('places an event without x/y at the seeded point Fluid used, the same every time', () => {
    const event = { time: 0.5, channel: 2 };
    const calls = splatsFor([event], { seed: 7, nodeId: 's' });
    expect(calls[0]!.slice(0, 2)).toEqual([seeded(7, 's', 0.5, 2, 'x'), seeded(7, 's', 0.5, 2, 'y')]);
    expect(splatsFor([event], { seed: 7, nodeId: 's' })).toEqual(calls);
    // Keyed by time, channel, node and seed; one missing coordinate falls back alone.
    expect(splatsFor([{ time: 0.5, channel: 3 }], { seed: 7, nodeId: 's' })[0]!.slice(0, 2)).not.toEqual(calls[0]!.slice(0, 2));
    expect(splatsFor([event], { seed: 8, nodeId: 's' })[0]!.slice(0, 2)).not.toEqual(calls[0]!.slice(0, 2));
    expect(splatsFor([{ time: 0.5, channel: 2, x: 0.3 }], { seed: 7, nodeId: 's' })[0]!.slice(0, 2)).toEqual([0.3, seeded(7, 's', 0.5, 2, 'y')]);
  });

  it('colors each channel by its index, else its channel, unless Color fixes a dye', () => {
    const events: EngineEvent[] = [0, 1, 2, 3, 4].map((channel) => ({ time: 0, channel, x: 0.5, y: 0.5 }));
    expect(splatsFor(events).map((c) => c[2])).toEqual([0, 1, 2, 3, 0].map((i) => [...canonicalDyes[i]!]));
    // An index wins over the channel: a clock's ticks cycle the four dyes.
    expect(splatsFor([{ time: 0, channel: 1, index: 6, x: 0.5, y: 0.5 }])[0]![2]).toEqual([...canonicalDyes[2]!]);
    expect(splatsFor(events, { params: { color: 'dye 3' } }).map((c) => c[2])).toEqual(events.map(() => [...canonicalDyes[2]!]));
  });

  it('scales the dye by velocity, clamped to 0–1', () => {
    const at = (velocity: number) => splatsFor([{ time: 0, channel: 0, x: 0.5, y: 0.5, velocity }])[0]![2];
    expect(at(0.5)).toEqual(canonicalDyes[0]!.map((c) => c * 0.5));
    expect(at(0)).toEqual([0, 0, 0]);
    expect(at(3)).toEqual([...canonicalDyes[0]!]);
    expect(at(NaN)).toEqual([...canonicalDyes[0]!]);
  });

  it('writes its queue once, then empties it, and drops a queue no Fluid wrote', () => {
    const state: NodeState = {};
    const writer = writerOf(state);
    frame(splat, 0, 1 / 60, { state, inputs: { at: [{ time: 0, channel: 0, x: 0.5, y: 0.5 }] } });
    expect(written(writer)).toHaveLength(1);
    expect(written(writer)).toEqual([]);
    // The writer is the same object every time, so Fluid can hold on to it.
    expect(writerOf(state)).toBe(writer);
    // Unwritten splats don't pile up across frames: each frame replaces the last one's queue.
    frame(splat, 1 / 60, 2 / 60, { state, inputs: { at: [{ time: 0.01, channel: 0, x: 0.1, y: 0.1 }] } });
    frame(splat, 2 / 60, 3 / 60, { state, inputs: { at: [{ time: 0.02, channel: 1, x: 0.9, y: 0.9 }] } });
    expect(written(writer).map((c) => c.slice(0, 2))).toEqual([[0.9, 0.9]]);
    // A frame with nothing due leaves nothing to write.
    frame(splat, 3 / 60, 4 / 60, { state });
    expect(written(writer)).toEqual([]);
  });

  it('applies an immediate-path event like any other, so the next frame splashes it', () => {
    const state: NodeState = {};
    const tap = { time: 5, channel: 1, x: 0.4, y: 0.6 };
    // The frame clock is far behind the tap's time; the runtime hands it over by arrival.
    frame(splat, 4.8, 4.816, { state, inputs: { at: [tap] }, immediate: [tap] });
    expect(written(writerOf(state)).map((c) => c.slice(0, 2))).toEqual([[0.4, 0.6]]);
  });

  it('lands a tap on the next frame in a Runtime, through Fluid', () => {
    const backend = spy();
    const rt = runtime(backend);
    rt.frame(0.6, 0.616, 1 / 60);
    rt.query(0.9, 1);
    rt.push('p', 'down', { time: 1.005, channel: 4, x: 0.2, y: 0.3 }, { now: 1, path: 'immediate' });
    rt.query(1, 1.025);
    rt.frame(0.616, 0.632, 1 / 60);
    rt.frame(0.632, 0.648, 1 / 60);
    expect(backend.work.map((w) => w.splats.length)).toEqual([0, 1, 0]);
    expect(backend.work[1]!.splats[0]!.slice(0, 2)).toEqual([0.2, 0.3]);
  });

  it('changes the Fluid image where the splat landed', () => {
    const fluid = createInProcessFluid();
    const rt = runtime(fluid, { size: 0.06 });
    rt.push('p', 'down', { time: 0.05, channel: 0, x: 0.25, y: 0.5 });
    rt.query(0, 0.5);
    for (let k = 0; k < 10; k++) rt.frame(k / 60, (k + 1) / 60, 1 / 60);
    // What Fluid's Field readers (the Renderer) see; Fluid has no image of its own.
    const image = fluid.latched()!;
    const brightness = (x: number, y: number) => {
      const i = (Math.round(x * image.width) + Math.round(y * image.height) * image.width) * 4;
      return image.pixels[i]! + image.pixels[i + 1]! + image.pixels[i + 2]!;
    };
    expect(brightness(0.25, 0.5)).toBeGreaterThan(brightness(0.75, 0.5) + 100);
  });

  it('gives defined, in-range splats for hostile events, and nothing for none', () => {
    expect(splatsFor([])).toEqual([]);
    const state: NodeState = {};
    frame(splat, 0, 1 / 60, { state });
    expect(written(writerOf(state))).toEqual([]);
    const hostile: EngineEvent[] = [
      { time: NaN, channel: -3, x: NaN, y: Infinity, index: 2.5 },
      { time: Infinity, channel: 2.5, x: 1e9, y: -1e9, velocity: -4 },
      { time: 0, channel: NaN, x: '0.5' as unknown as number, y: null as unknown as number, index: NaN, velocity: Infinity },
      { time: -1, channel: 1e12, x: -0, y: 1, index: -7 },
    ];
    const calls = splatsFor(hostile, { params: { size: 99, color: 'puce' } });
    expect(calls).toHaveLength(4);
    for (const [x, y, dye, size] of calls) {
      for (const v of [x, y]) expect(v >= 0 && v <= 1).toBe(true);
      expect(dye.every((c) => Number.isFinite(c) && c >= 0 && c <= 1)).toBe(true);
      // Clamped to the knob's range; an unknown color falls back to by-event.
      expect(size).toBe(0.2);
    }
    expect(calls[1]!.slice(0, 2)).toEqual([1, 0]);
    expect(calls[1]![2]).toEqual([0, 0, 0]);
    expect(calls[3]![2]).toEqual([...canonicalDyes[1]!]);
    expect(splatsFor(hostile, { params: { size: 99, color: 'puce' } })).toEqual(calls);
  });
});
