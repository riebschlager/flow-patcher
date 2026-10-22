import { expect, test } from '@playwright/test';
import type { LivePatch } from '../packages/editor/src/live';

declare global {
  interface Window {
    flowPatcher?: LivePatch;
  }
}

// Sampled Voice (#25): the card shows "loading" inline while the instrument's
// samples come from /vendor, an error with Retry when they don't, and the
// patch plays once they're in.
test('Sampled Voice shows its instrument loading, retries a failed load, then plays', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // The failed fetch below logs a resource error; anything else is a real one.
  page.on('console', (message) => message.type() === 'error' && !message.text().includes('503') && errors.push(message.text()));

  // Hold the samples back, and fail the first request, so both states can be seen.
  let fail = true, requests = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/vendor/*', async (route) => {
    requests++;
    await held;
    return fail ? route.fulfill({ status: 503, body: '' }) : route.continue();
  });

  await page.goto('/?patch=sampled-voice');
  const card = page.locator('[data-node-type="sampled-voice"]');
  const status = card.getByTestId('node-status');
  await expect(status).toHaveAttribute('data-status', 'loading');
  await expect(status).toHaveText('Loading vibraphone');

  release();
  await expect(status).toHaveAttribute('data-status', 'error');
  await expect(card).toHaveClass(/patch-node--error/);
  fail = false;
  await card.getByRole('button', { name: 'Retry' }).click();
  await expect(status).toHaveCount(0);
  expect(requests).toBe(2);

  // Start audio from the preview canvas; the example's notes reach the voice and none is skipped.
  await page.getByTestId('performance-canvas').click({ position: { x: 40, y: 40 } });
  await expect(page.getByTestId('audio-state')).toHaveText('live');
  const id = await card.evaluate((el) => el.closest<HTMLElement>('.react-flow__node')!.dataset.id!);
  await expect.poll(() => page.evaluate(() => window.flowPatcher!.stats.delivered), { timeout: 5000 }).toBeGreaterThan(4);
  expect(await page.evaluate((node) => window.flowPatcher!.stateOf(node)?.skippedNotes ?? 0, id)).toBe(0);

  await card.screenshot({ path: 'test-results/sampled-voice.png' });
  expect(errors).toEqual([]);
});
