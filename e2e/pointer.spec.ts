import { expect, test } from '@playwright/test';
import type { LivePatch } from '../packages/editor/src/live';

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

  // The first tap starts audio, and still sounds once it has.
  await canvas.click({ position: { x: 40, y: 40 } });
  await expect(page.getByTestId('audio-state')).toHaveText('live');
  await expect.poll(() => page.evaluate(() => window.flowPatcher!.taps[0]?.note ?? null)).not.toBeNull();

  // Warm taps, spread over different wake phases.
  for (let i = 0; i < 10; i++) {
    await canvas.click({ position: { x: 40 + i * 20, y: 80 } });
    await page.waitForTimeout(37);
  }
  const taps = await page.evaluate(() => window.flowPatcher!.taps.filter((tap) => !tap.cold));
  expect(taps).toHaveLength(10);
  for (const tap of taps) {
    expect(tap.stamped! - tap.at).toBeCloseTo(0.005, 6);
    expect(tap.note).not.toBeNull();
    expect(Math.abs(tap.note! - tap.at - 0.005)).toBeLessThanOrEqual(0.002);
  }
  const stats = await page.evaluate(() => window.flowPatcher!.stats);
  expect(stats.pushes).toBeGreaterThanOrEqual(11);

  await page.screenshot({ path: 'test-results/pointer.png' });
  expect(errors).toEqual([]);
});
