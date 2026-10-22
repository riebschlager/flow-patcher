import { expect, test } from '@playwright/test';
import type { LivePatch } from '../packages/editor/src/live';

declare global {
  interface Window {
    flowPatcher?: LivePatch;
  }
}

// Gate check Immediate path under load (docs/milestones.md, M1): with the
// Fluid stepping in its Worker and the Renderer drawing, the worst of 30
// scripted taps is ≤ offset + 7 ms from pointerdown to the note's time
// (ADR 0016, 0017). Each tap's splash reaches the canvas without the
// output-latency shift (ADR 0020).
const OFFSET = 0.005;
const BOUND = OFFSET + 0.007;

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
  const late = taps.map((tap) => tap.note! - tap.down);
  const worst = Math.max(...late);
  const splashes = taps.map((tap) => tap.splash!);
  console.log(
    `worst tap ${(worst * 1000).toFixed(2)} ms (bound ${(BOUND * 1000).toFixed(0)} ms); ` +
      `splash frames ${Math.min(...splashes.map((s) => s.frames))}–${Math.max(...splashes.map((s) => s.frames))}, ` +
      `ms ${Math.min(...splashes.map((s) => s.ms)).toFixed(1)}–${Math.max(...splashes.map((s) => s.ms)).toFixed(1)}; ` +
      `fluid step ${stats.fluid!.stepMs.toFixed(2)} ms, color ${stats.fluid!.colorMs.toFixed(2)} ms, ${stats.fluid!.merged} merged, ${stats.drawn}/${stats.frames} frames drawn`,
  );

  expect(taps).toHaveLength(30);
  for (const tap of taps) {
    expect(tap.note).not.toBeNull();
    expect(tap.stamped! - tap.at).toBeCloseTo(OFFSET, 6);
  }
  expect(worst).toBeLessThanOrEqual(BOUND);
  // A splash reaches the Fluid on the next frame and shows once the Worker's step comes back (a frame or two).
  for (const splash of splashes) expect(splash.frames).toBeLessThanOrEqual(4);

  await page.screenshot({ path: 'test-results/fluid-load.png' });
  expect(errors).toEqual([]);
});
