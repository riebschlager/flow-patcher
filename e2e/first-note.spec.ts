import { expect, test, type Page } from '@playwright/test';
import { IMMEDIATE_OFFSET } from '../packages/engine/src/scheduler';
import type { LivePatch } from '../packages/editor/src/live';
import { audioCallback } from './audio-clock';

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
// starts the patch at 0 and catches [0, now) up, moved to start now (ADR 0017), so
// the Clock's t=0 note sounds at the resume instead of the next tick, a whole
// period later. The tap's own note, held for the resume, follows it 5 ms later.

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

  await page.goto('/?patch=new');
  await page.getByTestId('open-file').setInputFiles({ name: 'first-note.flowpatch', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(patch)) });
  await expect(page.getByTestId('compile-status')).toContainText('6 nodes compiled');
  await expect(page.getByTestId('audio-state')).toHaveText('tap to start');
  expect(await page.evaluate(() => window.flowPatcher!.stats.windows)).toBe(0);

  await page.getByTestId('performance-canvas').click({ position: { x: 40, y: 40 } });
  await expect(page.getByTestId('audio-state')).toHaveText('live');
  // Both notes, long before the Clock's second tick at 1 s.
  await expect.poll(async () => (await starts(page)).length).toBeGreaterThanOrEqual(2);
  const seen = await starts(page);
  const stats = await page.evaluate(() => window.flowPatcher!.stats);
  const tap = await page.evaluate(() => window.flowPatcher!.taps[0]!);
  const ms = (s: number) => (s * 1000).toFixed(2);
  console.log(`[first note] starts ${seen.map((s) => `${Math.round(s.hz)} Hz at ${ms(s.when)} (called at ${ms(s.at)})`).join(', ')}; ` +
    `catch-ups ${stats.catchUps} (worst ${stats.catchUpMaxMs.toFixed(2)} ms), caught up ${stats.caughtUp}, ` +
    `late ${stats.lateCaughtUp} caught up, ${stats.lateScheduled} scheduled, ${stats.lateImmediate} immediate; stalls ${stats.stalls}`);

  // One clock step: the callback (baseLatency) or the largest step seen, whichever is longer (ADR 0027).
  const { callback, largestStep } = await audioCallback(page);
  const step = Math.max(callback, largestStep);
  const [clockNote, tapNote] = seen;
  // The t=0 tick, caught up: it reached Web Audio on the resume's first wake, at the clock then, not 1 s later.
  // A catch-up has no lead, so a clock step during that wake can leave it behind currentTime, by up to a step
  // (the runtime moves it to the clock at hand-over and counts it in lateCaughtUp; Web Audio plays it at once).
  expect(clockNote!.hz).toBeCloseTo(CLOCK_HZ, 1);
  expect(clockNote!.at - clockNote!.when).toBeLessThanOrEqual(step + 1e-6);
  expect(clockNote!.when).toBeLessThan(0.5);
  expect(stats.caughtUp).toBeGreaterThanOrEqual(1);
  expect(stats.catchUps).toBeGreaterThanOrEqual(1);
  // The tap, held while audio was stopped, is stamped currentTime + 5 ms by the same wake, after the catch-up.
  expect(tap.cold).toBe(true);
  expect(tapNote!.hz).toBeCloseTo(TAP_HZ, 1);
  // Its push read the clock after that wake handed the t=0 note over, so it follows by at least the 5 ms offset.
  expect(tapNote!.at - tapNote!.when).toBeLessThanOrEqual(step + 1e-6);
  expect(tapNote!.when - clockNote!.when).toBeGreaterThanOrEqual(IMMEDIATE_OFFSET - 1e-6);
  // The click's pointerdown and pointerup, both held.
  expect(stats.deferredPushes).toBe(2);
  expect(stats.lateScheduled).toBe(0);

  // And it keeps time from there: the next tick at 1 s.
  await expect.poll(async () => (await starts(page)).filter((s) => Math.abs(s.hz - CLOCK_HZ) < 1).length, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
  const ticks = (await starts(page)).filter((s) => Math.abs(s.hz - CLOCK_HZ) < 1);
  expect(ticks[1]!.when).toBeCloseTo(1, 9);
  expect(errors).toEqual([]);
});
