import { expect, test, type Page } from '@playwright/test';
import { CATCH_UP_LIMIT, IMMEDIATE_OFFSET } from '../packages/engine/src/scheduler';
import type { LivePatch } from '../packages/editor/src/live';
import { burstProbeReady, installBurstProbe } from './audio-burst';
import { audioCallback, stepLog } from './audio-clock';

/** One oscillator start(): its `when`, currentTime when it was called, and the oscillator's frequency then. */
interface Start {
  when: number;
  at: number;
  hz: number;
}

declare global {
  interface Window {
    flowPatcher?: LivePatch;
    firstNoteStarts?: Start[];
  }
}

// A note at t=0 plays (#105). The AudioContext is suspended until the first tap
// resumes it, and by the first running wake its clock is already past 0. That wake
// starts the patch at 0 and catches [0, now) up, moved to start at now + 5 ms (ADR 0017,
// with ADR 0033's lead), so the Clock's t=0 note sounds 5 ms after the resume instead of
// the next tick, a whole period later. The tap's own note, held for the resume, has the
// same 5 ms lead from a later clock read, so it follows at the same time or after.

const CLOCK_HZ = 440 * 2 ** ((60 - 69) / 12);
const TAP_HZ = 440 * 2 ** ((72 - 69) / 12);

/** Clock (one tick a second) → Make Note (C4), and Pointer Down → Make Note (C5), into one Simple Synth → Output. */
const patch = {
  format: 'flowpatch',
  version: 1,
  seed: 105,
  nodes: [
    { id: 'clock', type: 'clock', typeVersion: 3, params: { bpm: 60, division: '1/4' }, position: { x: 0, y: 0 } },
    { id: 'pointer', type: 'pointer', typeVersion: 2, params: {}, position: { x: 0, y: 200 } },
    { id: 'clock-note', type: 'make-note', typeVersion: 2, params: { pitch: 60, length: 0.2 }, position: { x: 240, y: 0 } },
    { id: 'tap-note', type: 'make-note', typeVersion: 2, params: { pitch: 72, length: 0.2 }, position: { x: 240, y: 200 } },
    { id: 'synth', type: 'simple-synth', typeVersion: 2, params: { level: 0.2 }, position: { x: 480, y: 100 } },
    { id: 'out', type: 'output', typeVersion: 2, params: {}, position: { x: 720, y: 100 } },
  ],
  cables: [
    { from: { node: 'clock', port: 'tick' }, to: { node: 'clock-note', port: 'trigger' } },
    { from: { node: 'pointer', port: 'down' }, to: { node: 'tap-note', port: 'trigger' } },
    { from: { node: 'clock-note', port: 'note' }, to: { node: 'synth', port: 'note' } },
    { from: { node: 'tap-note', port: 'note' }, to: { node: 'synth', port: 'note' } },
    { from: { node: 'synth', port: 'audio' }, to: { node: 'out', port: 'audio' } },
  ],
};

const starts = (page: Page) => page.evaluate(() => window.firstNoteStarts!);

test('the first tap starts audio, and the t=0 Clock note sounds at once, before the tap\'s own note', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && !message.text().includes('favicon') && errors.push(message.text()));
  await page.addInitScript(() => {
    const seen: Start[] = (window.firstNoteStarts = []);
    const start = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function (this: OscillatorNode, when?: number) {
      seen.push({ when: when ?? 0, at: this.context.currentTime, hz: this.frequency.value });
      start.call(this, when);
    };
  });

  await installBurstProbe(page);
  await page.goto('/?patch=new');
  await page.getByTestId('open-file').setInputFiles({ name: 'first-note.flowpatch', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(patch)) });
  await expect(page.getByTestId('compile-status')).toContainText('6 nodes compiled');
  await expect(page.getByTestId('audio-state')).toHaveText('tap to start');
  expect(await page.evaluate(() => window.flowPatcher!.stats.windows)).toBe(0);

  // The probe must be in the graph before the tap resumes the context, so it sees the resume's bursts.
  await burstProbeReady(page);
  await page.getByTestId('performance-canvas').click({ position: { x: 40, y: 40 } });
  await expect(page.getByTestId('audio-state')).toHaveText('live');
  // The tap's note, and the first running wake (when the resume let the scheduler query).
  await expect.poll(async () => (await starts(page)).some((s) => Math.abs(s.hz - TAP_HZ) < 1)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.flowPatcher!.stats.firstWake)).not.toBeNull();
  // Both notes, if the first wake caught up, long before the Clock's second tick at 1 s.
  await page.waitForTimeout(100);
  const seen = await starts(page);
  const stats = await page.evaluate(() => window.flowPatcher!.stats);
  const tap = await page.evaluate(() => window.flowPatcher!.taps[0]!);
  // One clock step (ADR 0027): the largest of baseLatency, the sampled step and the audio thread's largest burst.
  const steps = await audioCallback(page);
  const { step } = steps;
  const ms = (s: number) => (s * 1000).toFixed(2);
  console.log(`[first note] first wake at ${ms(stats.firstWake!)} ms; starts ${seen.map((s) => `${Math.round(s.hz)} Hz at ${ms(s.when)} (called at ${ms(s.at)})`).join(', ')}; ` +
    `catch-ups ${stats.catchUps} (worst ${stats.catchUpMaxMs.toFixed(2)} ms), caught up ${stats.caughtUp}, ` +
    `late ${stats.lateCaughtUp} caught up (worst ${stats.lateCaughtUpMaxMs.toFixed(2)} ms, main thread ${stats.lateCaughtUpWakeMs.toFixed(2)} ms from its wake to its hand-over), ${stats.lateScheduled} scheduled, ${stats.lateImmediate} immediate; stalls ${stats.stalls}; one step ${ms(step)} ms: ${stepLog(steps)}`);

  // A startup slower than the catch-up limit starts the patch at the first wake and drops the t=0 tick by design.
  expect(stats.firstWake!, `first wake ${ms(stats.firstWake!)} ms past 0, beyond the ${ms(CATCH_UP_LIMIT)} ms catch-up limit; t=0 dropped by design (ADR 0033)`)
    .toBeLessThanOrEqual(CATCH_UP_LIMIT);
  const clockNote = seen.find((s) => Math.abs(s.hz - CLOCK_HZ) < 1);
  const tapNote = seen.find((s) => Math.abs(s.hz - TAP_HZ) < 1);
  // The t=0 tick, caught up: the first wake moved it to its own clock reading plus the 5 ms lead (ADR 0033), not
  // 1 s later, also when that reading is exactly 0 (a catch-up of [0, 0]). A clock burst during that wake longer
  // than the lead can leave it behind currentTime (the runtime moves it to the clock at hand-over and counts it in
  // lateCaughtUp; Web Audio plays it at once). How far it moved is that lateness, so it has the same bound: one step
  // plus the main thread's time from its wake's start to its hand-over (ADR 0033).
  expect(clockNote, 'the t=0 Clock note was never started').toBeDefined();
  expect(stats.caughtUp).toBeGreaterThanOrEqual(1);
  const lead = IMMEDIATE_OFFSET;
  expect(clockNote!.when).toBeGreaterThanOrEqual(stats.firstWake! + lead - 1e-9);
  expect(clockNote!.when - (stats.firstWake! + lead)).toBeLessThanOrEqual(step + stats.lateCaughtUpWakeMs / 1000 + 1e-6);
  expect(clockNote!.at - clockNote!.when).toBeLessThanOrEqual(step + 1e-6);
  expect(seen.indexOf(clockNote!)).toBeLessThan(seen.indexOf(tapNote!));
  // The tap, held while audio was stopped, is stamped currentTime + 5 ms by the same wake, after the catch-up.
  expect(tap.cold).toBe(true);
  // Its push read the clock after that wake handed the t=0 note over, and both have the 5 ms lead: the tap's note
  // is at the same time or after it.
  expect(tapNote!.at - tapNote!.when).toBeLessThanOrEqual(step + 1e-6);
  expect(tapNote!.when - clockNote!.when).toBeGreaterThanOrEqual(IMMEDIATE_OFFSET - lead - 1e-6);
  // At least the pointerdown was held (the context may already run by the pointerup, under load).
  expect(stats.deferredPushes).toBeGreaterThanOrEqual(1);
  expect(stats.lateScheduled).toBe(0);
  // A caught-up event may be late by one step plus the main thread's time from its wake's start to its hand-over (ADRs 0027, 0033).
  expect(stats.lateCaughtUpMaxMs).toBeLessThanOrEqual(step * 1000 + stats.lateCaughtUpWakeMs + 1e-3);

  // And it keeps time from there: the next tick at 1 s. That holds because the first wake was within the
  // catch-up limit (asserted above); a slower start begins at now and its first tick would be this one.
  await expect.poll(async () => (await starts(page)).filter((s) => Math.abs(s.hz - CLOCK_HZ) < 1).length, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
  const ticks = (await starts(page)).filter((s) => Math.abs(s.hz - CLOCK_HZ) < 1);
  expect(ticks[1]!.when).toBeCloseTo(1, 9);
  expect(errors).toEqual([]);
});
