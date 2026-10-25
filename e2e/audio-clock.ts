import type { Page } from '@playwright/test';
import type { LivePatch } from '../packages/editor/src/live';

/** One audio callback, in seconds: how far currentTime can move between two reads in one handler.
 *  It depends on the platform's audio output (256 frames on macOS), so it comes from the page:
 *  Chromium reports the callback buffer as baseLatency. currentTime moves in render quanta of 128
 *  frames, up to a callback at a time, so the largest step seen backs it up. That is the larger of
 *  a 200 ms sample taken now and the largest step the editor's clock reads met over the whole run
 *  (`LivePatch.clock.largestStep`, #97), so a callback jump at the resume or during a push, which a
 *  sample taken afterwards can miss, still counts. Call it after the part of the run being checked. */
export async function audioCallback(page: Page): Promise<{ callback: number; largestStep: number; sampledStep: number }> {
  return page.evaluate(() => {
    const live = (window as Window & { flowPatcher?: LivePatch }).flowPatcher!;
    let sampledStep = 0;
    let last = live.clock.currentTime;
    for (const end = performance.now() + 200; performance.now() < end; ) {
      const now = live.clock.currentTime;
      sampledStep = Math.max(sampledStep, now - last);
      last = now;
    }
    const largestStep = Math.max(sampledStep, live.clock.largestStep);
    return { callback: live.clock.baseLatency || largestStep, largestStep, sampledStep };
  });
}
