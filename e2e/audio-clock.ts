import { expect, type Page } from '@playwright/test';
import type { LivePatch } from '../packages/editor/src/live';

type Live = Window & { flowPatcher?: LivePatch };

/** Waits until the page has measured the audio clock's step (ADR 0028), so the immediate offset
 *  no longer rests on baseLatency. Specs that time taps call this first. */
export async function clockStepKnown(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window as Live).flowPatcher!.clock.stepKnown), { timeout: 10_000 }).toBe(true);
}

/** The audio clock's step, in seconds: how far currentTime can move between two reads in one handler.
 *  It depends on the platform (5.33 ms callbacks on macOS; ~2.9 ms steps on Linux CI, which reports a
 *  10 ms baseLatency), so the page measures it (ADR 0028). This also reads the clock for 200 ms to log
 *  the largest step seen; that blocks the page, so call it after the timed taps, not before. */
export async function audioClock(page: Page): Promise<{ step: number; baseLatency: number; largestStep: number }> {
  await clockStepKnown(page);
  return page.evaluate(() => {
    const live = (window as Live).flowPatcher!;
    let largestStep = 0;
    let last = live.clock.currentTime;
    for (const end = performance.now() + 200; performance.now() < end; ) {
      const now = live.clock.currentTime;
      largestStep = Math.max(largestStep, now - last);
      last = now;
    }
    return { step: live.clock.step, baseLatency: live.clock.baseLatency, largestStep };
  });
}
