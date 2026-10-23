import type { Page } from '@playwright/test';
import type { LivePatch } from '../packages/editor/src/live';

/** One audio callback, in seconds: how far currentTime can move between two reads in one handler.
 *  It depends on the platform's audio output (256 frames on macOS), so it comes from the page:
 *  Chromium reports the callback buffer as baseLatency. currentTime moves in render quanta of 128
 *  frames, up to a callback at a time, so the largest step seen over 200 ms backs it up. */
export async function audioCallback(page: Page): Promise<{ callback: number; largestStep: number }> {
  return page.evaluate(() => {
    const live = (window as Window & { flowPatcher?: LivePatch }).flowPatcher!;
    let largestStep = 0;
    let last = live.clock.currentTime;
    for (const end = performance.now() + 200; performance.now() < end; ) {
      const now = live.clock.currentTime;
      largestStep = Math.max(largestStep, now - last);
      last = now;
    }
    return { callback: live.clock.baseLatency || largestStep, largestStep };
  });
}
