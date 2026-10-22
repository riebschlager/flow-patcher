// The fluid backend (ADR 0016): the worker's step function and protocol give
// the same pixels as the in-process backend, and FluidHost keeps the M0 spike's
// host rules (one step in flight, owed dt, recycled buffers, errors reset busy).
import { describe, expect, it } from 'vitest';
import {
  canonicalDyes,
  createFluidColorizer,
  createFluidStepper,
  createInProcessFluid,
  Fluid,
  MAX_OWED_SPLATS,
  fluidReplyTransfer,
  FluidHost,
  fluidSolverParams,
  renderFluidPixels,
  type FluidStepReply,
  type FluidStepRequest,
  type FluidWork,
  type SplatArgs,
} from '../src';

const GRID = { w: 48, h: 32 };
const DT = 1 / 60;

/** Frame k's work: a splat every third frame, knobs that move, a palette change halfway. */
function work(k: number): FluidWork {
  const dye = canonicalDyes[k % 4]!;
  const splats: SplatArgs[] = k % 3 === 0 ? [[0.2 + (k % 5) * 0.15, 0.3 + (k % 4) * 0.1, dye[0], dye[1], dye[2], 0.08, Math.sin(k) * 30, 19]] : [];
  return {
    dt: [DT, 1 / 120, 0.033][k % 3]!,
    grid: GRID,
    params: fluidSolverParams((k % 9) / 8, (k % 7) / 6, (k % 5) / 4),
    palette: k < 12 ? 'classic' : 'tide',
    splats,
    time: k * DT,
  };
}

/**
 * A Worker stand-in: requests and replies cross by structured clone with their
 * transfer lists, as postMessage does, and replies wait until `deliver()`.
 */
function emulatedWorker() {
  const step = createFluidStepper();
  const inbox: FluidStepReply[] = [];
  const requests: FluidStepRequest[] = [];
  let failNext = false;
  const host = new FluidHost((request, transfer) => {
    const received = structuredClone(request, { transfer });
    requests.push(received);
    if (failNext) {
      failNext = false;
      return;
    }
    const reply = step(received);
    // The stepper colors into the buffer it was handed back.
    if (received.recycle) expect(reply.pixels).toBe(received.recycle);
    inbox.push(structuredClone(reply, { transfer: fluidReplyTransfer(reply) }));
  });
  return {
    host,
    requests,
    deliver: () => {
      for (const reply of inbox.splice(0)) host.receive(reply);
    },
    dropNext: () => {
      failNext = true;
    },
    /** Replies waiting to be delivered. */
    inbox,
  };
}

describe('fluid stepper (the worker side)', () => {
  it('steps and colors like the solver and colorizer called directly', () => {
    const step = createFluidStepper();
    const sim = new Fluid(GRID.w, GRID.h);
    for (let k = 0; k < 20; k++) {
      const w = work(k);
      const reply = step({ ...w, generation: 0, seq: 1, recycle: null });
      sim.swirl = w.params.swirl;
      sim.persistence = w.params.persistence;
      sim.drag = w.params.drag;
      for (const [x, y, r, g, b, size, dx, dy] of w.splats) sim.splat(x, y, [r, g, b], size, dx, dy);
      sim.step(w.dt);
      const pixels = renderFluidPixels(sim, new Uint8ClampedArray(sim.n * 4), w.time, createFluidColorizer(w.palette));
      expect([reply.w, reply.h]).toEqual([GRID.w, GRID.h]);
      expect(reply.pixels, `frame ${k}`).toEqual(pixels);
    }
  });

  it('times the step and the colorizing with the clock it is given', () => {
    let t = 0;
    const reply = createFluidStepper(() => (t += 2))({ ...work(0), generation: 0, seq: 1, recycle: null });
    expect([reply.stepMs, reply.colorMs]).toEqual([2, 2]);
  });

  it('starts from still water when the generation changes, and ignores a recycled buffer of the wrong size', () => {
    const step = createFluidStepper();
    const dyed = step({ ...work(0), generation: 0, seq: 1, recycle: new Uint8ClampedArray(4) });
    expect(dyed.pixels.length).toBe(GRID.w * GRID.h * 4);
    const still = step({ ...work(1), splats: [], generation: 1, seq: 1, recycle: null });
    const fresh = createFluidStepper()({ ...work(1), splats: [], generation: 0, seq: 1, recycle: null });
    expect(still.pixels).toEqual(fresh.pixels);
    expect(still.generation).toBe(1);
  });
});

describe('FluidHost', () => {
  it('gives the same latched pixels in process and through a worker that keeps up', () => {
    const local = createInProcessFluid();
    const remote = emulatedWorker();
    for (let k = 0; k < 24; k++) {
      for (const backend of [local, remote.host]) backend.latch();
      expect(remote.host.latched()?.pixels, `frame ${k}`).toEqual(local.latched()?.pixels);
      local.step(work(k));
      remote.host.step(work(k));
      remote.deliver();
    }
    expect(local.latched()).not.toBeNull();
    // After the first two replies, every request hands a buffer back.
    expect(remote.requests.slice(2).every((r) => r.recycle !== null)).toBe(true);
  });

  it('latches only at the frame start: readers never see the step the frame starts', () => {
    const fluid = createInProcessFluid();
    fluid.latch();
    fluid.step(work(0));
    expect(fluid.latched()).toBeNull();
    fluid.latch();
    const first = fluid.latched();
    expect(first).not.toBeNull();
    fluid.step(work(1));
    expect(fluid.latched()).toBe(first);
  });

  it('keeps one step in flight, owing dt and queueing splats while busy', () => {
    const { host, requests, deliver } = emulatedWorker();
    host.step(work(0));
    host.step(work(3));
    host.step(work(6));
    expect(requests).toHaveLength(1);
    expect(host.pending).toBe(true);
    expect(host.stats).toMatchObject({ waitingFrames: 2, maxWaitingFrames: 2 });
    // The reply sends what waited at once, without waiting for the next frame:
    // dt summed, splats in order, the latest knobs.
    deliver();
    expect(requests).toHaveLength(2);
    const merged = requests[1]!;
    expect(merged.dt).toBeCloseTo(work(3).dt + work(6).dt, 12);
    expect(merged.splats).toEqual([...work(3).splats, ...work(6).splats]);
    expect(merged.params).toEqual(work(6).params);
    expect(host.stats).toMatchObject({ sent: 2, received: 1, merged: 1, waitingFrames: 0, maxWaitingFrames: 2 });
  });

  it('caps the splats waiting for a worker that never answers, dropping the oldest, and counts the wait', () => {
    const { host, requests } = emulatedWorker();
    const splat = (i: number): SplatArgs => [i / 1000, 0.5, 1, 0, 0, 0.05, 0, 0];
    // The worker dies before replying: nothing ever comes back.
    host.step({ ...work(1), splats: [] });
    for (let frame = 0; frame < 100; frame++) host.step({ ...work(1), splats: [splat(frame * 3), splat(frame * 3 + 1), splat(frame * 3 + 2)] });
    expect(requests).toHaveLength(1);
    expect(host.stats).toMatchObject({ waitingFrames: 100, maxWaitingFrames: 100, droppedSplats: 300 - MAX_OWED_SPLATS });
    // The host gives up on it (onerror); the next frame sends the newest splats, in order.
    host.fail('worker died');
    host.step({ ...work(1), splats: [] });
    expect(requests[1]!.splats).toHaveLength(MAX_OWED_SPLATS);
    expect(requests[1]!.splats[0]).toEqual(splat(300 - MAX_OWED_SPLATS));
    expect(requests[1]!.splats.at(-1)).toEqual(splat(299));
  });

  it('counts which steps the latched picture includes', () => {
    const { host, deliver } = emulatedWorker();
    host.step(work(0)); // step 1, sent
    host.step(work(1)); // step 2, waits
    expect([host.stepCount, host.latchedThrough]).toEqual([2, 0]);
    deliver(); // step 1 finished; steps 2 sent
    host.latch();
    expect(host.latchedThrough).toBe(1);
    host.step(work(2)); // step 3, waits
    deliver(); // step 2 finished; 3 sent
    deliver(); // step 3 finished
    host.latch();
    expect(host.latchedThrough).toBe(3);
    expect(host.stats).toMatchObject({ received: 3, latched: 2 });
    const local = createInProcessFluid();
    local.step(work(0));
    local.latch();
    expect(local.latchedThrough).toBe(1);
  });

  it('a slow worker gives the same pixels as in process with the same merged work', () => {
    const { host, deliver } = emulatedWorker();
    const local = createInProcessFluid();
    // Frames 0..5; the worker replies only every other frame.
    for (let k = 0; k < 6; k++) {
      host.latch();
      host.step(work(k));
      if (k % 2 === 1) deliver();
    }
    deliver();
    host.latch();
    // In process: frames 0 and 1 alone (1 goes out on 0's reply), then each pair merged as the host merged them.
    local.step(work(0));
    local.step(work(1));
    const pair = (a: number, b: number): FluidWork => ({ ...work(b), dt: work(a).dt + work(b).dt, splats: [...work(a).splats, ...work(b).splats] });
    local.step(pair(2, 3));
    local.step(pair(4, 5));
    local.latch();
    expect(host.latched()!.pixels).toEqual(local.latched()!.pixels);
    expect(host.stats).toMatchObject({ sent: 4, received: 4, merged: 2 });
  });

  it('recovers from a failed step: busy clears and the next frame sends again', () => {
    const { host, requests, dropNext, deliver } = emulatedWorker();
    dropNext();
    host.step(work(0));
    host.step(work(1));
    expect(requests).toHaveLength(1);
    host.fail('worker error');
    expect(host.pending).toBe(false);
    host.step(work(2));
    expect(requests).toHaveLength(2);
    deliver();
    host.latch();
    expect(host.latched()).not.toBeNull();
    expect(host.stats).toMatchObject({ failed: 1, received: 1, stale: 0 });
  });

  it('drops a reply that comes after fail() gave its step up, without taking the next step for it', () => {
    const { host, requests, inbox } = emulatedWorker();
    host.step(work(0));
    host.fail('spurious'); // the reply is still coming
    host.step(work(3)); // a new step goes out
    expect(requests).toHaveLength(2);
    host.receive(inbox.shift()!); // the late reply to the first
    expect(host.pending).toBe(true);
    host.latch();
    expect(host.latched()).toBeNull();
    host.receive(inbox.shift()!);
    host.latch();
    expect(host.latched()).not.toBeNull();
    expect(host.stats).toMatchObject({ received: 1, stale: 1, latched: 1 });
  });

  it('drops a reply from before a reset and starts the next step from still water', () => {
    const { host, deliver } = emulatedWorker();
    host.step(work(0));
    host.reset();
    deliver();
    host.latch();
    expect(host.latched()).toBeNull();
    host.step({ ...work(1), splats: [] });
    deliver();
    host.latch();
    const still = createInProcessFluid();
    still.step({ ...work(1), splats: [] });
    still.latch();
    expect(host.latched()!.pixels).toEqual(still.latched()!.pixels);
    expect(host.stats).toMatchObject({ received: 1, stale: 1 });
  });

  it('frees the busy flag if posting throws', () => {
    let throws = true;
    const host = new FluidHost(() => {
      if (throws) throw new Error('detached');
    });
    expect(() => host.step(work(0))).toThrow('detached');
    expect(host.pending).toBe(false);
    throws = false;
    host.step(work(1));
    expect(host.stats.sent).toBe(2);
  });
});
