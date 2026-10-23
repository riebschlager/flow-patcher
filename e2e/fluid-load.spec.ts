import { expect, test } from '@playwright/test';
import type { LivePatch } from '../packages/editor/src/live';
import { audioCallback } from './audio-clock';

declare global {
  interface Window {
    flowPatcher?: LivePatch;
  }
}

// Gate check Immediate path under load (docs/milestones.md, M1): with the
// Fluid stepping in its Worker and the Renderer drawing, the worst of 30
// scripted taps is ≤ offset + 7 ms from pointerdown to the note's time
// (ADR 0016, 0017). The offset is 5 ms, or one audio callback + 1 ms if
// that is longer (ADR 0027). Each tap's splash reaches the canvas without
// the output-latency shift (ADR 0020).

test('taps stay on time with the fluid stepping and the renderer drawing', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));

  await page.goto('/?patch=tap-splash');
  await expect(page.getByTestId('compile-status')).toHaveText('7 nodes compiled');
  const canvas = page.getByTestId('performance-canvas');

  // The first tap starts audio.
  await canvas.click({ position: { x: 40, y: 40 } });
  await expect(page.getByTestId('audio-state')).toHaveText('live');
  await expect.poll(() => page.evaluate(() => window.flowPatcher!.taps[0]?.note ?? null)).not.toBeNull();

  // Under load: the Worker answering steps and the Renderer drawing them.
  await expect
    .poll(() => page.evaluate(() => {
      const { drawn, fluid } = window.flowPatcher!.frameStats;
      return Math.min(drawn, fluid?.received ?? 0);
    }))
    .toBeGreaterThan(30);

  const box = (await canvas.boundingBox())!;
  for (let i = 0; i < 30; i++) {
    await canvas.click({ position: { x: 20 + ((i * 37) % (box.width - 40)), y: 20 + ((i * 23) % (box.height - 40)) } });
    await page.waitForTimeout(37);
  }
  await expect.poll(() => page.evaluate(() => window.flowPatcher!.taps.filter((tap) => !tap.cold && tap.splash).length)).toBe(30);

  const taps = await page.evaluate(() => window.flowPatcher!.taps.filter((tap) => !tap.cold));
  const stats = await page.evaluate(() => window.flowPatcher!.frameStats);
  const { callback, largestStep } = await audioCallback(page);
  const offset = await page.evaluate(() => window.flowPatcher!.immediateOffset);
  const bound = offset + 0.007;
  const late = taps.map((tap) => tap.note! - tap.down);
  const worst = Math.max(...late);
  const splashes = taps.map((tap) => tap.splash!);
  console.log(
    `worst tap ${(worst * 1000).toFixed(2)} ms (offset ${(offset * 1000).toFixed(2)} ms, bound ${(bound * 1000).toFixed(2)} ms); audio callback ${(callback * 1000).toFixed(2)} ms (largest clock step ${(largestStep * 1000).toFixed(2)} ms); ` +
      `splash handed after ${Math.max(...splashes.map((s) => s.handed))} frame(s), drawn after ${Math.min(...splashes.map((s) => s.frames))}–${Math.max(...splashes.map((s) => s.frames))}, ` +
      `ms ${Math.min(...splashes.map((s) => s.ms)).toFixed(1)}–${Math.max(...splashes.map((s) => s.ms)).toFixed(1)}; ` +
      `fluid step ${stats.fluid!.stepMs.toFixed(2)} ms, color ${stats.fluid!.colorMs.toFixed(2)} ms, ${stats.fluid!.merged} merged, ${stats.drawn}/${stats.frames} frames drawn`,
  );

  expect(taps).toHaveLength(30);
  for (const tap of taps) {
    expect(tap.note).not.toBeNull();
    // push reads the clock again after the handler did, and an audio callback can land between the two reads.
    expect(tap.stamped! - tap.at).toBeGreaterThanOrEqual(offset - 1e-6);
    expect(tap.stamped! - tap.at).toBeLessThanOrEqual(offset + callback + 1e-6);
  }
  expect(worst).toBeLessThanOrEqual(bound);
  // ADR 0026: a visible push always rewinds, so none fell back to the horizon, and none was handed over late.
  const pushes = await page.evaluate(() => window.flowPatcher!.stats);
  expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
  expect(pushes.pushFallbacks).toBe(0);
  expect(pushes.lateImmediate).toBe(0);
  // ADR 0020: each tap's own event reaches the visual nodes on the very next frame, without the
  // output-latency shift. When it is then drawn depends on the Worker's speed, so that is logged, not bounded.
  for (const splash of splashes) expect(splash.handed).toBe(1);

  await page.screenshot({ path: 'test-results/fluid-load.png' });
  expect(errors).toEqual([]);
});
