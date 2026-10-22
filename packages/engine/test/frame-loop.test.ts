// The frame clock (design.md, "Visual nodes run on the frame clock"): frames
// run over the audio clock shifted back by the output latency.
import { describe, expect, it } from 'vitest';
import { FALLBACK_FRAME_DT, FrameLoop, MAX_FRAME_DT, outputLatencyOf, type FrameClock, type FrameTimer } from '../src';

function setup(latency: number | (() => number) = 0) {
  const clock = { audio: 0, wall: 0 };
  const frames: [number, number, number][] = [];
  const source: FrameClock = {
    audioTime: () => clock.audio,
    wallTime: () => clock.wall,
    outputLatency: typeof latency === 'number' ? () => latency : latency,
  };
  const loop = new FrameLoop({ frame: (t0, t1, dt) => void frames.push([t0, t1, dt]) }, { clock: source });
  /** Moves both clocks by `ms` and ticks. */
  const at = (ms: number) => {
    clock.audio += ms / 1000;
    clock.wall += ms;
    return loop.tick();
  };
  return { clock, frames, loop, at };
}

describe('FrameLoop', () => {
  it('runs frames over the audio clock shifted back by the output latency', () => {
    const { frames, at } = setup(0.2);
    at(1000);
    at(16);
    at(17);
    expect(frames[0]![0]).toBeCloseTo(0.8, 12);
    expect(frames[0]![1]).toBeCloseTo(0.8, 12);
    expect(frames[1]![1]).toBeCloseTo(0.816, 12);
    expect(frames[2]![1]).toBeCloseTo(0.833, 12);
    // Contiguous: each frame starts where the last ended.
    expect(frames[1]![0]).toBe(frames[0]![1]);
    expect(frames[2]![0]).toBe(frames[1]![1]);
  });

  it('starts with an empty frame and the fallback dt, and clamps dt like Flow', () => {
    const { frames, at, clock, loop } = setup();
    at(500);
    at(10);
    at(250); // a long frame (a hidden tab, a stall)
    clock.audio += 0.01; // the wall clock didn't move
    loop.tick();
    expect(frames.map((f) => f[2])).toEqual([FALLBACK_FRAME_DT, 0.01, MAX_FRAME_DT, FALLBACK_FRAME_DT]);
    expect(frames[0]![0]).toBe(frames[0]![1]);
  });

  it('never moves the frame clock back when the latency grows', () => {
    let latency = 0.01;
    const { frames, at } = setup(() => latency);
    at(1000);
    at(16);
    latency = 0.25; // a Bluetooth headset connects
    at(16);
    at(16);
    for (const [t0, t1] of frames) expect(t1).toBeGreaterThanOrEqual(t0);
    for (let i = 1; i < frames.length; i++) expect(frames[i]![0]).toBe(frames[i - 1]![1]);
    expect(frames.at(-1)![1]).toBeCloseTo(1.006, 12);
  });

  it('treats a missing, NaN or negative latency as 0', () => {
    for (const bad of [NaN, -1, Infinity]) {
      const { at } = setup(bad);
      expect(at(1000).latency).toBe(0);
    }
    expect(outputLatencyOf({ outputLatency: 0.264, baseLatency: 0.01 })).toBe(0.264);
    expect(outputLatencyOf({ outputLatency: 0, baseLatency: 0.01 })).toBe(0.01);
    expect(outputLatencyOf({})).toBe(0);
    expect(outputLatencyOf({ baseLatency: NaN })).toBe(0);
  });

  it('starts afresh after reset, and runs on an injected timer', () => {
    const { frames, at, loop, clock } = setup();
    at(100);
    at(16);
    loop.reset();
    at(16);
    expect(frames[2]![0]).toBe(frames[2]![1]);

    let tick: (() => void) | null = null;
    const timer: FrameTimer = {
      everyFrame(t) {
        tick = t;
        return () => (tick = null);
      },
    };
    const driven: number[] = [];
    const timed = new FrameLoop({ frame: (_t0, t1) => void driven.push(t1) }, { clock: { audioTime: () => clock.audio, wallTime: () => clock.wall }, timer });
    timed.start();
    tick!();
    tick!();
    timed.halt();
    expect(tick).toBeNull();
    expect(driven).toHaveLength(2);
    expect(() => new FrameLoop({ frame() {} }, { clock: { audioTime: () => 0, wallTime: () => 0 } }).start()).toThrow(/timer/);
  });
});
