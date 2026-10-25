import type { Page } from '@playwright/test';
import type { LivePatch } from '../packages/editor/src/live';
import type { BurstProbe } from './audio-burst';

/** One audio clock step, in seconds (ADR 0027): how far currentTime can move at once, so between two
 *  reads in one handler. The larger of three measurements:
 *  - `callback`: what Chromium reports as baseLatency (or the sampled step without it);
 *  - `largestStep`: the largest move of currentTime over 200 ms sampled now;
 *  - `burstStep`: the most render quanta the audio thread ran back to back over the whole test,
 *    × 128 / sampleRate, from the burst probe (installBurstProbe, before page.goto; 0 without it).
 *    It sees the 512-frame bursts around the resume that a 200 ms sample afterwards misses, and it
 *    is measured on the audio thread, so a slow push can't widen it.
 *  `runStep`, the largest step the editor's own clock reads met over the run (#97), is for the logs
 *  only: a jump during the very push a bound checks would land in it. */
export async function audioCallback(page: Page): Promise<{ step: number; callback: number; largestStep: number; burstStep: number; burst: BurstProbe | null; note: string | null; runStep: number }> {
  return page.evaluate(() => {
    const live = (window as Window & { flowPatcher?: LivePatch }).flowPatcher!;
    const burst = (window as Window & { fpBurstProbe?: BurstProbe }).fpBurstProbe ?? null;
    const runStep = live.clock.largestStep;
    let largestStep = 0;
    let last = live.clock.currentTime;
    for (const end = performance.now() + 200; performance.now() < end; ) {
      const now = live.clock.currentTime;
      largestStep = Math.max(largestStep, now - last);
      last = now;
    }
    const callback = live.clock.baseLatency || largestStep;
    // Installed but never ran (the module failed, or the context never started): a silent 0 would hide it.
    if (burst && !(burst.ready && burst.calls > 0)) throw new Error(`the burst probe was installed but never ran (ready ${burst.ready}, ${burst.calls} process() calls)`);
    // Date.now() only tells calls 1 ms apart from calls in one burst while a quantum is 2 ms or more (≤ 48 kHz).
    // Above that, back-to-back quanta all read as one burst, without limit: no burst step.
    const unusable = burst !== null && burst.clock === 'Date' && burst.sampleRate > 48000;
    const burstStep = burst && !unusable ? burst.step : 0;
    const note = unusable ? `Date clock at ${burst!.sampleRate} Hz can't tell quanta apart, burst step not used` : null;
    return { step: Math.max(callback, largestStep, burstStep), callback, largestStep, burstStep, burst: burst && { ...burst }, note, runStep };
  });
}

/** The three measurements behind one step, for a log line. */
export const stepLog = ({ callback, largestStep, burstStep, burst, note, runStep }: Awaited<ReturnType<typeof audioCallback>>): string => {
  const ms = (s: number) => (s * 1000).toFixed(2);
  return `baseLatency/callback ${ms(callback)} ms, sampled step ${ms(largestStep)} ms, burst step ${ms(burstStep)} ms` +
    (burst ? ` (${burst.largest} quanta at ${burst.sampleRate} Hz over ${burst.calls} calls, ${burst.clock} clock${note ? `; ${note}` : ''})` : ' (no probe)') +
    `; run step ${ms(runStep)} ms (logged only)`;
};
