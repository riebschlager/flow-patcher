// The clock step is measured from currentTime's jumps, not baseLatency (ADR 0028): the fallback
// until enough steps are seen, then the largest single jump, and no more reading after that.
import { describe, expect, it } from 'vitest';
import { ClockStep, STEP_SLICE_MS, STEPS_SAMPLED, STEPS_TRUSTED } from '../src/clock-step';

/** An audio clock that jumps by `steps` in turn every `every` reads, and a wall clock that ticks 0.01 ms a read. */
const clocks = (steps: number[], every = 5) => {
  let reads = 0;
  let time = 0;
  let wall = 0;
  let next = 0;
  return {
    reads: () => reads,
    read: () => {
      reads++;
      if (reads % every === 0) time += steps[next++ % steps.length]!;
      return time;
    },
    now: () => (wall += 0.01),
  };
};

describe('ClockStep', () => {
  it('uses the fallback until enough steps are seen, then the largest one', () => {
    const clock = clocks([0.0029, 0.0027]);
    const step = new ClockStep(clock.read, clock.now, () => 0.01);
    for (let i = 0; i < STEPS_TRUSTED - 1; i++) step.sample();
    expect(step.known).toBe(false);
    expect(step.value()).toBe(0.01);
    step.sample();
    expect(step.known).toBe(true);
    expect(step.value()).toBeCloseTo(0.0029, 12);
  });

  it('reads for at most one slice when the clock does not move', () => {
    const clock = clocks([0.005], Infinity);
    const step = new ClockStep(clock.read, clock.now, () => 0.005);
    step.sample();
    // One read before the loop, then one per 0.01 ms wall tick until the slice ends.
    expect(clock.reads()).toBeLessThanOrEqual(STEP_SLICE_MS / 0.01 + 2);
    expect(step.known).toBe(false);
  });

  it('ignores a clock that goes back, and stops reading once it has sampled enough', () => {
    const clock = clocks([-0.1, 0.00533, 0.00267]);
    const step = new ClockStep(clock.read, clock.now, () => 0.01);
    for (let i = 0; i < STEPS_SAMPLED * 2; i++) step.sample();
    expect(step.value()).toBeCloseTo(0.00533, 12);
    const reads = clock.reads();
    step.sample();
    expect(clock.reads()).toBe(reads);
  });
});
