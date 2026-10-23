import { expect, test } from '@playwright/test';
import type { LivePatch } from '../packages/editor/src/live';
import { audioClock, clockStepKnown } from './audio-clock';

declare global {
  interface Window {
    flowPatcher?: LivePatch;
  }
}

// Gate check Immediate path (docs/milestones.md, M1): a scripted pointerdown
// produces a note at currentTime + 5 ms ± 2 ms, without waiting for a wake.
test('a tap on the preview canvas plays a note on the immediate path', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));

  await page.goto('/?patch=pointer-notes');
  await expect(page.getByTestId('compile-status')).toHaveText('4 nodes compiled');
  const canvas = page.getByTestId('performance-canvas');
  await expect(page.getByTestId('audio-state')).toHaveText('tap to start');

  // Hovering before the first tap: those moves must not pile up behind the stopped AudioContext.
  const box = (await canvas.boundingBox())!;
  for (let i = 0; i < 400; i++) await page.mouse.move(box.x + 10 + (i % 200), box.y + 10 + (i % 7) * 10);

  // The first tap starts audio, and still sounds once it has.
  await canvas.click({ position: { x: 40, y: 40 } });
  await expect(page.getByTestId('audio-state')).toHaveText('live');
  await expect.poll(() => page.evaluate(() => window.flowPatcher!.taps[0]?.note ?? null)).not.toBeNull();
  // The offset rests on the measured clock step once it is known (ADR 0028), so the warm taps wait for it.
  await clockStepKnown(page);

  // Warm taps, spread over different wake phases.
  for (let i = 0; i < 10; i++) {
    await canvas.click({ position: { x: 40 + i * 20, y: 80 } });
    await page.waitForTimeout(37);
  }
  const taps = await page.evaluate(() => window.flowPatcher!.taps.filter((tap) => !tap.cold));
  const clock = await audioClock(page);
  // Each tap keeps the offset it was stamped with: 5 ms, or one clock step + 1 ms if that is longer (ADR 0027, 0028).
  expect(taps).toHaveLength(10);
  for (const tap of taps) {
    // push reads currentTime again after the handler did, and the clock can step between the two
    // reads, so the gate's currentTime is push's read: the stamp minus the offset.
    expect(tap.stamped! - tap.at).toBeGreaterThanOrEqual(tap.offset - 1e-6);
    expect(tap.stamped! - tap.at).toBeLessThanOrEqual(tap.offset + clock.step + 1e-6);
    expect(tap.note).not.toBeNull();
    // The gate as written: the note at currentTime + 5 ms ± 2 ms.
    expect(Math.abs(tap.note! - (tap.stamped! - tap.offset) - 0.005)).toBeLessThanOrEqual(0.002 + 1e-9);
  }
  const ms = (s: number) => (s * 1000).toFixed(2);
  console.log(
    `offset ${[...new Set(taps.map((t) => ms(t.offset)))].join('/')} ms (clock step ${ms(clock.step)} ms, largest seen ${ms(clock.largestStep)} ms, baseLatency ${ms(clock.baseLatency)} ms); ` +
      `note − push's read: ${ms(Math.min(...taps.map((t) => t.note! - t.stamped! + t.offset)))}–${ms(Math.max(...taps.map((t) => t.note! - t.stamped! + t.offset)))} ms; ` +
      `note − handler's read: ${ms(Math.min(...taps.map((t) => t.note! - t.at)))}–${ms(Math.max(...taps.map((t) => t.note! - t.at)))} ms`,
  );
  const stats = await page.evaluate(() => window.flowPatcher!.stats);
  expect(stats.pushes).toBeGreaterThanOrEqual(11);
  // ADR 0026: a visible push always rewinds, so none fell back to the horizon, and none was handed over late.
  expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
  expect(stats.pushFallbacks).toBe(0);
  expect(stats.lateImmediate).toBe(0);

  await page.screenshot({ path: 'test-results/pointer.png' });
  expect(errors).toEqual([]);
});
